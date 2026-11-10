// ==========================================================================
// PRECIOS: validación de lo que devuelve la IA
//
// Regla de oro: ningún precio llega a la pantalla sin pasar por aquí.
//  1. El enlace debe ser de una tienda reconocida (lista blanca) y https.
//  2. El servidor intenta leer el precio él mismo desde la página del producto
//     (datos estructurados JSON-LD / meta). Si lo logra, ESE es el precio que se
//     muestra (corrige a la IA si se equivocó o estaba desactualizada).
//  3. Si la tienda no deja leerla (ej. Amazon bloquea bots), solo se acepta el
//     precio si Gemini realmente abrió esa página en esta consulta; y se marca.
//  4. Todo lo demás se descarta. Nunca se inventa ni se completa un precio.
// ==========================================================================

// Tiendas reconocidas. Puedes añadir más en .env: PRICE_SITES=dominio1.com,dominio2.com
const DEFAULT_STORES = [
    { host: 'mercadolibre.com.co', name: 'Mercado Libre' },
    { host: 'amazon.com', name: 'Amazon' },
    { host: 'alkosto.com', name: 'Alkosto' },
    { host: 'ktronix.com', name: 'Ktronix' },
    { host: 'falabella.com.co', name: 'Falabella' },
    { host: 'exito.com', name: 'Éxito' },
    { host: 'newegg.com', name: 'Newegg' },
    { host: 'bhphotovideo.com', name: 'B&H' },
    { host: 'bestbuy.com', name: 'Best Buy' }
];

const EXTRA = (process.env.PRICE_SITES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STORES = DEFAULT_STORES.concat(
    EXTRA.filter((h) => !DEFAULT_STORES.some((s) => s.host === h)).map((h) => ({ host: h, name: h }))
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseUrl(u) {
    try {
        const url = new URL(String(u));
        return url.protocol === 'https:' ? url : null;
    } catch (_) { return null; }
}

function storeFor(u) {
    const url = parseUrl(u);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    return STORES.find((s) => host === s.host || host.endsWith('.' + s.host)) || null;
}

// host + ruta, sin www, sin parámetros ni "/" final: sirve para comparar enlaces
function normUrl(u) {
    const url = parseUrl(u);
    if (!url) return '';
    return (url.hostname.replace(/^www\./i, '') + url.pathname.replace(/\/+$/, '')).toLowerCase();
}

function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.replace(/[^\d.,]/g, '');
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return parseFloat(s.replace(/,/g, ''));
    if (/^\d+,\d{1,2}$/.test(s)) return parseFloat(s.replace(',', '.'));
    return null;
}

// --------------------------------------------------------------------------
// Lectura del precio desde el HTML de la página (datos estructurados)
// --------------------------------------------------------------------------
function walkOffers(node, found) {
    if (!node || typeof node !== 'object' || found.price != null) return;
    if (Array.isArray(node)) { node.forEach((n) => walkOffers(n, found)); return; }

    if (node.offers) {
        const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
        for (const o of offers) {
            const price = parseNum(o && (o.price != null ? o.price : o.lowPrice));
            if (price != null && price > 0) {
                found.price = price;
                found.currency = String(o.priceCurrency || '').toUpperCase() || null;
                return;
            }
        }
    }
    Object.values(node).forEach((n) => { if (typeof n === 'object') walkOffers(n, found); });
}

function metaContent(html, attr, value) {
    const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*>`, 'i');
    const tag = re.exec(html);
    if (!tag) return null;
    const c = /content=["']([^"']*)["']/i.exec(tag[0]);
    return c ? c[1] : null;
}

function extractLive(html) {
    const found = { price: null, currency: null };

    const ld = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ld.exec(html)) && found.price == null) {
        try { walkOffers(JSON.parse(m[1].trim()), found); } catch (_) { /* bloque no válido */ }
    }

    if (found.price == null) {
        const p = parseNum(metaContent(html, 'itemprop', 'price') || metaContent(html, 'property', 'product:price:amount') || metaContent(html, 'property', 'og:price:amount'));
        if (p != null && p > 0) {
            found.price = p;
            found.currency = (metaContent(html, 'itemprop', 'priceCurrency') || metaContent(html, 'property', 'product:price:currency') || metaContent(html, 'property', 'og:price:currency') || '').toUpperCase() || null;
        }
    }

    const title = metaContent(html, 'property', 'og:title');
    return { price: found.price, currency: found.currency, title: title ? title.trim() : null };
}

// Descarga la página con redirecciones controladas: cada salto debe seguir en la lista blanca
async function fetchProductHtml(startUrl, fetchImpl, timeoutMs = 9000) {
    let current = startUrl;
    for (let hop = 0; hop < 4; hop++) {
        if (!storeFor(current)) return null;
        const res = await fetchImpl(current, {
            redirect: 'manual',
            headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.7', 'Accept': 'text/html,application/xhtml+xml' },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location'), current).toString();
            continue;
        }
        if (!res.ok) return null;
        return (await res.text()).slice(0, 3 * 1024 * 1024);
    }
    return null;
}

async function readLive(url, fetchImpl) {
    try {
        const html = await fetchProductHtml(url, fetchImpl);
        if (!html) return null;
        const live = extractLive(html);
        return live.price != null ? live : null;
    } catch (_) {
        return null; // bloqueada, lenta o sin red: se usa el siguiente nivel de verificación
    }
}

// --------------------------------------------------------------------------
// Validación de las ofertas que propone la IA
// --------------------------------------------------------------------------
async function validateOffers({ items, buildKeys, retrievedUrls, fetchImpl = fetch, strict = true }) {
    const list = Array.isArray(items) ? items.slice(0, 30) : [];
    const dropped = [];

    const results = await Promise.all(list.map(async (it) => {
        const drop = (reason) => { dropped.push({ componente: it && it.componente, reason }); return null; };
        if (!it || typeof it !== 'object') return drop('formato');
        if (!buildKeys.includes(it.componente)) return drop('componente');

        const store = storeFor(it.url);
        if (!store) return drop('tienda no reconocida');

        let precio = parseNum(it.precio);
        let moneda = String(it.moneda || '').toUpperCase();
        if (!(precio > 0) || !/^[A-Z]{3}$/.test(moneda)) return drop('precio no válido');

        let producto = String(it.producto || '').trim().slice(0, 140);
        let verificacion;
        let corregido = false;

        const live = await readLive(it.url, fetchImpl);
        if (live) {
            const same = live.currency ? live.currency === moneda : true;
            corregido = !same || Math.abs(live.price - precio) / live.price > 0.01;
            precio = live.price;
            if (live.currency) moneda = live.currency;
            if (live.title) producto = live.title.slice(0, 140);
            verificacion = 'live';
        } else if (retrievedUrls.has(normUrl(it.url))) {
            verificacion = 'page';
        } else if (!strict) {
            verificacion = 'search';
        } else {
            return drop('sin verificar');
        }

        return {
            componente: it.componente,
            producto: producto || 'Producto',
            tienda: store.name,
            precio,
            moneda,
            url: it.url,
            condicion: ['nuevo', 'usado', 'reacondicionado'].includes(String(it.condicion || '').toLowerCase()) ? String(it.condicion).toLowerCase() : 'nuevo',
            verificacion,
            corregido
        };
    }));

    return { offers: results.filter(Boolean), dropped };
}

// Agrupa por componente (máx. 3 ofertas, de menor a mayor precio dentro de la misma moneda)
// y calcula totales por moneda con los menores precios.
function summarize(offers, buildKeys) {
    const byPart = {};
    for (const key of buildKeys) {
        const own = offers.filter((o) => o.componente === key);
        if (!own.length) continue;
        own.sort((a, b) => (a.moneda === b.moneda ? a.precio - b.precio : a.moneda.localeCompare(b.moneda)));
        const list = [];
        const perStore = new Set();
        for (const o of own) {
            if (perStore.has(o.tienda + o.moneda)) continue; // una oferta por tienda
            perStore.add(o.tienda + o.moneda);
            list.push(o);
            if (list.length === 3) break;
        }
        const cheapest = {};
        list.forEach((o) => { if (!cheapest[o.moneda]) { cheapest[o.moneda] = o; o.menor = true; } });
        byPart[key] = list;
    }

    const totals = {};
    for (const key of Object.keys(byPart)) {
        for (const o of byPart[key]) {
            if (!o.menor) continue;
            const t = totals[o.moneda] || (totals[o.moneda] = { moneda: o.moneda, total: 0, piezas: 0 });
            t.total += o.precio;
            t.piezas += 1;
        }
    }
    const faltantes = buildKeys.filter((k) => !byPart[k]);
    return { byPart, totals: Object.values(totals).sort((a, b) => b.piezas - a.piezas), faltantes };
}

module.exports = { STORES, storeFor, normUrl, parseNum, extractLive, validateOffers, summarize };

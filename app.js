// ==========================================================================
// PCRAFTER — Login con Google, chat con IA en streaming y panel "Tu PC"
// ==========================================================================

import {
    auth,
    googleProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from './config.js';

// Si este archivo se ejecuta, la app cargó (lo usa el diagnóstico de index.html)
window.__pcrafterReady = true;

// Firebase solo autoriza "localhost": si Live Server abre 127.0.0.1, se redirige.
if (window.location.hostname === '127.0.0.1') {
    window.location.hostname = 'localhost';
}

// Si abres la app desde el propio servidor (http://localhost:3000) usa la misma dirección;
// si usas Live Server, apunta al servidor en el puerto 3000.
// En producción (Render, etc.) el servidor sirve la web y la API desde el mismo dominio -> ruta relativa.
// Solo en desarrollo con Live Server (localhost en otro puerto) se apunta a localhost:3000.
const IS_DEV_OTHER_PORT = ['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '3000';
const API_URL = IS_DEV_OTHER_PORT ? 'http://localhost:3000/api/chat' : '/api/chat';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const CHECK = '<svg class="i-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

const PARTS = [
    { key: 'cpu', label: 'Procesador' },
    { key: 'mb', label: 'Placa base' },
    { key: 'gpu', label: 'Tarjeta gráfica' },
    { key: 'ram', label: 'Memoria RAM' },
    { key: 'storage', label: 'Almacenamiento' },
    { key: 'psu', label: 'Fuente' },
    { key: 'cooler', label: 'Refrigeración' },
    { key: 'case', label: 'Chasis' }
];

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------
const appView = $('appView');
const thread = $('thread');
const messages = $('chatMessages');
const form = $('chatForm');
const input = $('messageInput');
const btnSend = $('btnSend');
const fileInput = $('fileUpload');
const fileChip = $('fileChip');
const fileName = $('fileName');

let currentUser = null;
let busy = false;
let controller = null;
let history = [];          // memoria de la conversación (solo en este navegador)
let currentBuild = null;   // último armado que entregó la IA
let offerPending = false;  // la IA acaba de preguntar si quieres precios actuales

// ---------------------------------------------------------------------------
// 1. Sesión con Google
// ---------------------------------------------------------------------------
// La persistencia se fija al cargar (no en el clic) para que el popup se abra al instante.
setPersistence(auth, browserLocalPersistence).catch(() => {});

async function checkServer() {
    const url = API_URL.replace('/api/chat', '/api/health');
    let problem = null;
    try {
        const r = await fetch(url);
        const j = await r.json();
        if (!j.ok) problem = 'old';
    } catch (err) {
        problem = err instanceof TypeError ? 'down' : 'old';
    }
    if (!problem) return;
    const m = addAiMessage();
    m.el.classList.add('is-error');
    m.body.innerHTML = problem === 'down'
        ? '<p>No puedo comunicarme con el servidor de PCrafter. Ejecuta "node server.js" en la carpeta del proyecto.</p>'
        : '<p>El servidor que está corriendo es una versión anterior. Ciérralo con Ctrl+C, ejecuta de nuevo "node server.js" y recarga la página con Ctrl+F5.</p>';
}

function fillAvatar(node, user) {
    node.replaceChildren();
    if (user.photoURL) {
        const img = document.createElement('img');
        img.src = user.photoURL;
        img.alt = '';
        img.width = 30;
        img.height = 30;
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => { node.textContent = initialOf(user); };
        node.appendChild(img);
    } else {
        node.textContent = initialOf(user);
    }
}
const initialOf = (user) => (user.displayName || user.email || 'U').charAt(0).toUpperCase();

onAuthStateChanged(auth, (user) => {
    currentUser = user;
    root.dataset.auth = user ? 'in' : 'out';
    $('loginView').hidden = !!user;
    appView.hidden = !user;

    if (user) {
        $('userNameDisplay').textContent = user.displayName || user.email;
        fillAvatar($('userAvatar'), user);
        if (!thread.children.length) resetChat();
        checkServer();
    } else {
        abortStream();
        resetChat();
    }
});

function loginHint(error) {
    const code = error.code || '';
    const msg = error.message || '';
    const origin = window.location.origin;
    let hint;
    if (code === 'auth/unauthorized-domain') hint = `Firebase no autoriza ${window.location.hostname}. En la consola de Firebase ve a Authentication > Settings > Authorized domains y agrega "${window.location.hostname}".`;
    else if (code === 'auth/popup-blocked') hint = 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio (ícono en la barra de direcciones) e inténtalo de nuevo.';
    else if (code === 'auth/operation-not-allowed') hint = 'El inicio de sesión con Google no está activado. En Firebase ve a Authentication > Sign-in method, abre Google y actívalo.';
    else if (code === 'auth/network-request-failed') hint = 'No hay conexión con Google. Revisa tu internet; si usas Brave, desactiva Shields para este sitio.';
    else if (/api-key|API_KEY/i.test(code + msg) && /referer|referrer|blocked/i.test(code + msg)) hint = `La API key de Google bloquea esta dirección. En Google Cloud Console > Credenciales > tu API key > Restricciones de aplicación, agrega ${origin}/* (o quita la restricción mientras desarrollas).`;
    else if (/api-key/i.test(code)) hint = 'La API key de Firebase no es válida. Revisa firebaseConfig en config.js.';
    else hint = 'No se pudo iniciar sesión.';
    return `${hint} (${code || msg})`;
}

async function login() {
    const errorBox = $('loginError');
    errorBox.classList.add('hidden');
    try {
        await signInWithPopup(auth, googleProvider);
    } catch (error) {
        if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') return;
        errorBox.textContent = loginHint(error);
        errorBox.classList.remove('hidden');
        errorBox.scrollIntoView({ block: 'nearest' });
    }
}
$('btnGoogleLogin').addEventListener('click', login);
$('btnNavLogin').addEventListener('click', login);

$('btnLogout').addEventListener('click', () => signOut(auth));

// ---------------------------------------------------------------------------
// 2. Texto de la IA: markdown mínimo y seguro
// ---------------------------------------------------------------------------
function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
    return esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(src) {
    const lines = src.replace(/\r/g, '').split('\n');
    let html = '';
    let list = null;
    let para = [];
    let code = null;

    const flushPara = () => {
        if (para.length) html += '<p>' + para.map(inline).join('<br>') + '</p>';
        para = [];
    };
    const closeList = () => {
        if (list) html += `</${list}>`;
        list = null;
    };
    const openList = (type) => {
        if (list !== type) {
            closeList();
            html += `<${type}>`;
            list = type;
        }
    };

    for (const line of lines) {
        if (/^```/.test(line)) {
            if (code === null) {
                flushPara();
                closeList();
                code = [];
            } else {
                html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
                code = null;
            }
            continue;
        }
        if (code !== null) {
            code.push(line);
            continue;
        }
        if (!line.trim()) {
            flushPara();
            closeList();
            continue;
        }

        let m;
        if ((m = line.match(/^#{1,4}\s+(.*)/))) {
            flushPara();
            closeList();
            html += '<h3>' + inline(m[1]) + '</h3>';
        } else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
            flushPara();
            openList('ul');
            html += '<li>' + inline(m[1]) + '</li>';
        } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
            flushPara();
            openList('ol');
            html += '<li>' + inline(m[1]) + '</li>';
        } else {
            closeList();
            para.push(line);
        }
    }

    if (code !== null) html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
    flushPara();
    closeList();
    return html;
}

// Separa el texto visible del bloque <PC_BUILD>...</PC_BUILD> (incluso mientras llega por partes)
const OPEN_TAG = '<PC_BUILD>';
const CLOSE_TAG = '</PC_BUILD>';

function splitBuild(text) {
    const start = text.indexOf(OPEN_TAG);
    if (start === -1) {
        // Oculta una etiqueta que aún está llegando a medias, ej. "<PC_BU"
        for (let k = OPEN_TAG.length - 1; k > 0; k--) {
            if (text.endsWith(OPEN_TAG.slice(0, k))) return { visible: text.slice(0, -k), json: null };
        }
        return { visible: text, json: null };
    }
    const end = text.indexOf(CLOSE_TAG, start);
    if (end === -1) return { visible: text.slice(0, start).trimEnd(), json: null };
    return {
        visible: (text.slice(0, start) + text.slice(end + CLOSE_TAG.length)).trim(),
        json: text.slice(start + OPEN_TAG.length, end)
    };
}

// ---------------------------------------------------------------------------
// 3. Panel "Tu PC" (lista + visor 3D + precios)
// ---------------------------------------------------------------------------
const rows = {};
const buildList = $('buildList');
const statusTag = $('compatibilityStatus');
const buildNote = $('buildNote');
const labels = Object.fromEntries(PARTS.map((p) => [p.key, p.label]));

let viewer = { update() {}, highlight() {}, reset() {} };
import('./pc3d.js')
    .then((m) => {
        viewer = m.createViewer($('viewer'), { labels, onSelect: highlightRow });
        if (currentBuild) viewer.update(currentBuild);
    })
    .catch((err) => {
        console.warn('El visor 3D no se pudo cargar (la app sigue funcionando):', err);
        $('viewer').classList.add('is-off');
    });

function makeRow({ key, label }) {
    const li = document.createElement('li');
    li.className = 'part is-empty';
    li.innerHTML =
        '<div class="part-main"><strong class="part-name">Sin asignar</strong>' +
        `<span class="part-sub"><span class="part-type">${label}</span><span class="part-meta"></span></span>` +
        '<span class="part-price hidden"></span></div>' +
        '<span class="tag tag-ok hidden">' + CHECK + 'Compatible</span>';
    li.addEventListener('mouseenter', () => viewer.highlight(key));
    li.addEventListener('mouseleave', () => viewer.highlight(null));
    rows[key] = {
        li,
        name: li.querySelector('.part-name'),
        meta: li.querySelector('.part-meta'),
        price: li.querySelector('.part-price'),
        tag: li.querySelector('.tag')
    };
    return li;
}

buildList.replaceChildren(...PARTS.map(makeRow));

function highlightRow(key) {
    const r = rows[key];
    if (!r) return;
    document.querySelectorAll('.part.is-active').forEach((n) => n.classList.remove('is-active'));
    r.li.classList.add('is-active');
    r.li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => r.li.classList.remove('is-active'), 2200);
}

function clearPrices() {
    PARTS.forEach(({ key }) => { rows[key].price.classList.add('hidden'); rows[key].price.textContent = ''; });
    $('priceTotal').classList.add('hidden');
}

function resetBuild() {
    currentBuild = null;
    offerPending = false;
    PARTS.forEach(({ key }) => {
        const r = rows[key];
        r.li.classList.add('is-empty');
        r.name.textContent = 'Sin asignar';
        r.meta.textContent = '';
        r.tag.classList.add('hidden');
    });
    clearPrices();
    statusTag.className = 'tag tag-idle';
    statusTag.textContent = 'Sin armar';
    buildNote.textContent = '';
    $('buildTitle').textContent = 'Tu PC armado';
    $('refBox').classList.add('hidden');
    $('powerText').textContent = '—';
    $('powerFill').style.width = '0%';
    appView.classList.remove('has-build');
    viewer.update(null);
}

function renderBuild(b) {
    if (!b || typeof b !== 'object') return;
    currentBuild = b;
    const ok = b.compatible !== false;
    appView.classList.add('has-build'); // el panel se despliega junto al chat
    $('buildTitle').textContent = b.titulo || 'Tu PC armado';
    if (Number(b.totalRefCOP) > 0) {
        $('refTotal').textContent = money(Number(b.totalRefCOP), 'COP');
        $('refBox').classList.remove('hidden');
    } else {
        $('refBox').classList.add('hidden');
    }

    statusTag.className = 'tag ' + (ok ? 'tag-ok' : 'tag-warn');
    statusTag.innerHTML = ok ? CHECK + 'Compatible' : 'Revisar';
    buildNote.textContent = b.mensajeCompatibilidad || (ok ? 'Todas las piezas son compatibles' : 'Revisa la compatibilidad');

    PARTS.forEach(({ key }) => {
        const part = b[key];
        const r = rows[key];
        if (!part || !part.nombre) {
            r.li.classList.add('is-empty');
            r.name.textContent = 'Sin asignar';
            r.meta.textContent = '';
            r.tag.classList.add('hidden');
            return;
        }
        r.li.classList.remove('is-empty');
        r.name.textContent = part.nombre;
        r.meta.textContent = (part.meta || '').replace(/\b(Socket|RAM|Tipo|Interfaz|Formato|Soporte):\s*/gi, '').replace(/\s*\|\s*/g, ', ');
        r.tag.classList.toggle('hidden', !ok);
    });
    clearPrices(); // los precios anteriores eran de otro armado

    const consumo = Number(b.consumoW) || 0;
    const psuW = parseInt(((b.psu && ((b.psu.meta || '') + ' ' + (b.psu.nombre || ''))) || '').match(/(\d{3,4})\s*W/i)?.[1], 10);
    $('powerText').textContent = consumo ? (psuW ? `${consumo} W de ${psuW} W` : `${consumo} W`) : '—';
    $('powerFill').style.width = consumo && psuW ? Math.min(100, (consumo / psuW) * 100) + '%' : '0%';

    viewer.update(b);

    // En celular, avisa que el armado cambió
    const buildTab = document.querySelector('.tab[data-tab="build"]');
    if (!buildTab.classList.contains('active')) buildTab.dataset.new = 'true';
}

function parseBuild(json) {
    try {
        const clean = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const b = JSON.parse(clean);
        renderBuild(b);
        return true;
    } catch (err) {
        console.warn('No se pudo leer el JSON del armado:', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// 4. Precios actuales
// ---------------------------------------------------------------------------
function money(n, cur) {
    try {
        const s = new Intl.NumberFormat('es-CO', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'COP' ? 0 : 2 }).format(n);
        return cur === 'COP' ? s + ' COP' : s;
    } catch (_) {
        return `${n} ${cur}`;
    }
}

const VERIF = {
    live: 'Precio leído directamente de la página de la tienda',
    page: 'La IA lo leyó en la página del producto; confírmalo en la tienda',
    search: 'Visto en resultados de búsqueda, sin confirmar en la página'
};

function h(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
}

function renderPrices(container, data) {
    const when = new Date(data.consultado).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
    const card = h('div', 'prices');
    const head = h('div', 'prices-head');
    head.append(h('h3', '', 'Precios actuales'), h('span', 'muted small', 'Consultado: ' + when));
    card.appendChild(head);

    const keys = PARTS.map((p) => p.key).filter((k) => data.porComponente[k]);

    if (!keys.length) {
        card.appendChild(h('p', 'prices-missing', 'No pude confirmar ningún precio en las tiendas ahora mismo. Prefiero no mostrarte datos sin verificar. Intenta de nuevo en unos minutos.'));
        container.appendChild(card);
        return;
    }

    keys.forEach((key) => {
        const g = h('div', 'pgroup');
        g.appendChild(h('div', 'pgroup-title', `${labels[key]}: ${currentBuild && currentBuild[key] ? currentBuild[key].nombre : ''}`));
        data.porComponente[key].forEach((o) => {
            const row = h('div', 'offer');
            const store = h('div', 'offer-store');
            store.appendChild(h('span', '', o.tienda));
            const rivals = data.porComponente[key].filter((x) => x.moneda === o.moneda).length;
            if (o.menor && rivals > 1) store.appendChild(h('span', 'tag tag-ok', 'Menor precio'));
            if (o.condicion && o.condicion !== 'nuevo') store.appendChild(h('span', 'tag tag-idle', o.condicion));
            row.append(store, h('div', 'offer-price', money(o.precio, o.moneda)));

            row.appendChild(h('div', 'offer-title', o.producto));
            const a = h('a', 'offer-link', 'Ver en la tienda');
            if (/^https:\/\//i.test(o.url)) { a.href = o.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
            row.appendChild(a);

            row.appendChild(h('div', 'offer-check', VERIF[o.verificacion] || '' ));
            g.appendChild(row);
        });
        card.appendChild(g);
    });

    if (data.faltantes.length) {
        card.appendChild(h('p', 'prices-missing', 'Sin precio confirmado para: ' + data.faltantes.map((k) => labels[k]).join(', ') + '. Prefiero no mostrar un dato que no pueda verificar.'));
    }

    if (data.totales.length) {
        const t = h('div', 'prices-totals');
        data.totales.forEach((x) => {
            const line = h('div');
            line.append(h('span', '', `Total con los menores precios (${x.piezas} de ${keys.length + data.faltantes.length} piezas, ${x.moneda})`), h('strong', '', money(x.total, x.moneda)));
            t.appendChild(line);
        });
        card.appendChild(t);
    }

    card.appendChild(h('p', 'prices-note', 'Los precios cambian y dependen de stock, envío e impuestos. Abre el enlace y confirma antes de pagar.'));
    container.appendChild(card);

    // Precio más bajo de cada pieza también en el panel "Tu PC"
    clearPrices();
    keys.forEach((key) => {
        const best = data.porComponente[key].find((o) => o.menor && o.moneda === 'COP') || data.porComponente[key].find((o) => o.menor);
        if (!best) return;
        rows[key].price.textContent = `Desde ${money(best.precio, best.moneda)} en ${best.tienda}`;
        rows[key].price.classList.remove('hidden');
    });
    const cop = data.totales.find((x) => x.moneda === 'COP');
    if (cop) {
        const box = $('priceTotal');
        box.replaceChildren(h('span', '', `Con precios actuales (${cop.piezas} de ${keys.length + data.faltantes.length} piezas)`), h('strong', '', money(cop.total, 'COP')));
        box.classList.remove('hidden');
    }
}

function addSearchEntry(container, html) {
    const f = document.createElement('iframe');
    f.className = 'search-entry';
    f.title = 'Sugerencias de búsqueda de Google';
    f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    f.srcdoc = '<base target="_blank"><style>body{margin:0}</style>' + html;
    container.appendChild(f);
}

// ---------------------------------------------------------------------------
// 5. Chat
// ---------------------------------------------------------------------------
function resetChat() {
    thread.replaceChildren($('welcomeTpl').content.cloneNode(true));
    history = [];
    resetBuild();
    clearFile();
    input.value = '';
    autosize();
}

function nearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
}

function toBottom() {
    messages.scrollTop = messages.scrollHeight;
}

function addUserMessage(text) {
    const row = h('div', 'msg msg-user');
    const avatar = h('div', 'avatar');
    fillAvatar(avatar, currentUser);
    row.append(avatar, h('div', 'bubble', text));
    thread.appendChild(row);
    toBottom();
}

function addAiMessage() {
    const row = h('div', 'msg msg-ai');
    const avatar = h('div', 'avatar avatar-ai');
    avatar.innerHTML = '<svg aria-hidden="true"><use href="icons.svg#logo"/></svg>';
    const content = h('div', 'content');
    const body = h('div', 'md');
    body.innerHTML = '<span class="dots" aria-label="Pensando"><span></span><span></span><span></span></span>';
    content.appendChild(body);
    row.append(avatar, content);
    thread.appendChild(row);
    toBottom();
    return { el: row, content, body };
}

function addSources(container, links) {
    if (!links || !links.length) return;
    const box = h('div', 'sources');
    box.appendChild(h('strong', '', 'Fuentes'));
    const ul = document.createElement('ul');
    links.slice(0, 4).forEach((l) => {
        if (!/^https?:\/\//i.test(l.url)) return;
        const li = document.createElement('li');
        const a = h('a', '', l.title);
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
        ul.appendChild(li);
    });
    box.appendChild(ul);
    container.appendChild(box);
}

// Botones de respuesta rápida tras entregar un armado
function addPriceOffer(container) {
    const q = h('div', 'quick');
    const yes = h('button', 'chip chip-primary', 'Sí, ver precios actuales');
    const no = h('button', 'chip', 'No por ahora');
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => { if (!busy) askPrices(); });
    no.addEventListener('click', () => {
        document.querySelectorAll('.quick').forEach((n) => n.remove());
        offerPending = false;
        const m = addAiMessage();
        m.body.innerHTML = '<p>Sin problema. Cuando quieras, dime "precios actuales" y los consulto.</p>';
    });
    q.append(yes, no);
    container.appendChild(q);
}

function setBusy(value) {
    busy = value;
    btnSend.textContent = value ? 'Detener' : 'Enviar';
}

function abortStream() {
    if (controller) controller.abort();
}

// Lee la respuesta del servidor (Server-Sent Events) y avisa de cada evento
async function readStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (raw.startsWith('data: ')) onEvent(JSON.parse(raw.slice(6)));
        }
    }
}

function setUsage({ count, limit }) {
    $('usageCount').textContent = `${count} / ${limit}`;
    $('usageFill').style.width = Math.min(100, (count / limit) * 100) + '%';
}

async function sendMessage(text, file, { prices = false, shown, retry = false } = {}) {
    document.querySelectorAll('.quick').forEach((n) => n.remove());
    thread.querySelector('.welcome')?.remove();
    if (!retry) addUserMessage(shown || (file ? `Archivo: ${file.name}${text ? '\n' + text : ''}` : text));
    offerPending = false;

    const ai = addAiMessage();
    let full = '';
    let started = false;
    let raf = 0;
    let streamError = null;
    let retryable = false;
    let sources = [];
    let gotPrices = false;
    let serverBuild = null;

    const paint = () => {
        raf = 0;
        const stick = nearBottom();
        ai.body.innerHTML = renderMarkdown(splitBuild(full).visible);
        if (stick) toBottom();
    };

    // Estado visible mientras se espera: qué está pasando y cuántos segundos van
    let statusText = prices ? 'Consultando precios' : 'Pensando';
    const waitStart = Date.now();
    const renderStatus = () => {
        if (started || gotPrices) return;
        const secs = Math.round((Date.now() - waitStart) / 1000);
        let line = ai.body.querySelector('.status-line');
        if (!line) {
            ai.body.innerHTML = '<div class="status-line"><span class="dots"><span></span><span></span><span></span></span><span class="status-text"></span></div>';
            line = ai.body.querySelector('.status-line');
        }
        line.querySelector('.status-text').textContent = statusText.replace(/\.+$/, '') + (secs >= 3 ? `... ${secs} s` : '...');
    };
    renderStatus();
    const ticker = setInterval(renderStatus, 1000);

    controller = new AbortController();
    setBusy(true);

    try {
        const token = await currentUser.getIdToken();
        const data = new FormData();
        data.append('message', text);
        if (file) data.append('file', file);
        if (currentBuild) data.append('build', JSON.stringify(currentBuild));
        if (prices) data.append('prices', '1');
        else data.append('history', JSON.stringify(history));

        const response = await fetch(API_URL, { method: 'POST', body: data, headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });

        if (!response.ok || !response.body) {
            let msg = 'No se pudo procesar la solicitud.';
            try { msg = (await response.json()).error || msg; } catch (_) { /* sin cuerpo JSON */ }
            throw new Error(msg);
        }

        await readStream(response, (event) => {
            if (event.t === 'usage') setUsage(event.usage);
            else if (event.t === 'status') {
                statusText = event.text;
                renderStatus();
            } else if (event.t === 'chunk') {
                full += event.text;
                started = true;
                if (!raf) raf = requestAnimationFrame(paint);
            } else if (event.t === 'prices') {
                gotPrices = true;
                ai.body.innerHTML = '<p>Estos son los precios que encontré y pude verificar en tiendas reconocidas.</p>';
                renderPrices(ai.content, event.data);
            } else if (event.t === 'searchEntry') addSearchEntry(ai.content, event.html);
            else if (event.t === 'build') serverBuild = event.data;
            else if (event.t === 'done') sources = event.searchLinks || [];
            else if (event.t === 'error') { streamError = event.error; retryable = !!event.retryable; }
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            ai.el.dataset.stopped = 'true';
        } else if (error instanceof TypeError) {
            streamError = 'No se pudo conectar con el servidor de PCrafter. Enciéndelo con "node server.js" en la terminal.';
            retryable = true;
        } else {
            streamError = error.message;
        }
    } finally {
        clearInterval(ticker);
        if (raf) cancelAnimationFrame(raf);
        controller = null;
        setBusy(false);
    }

    // Pintado final: texto limpio, armado de PC y fuentes
    const { visible, json } = splitBuild(full);
    let built = false;
    if (serverBuild) { renderBuild(serverBuild); built = true; }
    else if (json) built = parseBuild(json);

    if (!gotPrices) {
        if (visible) ai.body.innerHTML = renderMarkdown(visible);
        else if (!ai.body.querySelector('p')) ai.body.textContent = '';
    }

    if (streamError) {
        const note = h('p', '', streamError);
        ai.el.classList.add('is-error');
        ai.body.querySelector('.status-line, .dots')?.remove();
        ai.body.appendChild(note);
        if (retryable) {
            const q = h('div', 'quick');
            const btn = h('button', 'chip chip-primary', 'Reintentar');
            btn.type = 'button';
            btn.addEventListener('click', () => {
                if (busy) return;
                ai.el.remove();
                sendMessage(text, file, { prices, shown, retry: true });
            });
            q.appendChild(btn);
            ai.content.appendChild(q);
        }
    } else if (ai.el.dataset.stopped && !visible && !gotPrices) {
        ai.body.innerHTML = '<p class="muted">Respuesta detenida.</p>';
    } else if (!visible && !json && !gotPrices) {
        ai.body.innerHTML = '<p class="muted">No se pudo generar una respuesta.</p>';
    }

    addSources(ai.content, sources);

    // Memoria: solo intercambios completos
    if (!streamError && !prices && !ai.el.dataset.stopped && visible) {
        history.push({ role: 'user', text: text || (file ? `Adjunté el archivo ${file.name}` : '') }, { role: 'model', text: visible });
        history = history.slice(-10);
    }

    // La IA preguntó si quieres precios: ofrecer respuesta rápida
    if (built && !streamError) {
        offerPending = true;
        addPriceOffer(ai.content);
    }
    toBottom();
}

function askPrices() {
    sendMessage('Consulta los precios actuales de mi cotización', null, { prices: true, shown: 'Sí, ver precios actuales' });
}

const YES = /^\s*(s[ií]|sii+|dale|claro|ok|okay|por favor|de una|listo|va|hazlo|h[aá]zlo|obvio)\b/i;
const PRICE_WORDS = /\b(precios?|cotiz\w*)\b/i;
const PRICE_SCOPE = /\b(actual\w*|hoy|tiendas?|mercado ?libre|amazon|consulta\w*|muestra\w*|busca\w*|cu[aá]nto)\b/i;

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) {
        abortStream();
        return;
    }
    if (!currentUser) return;

    const text = input.value.trim();
    const file = fileInput.files[0] || null;
    if (!text && !file) return;

    input.value = '';
    autosize();
    clearFile();

    // Responder "sí" a la pregunta de precios, o pedirlos con palabras, activa la consulta en tiendas
    const wantsPrices = currentBuild && !file && ((offerPending && YES.test(text)) || (PRICE_WORDS.test(text) && PRICE_SCOPE.test(text)));
    if (wantsPrices) sendMessage(text, null, { prices: true, shown: text });
    else sendMessage(text, file);
});

// Enter envía, Shift+Enter hace salto de línea
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
    }
});

function autosize() {
    input.style.height = 'auto';
    const hgt = input.scrollHeight; // 0 si la app aún está oculta: no fijar alto
    input.style.height = hgt ? Math.min(hgt, 160) + 'px' : '';
}
input.addEventListener('input', autosize);

// Sugerencias rápidas de bienvenida
thread.addEventListener('click', (e) => {
    const chip = e.target.closest('.welcome .chip');
    if (!chip || busy) return;
    input.value = chip.textContent;
    form.requestSubmit();
});

// Archivo adjunto
function clearFile() {
    fileInput.value = '';
    fileChip.classList.add('hidden');
    fileName.textContent = '';
}

fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return clearFile();

    if (file.size > MAX_FILE_BYTES) {
        clearFile();
        const note = addAiMessage();
        note.el.classList.add('is-error');
        note.body.innerHTML = '<p>El archivo pesa más de 10 MB. Sube uno más liviano.</p>';
        return;
    }
    fileName.textContent = file.name;
    fileChip.classList.remove('hidden');
    input.focus();
});

$('btnRemoveFile').addEventListener('click', clearFile);

$('btnNewChat').addEventListener('click', () => {
    abortStream();
    resetChat();
    appView.classList.remove('menu-open');
    input.focus();
});

// ---------------------------------------------------------------------------
// 6. Menú lateral y pestañas en celular
// ---------------------------------------------------------------------------
const closeMenu = () => { appView.classList.remove('menu-open'); $('btnOpenSidebar').setAttribute('aria-expanded', 'false'); };
$('btnOpenSidebar').addEventListener('click', () => { appView.classList.add('menu-open'); $('btnOpenSidebar').setAttribute('aria-expanded', 'true'); });
$('btnCloseSidebar').addEventListener('click', closeMenu);
$('scrim').addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => {
            const active = t === tab;
            t.classList.toggle('active', active);
            t.setAttribute('aria-pressed', String(active));
        });
        tab.removeAttribute('data-new');
        $('panes').dataset.tab = tab.dataset.tab;
    });
});

// ==========================================================================
// SERVIDOR DE PCRAFTER
//  - Streaming (el texto aparece mientras la IA escribe) y razonamiento bajo.
//  - Sesión verificada con el token de Firebase (el límite diario no se puede falsear).
//  - Memoria de la conversación y del armado actual.
//  - Búsqueda en internet cuando hace falta y consulta de precios verificados.
// ==========================================================================

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const { GoogleGenAI } = require('@google/genai');
const { verifyFirebaseToken } = require('./auth');
const { validateOffers, summarize, normUrl } = require('./prices');

// Opcionales en .env:
//   GEMINI_MODEL=gemini-3.8-flash   GEMINI_THINKING=LOW
//   DAILY_LIMIT=20   PRICE_DAILY_LIMIT=5   PRICE_STRICT=1   PRICE_SITES=otra-tienda.com
const list = (v) => v.split(',').map((m) => m.trim()).filter(Boolean);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const THINKING_LEVEL = (process.env.GEMINI_THINKING || 'LOW').toUpperCase();
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 20;
const PRICE_DAILY_LIMIT = Number(process.env.PRICE_DAILY_LIMIT) || 5;
const PRICE_STRICT = process.env.PRICE_STRICT !== '0';
// Modelos de respaldo si el principal está saturado (503). Cada modelo tiene su propia capacidad.
const FALLBACK_MODELS = list(process.env.GEMINI_FALLBACKS || 'gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite');
// Para consultar precios (usa la búsqueda de Google) se prefieren los modelos que la incluyen en el plan gratuito
const PRICE_MODELS = list(process.env.GEMINI_PRICE_MODELS || 'gemini-2.5-flash,gemini-2.5-flash-lite');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 6;  // llamadas a la IA al mismo tiempo
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 40;           // usuarios esperando turno
const MAX_OUTPUT_TOKENS = 8192; // incluye los tokens de razonamiento, por eso es amplio
const MAX_DOC_CHARS = 60000;
const PART_KEYS = ['cpu', 'mb', 'gpu', 'ram', 'storage', 'psu', 'cooler', 'case'];

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('PEGA_AQUI')) {
    console.warn('⚠️  Revisa tu archivo .env y pon tu GEMINI_API_KEY real.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.disable('x-powered-by');
// Detrás de un proxy (Render, Railway, Nginx...) define TRUST_PROXY=1 para que se detecte bien HTTPS y la IP real
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// --------------------------------------------------------------------------
// Seguridad: HTTPS, cabeceras, CORS y límites
// --------------------------------------------------------------------------
if (process.env.FORCE_HTTPS === '1') {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(301, 'https://' + req.headers.host + req.originalUrl)));
}

// Política de contenido: solo se permite lo que PCrafter y Google (Firebase, fuentes, búsqueda) necesitan.
// Si algún día algo se bloquea, prueba con CSP_REPORT_ONLY=1 en .env para ver los avisos sin bloquear.
const CSP = [
    "default-src 'self'",
    "script-src 'self' https://www.gstatic.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com https://www.google.com",
    "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.firebaseapp.com https://*.gstatic.com",
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://*.google.com",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
    res.set({
        [process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']: CSP + (req.secure ? '; upgrade-insecure-requests' : ''),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
        // "allow-popups" mantiene funcionando la ventana de Google para iniciar sesión
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'X-Permitted-Cross-Domain-Policies': 'none'
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
});

// CORS: solo el propio sitio, tu equipo en desarrollo (localhost / Live Server) y lo que añadas en CORS_ORIGINS
const CORS_EXTRA = list(process.env.CORS_ORIGINS || '');
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
app.use(cors({
    origin: (origin, cb) => cb(null, !origin || isLocalOrigin(origin) || CORS_EXTRA.includes(origin)),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use(express.json({ limit: '20kb' }));

// Límite de peticiones por IP (en memoria)
function rateLimit({ windowMs, max, message }) {
    const hits = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
    return (req, res, next) => {
        const now = Date.now();
        let h = hits.get(req.ip);
        if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(req.ip, h); }
        h.n += 1;
        if (h.n > max) {
            res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
            return res.status(429).json({ error: message });
        }
        next();
    };
}
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 240, message: 'Demasiadas solicitudes seguidas. Espera un momento.' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --------------------------------------------------------------------------
// Archivos públicos (solo estos; .env, server.js, auth.js y prices.js nunca se publican)
// --------------------------------------------------------------------------
const PUBLIC_FILES = new Set([
    'index.html', 'styles.css', 'app.js', 'config.js', 'pc3d.js', 'boot.js', 'contact.js', 'icons.svg',
    'privacidad.html', 'terminos.html', 'creditos.html', '404.html',
    'logo.svg', 'favicon.svg', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
    'site.webmanifest', 'robots.txt'
]);
app.get('/api/health', (req, res) => res.json({ ok: true, version: 2, model: orderedModels(false)[0], modelos: orderedModels(false), modelosPrecios: orderedModels(true) }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/privacidad', (req, res) => res.sendFile(path.join(__dirname, 'privacidad.html')));
app.get('/terminos', (req, res) => res.sendFile(path.join(__dirname, 'terminos.html')));
app.get('/creditos', (req, res) => res.sendFile(path.join(__dirname, 'creditos.html')));

// ---- Contacto: formulario protegido (token firmado + trampa anti-bots + validación + límite por IP) ----
const FORM_SECRET = crypto.randomBytes(32);
const MESSAGES_FILE = path.join(__dirname, 'mensajes.jsonl'); // solo lo lees tú; no se publica
const signForm = (t) => crypto.createHmac('sha256', FORM_SECRET).update(t).digest('base64url');
const newFormToken = () => { const t = Date.now().toString(36); return t + '.' + signForm(t); };
function validFormToken(tok) {
    if (typeof tok !== 'string' || !tok.includes('.')) return false;
    const [t, sig] = tok.split('.');
    const good = signForm(t);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
    const age = Date.now() - parseInt(t, 36);
    return age >= 2500 && age <= 2 * 3600 * 1000; // ni demasiado rápido (bot) ni vencido
}
app.get('/contacto', (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, 'contacto.html'), 'utf8').replace('{{TOKEN}}', newFormToken());
    res.type('html').send(html);
});

const oneLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
app.post('/api/contact',
    rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: 'Enviaste varios mensajes seguidos. Inténtalo de nuevo en un rato.' }),
    express.urlencoded({ extended: false, limit: '10kb' }),
    (req, res) => {
        const b = req.body || {};
        const html = req.accepts(['json', 'html']) === 'html';
        const done = () => (html ? res.redirect(303, '/contacto?enviado=1') : res.status(201).json({ ok: true }));
        if (b.website) return done(); // trampa anti-bots: un humano nunca ve este campo

        const nombre = oneLine(b.nombre, 80);
        const email = oneLine(b.email, 120);
        const mensaje = String(b.mensaje == null ? '' : b.mensaje).replace(/\u0000/g, '').trim().slice(0, 1500);
        const errors = {};
        if (nombre.length < 2) errors.nombre = 'Escribe tu nombre (mínimo 2 letras).';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Escribe un correo válido, por ejemplo nombre@correo.com.';
        if (mensaje.length < 10) errors.mensaje = 'Cuéntanos un poco más (mínimo 10 caracteres).';
        if (!validFormToken(b.token)) errors.form = 'El formulario venció o se envió muy rápido. Recarga la página e inténtalo de nuevo.';
        if (Object.keys(errors).length) return html ? res.redirect(303, '/contacto?error=1') : res.status(400).json({ ok: false, errors });

        fs.appendFile(MESSAGES_FILE, JSON.stringify({ fecha: new Date().toISOString(), nombre, email, mensaje }) + '\n', (err) => {
            if (err) { console.error('No se pudo guardar el mensaje de contacto:', err.message); return html ? res.redirect(303, '/contacto?error=1') : res.status(500).json({ ok: false, errors: { form: 'No pudimos guardar tu mensaje. Inténtalo más tarde.' } }); }
            console.log('Nuevo mensaje de contacto guardado en mensajes.jsonl');
            done();
        });
    });
app.get('/:file', (req, res, next) => {
    if (!PUBLIC_FILES.has(req.params.file)) return next();
    res.sendFile(path.join(__dirname, req.params.file));
});

// --------------------------------------------------------------------------
// Límites diarios (por usuario verificado)
// --------------------------------------------------------------------------
function makeCounter(limit) {
    const map = new Map();
    return {
        take(uid) {
            const today = new Date().toISOString().split('T')[0];
            const rec = map.get(uid);
            if (!rec || rec.date !== today) { map.set(uid, { date: today, count: 1 }); return { allowed: true, count: 1, limit }; }
            if (rec.count >= limit) return { allowed: false, count: rec.count, limit };
            rec.count += 1;
            return { allowed: true, count: rec.count, limit };
        },
        peek(uid) {
            const rec = map.get(uid);
            const today = new Date().toISOString().split('T')[0];
            return { allowed: true, count: rec && rec.date === today ? rec.count : 0, limit };
        },
        refund(uid) {
            const rec = map.get(uid);
            if (rec && rec.count > 0) rec.count -= 1; // si la IA no pudo responder, no te cuesta un mensaje
        }
    };
}
const messageCounter = makeCounter(DAILY_LIMIT);
const priceCounter = makeCounter(PRICE_DAILY_LIMIT);

// --------------------------------------------------------------------------
// Catálogo e instrucciones
// --------------------------------------------------------------------------
const CATALOGO_VERIFICADO = [
    { tipo: 'CPU', nombre: 'AMD Ryzen 5 7600', socket: 'AM5', ram: 'DDR5', tdp: 65, precioRefCOP: 890000 },
    { tipo: 'CPU', nombre: 'AMD Ryzen 5 9600X', socket: 'AM5', ram: 'DDR5', tdp: 65, precioRefCOP: 1180000 },
    { tipo: 'CPU', nombre: 'AMD Ryzen 7 5700X', socket: 'AM4', ram: 'DDR4', tdp: 65, precioRefCOP: 680000 },
    { tipo: 'Placa Base', nombre: 'MSI PRO B650M-P', socket: 'AM5', ram: 'DDR5', formato: 'Micro-ATX', precioRefCOP: 560000 },
    { tipo: 'Placa Base', nombre: 'ASUS TUF Gaming B550M-Plus', socket: 'AM4', ram: 'DDR4', formato: 'Micro-ATX', precioRefCOP: 520000 },
    { tipo: 'RAM', nombre: 'Corsair Vengeance 32GB (2x16GB) 6000MHz', tipoRam: 'DDR5', precioRefCOP: 480000 },
    { tipo: 'RAM', nombre: 'Kingston Fury Beast 16GB (2x8GB) 3200MHz', tipoRam: 'DDR4', precioRefCOP: 210000 },
    { tipo: 'GPU', nombre: 'AMD Radeon RX 6600 8GB', vram: '8GB', consumoW: 132, precioRefCOP: 950000 },
    { tipo: 'GPU', nombre: 'NVIDIA GeForce RTX 4060 8GB', vram: '8GB', consumoW: 115, precioRefCOP: 1350000 },
    { tipo: 'Almacenamiento', nombre: 'SSD NVMe Kingston NV2 1TB PCIe 4.0', interfaz: 'M.2 NVMe', precioRefCOP: 260000 },
    { tipo: 'Fuente', nombre: 'Corsair CX650 650W 80+ Bronze', watts: 650, precioRefCOP: 290000 },
    { tipo: 'Refrigeración', nombre: 'Cooler Master Hyper 212 Black', soporte: 'AM4/AM5/LGA1700', precioRefCOP: 160000 },
    { tipo: 'Chasis', nombre: 'Iceberg Glacius V2 Mesh ATX', formato: 'ATX / Micro-ATX', precioRefCOP: 230000 }
];

const BUILD_QUESTION = '¿Quieres que consulte los precios actuales de tu cotización en tiendas como Mercado Libre y Amazon?';

const SYSTEM_INSTRUCTION = `
Eres la IA oficial de PCrafter (creado por Juan Diego Ruiz Correa y Nicolás Buitrón Bolaños).
Responde siempre en español, de forma directa y breve: ve al punto, sin introducciones ni relleno. Usa listas cortas y no uses tablas. Solo alarga la respuesta si el usuario pide detalle.

REGLA DE DATOS: nunca inventes precios, tiendas, enlaces ni especificaciones. Los precios del catálogo (precioRefCOP) son solo de REFERENCIA y pueden estar desactualizados: cuando los uses di "precio de referencia" y jamás los presentes como actuales. Tú no ves precios en tiempo real en esta conversación; si el usuario los pide, ofrece consultarlos con la pregunta de abajo.

1. EXPERTO EN HARDWARE DE PC: Si el usuario pide armar un PC o evaluar compatibilidad, usa presupuestos en pesos colombianos (COP) y revisa siempre compatibilidad de Socket (AM5 con DDR5, AM4 con DDR4), formato de placa/chasis, soporte del cooler y consumo en Watts. Catálogo base:
${JSON.stringify(CATALOGO_VERIFICADO)}.
2. ASISTENTE MULTIPROPÓSITO: Responde preguntas de cualquier tema, explica código y resume documentos. Recuerdas la conversación y el armado actual del usuario (si hay uno), así que puedes modificarlo cuando lo pida. El campo "titulo" del JSON es un nombre corto del armado según su uso.

Cuando entregues o modifiques un listado de componentes (un armado), cierra el texto con esta pregunta exacta: "${BUILD_QUESTION}" y DESPUÉS incluye AL FINAL un bloque JSON entre <PC_BUILD> y </PC_BUILD>:
<PC_BUILD>
{
  "titulo": "PC para programar y jugar en 1080p",
  "compatible": true,
  "mensajeCompatibilidad": "Compatible (AM5 + DDR5)",
  "consumoW": 320,
  "cpu": {"nombre": "AMD Ryzen 5 7600", "meta": "Socket: AM5"},
  "mb": {"nombre": "MSI PRO B650M-P", "meta": "Socket: AM5 | RAM: DDR5 | Micro-ATX"},
  "gpu": {"nombre": "AMD Radeon RX 6600 8GB", "meta": "VRAM: 8GB"},
  "ram": {"nombre": "Corsair Vengeance 32GB (2x16GB)", "meta": "Tipo: DDR5 6000MHz"},
  "storage": {"nombre": "Kingston NV2 1TB", "meta": "Interfaz: M.2 NVMe"},
  "psu": {"nombre": "Corsair CX650", "meta": "Capacidad: 650W"},
  "cooler": {"nombre": "Hyper 212 Black", "meta": "Soporte: AM5"},
  "case": {"nombre": "Iceberg Glacius V2", "meta": "Formato: ATX"}
}
</PC_BUILD>`;

// Cuando la búsqueda está activa pero no es una consulta de precios del armado
const SEARCH_NOTE = `
BÚSQUEDA ACTIVADA: usa Google Search y prioriza páginas oficiales y tiendas/medios reconocidos. Si das un precio, que sea SOLO uno que aparezca en los resultados, con el nombre de la tienda; si no aparece, dilo. Nunca des precios de memoria.`;

const PRICE_INSTRUCTION = `
Eres el verificador de precios de PCrafter. Tienes Google Search y lectura de páginas (URL context).
Recibirás un armado de PC. Para CADA componente busca el precio ACTUAL de ese modelo exacto en tiendas reconocidas disponibles para Colombia: Mercado Libre Colombia (mercadolibre.com.co), Amazon (amazon.com), Alkosto, Ktronix, Falabella, Éxito, Newegg, B&H, Best Buy. Abre la página del producto y lee el precio que aparece en ella.

REGLAS ESTRICTAS:
1. Nunca inventes, estimes, redondees, conviertas de moneda ni recuerdes precios de memoria. Solo reporta lo que leíste en una página en ESTA consulta.
2. Reporta el precio tal como lo muestra la tienda y en su moneda original (COP, USD, etc.), como número sin símbolos ni separadores de miles.
3. Cada oferta debe traer la URL exacta de la página del producto donde viste el precio (https, de una de las tiendas anteriores). No uses páginas de listados ni buscadores.
4. Entrega hasta 3 ofertas por componente, de tiendas distintas, priorizando el menor precio. El producto debe ser el mismo modelo.
5. Si no puedes confirmar el precio de un componente, no pongas ninguna oferta para él.
6. Condición: "nuevo", "usado" o "reacondicionado" según la publicación.

FORMATO DE RESPUESTA: responde SOLO con un arreglo JSON entre <PRECIOS> y </PRECIOS>, sin ningún otro texto:
<PRECIOS>
[{"componente":"cpu","producto":"título exacto de la publicación","precio":890000,"moneda":"COP","url":"https://...","condicion":"nuevo"}]
</PRECIOS>
Los valores válidos de "componente" son: cpu, mb, gpu, ram, storage, psu, cooler, case.`;

// --------------------------------------------------------------------------
// Utilidades de entrada
// --------------------------------------------------------------------------
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

function parseJsonField(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function sanitizeHistory(raw) {
    const items = parseJsonField(raw, []);
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const it of items.slice(-10)) {
        const role = it && it.role === 'model' ? 'model' : it && it.role === 'user' ? 'user' : null;
        const text = clip(it && it.text, 4000).trim();
        if (!role || !text) continue;
        if (!out.length && role !== 'user') continue;                  // debe empezar con el usuario
        if (out.length && out[out.length - 1].role === role) continue; // roles alternados
        out.push({ role, text });
    }
    if (out.length && out[out.length - 1].role === 'user') out.pop(); // el último turno es el mensaje nuevo
    return out;
}

function sanitizeBuild(raw) {
    const b = parseJsonField(raw, null);
    if (!b || typeof b !== 'object') return null;
    const clean = { titulo: clip(b.titulo, 80), compatible: b.compatible !== false, mensajeCompatibilidad: clip(b.mensajeCompatibilidad, 120), consumoW: Number(b.consumoW) || 0 };
    let any = false;
    for (const k of PART_KEYS) {
        if (b[k] && b[k].nombre) { clean[k] = { nombre: clip(b[k].nombre, 120), meta: clip(b[k].meta, 120) }; any = true; }
    }
    return any ? clean : null;
}

async function fileToContent(file) {
    if (!file) return null;
    const isPdf = file.mimetype === 'application/pdf';
    const isDocx = file.originalname.toLowerCase().endsWith('.docx');
    if (isPdf) return { inlineData: { data: file.buffer.toString('base64'), mimeType: 'application/pdf' } };
    if (isDocx) {
        const extracted = await mammoth.extractRawText({ buffer: file.buffer });
        return { text: `Contenido del documento Word (${file.originalname}):\n${extracted.value.slice(0, MAX_DOC_CHARS)}` };
    }
    throw Object.assign(new Error('Formato no compatible. Sube un PDF o un Word (.docx).'), { status: 400 });
}

// Google devuelve el error como JSON dentro de JSON: se abre para leer el código, los detalles y el tiempo de espera
function parseGoogleError(error) {
    let text = String((error && error.message) || '');
    let node = null;
    for (let i = 0; i < 3; i++) {
        let j;
        try { j = JSON.parse(text); } catch (_) { break; }
        if (!j || !j.error) break;
        node = j.error;
        if (typeof node.message === 'string' && node.message.trim().startsWith('{')) text = node.message; else break;
    }
    const info = { message: (node && node.message) || String((error && error.message) || ''), quotaIds: [], retryMs: null };
    for (const d of (node && node.details) || []) {
        (d.violations || []).forEach((v) => { if (v.quotaId) info.quotaIds.push(v.quotaId); });
        if (d.retryDelay) info.retryMs = parseFloat(d.retryDelay) * 1000;
    }
    return info;
}

const isQuotaError = (error) => Number(error && error.status) === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(String((error && error.message) || ''));

// Medianoche del Pacífico (hora en que Google reinicia las cuotas diarias)
function nextPacificMidnight() {
    const now = new Date();
    const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const next = new Date(la);
    next.setHours(24, 0, 0, 0);
    return new Date(now.getTime() + (next - la));
}

// Cuánto tiempo apartar un modelo que respondió 429: si Google indica espera corta se usa esa; si no, hasta el reinicio diario
function quotaCooldown(error) {
    const info = parseGoogleError(error);
    if (info.retryMs && info.retryMs <= 90000) return { ms: info.retryMs + 1500, daily: false };
    if (info.quotaIds.some((q) => /PerMinute/i.test(q)) && !info.quotaIds.some((q) => /PerDay/i.test(q))) return { ms: 65000, daily: false };
    return { ms: Math.max(60000, nextPacificMidnight() - Date.now()), daily: true };
}

// 'retry' = problema temporal de Google (saturado, red) | 'next' = este modelo no sirve, probar otro | 'fatal' = no insistir
function classify(error) {
    const status = Number(error && (error.status || error.code));
    const msg = String((error && error.message) || '');
    if (error && error.busy) return 'retry';
    if ([401, 403].includes(status) || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return 'fatal';
    if (isQuotaError(error)) return 'quota';
    if ([500, 502, 503, 504].includes(status) || /UNAVAILABLE|overloaded|fetch failed|ECONNRESET|ETIMEDOUT|terminated|socket hang up|Respuesta vac/i.test(msg)) return 'retry';
    if ([400, 404].includes(status)) return 'next';
    return 'fatal';
}

function resetText(resetAt) {
    return new Date(resetAt).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });
}

function friendlyError(error) {
    const status = Number(error && error.status);
    const msg = String((error && error.message) || '');
    if (error && error.quotaExhausted) {
        const when = error.daily ? `Se reinicia hoy a las ${resetText(error.resetAt)} (hora de Colombia).` : 'Vuelve a intentarlo en un minuto.';
        return error.forSearch
            ? `La búsqueda de precios usa Google Search, y tu plan de Gemini no tiene cupo disponible para eso ahora (el plan gratuito casi no lo incluye). ${when} Para quitar el límite activa la facturación del proyecto en Google AI Studio.`
            : `Tu API key de Google AI Studio agotó la cuota de la IA (el plan gratuito tiene topes diarios muy bajos). ${when} Para quitar el límite activa la facturación del proyecto en Google AI Studio.`;
    }
    if (error && error.busy) return error.message;
    if ([401, 403].includes(status) || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return 'La API key de Gemini no es válida o no tiene permiso. Revisa GEMINI_API_KEY en el archivo .env.';
    if (classify(error) === 'retry') return 'Los servidores de IA de Google están saturados en este momento. Probé varias veces y con modelos de respaldo; inténtalo de nuevo en unos segundos.';
    return 'Error en el servidor: ' + (msg || 'desconocido');
}

// Los modelos Gemini 3 usan "thinkingLevel"; para otros se omite para no causar un error 400
const thinkingFor = (model, level) => {
    if (/^gemini-3/i.test(model)) return { thinkingLevel: level };
    if (/^gemini-2\.5-flash/i.test(model)) return { thinkingBudget: level === 'MEDIUM' ? 1024 : 0 }; // sin razonamiento largo = más rápido
    return undefined;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelado')); }, { once: true });
});


// --------------------------------------------------------------------------
// Modelos: se usan los que tu cuenta realmente tiene. Cada modelo se evalúa por separado
// para chat normal y para búsqueda (la búsqueda tiene sus propias cuotas y puede fallar sola).
// --------------------------------------------------------------------------
let candidates = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
const health = new Map();      // "modelo|p" (chat) o "modelo|t" (con búsqueda) -> { fails, until, quota }
const badModels = new Set();   // modelo|modo que respondió 400/404
const FAIL_COOLDOWN_MS = 90 * 1000;

const keyOf = (m, tools) => m + (tools ? '|t' : '|p');
const isHealthy = (m, tools) => { const h = health.get(keyOf(m, tools)); return !h || h.until <= Date.now(); };
const markOk = (m, tools) => health.set(keyOf(m, tools), { fails: 0, until: 0 });
function markFail(m, tools) {
    const k = keyOf(m, tools);
    const h = health.get(k) || { fails: 0, until: 0 };
    h.fails += 1;
    h.quota = false;
    if (h.fails >= 2) h.until = Date.now() + FAIL_COOLDOWN_MS;
    health.set(k, h);
}
const markQuota = (m, tools, ms) => health.set(keyOf(m, tools), { fails: 0, until: Date.now() + ms, quota: true });
const quotaUntil = (m, tools) => { const h = health.get(keyOf(m, tools)); return h && h.quota && h.until > Date.now() ? h.until : 0; };

function orderedModels(tools = false) {
    const base = tools
        ? [...PRICE_MODELS.filter((m) => candidates.includes(m)), ...candidates.filter((m) => !PRICE_MODELS.includes(m))]
        : candidates;
    const usable = base.filter((m) => !badModels.has(keyOf(m, tools)));
    const list = usable.length ? usable : base;
    return [...list.filter((m) => isHealthy(m, tools)), ...list.filter((m) => !isHealthy(m, tools))];
}

const NOT_TEXT_MODELS = /image|tts|audio|live|embed|robot|computer|native|imagen|veo|lyria|aqa|gemma|learnlm|deep-research|customtools|-\d{2}-\d{4}$/i;
const versionOf = (n) => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };

async function discoverModels() {
    const names = [];
    const pager = await ai.models.list();
    for await (const m of pager) {
        const n = String(m.name || '').replace(/^models\//, '');
        if (!/^gemini-/.test(n) || NOT_TEXT_MODELS.test(n)) continue;
        if (m.supportedActions && !m.supportedActions.includes('generateContent')) continue;
        names.push(n);
    }
    return [...new Set(names)];
}

// Se ejecuta al encender el servidor. Solo LISTA modelos (no gasta cuota de la IA).
// Si quieres además una prueba real de cada modelo: STARTUP_PROBE=1 en .env (gasta 1 petición por modelo).
async function startupCheck() {
    let names;
    try {
        names = await discoverModels();
    } catch (e) {
        const st = e && e.status;
        console.warn(`⚠️  No pude consultar tus modelos de Gemini${st ? ' (' + st + ')' : ''}: ${String((e && e.message) || e).slice(0, 140)}`);
        if (st === 400 || st === 401 || st === 403) console.warn('   Revisa que GEMINI_API_KEY en .env sea correcta y esté activa en Google AI Studio.');
        else console.warn('   Si es un problema de internet, el servidor seguirá con los modelos configurados.');
        return;
    }
    const available = new Set(names);
    const preferred = [MODEL, ...FALLBACK_MODELS, ...PRICE_MODELS].filter((m) => available.has(m));
    const extra = names
        .filter((n) => /flash/.test(n) && !preferred.includes(n))
        .sort((a, b) => versionOf(b) - versionOf(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0))
        .slice(0, 2);
    if (!available.has(MODEL)) console.warn(`⚠️  El modelo "${MODEL}" NO aparece en tu cuenta. Modelos Flash que sí tienes: ${names.filter((n) => /flash/.test(n)).join(', ') || '(ninguno)'}`);
    const chain = [...new Set([MODEL, ...preferred, ...extra].filter((m) => available.has(m)))];
    if (chain.length) candidates = chain;

    console.log('Modelos de IA disponibles en tu cuenta (en orden de uso):');
    console.log('   Chat normal :', orderedModels(false).join(' > '));
    console.log('   Con precios :', orderedModels(true).join(' > '), '(se prefieren los que incluyen búsqueda gratis)');

    if (process.env.STARTUP_PROBE === '1') {
        for (const m of orderedModels(false).slice(0, 3)) {
            const t0 = Date.now();
            try {
                const config = { maxOutputTokens: 64 };
                const th = thinkingFor(m, 'LOW'); if (th) config.thinkingConfig = th;
                await ai.models.generateContent({ model: m, contents: 'Responde solo: ok', config });
                markOk(m, false);
                console.log(`   ✓ ${m.padEnd(26)} responde en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
            } catch (e) {
                console.log(`   ✗ ${m.padEnd(26)} falló (${e && e.status || 'sin código'}): ${parseGoogleError(e).message.slice(0, 90)}`);
                if (isQuotaError(e)) markQuota(m, false, quotaCooldown(e).ms);
            }
        }
    }
}

// Cola: con muchos usuarios a la vez, atiende hasta MAX_CONCURRENT y deja esperar al resto
function makeLimiter(max, maxQueue) {
    let active = 0;
    const queue = [];
    return {
        full: () => active >= max,
        acquire(signal) {
            if (active < max) { active++; return Promise.resolve(); }
            if (queue.length >= maxQueue) return Promise.reject(Object.assign(new Error('Hay demasiados usuarios usando PCrafter ahora mismo. Inténtalo de nuevo en un momento.'), { status: 503, busy: true }));
            return new Promise((resolve, reject) => {
                const entry = { go: () => { active++; resolve(); } };
                queue.push(entry);
                signal.addEventListener('abort', () => {
                    const i = queue.indexOf(entry);
                    if (i !== -1) { queue.splice(i, 1); reject(new Error('cancelado')); }
                }, { once: true });
            });
        },
        release() { active--; const next = queue.shift(); if (next) next.go(); }
    };
}
const limiter = makeLimiter(MAX_CONCURRENT, MAX_QUEUE);

// --------------------------------------------------------------------------
// Armado entregado por la IA -> se completa con precios de REFERENCIA del catálogo.
// Los números salen del catálogo, nunca de lo que escriba la IA.
// --------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const TYPE_BY_KEY = { cpu: 'CPU', mb: 'Placa Base', gpu: 'GPU', ram: 'RAM', storage: 'Almacenamiento', psu: 'Fuente', cooler: 'Refrigeración', case: 'Chasis' };
const CATALOG_INDEX = CATALOGO_VERIFICADO.map((c) => ({ key: norm(c.nombre), tipo: c.tipo, price: c.precioRefCOP }));

function refPrice(key, nombre) {
    const n = norm(nombre);
    if (n.length < 5) return null;
    const same = CATALOG_INDEX.filter((c) => c.tipo === TYPE_BY_KEY[key]);
    const hit = same.find((c) => c.key === n) || same.filter((c) => c.key.includes(n)).sort((a, b) => a.key.length - b.key.length)[0];
    return hit ? hit.price : null;
}

function buildFromText(fullText) {
    const m = /<PC_BUILD>([\s\S]*?)<\/PC_BUILD>/i.exec(fullText);
    if (!m) return null;
    const raw = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const b = sanitizeBuild(raw);
    if (!b) return null;
    let total = 0, all = true, any = false;
    for (const k of PART_KEYS) {
        if (!b[k]) continue;
        any = true;
        const p = refPrice(k, b[k].nombre);
        if (p == null) all = false; else total += p;
    }
    b.totalRefCOP = any && all ? total : null;
    return b;
}

// Búsqueda web para mensajes normales: solo si el texto lo pide
const SEARCH_INTENT = /\b(busca(r|me)?|b[uú]squeda|enlaces?|links?|url|p[aá]gina oficial|sitio oficial|descarga(r)?|noticias?|[uú]ltim[oa]s?|lanzamientos?|rese[ñn]as?|reviews?|benchmarks?|precios?|cu[aá]nto (cuesta|vale)|d[oó]nde (comprar|consigo))\b/i;

// Extrae el arreglo JSON de la respuesta de precios
function extractPriceItems(text) {
    let body = text;
    const tagged = /<PRECIOS>([\s\S]*?)<\/PRECIOS>/i.exec(text);
    if (tagged) body = tagged[1];
    body = body.replace(/```(?:json)?/gi, '').trim();
    const a = body.indexOf('['), z = body.lastIndexOf(']');
    if (a === -1 || z <= a) return [];
    try { const arr = JSON.parse(body.slice(a, z + 1)); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
}

// --------------------------------------------------------------------------
// POST /api/chat  ->  Server-Sent Events
// Eventos: usage, status, chunk, prices, searchEntry, done, error
// --------------------------------------------------------------------------
app.post('/api/chat', upload.single('file'), async (req, res) => {
    // 1) Sesión verificada
    let user;
    try {
        const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
        user = await verifyFirebaseToken(token);
    } catch (error) {
        return res.status(error.status || 401).json({ error: error.message });
    }

    const message = clip(req.body.message, 8000);
    const wantsPrices = req.body.prices === '1';
    const history = sanitizeHistory(req.body.history);
    const build = sanitizeBuild(req.body.build);

    // 2) Validaciones antes de gastar un mensaje del límite diario
    let fileContent;
    try { fileContent = await fileToContent(req.file); } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }

    if (wantsPrices && !build) {
        return res.status(400).json({ error: 'Primero pídeme un armado de PC para poder consultar sus precios.' });
    }

    const usage = messageCounter.take(user.uid);
    if (!usage.allowed) {
        return res.status(429).json({ error: `Has alcanzado tu límite de ${DAILY_LIMIT} mensajes diarios. Tu contador se reiniciará mañana.`, usage });
    }
    if (wantsPrices) {
        const p = priceCounter.take(user.uid);
        if (!p.allowed) {
            return res.status(429).json({ error: `Hoy ya hiciste ${PRICE_DAILY_LIMIT} consultas de precios. Se reinicia mañana (cada consulta usa búsqueda en tiendas).`, usage });
        }
    }

    const useSearch = wantsPrices || SEARCH_INTENT.test(message);

    // 3) Contenido para Gemini: historial + armado actual + mensaje nuevo
    const contents = history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
    const lastParts = [];
    if (fileContent) lastParts.push(fileContent);

    if (wantsPrices) {
        lastParts.push({ text: `Armado a cotizar (JSON): ${JSON.stringify(build)}\nConsulta ahora los precios actuales de cada componente.` });
    } else {
        const ctx = build ? `Armado actual del usuario (JSON): ${JSON.stringify(build)}\n\n` : '';
        lastParts.push({ text: ctx + (message || 'Analiza el documento adjunto.') });
    }
    contents.push({ role: 'user', parts: lastParts });

    // 4) Respuesta en streaming
    res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, wantsPrices ? 240000 : useSearch ? 150000 : 80000);
    const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 8000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const send = (payload) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
    send({ t: 'usage', usage });

    let slot = false;       // ¿tengo turno en la cola?
    let produced = false;   // ¿ya se envió texto al usuario? (entonces no se puede reintentar sin duplicarlo)

    const refund = () => {
        messageCounter.refund(user.uid);
        if (wantsPrices) priceCounter.refund(user.uid);
        send({ t: 'usage', usage: messageCounter.peek(user.uid) });
    };

    try {
        if (limiter.full()) send({ t: 'status', text: 'Hay varios usuarios usando PCrafter. Tu mensaje está en cola...' });
        await limiter.acquire(controller.signal);
        slot = true;

        const baseConfig = {
            systemInstruction: wantsPrices ? PRICE_INSTRUCTION : SYSTEM_INSTRUCTION + (useSearch ? SEARCH_NOTE : ''),
            maxOutputTokens: wantsPrices ? 4096 : MAX_OUTPUT_TOKENS,
            abortSignal: controller.signal
        };
        if (wantsPrices) baseConfig.tools = [{ googleSearch: {} }, { urlContext: {} }];
        else if (useSearch) baseConfig.tools = [{ googleSearch: {} }];

        if (wantsPrices) send({ t: 'status', text: 'Buscando precios actuales en tiendas reconocidas. Puede tardar un minuto.' });
        else if (useSearch) send({ t: 'status', text: 'Buscando en internet...' });

        // Plazos por intento: si un modelo no entrega texto a tiempo, se corta y se pasa al siguiente
        const FIRST_TOKEN_MS = (Number(process.env.FIRST_TOKEN_SECONDS) || 0) * 1000 || (wantsPrices ? 70000 : useSearch ? 45000 : 20000);
        const IDLE_MS = wantsPrices ? 70000 : useSearch ? 45000 : 30000;

        // Una ejecución completa contra un modelo; lo que falle aquí se puede reintentar si aún no se mostró nada
        const runModel = async (model) => {
            const attempt = new AbortController();
            let attemptTimedOut = false;
            let timer = null;
            const onClientAbort = () => attempt.abort();
            controller.signal.addEventListener('abort', onClientAbort, { once: true });
            const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { attemptTimedOut = true; attempt.abort(); }, ms); };
            arm(FIRST_TOKEN_MS);

            try {
                const config = { ...baseConfig, abortSignal: attempt.signal };
                const thinking = thinkingFor(model, wantsPrices ? 'MEDIUM' : THINKING_LEVEL);
                if (thinking) config.thinkingConfig = thinking;

                const stream = await ai.models.generateContentStream({ model, contents, config });
                const out = { model, fullText: '', groundingChunks: [], searchEntry: '', retrieved: new Set() };

                for await (const chunk of stream) {
                    arm(IDLE_MS); // llegó algo: se reinicia el plazo entre fragmentos
                    const text = chunk.text;
                    if (text) {
                        out.fullText += text;
                        if (!wantsPrices) { produced = true; send({ t: 'chunk', text }); } // en precios no se muestra texto de la IA
                    }
                    const cand = chunk.candidates && chunk.candidates[0];
                    const g = cand && cand.groundingMetadata;
                    if (g && g.groundingChunks && g.groundingChunks.length) out.groundingChunks = g.groundingChunks;
                    if (g && g.searchEntryPoint && g.searchEntryPoint.renderedContent) out.searchEntry = g.searchEntryPoint.renderedContent;
                    const um = cand && cand.urlContextMetadata && cand.urlContextMetadata.urlMetadata;
                    if (um) um.forEach((u) => {
                        if (u.retrievedUrl && /SUCCESS/.test(u.urlRetrievalStatus || '')) out.retrieved.add(normUrl(u.retrievedUrl));
                    });
                }
                if (!out.fullText.trim()) throw Object.assign(new Error('Respuesta vacía del modelo'), { status: 503 });
                return out;
            } catch (err) {
                if (attemptTimedOut) throw Object.assign(new Error(`sin respuesta en ${Math.round((produced ? IDLE_MS : FIRST_TOKEN_MS) / 1000)} s`), { status: 504, attemptTimeout: true });
                throw err;
            } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', onClientAbort);
            }
        };

        // Orden: los modelos sanos primero (para precios, los que incluyen búsqueda gratis). Un 503 rápido se
        // reintenta una vez; un modelo colgado se salta; un modelo sin cuota se aparta hasta que Google la reinicie.
        const tools = wantsPrices || useSearch;
        const queue = orderedModels(tools);
        const quickRetried = new Set();
        const outcomes = [];
        let quotaResetAt = 0;
        let quotaDaily = false;
        let result = null;
        let lastError = null;
        let attempts = 0;

        while (queue.length && !result) {
            const model = queue.shift();

            const blockedUntil = quotaUntil(model, tools);
            if (blockedUntil) { // ya sabemos que no tiene cuota: no se le vuelve a preguntar a Google
                outcomes.push('quota');
                quotaResetAt = Math.max(quotaResetAt, blockedUntil);
                quotaDaily = quotaDaily || blockedUntil - Date.now() > 120000;
                continue;
            }

            if (attempts > 0) await sleep(600 + Math.random() * 300, controller.signal);
            attempts += 1;
            const t0 = Date.now();

            try {
                result = await runModel(model);
                markOk(model, tools);
                console.log(`✓ ${model} respondió en ${((Date.now() - t0) / 1000).toFixed(1)} s${attempts > 1 ? ' (tras ' + (attempts - 1) + ' intento(s) fallido(s))' : ''}`);
            } catch (err) {
                lastError = err;
                if (controller.signal.aborted || produced) throw err;
                const kind = classify(err);
                const ms = Date.now() - t0;
                const detail = parseGoogleError(err).message.replace(/\s+/g, ' ').slice(0, 110);
                console.warn(`⚠️  ${model}${tools ? ' (con búsqueda)' : ''} ${kind === 'quota' ? 'sin cuota (429)' : 'falló'} tras ${(ms / 1000).toFixed(1)} s [${err.status || 'sin código'}]: ${detail}`);
                if (kind === 'fatal') throw err;

                if (kind === 'quota') {
                    const cd = quotaCooldown(err);
                    markQuota(model, tools, cd.ms);
                    outcomes.push('quota');
                    quotaResetAt = Math.max(quotaResetAt, Date.now() + cd.ms);
                    quotaDaily = quotaDaily || cd.daily;
                } else if (kind === 'next') {
                    badModels.add(keyOf(model, tools));
                    outcomes.push('next');
                } else {
                    markFail(model, tools);
                    outcomes.push('retry');
                    if (!err.attemptTimeout && ms < 4000 && !quickRetried.has(model)) { quickRetried.add(model); queue.unshift(model); }
                }
                if (queue.length && queue[0] !== model) send({ t: 'status', text: `Probando con otro modelo (${queue[0]})...` });
            }
        }

        if (!result) {
            // Si lo único que falló fue la cuota, se explica el motivo real y cuándo se reinicia
            if (outcomes.includes('quota') && !outcomes.includes('retry')) {
                throw Object.assign(new Error('Cuota agotada'), { quotaExhausted: true, daily: quotaDaily, resetAt: quotaResetAt, forSearch: tools });
            }
            throw lastError || new Error('Sin respuesta');
        }

        const { fullText, groundingChunks, searchEntry, retrieved } = result;

        if (wantsPrices) {
            send({ t: 'status', text: 'Verificando los precios contra las páginas de las tiendas...' });
            const items = extractPriceItems(fullText);
            const keys = PART_KEYS.filter((k) => build[k]);
            const { offers, dropped } = await validateOffers({ items, buildKeys: keys, retrievedUrls: retrieved, strict: PRICE_STRICT });
            const summary = summarize(offers, keys);
            send({
                t: 'prices',
                data: { consultado: new Date().toISOString(), porComponente: summary.byPart, totales: summary.totals, faltantes: summary.faltantes, descartados: dropped.length }
            });
        } else {
            const finalBuild = buildFromText(fullText);
            if (finalBuild) send({ t: 'build', data: finalBuild });
        }

        if (searchEntry) send({ t: 'searchEntry', html: searchEntry });

        const searchLinks = wantsPrices ? [] : groundingChunks
            .filter((c) => c.web && c.web.uri && c.web.title)
            .map((c) => ({ title: c.web.title, url: c.web.uri }));
        send({ t: 'done', searchLinks });
    } catch (error) {
        if (timedOut) {
            if (!produced) refund();
            send({ t: 'error', error: wantsPrices || useSearch ? 'La búsqueda tardó demasiado. Inténtalo de nuevo.' : 'La IA tardó demasiado en responder. Inténtalo de nuevo en unos segundos.', retryable: true });
        } else if (!controller.signal.aborted) {
            console.error(`Error en /api/chat (${user.email || user.uid}) [${error && error.status ? error.status : 'sin código'}]:`, error && error.message ? error.message : error);
            if (!produced) refund(); // si la IA no pudo responder, no te cuesta un mensaje
            send({ t: 'error', error: friendlyError(error), retryable: classify(error) === 'retry' });
        }
    } finally {
        if (slot) limiter.release();
        clearTimeout(timeout);
        clearInterval(keepAlive);
        res.end();
    }
});

// Página 404 (al final: solo si ninguna ruta anterior respondió)
app.use((req, res) => {
    res.status(404);
    if (req.accepts('html')) res.sendFile(path.join(__dirname, '404.html'));
    else res.json({ error: 'No encontrado' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ PCrafter listo en http://localhost:${PORT}  (modelo: ${MODEL}, razonamiento: ${THINKING_LEVEL})`);
    if (process.env.SKIP_STARTUP_CHECK !== '1') startupCheck().catch((e) => console.warn('Diagnóstico omitido:', e && e.message));
});

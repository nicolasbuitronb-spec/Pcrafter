// ==========================================================================
// Verificación del token de Firebase (sin dependencias extra).
// El navegador envía "Authorization: Bearer <idToken>"; aquí se comprueba la
// firma con las claves públicas de Google y que el token sea de TU proyecto.
// ==========================================================================
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'pccrafter-16388';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certCache = { certs: null, expires: 0 };

async function getCerts() {
    if (certCache.certs && Date.now() < certCache.expires) return certCache.certs;
    const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('No se pudieron obtener las claves de Google (' + res.status + ')');
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
    certCache = { certs: await res.json(), expires: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
    return certCache.certs;
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// Devuelve { uid, email, name, picture } o lanza un error con status 401
async function verifyFirebaseToken(token) {
    const fail = (msg) => Object.assign(new Error(msg), { status: 401 });
    if (!token || typeof token !== 'string') throw fail('Falta iniciar sesión.');

    const parts = token.split('.');
    if (parts.length !== 3) throw fail('Sesión no válida.');

    let header, payload;
    try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch (_) { throw fail('Sesión no válida.'); }
    if (header.alg !== 'RS256' || !header.kid) throw fail('Sesión no válida.');

    let certs;
    try { certs = await getCerts(); } catch (e) { throw Object.assign(new Error('No se pudo verificar tu sesión ahora. Intenta de nuevo.'), { status: 503 }); }
    const cert = certs[header.kid];
    if (!cert) throw fail('Sesión vencida. Vuelve a iniciar sesión.');

    const ok = crypto.createVerify('RSA-SHA256')
        .update(parts[0] + '.' + parts[1])
        .verify(crypto.createPublicKey(cert), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw fail('Sesión no válida.');

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID || payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw fail('Sesión no válida.');
    if (!payload.sub || payload.exp <= now || payload.iat > now + 60) throw fail('Sesión vencida. Vuelve a iniciar sesión.');

    return { uid: payload.sub, email: payload.email || '', name: payload.name || '', picture: payload.picture || '' };
}

module.exports = { verifyFirebaseToken };

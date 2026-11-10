// ==========================================================================
// PC EN 3D — CSS 3D puro, sin librerías (carga al instante y funciona sin internet).
// Cada pieza que la IA elige aparece en su lugar del chasis, con materiales, luces y cables.
// Arrastra para girar, Ctrl+rueda o botones para acercar, "Vista explosionada" para separar las piezas.
// ==========================================================================

const PART_KEYS = ['cpu', 'mb', 'gpu', 'ram', 'storage', 'psu', 'cooler', 'case'];
const ACCENT = '#5B5BD6';
const PCB = '#2C3E5E';
const DEFAULT_VIEW = { rx: -15, ry: -32 };

// Separación de cada pieza en la vista explosionada [x, y, z]
const EXPLODE = {
    mb: [0, 0, -10], cpu: [0, -8, 44], cooler: [-6, -26, 96], ram: [16, -20, 68],
    gpu: [0, 20, 96], storage: [-8, -22, 40], psu: [-10, 30, 34], case: [0, 0, 0]
};
const GLASS_EXPLODE = [0, 0, 110];

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${clamp255(((n >> 16) & 255) * k)},${clamp255(((n >> 8) & 255) * k)},${clamp255((n & 255) * k)})`;
}

// Materiales
const METAL = 'repeating-linear-gradient(90deg,rgba(255,255,255,.13) 0 1px,rgba(0,0,0,.07) 1px 2px),linear-gradient(135deg,#e2e8f0,#8794a8 45%,#cbd5e1 62%,#64748b)';
const FINS_H = 'repeating-linear-gradient(180deg,#eef2f8 0 1.4px,#7d8aa0 1.4px 3px)';
const FINS_V = 'repeating-linear-gradient(90deg,#eef2f8 0 1.4px,#7d8aa0 1.4px 3px)';
const COPPER = 'linear-gradient(90deg,#92400e,#f59e0b 45%,#b45309)';
const VENT = 'radial-gradient(circle,rgba(0,0,0,.62) 0 1.7px,transparent 2.2px) 0 0/7px 7px,linear-gradient(#27334b,#1a2336)';
const SLEEVE = 'repeating-linear-gradient(90deg,rgba(255,255,255,.09) 0 1px,transparent 1px 3px),#0d1424';

// Luz por orientación de cada cara (se superpone al material)
const LIGHT = {
    top: 'linear-gradient(180deg,rgba(255,255,255,.24),rgba(255,255,255,.04))',
    front: 'linear-gradient(135deg,rgba(255,255,255,.13),rgba(0,0,0,.17))',
    back: 'linear-gradient(rgba(0,0,0,.28),rgba(0,0,0,.38))',
    right: 'linear-gradient(90deg,rgba(255,255,255,.05),rgba(0,0,0,.24))',
    left: 'linear-gradient(90deg,rgba(0,0,0,.24),rgba(255,255,255,.05))',
    bottom: 'linear-gradient(rgba(0,0,0,.38),rgba(0,0,0,.48))'
};

function el(cls, css, parent) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (css) d.style.cssText = css;
    if (parent) parent.appendChild(d);
    return d;
}

// Plano de w×h centrado en (x,y,z); mira hacia +z salvo que se gire con rx/ry
function plane(parent, { w, h, x = 0, y = 0, z = 0, rx = 0, ry = 0, bg, r = 0, cls = '', css = '' }) {
    return el('pl ' + cls,
        `width:${w}px;height:${h}px;margin:${-h / 2}px 0 0 ${-w / 2}px;` +
        `transform:translate3d(${x}px,${y}px,${z}px) rotateX(${rx}deg) rotateY(${ry}deg);` +
        `${bg ? 'background:' + bg + ';' : ''}${r ? 'border-radius:' + r + 'px;' : ''}${css}`, parent);
}

// Caja de w×h×d con 6 caras: material + luz según orientación
function box(parent, { w, h, d, x = 0, y = 0, z = 0, color = '#334155', faces = {}, r = 0 }) {
    const b = el('bx', `transform:translate3d(${x}px,${y}px,${z}px)`, parent);
    const spec = {
        front: [w, h, `translateZ(${d / 2}px)`, 1],
        back: [w, h, `rotateY(180deg) translateZ(${d / 2}px)`, 0.7],
        right: [d, h, `rotateY(90deg) translateZ(${w / 2}px)`, 0.9],
        left: [d, h, `rotateY(-90deg) translateZ(${w / 2}px)`, 0.82],
        top: [w, d, `rotateX(90deg) translateZ(${h / 2}px)`, 1.1],
        bottom: [w, d, `rotateX(-90deg) translateZ(${h / 2}px)`, 0.6]
    };
    for (const [k, [fw, fh, tf, br]] of Object.entries(spec)) {
        el('f', `width:${fw}px;height:${fh}px;margin:${-fh / 2}px 0 0 ${-fw / 2}px;transform:${tf};` +
            `background:${LIGHT[k]},${faces[k] || shade(color, br)};${r ? 'border-radius:' + r + 'px;' : ''}`, b);
    }
    return b;
}

// Ventilador: marco, aspas giratorias, cubo con LED. facing: 'z' (hacia el vidrio), 'x' (frente), 'y' (abajo)
function fan(parent, { d, x, y, z, facing = 'z', frame = false }) {
    const tf = facing === 'x' ? 'rotateY(90deg)' : facing === 'y' ? 'rotateX(90deg)' : '';
    const pos = `transform:translate3d(${x}px,${y}px,${z}px) ${tf}`;
    if (frame) {
        const fr = d + 8;
        plane(parent, { w: fr, h: fr, x, y, z: z - 0.6, bg: '#0b1220', r: 9, css: `box-shadow:inset 0 0 0 2px #334155;${facing === 'x' ? 'transform:translate3d(' + (x - 0.6) + 'px,' + y + 'px,' + z + 'px) rotateY(90deg);' : ''}` });
    }
    const f = el('fan', `width:${d}px;height:${d}px;margin:${-d / 2}px 0 0 ${-d / 2}px;${pos}`, parent);
    el('blades', '', f);
    el('hub', '', f);
    return f;
}

// Sombra de contacto suave sobre la superficie donde está apoyada la pieza
function shadow(parent, { x, y, z, w, h, blur = 5, op = 0.5, rx = 0, ry = 0 }) {
    return plane(parent, { w, h, x, y, z, rx, ry, bg: `rgba(0,0,0,${op})`, r: 5, css: `filter:blur(${blur}px);` });
}

// Tornillo / capacitor / pila: círculo metálico
function dot(parent, { x, y, z, d = 6, bg = 'radial-gradient(circle at 35% 30%,#f1f5f9,#64748b 70%)' }) {
    return plane(parent, { w: d, h: d, x, y, z, bg, r: d / 2 });
}

const text = (b, k) => (b && b[k] && b[k].nombre ? `${b[k].nombre} ${b[k].meta || ''}` : '');
const has = (b, k) => !!(b && b[k] && b[k].nombre);

export function createViewer(root, { labels = {}, onSelect } = {}) {
    const stage = root.querySelector('.viewer-stage');
    const world = root.querySelector('.world');
    const tip = root.querySelector('.viewer-tip');
    const explodeBtn = root.querySelector('[data-zoom="explode"]');

    let build = null;
    let prev = {};
    let rx = DEFAULT_VIEW.rx, ry = DEFAULT_VIEW.ry, fit = 1, zoom = 1;
    let auto = true, visible = true, raf = 0, drag = null, hoverKey = null, exploded = false, vel = 0;
    const t0 = performance.now();

    const apply = () => { world.style.transform = `scale(${fit * zoom}) rotateX(${rx}deg) rotateY(${ry}deg)`; };
    const move = (v) => `translate3d(${v[0]}px,${v[1]}px,${v[2]}px)`;

    function applyExplode() {
        world.querySelectorAll('.slot').forEach((s) => {
            const v = EXPLODE[s.dataset.key] || [0, 0, 0];
            s.style.transform = exploded ? move(v) : '';
        });
        world.querySelectorAll('.sub').forEach((s) => { s.style.transform = exploded ? move(GLASS_EXPLODE) : ''; });
        if (explodeBtn) {
            explodeBtn.setAttribute('aria-pressed', String(exploded));
            const lbl = explodeBtn.querySelector('span');
            if (lbl) lbl.textContent = exploded ? 'Juntar piezas' : 'Vista explosionada';
        }
    }

    // ---------------- Escena ----------------
    function render() {
        const b = build;
        world.replaceChildren();
        const changed = (k) => (has(b, k) ? b[k].nombre !== (prev[k] || '') : false);
        const slot = (k) => {
            const s = el('slot' + (changed(k) ? ' drop' : ''), '', world);
            s.dataset.key = k;
            s.addEventListener('animationend', (e) => { if (e.target === s) s.classList.remove('drop'); });
            return s;
        };
        const bz = -70; // superficie de la placa base

        // ============ Chasis: siempre visible (tenue si aún no hay chasis elegido) ============
        const sh = slot('case');
        plane(sh, { w: 280, h: 290, z: -75, bg: 'radial-gradient(ellipse at 45% 38%,#18253f 0%,#0b1220 74%)', cls: 'edge' });
        [[70, -62, 22, 70], [70, 40, 22, 52], [-10, 129, 92, 14]].forEach(([x, y, w, h]) =>
            plane(sh, { w, h, x, y, z: -74.4, bg: '#04070d', r: 6, css: 'box-shadow:inset 0 0 0 2px #1d2a44;' }));
        plane(sh, { w: 280, h: 150, y: 145, rx: 90, bg: 'linear-gradient(#0f172a,#1d2943)', cls: 'edge' });
        plane(sh, { w: 280, h: 150, y: -145, rx: 90, bg: '#1E293B', cls: 'edge' });
        plane(sh, { w: 190, h: 100, y: -145.5, rx: 90, bg: 'repeating-linear-gradient(90deg,#070b14 0 4px,#1E293B 4px 8px)', css: 'opacity:.9;' });
        // panel trasero (visible al girar): salida de la placa, ranuras PCI y fuente
        plane(sh, { w: 150, h: 290, x: -140, ry: 90, bg: '#1E293B', cls: 'edge' });
        plane(sh, { w: 38, h: 62, x: -140.8, y: -94, z: -50, ry: 90, bg: '#05080f', r: 3 });
        for (let i = 0; i < 7; i++) plane(sh, { w: 44, h: 8, x: -140.8, y: -24 + i * 13, z: -42, ry: 90, bg: 'repeating-linear-gradient(90deg,#05080f 0 2px,#27334b 2px 5px)', r: 2 });
        plane(sh, { w: 92, h: 58, x: -140.8, y: 113, z: -28, ry: 90, bg: 'radial-gradient(circle,#05080f 0 30%,#1b2538 32% 100%)', r: 4 });
        // frente: malla y ventiladores
        plane(sh, { w: 150, h: 290, x: 140, ry: 90, cls: 'mesh' });
        if (has(b, 'case')) {
            [-92, 0, 92].forEach((fy) => fan(sh, { d: 78, x: 131, y: fy, z: 0, facing: 'x', frame: true }));
            plane(sh, { w: 4, h: 262, x: 141, y: 0, z: 70, ry: 90, bg: ACCENT, css: 'box-shadow:0 0 8px rgba(91,91,214,.8);' });
        }
        [[-110, -52], [110, -52], [-110, 52], [110, 52]].forEach(([x, z]) => box(sh, { w: 20, h: 8, d: 20, x, y: 149, z, color: '#05080f', r: 3 }));

        // vidrio templado con reflejos y tornillos (se separa en la vista explosionada)
        const gw = el('sub', '', sh);
        plane(gw, { w: 280, h: 290, z: 75, cls: 'glass' });
        [[-128, -133], [128, -133], [-128, 133], [128, 133]].forEach(([x, y]) => dot(gw, { x, y, z: 75.6, d: 9 }));

        // ============ Placa base ============
        if (has(b, 'mb')) {
            const s = slot('mb');
            const t = text(b, 'mb');
            const atx = !/micro|m-?atx|matx/i.test(t) && /\batx\b/i.test(t);
            const bw = atx ? 190 : 158, bh = 158;
            const left = -118, right = left + bw, top = -125;
            shadow(s, { w: bw + 6, h: bh + 6, x: left + bw / 2 + 3, y: top + bh / 2 + 4, z: bz - 0.4, blur: 4, op: 0.55 });
            plane(s, { w: bw, h: bh, x: left + bw / 2, y: top + bh / 2, z: bz, bg: PCB, r: 3, cls: 'pcb' });
            // cubierta de entradas/salidas (metal cepillado con línea de acento)
            box(s, { w: 22, h: 64, d: 14, x: -107, y: -93, z: bz + 7, color: '#64748b', faces: { front: METAL, top: METAL }, r: 2 });
            plane(s, { w: 3, h: 62, x: -99.5, y: -93, z: bz + 14.4, bg: ACCENT, css: 'box-shadow:0 0 5px rgba(91,91,214,.8);' });
            // zócalo del procesador
            plane(s, { w: 42, h: 42, x: -52, y: -76, z: bz + 0.6, bg: '#1b2740', r: 3, css: 'box-shadow:inset 0 0 0 2px #475569;' });
            plane(s, { w: 28, h: 28, x: -52, y: -76, z: bz + 1.2, bg: '#0b1220', r: 2 });
            // disipadores de la etapa de energía (VRM) con aletas
            box(s, { w: 70, h: 12, d: 18, x: -52, y: -118, z: bz + 9, color: '#475569', faces: { front: FINS_V, top: METAL } });
            box(s, { w: 12, h: 66, d: 18, x: -95, y: -76, z: bz + 9, color: '#475569', faces: { front: FINS_H, top: METAL } });
            // conector de energía de la CPU (EPS) y capacitores
            box(s, { w: 26, h: 8, d: 10, x: -14, y: -123, z: bz + 5, color: '#e2e8f0' });
            [0, 1, 2, 3, 4].forEach((i) => dot(s, { x: -80 + i * 9, y: -41, z: bz + 1, d: 7, bg: 'radial-gradient(circle at 35% 30%,#d6b46a,#6b4f14 70%)' }));
            // ranuras de memoria con seguro
            [-2, 8, 18, 28].forEach((x) => {
                box(s, { w: 6, h: 90, d: 6, x, y: -78, z: bz + 3, color: '#0b1220' });
                plane(s, { w: 6, h: 7, x, y: -125, z: bz + 6.6, bg: '#e2e8f0', r: 1 });
            });
            // ranuras PCIe, ranura M.2 y puertos SATA
            box(s, { w: 104, h: 6, d: 7, x: -60, y: 8, z: bz + 3.5, color: '#0b1220' });
            plane(s, { w: 8, h: 6, x: -8, y: 8, z: bz + 7.2, bg: '#e2e8f0', r: 1 });
            box(s, { w: 46, h: 6, d: 7, x: -83, y: 30, z: bz + 3.5, color: '#0b1220' });
            plane(s, { w: 54, h: 15, x: -62, y: -22, z: bz + 0.6, bg: '#142036', r: 2, css: 'box-shadow:inset 0 0 0 1.5px #3b4a63;' });
            [0, 1, 2, 3].forEach((i) => box(s, { w: 14, h: 6, d: 7, x: right - 14, y: 20 + i * 8, z: bz + 3.5, color: '#27334b' }));
            // chipset con disipador y logo de acento
            box(s, { w: 34, h: 34, d: 10, x: 14, y: 12, z: bz + 5, color: '#475569', faces: { front: FINS_V, top: METAL } });
            plane(s, { w: 12, h: 5, x: 14, y: 12, z: bz + 10.4, bg: ACCENT, r: 1, css: 'box-shadow:0 0 6px rgba(91,91,214,.9);' });
            // conector principal de 24 pines, pila y tornillos
            box(s, { w: 9, h: 54, d: 14, x: right - 8, y: -72, z: bz + 7, color: '#cbd5e1', faces: { front: 'repeating-linear-gradient(180deg,#e2e8f0 0 3px,#94a3b8 3px 4px)' } });
            dot(s, { x: -8, y: 30, z: bz + 1, d: 14 });
            [[left + 5, top + 5], [right - 5, top + 5], [left + 5, top + bh - 5], [right - 5, top + bh - 5], [-52, 38]].forEach(([x, y]) => dot(s, { x, y, z: bz + 0.8, d: 6 }));
        }

        // ============ Procesador ============
        if (has(b, 'cpu')) {
            const s = slot('cpu');
            box(s, { w: 28, h: 28, d: 3, x: -52, y: -76, z: bz + 2.6, color: '#cbd5e1', faces: { front: METAL }, r: 2 });
        }

        // ============ Refrigeración: torre con ventilador o líquida con radiador ============
        if (has(b, 'cooler')) {
            const s = slot('cooler');
            if (/aio|l[ií]quid|radiador|\b(240|280|360)\b/i.test(text(b, 'cooler'))) {
                shadow(s, { w: 44, h: 44, x: -49, y: -73, z: bz + 0.4, blur: 5, op: 0.5 });
                box(s, { w: 38, h: 38, d: 22, x: -52, y: -76, z: -58, color: '#2b3750', faces: { front: 'radial-gradient(circle,#5B5BD6 0 22%,#0b1220 25% 100%)' }, r: 6 });
                box(s, { w: 134, h: 16, d: 44, x: -5, y: -134, z: -30, color: '#475569', faces: { front: FINS_V, bottom: '#1b2538', top: '#334155' } });
                box(s, { w: 6, h: 54, d: 6, x: -64, y: -102, z: -50, color: '#0d1424', faces: { front: SLEEVE }, r: 3 });
                box(s, { w: 6, h: 54, d: 6, x: -44, y: -102, z: -50, color: '#0d1424', faces: { front: SLEEVE }, r: 3 });
                fan(s, { d: 54, x: -35, y: -124, z: -30, facing: 'y' });
                fan(s, { d: 54, x: 25, y: -124, z: -30, facing: 'y' });
            } else {
                shadow(s, { w: 50, h: 86, x: -40, y: -74, z: bz + 0.4, blur: 6, op: 0.55 });
                box(s, { w: 40, h: 100, d: 76, x: -44, y: -80, z: -27, color: '#94A3B8', faces: { front: FINS_H, back: FINS_H, left: FINS_H, top: '#27334b' } });
                box(s, { w: 40, h: 3, d: 76, x: -44, y: -131.5, z: -27, color: '#1b2538', faces: { top: METAL } });
                [-47, -37, -17, -7].forEach((z) => box(s, { w: 5, h: 9, d: 5, x: -44, y: -137, z, color: '#b45309', faces: { front: COPPER, left: COPPER, right: COPPER, top: '#f59e0b' }, r: 2 }));
                fan(s, { d: 70, x: -22, y: -80, z: -27, facing: 'x', frame: true });
            }
        }

        // ============ Memoria RAM con luz ============
        if (has(b, 'ram')) {
            const m = /(\d)\s*x\s*\d+\s*gb/i.exec(text(b, 'ram'));
            const n = m ? parseInt(m[1], 10) : 2;
            const xs = n >= 4 ? [-2, 8, 18, 28] : n === 1 ? [8] : [8, 28];
            const s = slot('ram');
            xs.forEach((x) => {
                shadow(s, { w: 12, h: 92, x: x + 3, y: -77, z: bz + 0.4, blur: 3, op: 0.5 });
                box(s, { w: 6, h: 88, d: 26, x, y: -78, z: bz + 14, color: '#3b4a63', faces: { front: `linear-gradient(90deg,#3b4a63 0 20%,${ACCENT} 20% 80%,#3b4a63 80%)`, top: FINS_V, right: FINS_H, left: FINS_H }, r: 1 });
                plane(s, { w: 3, h: 80, x, y: -78, z: bz + 27.5, bg: '#c7c9ff', css: `box-shadow:0 0 9px 2px rgba(91,91,214,.85);` });
            });
        }

        // ============ Tarjeta gráfica (montaje vertical para que se vean sus ventiladores) ============
        if (has(b, 'gpu')) {
            const s = slot('gpu');
            shadow(s, { w: 156, h: 76, x: -27, y: 32, z: bz + 0.4, blur: 7, op: 0.5 });
            box(s, { w: 150, h: 70, d: 26, x: -30, y: 28, z: -42, color: '#2d3a52', faces: { front: 'linear-gradient(160deg,#41506b,#242f45 70%)', top: '#1b2538', bottom: '#0b1220', back: METAL, left: '#101828' }, r: 3 });
            // facetas angulares del diseño de la cubierta
            plane(s, { w: 150, h: 70, x: -30, y: 28, z: -28.7, bg: 'linear-gradient(150deg,transparent 0 62%,rgba(5,8,15,.55) 62% 100%)' });
            plane(s, { w: 150, h: 3, x: -30, y: -5, z: -28.5, bg: ACCENT, css: 'box-shadow:0 0 8px 1px rgba(91,91,214,.85);' });
            plane(s, { w: 150, h: 2, x: -30, y: 61, z: -28.5, bg: '#5B5BD6', css: 'opacity:.55;' });
            fan(s, { d: 56, x: -68, y: 28, z: -28.4, frame: false });
            fan(s, { d: 56, x: 8, y: 28, z: -28.4, frame: false });
            // conector de alimentación en el borde superior y soporte con puertos de video
            box(s, { w: 22, h: 7, d: 12, x: 28, y: -9, z: -42, color: '#05080f', faces: { front: 'repeating-linear-gradient(90deg,#05080f 0 2px,#1d2a44 2px 4px)' }, r: 1 });
            box(s, { w: 3, h: 70, d: 26, x: -106, y: 28, z: -42, color: '#cbd5e1', faces: { left: METAL, front: METAL, right: METAL } });
            [0, 1, 2, 3].forEach((i) => plane(s, { w: 12, h: 7, x: -107.8, y: 8 + i * 15, z: -42, ry: 90, bg: '#05080f', r: 1 }));
        }

        // ============ Almacenamiento: M.2 con disipador o SSD de 2.5" ============
        if (has(b, 'storage')) {
            const s = slot('storage');
            if (/m\.?2|nvme|pcie/i.test(text(b, 'storage')) || !/sata|2\.5|hdd/i.test(text(b, 'storage'))) {
                box(s, { w: 56, h: 16, d: 5, x: -62, y: -22, z: bz + 3, color: '#475569', faces: { front: FINS_V, top: METAL } });
                plane(s, { w: 40, h: 3, x: -62, y: -22, z: bz + 5.6, bg: ACCENT, css: 'box-shadow:0 0 5px rgba(91,91,214,.8);' });
            } else {
                shadow(s, { w: 70, h: 48, x: 82, y: 142, z: -10, blur: 4, op: 0.5, rx: 90 });
                box(s, { w: 66, h: 6, d: 44, x: 80, y: 141, z: -10, color: '#e2e8f0', faces: { top: 'linear-gradient(135deg,#e2e8f0,#94a3b8)' } });
            }
        }

        // ============ Fuente de poder con vataje y cables ============
        if (has(b, 'psu')) {
            const s = slot('psu');
            shadow(s, { w: 104, h: 96, x: -88, y: 142, z: -28, blur: 7, op: 0.6, rx: 90 });
            const pb = box(s, { w: 100, h: 56, d: 90, x: -88, y: 113, z: -28, color: '#1E293B', faces: { front: VENT, top: '#26334d' }, r: 3 });
            const watts = /(\d{3,4})\s*w/i.exec(text(b, 'psu'));
            const tier = /80\+\s*\w+/i.exec(text(b, 'psu'));
            pb.children[0].innerHTML = `<span class="lbl">${watts ? watts[1] + ' W' : 'PSU'}</span>${tier ? `<span class="lbl-sub">${tier[0]}</span>` : ''}`;
            // cables con funda: 24 pines hacia la placa y PCIe hacia la tarjeta gráfica
            if (has(b, 'mb')) {
                const t = text(b, 'mb');
                const atx = !/micro|m-?atx|matx/i.test(t) && /\batx\b/i.test(t);
                const rx2 = (atx ? 72 : 40) + 7;
                box(s, { w: 100, h: 9, d: 7, x: -50 + 50 - 3, y: 82, z: -46, color: '#0d1424', faces: { front: SLEEVE, top: SLEEVE }, r: 3 });
                box(s, { w: 9, h: 152, d: 7, x: rx2, y: 6, z: -46, color: '#0d1424', faces: { front: SLEEVE, left: SLEEVE }, r: 3 });
                box(s, { w: 16, h: 9, d: 7, x: rx2 - 8, y: -69, z: -57, color: '#0d1424', faces: { front: SLEEVE }, r: 3 });
            }
            if (has(b, 'gpu')) {
                box(s, { w: 7, h: 98, d: 7, x: -113, y: 36, z: -30, color: '#0d1424', faces: { front: SLEEVE, right: SLEEVE }, r: 3 });
                box(s, { w: 148, h: 7, d: 7, x: -39, y: -13, z: -42, color: '#0d1424', faces: { front: SLEEVE, top: SLEEVE }, r: 3 });
            }
        }

        prev = {};
        PART_KEYS.forEach((k) => { if (has(b, k)) prev[k] = b[k].nombre; });
        applyExplode();
        apply();
    }

    // ---------------- Interacción ----------------
    function setHover(key) {
        if (key === hoverKey) return;
        const old = world.querySelector('.slot.is-hover');
        if (old) old.classList.remove('is-hover');
        hoverKey = key;
        if (key) {
            const s = world.querySelector(`.slot[data-key="${key}"]`);
            if (s) s.classList.add('is-hover');
        }
    }

    function showTip(key, e) {
        if (!key || !has(build, key)) { tip.hidden = true; return; }
        const part = build[key];
        tip.replaceChildren();
        const strong = document.createElement('strong');
        strong.textContent = part.nombre;
        const small = document.createElement('span');
        small.textContent = (labels[key] || key) + (part.meta ? ', ' + String(part.meta).replace(/\s*\|\s*/g, ', ') : '');
        tip.append(strong, small);
        const r = root.getBoundingClientRect();
        tip.hidden = false;
        const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8);
        const y = Math.min(e.clientY - r.top + 14, r.height - tip.offsetHeight - 8);
        tip.style.transform = `translate(${Math.max(8, x)}px,${Math.max(8, y)}px)`;
    }

    const slotAt = (e) => {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        return hit && hit.closest ? hit.closest('.slot') : null;
    };

    stage.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, rx, ry, moved: false, lastX: e.clientX };
        auto = false;
        vel = 0;
        stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
        if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
            vel = (e.clientX - drag.lastX) * 0.5;
            drag.lastX = e.clientX;
            ry = drag.ry + dx * 0.5;
            rx = Math.max(-60, Math.min(25, drag.rx - dy * 0.4));
            apply();
            return;
        }
        const s = slotAt(e);
        const key = s ? s.dataset.key : null;
        setHover(key);
        showTip(key, e);
    });
    stage.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved) {
            const s = slotAt(e);
            if (s && has(build, s.dataset.key) && onSelect) onSelect(s.dataset.key);
        }
        drag = null;
        kick(); // la inercia sigue girando un instante tras soltar
    });
    stage.addEventListener('pointerleave', () => { if (!drag) { setHover(null); tip.hidden = true; } });
    stage.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return; // sin Ctrl el scroll sigue moviendo la página
        e.preventDefault();
        zoom = Math.max(0.7, Math.min(2, zoom * (e.deltaY < 0 ? 1.08 : 0.93)));
        apply();
    }, { passive: false });

    // Teclado: flechas giran, + / - acercan, E separa las piezas, Inicio reinicia
    stage.addEventListener('keydown', (e) => {
        const k = e.key;
        const known = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'e', 'E', 'Home'];
        if (!known.includes(k)) return;
        e.preventDefault();
        auto = false;
        if (k === 'ArrowLeft') ry -= 8;
        else if (k === 'ArrowRight') ry += 8;
        else if (k === 'ArrowUp') rx = Math.max(-60, rx - 6);
        else if (k === 'ArrowDown') rx = Math.min(25, rx + 6);
        else if (k === '+' || k === '=') zoom = Math.min(2, zoom * 1.12);
        else if (k === '-' || k === '_') zoom = Math.max(0.7, zoom / 1.12);
        else if (k === 'e' || k === 'E') { exploded = !exploded; applyExplode(); }
        else if (k === 'Home') { reset(); return; }
        apply();
    });

    root.querySelector('[data-zoom="in"]').addEventListener('click', () => { zoom = Math.min(2, zoom * 1.15); apply(); });
    root.querySelector('[data-zoom="out"]').addEventListener('click', () => { zoom = Math.max(0.7, zoom / 1.15); apply(); });
    root.querySelector('[data-zoom="reset"]').addEventListener('click', reset);
    if (explodeBtn) explodeBtn.addEventListener('click', () => { exploded = !exploded; applyExplode(); });

    function reset() {
        rx = DEFAULT_VIEW.rx; ry = DEFAULT_VIEW.ry; zoom = 1; auto = true; vel = 0;
        exploded = false;
        applyExplode();
        apply();
        kick();
    }

    // Giro suave automático hasta que el usuario lo toque; inercia al soltar
    function loop(now) {
        raf = 0;
        if (!visible || document.hidden) return;
        if (auto) {
            ry = DEFAULT_VIEW.ry + 24 * Math.sin((now - t0) / 2600);
            apply();
            raf = requestAnimationFrame(loop);
        } else if (!drag && Math.abs(vel) > 0.03) {
            ry += vel;
            vel *= 0.93;
            apply();
            raf = requestAnimationFrame(loop);
        }
    }
    function kick() { if (!raf && visible) raf = requestAnimationFrame(loop); }

    // Ajuste de tamaño y pausa cuando no se ve
    new ResizeObserver(() => {
        const r = stage.getBoundingClientRect();
        if (r.width) { fit = Math.min(r.width / 385, r.height / 385); apply(); }
    }).observe(stage);
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; kick(); }).observe(root);
    document.addEventListener('visibilitychange', kick);

    apply();
    render();
    kick();

    return {
        update(b) {
            build = b;
            root.classList.toggle('has-build', PART_KEYS.some((k) => has(b, k)));
            root.classList.toggle('no-case', !has(b, 'case'));
            const names = PART_KEYS.filter((k) => has(b, k)).map((k) => b[k].nombre);
            stage.setAttribute('aria-label', (names.length ? 'Modelo 3D de tu PC con ' + names.join(', ') + '. ' : 'Modelo 3D de tu PC. ') + 'Con el teclado: flechas para girar, más y menos para acercar o alejar, la tecla E para separar las piezas.');
            render();
        },
        highlight(key) { setHover(key); },
        reset
    };
}

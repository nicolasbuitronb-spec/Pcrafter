// ==========================================================================
// Arranque de PCrafter (script clásico y mínimo, cargado en todas las páginas)
//  1) Marca la sesión como "pendiente" para no mostrar un parpadeo del login.
//  2) Menú móvil accesible (botón hamburguesa con aria-expanded).
//  3) Diagnóstico: si la aplicación no carga, los botones de entrada lo explican.
// ==========================================================================
(function () {
    'use strict';
    var root = document.documentElement;

    // 1) Sesión pendiente: si Firebase no responde en 2,5 s se muestra el inicio de todos modos
    root.dataset.auth = 'pending';
    setTimeout(function () {
        if (root.dataset.auth === 'pending') root.dataset.auth = 'out';
    }, 2500);

    // 2) Menú móvil
    function setupMenu() {
        var toggles = document.querySelectorAll('.nav-toggle');
        Array.prototype.forEach.call(toggles, function (btn) {
            var menu = document.getElementById(btn.getAttribute('aria-controls'));
            if (!menu) return;
            var label = btn.querySelector('.sr-only');

            function close() {
                menu.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
                if (label) label.textContent = 'Abrir menú';
            }
            btn.addEventListener('click', function () {
                var open = !menu.classList.contains('open');
                menu.classList.toggle('open', open);
                btn.setAttribute('aria-expanded', String(open));
                if (label) label.textContent = open ? 'Cerrar menú' : 'Abrir menú';
            });
            menu.addEventListener('click', function (e) { if (e.target.closest('a')) close(); });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && menu.classList.contains('open')) { close(); btn.focus(); }
            });
            document.addEventListener('click', function (e) {
                if (menu.classList.contains('open') && !e.target.closest('.nav-row')) close();
            });
            window.addEventListener('resize', function () { if (window.innerWidth > 960) close(); });
        });
    }

    // 3) Diagnóstico de carga (solo en la página con el botón de Google)
    var pendingMessage = null;
    function showError(msg) {
        var box = document.getElementById('loginError');
        if (!box) { pendingMessage = msg; return; }
        box.textContent = msg;
        box.classList.remove('hidden');
        if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    }

    window.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t.tagName === 'SCRIPT' && /app\.js(\?|$)/.test(t.src || '')) {
            showError('No se pudo cargar app.js. Reinicia el servidor (Ctrl+C y luego "node server.js") y recarga con Ctrl+F5.');
        }
    }, true);

    document.addEventListener('click', function (e) {
        if (window.__pcrafterReady || !e.target.closest || !e.target.closest('#btnGoogleLogin, #btnNavLogin')) return;
        showError('La aplicación no terminó de cargar. Revisa tu internet (Firebase se descarga de Google), recarga con Ctrl+F5 y, si sigue igual, reinicia el servidor con "node server.js". Detalle en la consola (F12).');
    });

    document.addEventListener('DOMContentLoaded', function () {
        setupMenu();
        if (pendingMessage) showError(pendingMessage);
    });
})();

// ==========================================================================
// Formulario de contacto: validación accesible y envío sin recargar la página.
// Si JavaScript no está disponible, el formulario se envía de forma normal.
// ==========================================================================
(function () {
    'use strict';
    var form = document.getElementById('contact-form');
    if (!form) return;

    var status = document.getElementById('form-status');
    var fields = {
        nombre: document.getElementById('c-nombre'),
        email: document.getElementById('c-email'),
        mensaje: document.getElementById('c-mensaje')
    };

    function show(kind, text) {
        status.className = 'form-status ' + kind;
        status.textContent = text;
    }
    function setError(name, text) {
        var input = fields[name];
        var out = document.getElementById('e-' + name);
        if (out) out.textContent = text || '';
        if (input) {
            if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
        }
    }
    function clearErrors() { Object.keys(fields).forEach(function (n) { setError(n, ''); }); show('', ''); }

    // Mensajes que vienen en la dirección tras un envío sin JavaScript
    var params = new URLSearchParams(window.location.search);
    if (params.get('enviado')) show('ok', 'Gracias. Recibimos tu mensaje y te responderemos pronto.');
    if (params.get('error')) show('bad', 'No pudimos enviar el mensaje. Revisa los datos e inténtalo de nuevo.');

    // Contador de caracteres
    var counter = document.getElementById('c-count');
    fields.mensaje.addEventListener('input', function () { counter.textContent = String(fields.mensaje.value.length); });

    function validate() {
        var errors = {};
        if (fields.nombre.value.trim().length < 2) errors.nombre = 'Escribe tu nombre (mínimo 2 letras).';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fields.email.value.trim())) errors.email = 'Escribe un correo válido, por ejemplo nombre@correo.com.';
        if (fields.mensaje.value.trim().length < 10) errors.mensaje = 'Cuéntanos un poco más (mínimo 10 caracteres).';
        return errors;
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearErrors();
        var errors = validate();
        var names = Object.keys(errors);
        if (names.length) {
            names.forEach(function (n) { setError(n, errors[n]); });
            fields[names[0]].focus();
            show('bad', 'Revisa los campos marcados.');
            return;
        }

        var button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        show('', 'Enviando...');

        fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                token: form.elements.token.value,
                website: form.elements.website.value,
                nombre: fields.nombre.value,
                email: fields.email.value,
                mensaje: fields.mensaje.value
            })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
        }).then(function (r) {
            if (r.ok) {
                form.reset();
                counter.textContent = '0';
                show('ok', 'Gracias. Recibimos tu mensaje y te responderemos pronto.');
                return;
            }
            var errs = (r.data && r.data.errors) || {};
            Object.keys(fields).forEach(function (n) { if (errs[n]) setError(n, errs[n]); });
            show('bad', errs.form || (r.data && r.data.error) || 'No pudimos enviar el mensaje. Revisa los datos e inténtalo de nuevo.');
        }).catch(function () {
            show('bad', 'No hay conexión con el servidor. Inténtalo de nuevo en un momento.');
        }).then(function () { button.disabled = false; });
    });
})();

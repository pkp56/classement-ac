/* Connexion navigateur : cookie HttpOnly, seul le nonce CSRF reste en mémoire. */
(function () {
  'use strict';
  var csrfToken = '';
  var pending = null;
  var nativeFetch = window.fetch.bind(window);
  // Invalider le stockage hérité sans jamais récupérer ses jetons.
  try { localStorage.removeItem('gdsp_admin_token'); sessionStorage.removeItem('gdsp_admin_token'); } catch (e) {}
  function session() {
    if (!pending) pending = nativeFetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { csrfToken = j.authenticated ? j.csrfToken : ''; return j; })
      .finally(function () { pending = null; });
    return pending;
  }
  async function request(input, options) {
    var url = new URL(input, window.location.href);
    var opts = Object.assign({}, options || {});
    // Ne jamais transmettre le nonce ni les identifiants aux domaines externes.
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, opts);
    opts.credentials = 'same-origin';
    var headers = new Headers(opts.headers || {});
    headers.delete('Authorization');
    var method = String(opts.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrfToken) await session();
      if (csrfToken) headers.set('X-GDSP-CSRF', csrfToken);
    }
    if (url.pathname === '/api/admin/login') headers.set('X-GDSP-Session', 'cookie');
    opts.headers = headers;
    var response = await nativeFetch(input, opts);
    if (response.status === 401 || response.status === 403) csrfToken = '';
    if (url.pathname === '/api/admin/login' && response.ok) {
      var login = await response.clone().json();
      csrfToken = login.csrfToken || '';
    }
    if (url.pathname === '/api/admin/logout' && response.ok) csrfToken = '';
    return response;
  }
  window.gdspAuth = { fetch: request, session: session };
})();

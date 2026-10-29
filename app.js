// Serveur GDSP frontend — statique + proxy API vers le backend Render/Neon.
// Pas de variable d'environnement obligatoire : l'URL du backend est celle du
// dépôt gdsp-render-backend déployé, mais elle peut être surchargée par BACKEND_URL
// (ou GDSP_API_URL) si tu redéploies le backend ailleurs.

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 10000);
const BACKEND_URL = (process.env.BACKEND_URL || process.env.GDSP_API_URL || 'https://gdsp-render-backend.onrender.com').replace(/\/+$/,'');
const ROOT = __dirname;

// Fichiers interdits au public
const FORBIDDEN = /(^|\/)(?:\.env|node_modules|\.git|\.github|package\.json|package-lock\.json|README\.md|render\.yaml|\.gitignore|\.gitattributes|app\.js|tests?\/|backups?\/)/i;
app.use((req, res, next) => {
  if (FORBIDDEN.test(req.path)) return res.sendStatus(404);
  next();
});

// --- PROXY API vers le backend gdsp-render-backend ---
function proxyRequest(req, res, opts = {}) {
  let target;
  try { target = new URL(opts.path || req.url, BACKEND_URL); } catch(e) { return res.status(400).end('URL invalide'); }

  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;

  if (opts.method) headers['content-length'] = Buffer.byteLength(opts.body||'');

  const chunks = [];
  const send = (body) => {
    if (body && body.length) headers['content-length'] = body.length;
    const proto = target.protocol === 'https:' ? https : http;
    const upstream = proto.request(target, {
      method: opts.method || req.method,
      headers,
      timeout: 25000,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => { upstream.destroy(new Error('upstream timeout')); });
    upstream.on('error', (e) => {
      console.error('proxy error:', req.method, req.url, '->', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Backend indisponible', detail: e.message });
      else res.end();
    });
    if (body) upstream.write(body);
    upstream.end();
  };

  if (opts.method) {
    // Body provided directly (e.g. reset endpoint)
    send(opts.body);
  } else {
    req.on('data', c => chunks.push(c));
    req.on('end', () => send(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
  }
}

app.all('/api/admin/reset', (req, res) => {
  // Endpoint local de réinitialisation totale. Transmet une sauvegarde vide au backend
  // (upsert) PUIS répond au frontend.
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch {}
    if (body.confirmation !== 'REINIT_CHAMPIONNAT') return res.status(400).json({ error: 'Confirmation manquante.' });
    proxyRequest(req, res, {
      method: 'POST',
      path: '/api/save-championship',
      body: JSON.stringify({ _reset: true, sessions: [], penMap: {}, manualDrivers: null, customCalendar: null, warnings: {}, meta: { resetAt: new Date().toISOString(), resetBy: 'admin' } }),
    });
  });
});
app.all('/api/*', (req, res) => proxyRequest(req, res));
app.all('/health', (req, res) => proxyRequest(req, res));


// Parser JSON (inutile pour /api/* qui est relayé brut, mais au cas où on ajoute des routes locales)
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'JSON trop volumineux.' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'JSON invalide.' });
  next(err);
});

// Point d'entrée HTML
const INDEX_PATH = path.join(ROOT, 'index.html');
let _indexCache = null;
function getIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8')
    .replace(/window\.GDSP_API_URL\s*=\s*window\.GDSP_API_URL\s*\|\|\s*"[^"]*"/g,
             `window.GDSP_API_URL=window.GDSP_API_URL||""`);
}
app.get('/', (_req, res) => {
  if (!_indexCache || process.env.NODE_ENV !== 'production') _indexCache = getIndex();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(_indexCache);
});

// Health check local (Render)
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, service: 'gdsp-frontend', backend: BACKEND_URL });
});

// Fichiers statiques
app.use(express.static(ROOT, {
  dotfiles: 'deny',
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/data\.json$/i.test(filePath)) res.set('Cache-Control', 'no-cache');
    if (/\.html$/i.test(filePath)) res.set('Cache-Control', 'no-cache');
  }
}));

app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(INDEX_PATH);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GDSP frontend démarré sur le port ${PORT}. API proxifiée vers : ${BACKEND_URL}`);
});

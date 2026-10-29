// Serveur GDSP frontend — statique + proxy API vers le backend Render/Neon.
// Pas de variable d'environnement obligatoire : l'URL du backend est celle du
// dépôt gdsp-render-backend déployé, mais elle peut être surchargée par BACKEND_URL
// (ou GDSP_API_URL) si tu redéploies le backend ailleurs.

const express = require('express');
const path = require('path');
const fs = require('fs');

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
// On relaie à la main pour éviter d'ajouter une dépendance (http-proxy-middleware).
// Cela évite les problèmes de CORS et évite d'exposer l'URL du backend dans le HTML.
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'JSON trop volumineux.' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'JSON invalide.' });
  next(err);
});

function proxyReq(req, res) {
  const target = new URL(req.originalUrl, BACKEND_URL);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.referer;
  delete headers.origin;
  delete headers['accept-encoding']; // évite le compressé que node devrait décompresser
  const method = req.method;
  const opts = { method, headers };
  let body;
  if (method !== 'GET' && method !== 'HEAD' && req.body) {
    body = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  const proto = target.protocol === 'https:' ? require('https') : require('http');
  const up = proto.request(target, opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    console.error('proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Backend indisponible.', detail: e.message });
  });
  if (body) up.write(body);
  up.end();
}
app.all('/api/*', proxyReq);
app.all('/health', proxyReq);

// Point d'entrée HTML : aucun besoin d'injecter l'URL backend, le navigateur
// appelle /api/* en relatif et le serveur relaie.
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

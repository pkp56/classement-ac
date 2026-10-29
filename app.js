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
// Implémenté à la main (sans http-proxy-middleware) pour n'ajouter aucune dépendance.
// Body-parser est volontairement DÉSACTIVÉ sur /api/* : on relaie le corps brut pour
// conserver Content-Length et éviter les doubles lectures.
function proxyRequest(req, res) {
  let target;
  try { target = new URL(req.url, BACKEND_URL); } catch(e) { return res.status(400).end('URL invalide'); }

  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  // On laisse Accept-Encoding : les réponses compressées (gzip/br) sont relayées telles quelles.

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    if (body && body.length) headers['content-length'] = body.length;
    const proto = target.protocol === 'https:' ? https : http;
    const upstream = proto.request(target, {
      method: req.method,
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
  });
  req.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
}

// Intercepter TOUTES les méthodes sur /api/* et /health avant le body parser statique.
app.all('/api/*', proxyRequest);
app.all('/health', proxyRequest);

// Parser JSON limité, au cas où on en aurait besoin (aucune route POST hors API,
// mais laisse la place pour de futurs webhooks côté statique ; ici inutilisé).
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

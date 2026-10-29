// Serveur statique minimal pour le site GDSP (Lola T290 International Series).
// Déployable sur Render en service Web statique via Node.
// La persistance métier est assurée par le backend séparé (gdsp-render-backend) ;
// ce serveur ne fait que servir les fichiers et injecter l'URL du backend dans le HTML.

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 10000);
const BACKEND_URL = (process.env.GDSP_API_URL || process.env.BACKEND_URL || '').replace(/\/+$/,'');
const ROOT = __dirname;

// Sécurité : ne jamais servir de .env, node_modules, sources de build, backups, etc.
const FORBIDDEN = /(^|\/)(?:\.env|node_modules|\.git|\.github|package\.json|package-lock\.json|README\.md|render\.yaml|\.gitignore|\.gitattributes|app\.js|tests?\/|backups?\/)/i;
app.use((req, res, next) => {
  if (FORBIDDEN.test(req.path)) return res.sendStatus(404);
  next();
});

// Injection de la configuration backend dans le HTML servi.
// Remplace le marqueur __GDSP_API_URL__ par la valeur de la variable d'env,
// ce qui évite de rebuild l'HTML quand l'URL change (ex: nouveau backend Render).
const INDEX_PATH = path.join(ROOT, 'index.html');
let _indexCache = null;
function getIndex() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  return html.replace(/__GDSP_API_URL__/g, BACKEND_URL || '');
}
app.get('/', (_req, res) => {
  if (!_indexCache || process.env.NODE_ENV !== 'production') _indexCache = getIndex();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(_indexCache);
});

// Health check pour Render.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, service: 'gdsp-frontend', backendConfigured: !!BACKEND_URL });
});

// Fichiers statiques (HTML/CSS/JS/images/JSON).
app.use(express.static(ROOT, {
  dotfiles: 'deny',
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/data\.json$/i.test(filePath)) res.set('Cache-Control', 'no-cache');
    if (/\.html$/i.test(filePath)) res.set('Cache-Control', 'no-cache');
  }
}));

// Redirections de courtoisie pour les routes hash du SPA.
app.get('*', (req, res, next) => {
  // Ne pas intercepter les fichiers évidents (avec extension)
  if (path.extname(req.path)) return next();
  res.sendFile(INDEX_PATH);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GDSP frontend démarré sur le port ${PORT}. Backend configuré : ${BACKEND_URL || '(aucun — lecture seule data/data.json)'}`);
});

'use strict';
// Interface isolée en lecture seule : aucun accès aux fichiers ni processus AC.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assets = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/grid.js': ['grid.js', 'text/javascript; charset=utf-8'],
  '/race-preview.js': ['race-preview.js', 'text/javascript; charset=utf-8'],
  '/entry-preview.js': ['entry-preview.js', 'text/javascript; charset=utf-8'],
  '/samples/result.json': ['samples/result.json', 'application/json; charset=utf-8'],
  '/samples/server_cfg.ini': ['samples/server_cfg.ini', 'text/plain; charset=utf-8'],
  '/samples/entry_list.ini': ['samples/entry_list.ini', 'text/plain; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
});
function handler(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const host = req.headers.host || '';
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(host)) {
    res.writeHead(403); return res.end('Accès local uniquement');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {Allow:'GET, HEAD'}); return res.end();
  }
  const asset = assets[req.url];
  if (!asset) { res.writeHead(404); return res.end('Introuvable'); }
  const body = fs.readFileSync(path.join(__dirname, 'public', asset[0]));
  res.writeHead(200, {'Content-Type': asset[1], 'Content-Length': body.length});
  res.end(req.method === 'HEAD' ? undefined : body);
}
if (require.main === module) {
  const port = Number(process.env.GDSP_MANAGER_PORT || 8780);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port HTTP invalide');
  http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`Gestionnaire local : http://127.0.0.1:${port}`));
}
module.exports = {handler};

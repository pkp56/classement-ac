#!/usr/bin/env node
/*
 * Serveur de développement / aperçu.
 *
 * Sert le site (index.html, assets, data) et simule le backend des événements
 * à partir des fichiers locaux : data/data.json + data/championship.json.
 * Utile pour vérifier l'onglet Circuit sans backend Render.
 *
 *   node tools/preview-server.js            → http://localhost:8080
 *   PORT=3001 node tools/preview-server.js
 *
 * Ce fichier n'est pas utilisé en production (app.js reste le serveur Render).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const SLUG = process.env.PREVIEW_SLUG || 'lola-t290-gdsp-championnat-2026';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const sessions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/data.json'), 'utf8'));
let championship = {};
try {
  championship = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/championship.json'), 'utf8'));
} catch (e) { /* fichier optionnel */ }

const pointsConfig = {
  pointsScale: [41, 38, 35, 32, 30, 28, 26, 24, 22, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  polePoints: 1,
  doubleLongRaces: true,
  longRaceMinutes: 60,
  minPercentDistance: 0.75,
  jokerCount: 5,
  globalCoef: 1.0
};

// Doublons possibles dans data.json (même date/heure/type) → on déduplique.
const seen = new Set();
const dedupedSessions = sessions.filter(s => {
  const key = `${s.date}|${s.type}|${s.track}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const event = {
  slug: SLUG,
  name: 'International Series Lola T290 - GDSP - Championnat',
  kind: 'championship',
  points_config: pointsConfig,
  updated_at: new Date().toISOString(),
  data: {
    sessions: dedupedSessions,
    penMap: {},
    manualDrivers: null,
    customCalendar: null,
    eventInfo: (championship && championship.eventInfo) || {}
  }
};

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/api/events') return json(res, 200, { events: [{ slug: event.slug, name: event.name, kind: event.kind, points_config: pointsConfig, updated_at: event.updated_at }] });
  if (urlPath === '/api/events/' + encodeURIComponent(SLUG)) return json(res, 200, event);
  if (urlPath === '/api/global-exclusions') return json(res, 200, { ids: {} });
  if (urlPath === '/api/championship') return json(res, 200, { championship: { sessions: dedupedSessions, penMap: {} } });
  if (urlPath.startsWith('/api/')) return json(res, 503, { error: 'API non simulée en aperçu' });

  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') filePath = path.join(ROOT, 'index.html');
  else filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, ''));

  fs.readFile(filePath, (err, buf) => {
    if (err || !filePath.startsWith(ROOT)) {
      // Routes SPA : /evenements/<slug> et /evenements/<slug>/circuit
      if (/^\/evenements\/[^/]+(\/circuit)?\/?$/.test(urlPath)) {
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404).end('Not found'); return; }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          res.end(html);
        });
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Aperçu GDSP en ligne sur 0.0.0.0:${PORT} (événement simulé : ${SLUG}, ${dedupedSessions.length} sessions)`);
});

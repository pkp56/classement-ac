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

// --- Relevé de démonstration pour l'aperçu local -----------------------------
// Reprend la forme exacte d'un instantané du collecteur, pour que la page se
// dessine comme en production (classement, écarts, meilleurs tours, fil).
const DEMO = {
  name: 'GDSP · Serveur de démonstration',
  track: 'oesterreichring1979',
  trackConfig: 'chicane',
  session: 'practice',
  drivers: [
    { name: 'Kami_Kaze31', team: 'Scuderia Tolosa', best: 118907, last: 119432, laps: 34 },
    { name: 'TofuSan21', team: 'ECURIE GDSP #2', best: 118995, last: 119201, laps: 58 },
    { name: 'Jim Zplouch8', team: 'Gitane Maïs', best: 119126, last: 120044, laps: 44 },
    { name: 'Kimy Hoyer7', team: 'Ecurie GDSP #1', best: 119963, last: 120311, laps: 25 },
    { name: 'fmherrou10', team: 'FK Racing', best: 120080, last: 120552, laps: 7 },
    { name: 'pikoupok23', team: 'Indépendant #1', best: 120307, last: 121004, laps: 73 },
    { name: 'SuperSlipos42', team: 'Les Bananes Flambées', best: 120448, last: 121330, laps: 29 },
    { name: 'Elouan27', team: 'Erminig Gwenn', best: 120939, last: 121587, laps: 22 }
  ]
};
function fmtDemoMs(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), mm = String(ms % 1000).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${mm}` : `${s}.${mm}`;
}
function demoLiveSnapshot() {
  const now = Date.now();
  const leaderBest = DEMO.drivers[0].best;
  const cars = DEMO.drivers.map((d, i) => {
    const diff = i === 0 ? 0 : d.best - leaderBest;
    const prev = i === 0 ? null : DEMO.drivers[i - 1].best - leaderBest;
    return {
      carId: i, position: i + 1, name: d.name, team: d.team, model: 'actk_lola_t290', skin: '00_gdsp',
      connected: true, laps: d.laps, spline: 0.42, progress: d.laps + 0.42,
      lastLapMs: d.last, lastLap: fmtDemoMs(d.last), bestLapMs: d.best, bestLap: fmtDemoMs(d.best),
      lastLapCuts: 0, bestLapCuts: 0, totalMs: d.best * d.laps,
      gear: 4, rpm: 9100, speedKmh: 226 - i * 2, inPit: i === 6, pitStops: i === 6 ? 1 : 0,
      gapMs: diff, gap: i === 0 ? 'leader' : '+' + fmtDemoMs(diff), gapEstimated: true,
      intervalMs: i === 0 ? null : diff - prev, interval: i === 0 ? '' : '+' + fmtDemoMs(diff - prev),
      lastSeenMs: 120, currentLapMs: 41000 + i * 3000
    };
  });
  return {
    status: { status: 'live', mode: 'demo', listening: true, lastPacketAgoMs: 120, error: null, demo: true },
    server: { name: DEMO.name, track: DEMO.track, trackConfig: DEMO.trackConfig, weather: 'Sol 02 Few Clouds', ambientTemp: 26, roadTemp: 34, protocolVersion: 4, httpClients: cars.length, httpMaxClients: 32, passwordProtected: false },
    session: { type: DEMO.session, name: 'Practice', index: 0, count: 2, laps: 0, timeMinutes: 60, waitTimeMinutes: 0, elapsedMs: 1900000, remainingMs: 1700000, remaining: '28:20.000', elapsed: '31:40.000' },
    cars,
    bestLaps: cars.slice().sort((a, b) => a.bestLapMs - b.bestLapMs).map((c, i) => ({ rank: i + 1, name: c.name, team: c.team, bestLap: c.bestLap, bestLapMs: c.bestLapMs, laps: c.laps })),
    referenceLapMs: leaderBest,
    events: [
      { at: new Date(now - 4000).toISOString(), kind: 'lap', text: 'Kami_Kaze31 — tour 1:59.432' },
      { at: new Date(now - 21000).toISOString(), kind: 'lap', text: 'TofuSan21 — tour 1:58.995' },
      { at: new Date(now - 60000).toISOString(), kind: 'pit', text: 'SuperSlipos42 aux stands' },
      { at: new Date(now - 95000).toISOString(), kind: 'session', text: 'Session practice : Practice' }
    ],
    collisions: [],
    updatedAt: new Date(now).toISOString(),
    serverTimeMs: now
  };
}

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
  // Live timing : en aperçu local on renvoie un relevé « démo » pour que la page
  // /live-timing et le lien du menu soient visibles sans serveur AC ni agent.
  // (Le site réel, lui, lit l'UDP local, l'agent distant ou une source HTTP.)
  if (urlPath === '/api/live/config') return json(res, 200, { enabled: true, push: { enabled: false, endpoint: '/api/live/push' }, udp: { listenPort: 12000, serverPort: 12001 }, httpSources: [], demo: true });
  if (urlPath === '/api/live/status' || urlPath === '/api/live/snapshot') return json(res, 200, demoLiveSnapshot());
  if (urlPath === '/api/championship') return json(res, 200, { championship: { sessions: dedupedSessions, penMap: {} } });
  if (urlPath.startsWith('/api/')) {
    // Écritures de l'administration : on répond « pas en aperçu » explicitement.
    if (req.method !== 'GET') return json(res, 503, { error: 'Aperçu local : les écritures (sauvegarde, imports, comptes) nécessitent le backend.' });
    return json(res, 503, { error: 'API non simulée en aperçu' });
  }

  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') filePath = path.join(ROOT, 'index.html');
  // Même URL que le site en production pour la page de suivi en direct.
  else if (urlPath === '/live-timing' || urlPath === '/live-timing/') filePath = path.join(ROOT, 'live-timing.html');
  // Fiches et onglets du site (routes virtuelles gérées par le JS) : on renvoie
  // l'index comme le fait app.js, pour éviter un 404 en aperçu.
  else if (/^\/(evenements\/[^/]+(\/circuit)?|classement|manches|pilotes|admin)\/?$/.test(urlPath)) filePath = path.join(ROOT, 'index.html');
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
  console.log(`  → page de suivi en direct : http://localhost:${PORT}/live-timing (instantané de démonstration)`);
});

'use strict';
/*
 * Capture enregistrée d'un serveur AC (/INFO + /ENTRY) et outil de capture.
 * Ces tests garantissent qu'une capture est rejouée à l'identique par le site,
 * et qu'elle est TOUJOURS signalée comme une capture (jamais comme du direct).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MirrorHttpSource, RemoteHttpSource } = require('../tools/live-timing/http-source');
const capture = require('../tools/live-timing/capture');

const MIRROR = path.join(__dirname, '..', 'data', 'live-mirror.json');

const CAPTURE = {
  capturedAt: '2026-06-01T12:00:00.000Z',
  sourceUrl: 'http://82.66.165.242:16835',
  info: {
    name: '{GDSP_ Server test 1', track: 'ks_monza66-junior', clients: 1, maxclients: 8,
    port: 16834, cport: 16835, session: 1, sessiontypes: [1, 2], durations: [60, 30], timeleft: 25, pass: false
  },
  entryHtml: `<html><body><h1>Entry List</h1>
    <h2>Session: RACE [Course], TIME LEFT 00:25</h2>
    <table>
      <tr><th>POS</th><th>Driver</th><th>Car</th><th>Team</th><th>Laps</th><th>Time</th><th>Diff</th></tr>
      <tr><td>0</td><td>Leader One</td><td>ks_alfa</td><td>Team A</td><td>12</td><td>18:20:100</td><td></td></tr>
      <tr><td>1</td><td>Second Two</td><td>ks_alfa</td><td>Team B</td><td>12</td><td>18:22:400</td><td>+0:02:300</td></tr>
    </table></body></html>`
};

test('une capture est rejouée comme un classement de course complet', () => {
  const src = new MirrorHttpSource({ data: CAPTURE });
  const snap = src.snapshot(Date.parse('2026-06-01T12:01:00.000Z'));
  assert.equal(snap.cars.length, 2);
  assert.equal(snap.cars[0].name, 'Leader One');
  assert.equal(snap.cars[0].position, 1);
  assert.equal(snap.cars[0].gap, 'leader');
  assert.equal(snap.cars[1].gap, '+2.300');
  assert.equal(snap.cars[0].bestLap, null, 'la feuille de course ne donne pas de meilleur tour');
  assert.equal(snap.server.name, '{GDSP_ Server test 1');
  assert.equal(snap.server.track, 'ks_monza66-junior');
});

test('une capture est annoncée comme telle : mode mirror, jamais live', () => {
  const snap = new MirrorHttpSource({ data: CAPTURE }).snapshot();
  assert.equal(snap.status.mode, 'mirror');
  assert.equal(snap.status.status, 'mirror');
  assert.notEqual(snap.status.status, 'live');
  assert.equal(snap.status.readOnly, true);
  assert.equal(snap.status.live, false);
  assert.match(snap.status.hint, /capture/i);
  assert.ok(snap.status.capturedAt);
});

test('le mode mirror ne réutilise pas le statut « live » du résumé HTTP', () => {
  // Une capture est forcément plus vieille que le seuil de fraîcheur : même
  // très ancienne, elle reste « mirror » et non « offline ».
  const old = Object.assign({}, CAPTURE, { capturedAt: '2020-01-01T00:00:00.000Z' });
  const snap = new MirrorHttpSource({ data: old }).snapshot();
  assert.equal(snap.status.status, 'mirror');
  assert.ok(snap.status.capturedAgoMs > 0);
});

test('le fichier de capture livré est lisible et rejouable', () => {
  assert.ok(fs.existsSync(MIRROR), 'data/live-mirror.json doit exister');
  const snap = new MirrorHttpSource({ file: MIRROR }).snapshot();
  assert.equal(snap.status.mode, 'mirror');
  assert.ok(snap.cars.length >= 1);
  assert.ok(snap.server.track);
});

test('une capture illisible ne casse pas la page (statut hors ligne)', () => {
  const src = new MirrorHttpSource({ file: '/nonexistent/capture.json' });
  const snap = src.snapshot();
  assert.equal(snap.status.status, 'offline');
  assert.equal(snap.status.mode, 'mirror');
  assert.equal(snap.cars.length, 0);
});

test('un lien acstuff.club est reconnu comme source AC (ip + httpPort)', () => {
  assert.equal(
    capture.normalizeSource('https://acstuff.club/s/q:race/online/join?ip=82.66.165.242&httpPort=16835'),
    'http://82.66.165.242:16835'
  );
  assert.equal(capture.normalizeSource('82.66.165.242:16835'), 'http://82.66.165.242:16835');
  assert.equal(capture.normalizeSource('http://82.66.165.242:16835/'), 'http://82.66.165.242:16835');
  assert.equal(capture.normalizeSource('ftp://nope'), null);
  assert.equal(capture.normalizeSource(''), null);
});

test('le serveur de lecture directe reste utilisé quand il répond', () => {
  // Vérifie qu'une source HTTP normale n'hérite pas du mode mirror par erreur.
  const remote = new RemoteHttpSource({ url: 'http://127.0.0.1:1' });
  const snap = remote.snapshot();
  assert.notEqual(snap.status.mode, 'mirror');
  assert.equal(snap.status.mode, 'http-remote');
});

test('le site (app.js) sert la capture quand la lecture directe échoue', async () => {
  // Lance le vrai app.js sur un port libre, avec une capture enregistrée et une
  // source HTTP morte : /api/live/snapshot doit renvoyer la capture, en mode mirror.
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      LIVE_MIRROR_FILE: MIRROR,
      LIVE_HTTP_SOURCES: 'http://127.0.0.1:1',
      LIVE_PUSH_TOKEN: '',
      LIVE_TIMING_ENABLED: '1'
    }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
  try {
    const body = await (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/live/snapshot`);
          if (res.ok) return await res.json();
        } catch (e) { /* pas encore prêt */ }
      }
      throw new Error('le serveur n\'a pas répondu');
    })();
    assert.equal(body.status.mode, 'mirror', 'la capture doit prendre le relais de la source morte');
    assert.equal(body.status.readOnly, true);
    assert.ok(body.cars.length >= 1);
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/live/config`)).json();
    assert.equal(cfg.mirror.enabled, true);
  } finally {
    child.kill('SIGKILL');
  }
});

test('la capture livrée est affichée par défaut (aucune variable à configurer)', async () => {
  // Le site publié doit montrer le serveur sans LIVE_MIRROR_FILE : la capture
  // présente dans data/ est utilisée automatiquement.
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const env = Object.assign({}, process.env, { PORT: String(port), BACKEND_URL: 'http://127.0.0.1:1' });
  delete env.LIVE_MIRROR_FILE;
  delete env.LIVE_HTTP_SOURCES;
  delete env.LIVE_PUSH_TOKEN;
  const child = spawn(process.execPath, ['app.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    let snap = null;
    for (let i = 0; i < 40 && !snap; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/live/status`);
        if (res.ok) snap = await res.json();
      } catch (e) { /* pas prêt */ }
    }
    assert.ok(snap, 'le serveur doit répondre');
    assert.equal(snap.status.mode, 'mirror');
    assert.equal(snap.server.track, 'ks_monza66-junior');
    assert.equal(snap.cars[0].name, "Assassin's Street");
    assert.equal(snap.cars[0].bestLap, '1:15.576');
  } finally {
    child.kill('SIGKILL');
  }
});

test('LIVE_MIRROR_FILE=off désactive la capture', async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), BACKEND_URL: 'http://127.0.0.1:1', LIVE_MIRROR_FILE: 'off' }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
  try {
    let cfg = null;
    for (let i = 0; i < 40 && !cfg; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/live/config`);
        if (res.ok) cfg = await res.json();
      } catch (e) { /* pas prêt */ }
    }
    assert.ok(cfg);
    assert.equal(cfg.mirror.enabled, false);
  } finally {
    child.kill('SIGKILL');
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveHistoryRecorder, FileLiveHistory, sessionSignature } = require('../tools/live-timing/history');

function tmpHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-live-hist-'));
  return new FileLiveHistory(path.join(dir, 'history.json'));
}
function snap(overrides = {}) {
  return {
    server: { name: 'GDSP #1', track: 'oesterreichring1979', trackConfig: null },
    session: { type: 'race', index: 2 },
    cars: [
      { position: 1, name: 'A', model: 'lola', laps: 4, bestLap: '2:06.177', gap: 'leader', connected: true },
      { position: 2, name: 'B', model: 'alfa', laps: 3, bestLap: '2:08.257', gap: '+1:00.0', connected: true }
    ],
    bestLaps: [{ name: 'A', bestLap: '2:06.177' }],
    events: [{ kind: 'lap', text: 'A boucle 2:06.177', at: '2026-11-14T20:00:00Z' }],
    status: { mode: 'push', status: 'live' },
    ...overrides
  };
}

test('une séance s\'ouvre, se met à jour, se ferme au changement de séance', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  await rec.record(snap(), t0);
  await rec.record(snap(), t0 + 5000);
  let list = await store.list();
  assert.equal(list.length, 1, 'une seule séance, mise à jour sur place');
  assert.equal(list[0].track, 'oesterreichring1979');
  assert.equal(list[0].session_type, 'race');
  assert.equal(list[0].drivers, 2);
  assert.equal(list[0].ended_at, null, 'en cours tant qu\'elle est vue');

  // Le serveur passe en qualify : la course se ferme, une nouvelle séance s'ouvre.
  const raceId = list[0].id;
  await rec.record(snap({ session: { type: 'qualify', index: 3 } }), t0 + 60000);
  list = await store.list();
  assert.equal(list.length, 2);
  const closed = list.find(r => r.id === raceId);
  assert.ok(closed.ended_at, 'la course est fermée');
  assert.equal(closed.classification.length, 2);
  assert.equal(closed.classification[0].name, 'A');
  assert.equal(list.find(r => r.id !== raceId).session_type, 'qualify');
});

test('la dernière photo est écrite à la fermeture (la ligne d\'arrivée compte)', async () => {
  const store = tmpHistory();
  // writeIntervalMs énorme : aucune écriture intermédiaire ne doit passer —
  // seule la photo de fermeture peut sauver le dernier tour.
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 60 * 60 * 1000 });
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  await rec.record(snap(), t0);
  // Le dernier instantané de la course : le leader a bouclé un tour de plus.
  const finish = snap();
  finish.cars[0].laps = 5;
  await rec.record(finish, t0 + 500);
  // Puis le serveur passe en practice : la course se ferme.
  await rec.record(snap({ session: { type: 'practice', index: 4 } }), t0 + 1000);
  const list = await store.list();
  const race = list.find(r => r.session_type === 'race');
  assert.equal(race.classification[0].laps, 5, 'le dernier instantané avant fermeture est conservé');
});

test('une capture rejouée (miroir) n\'entre jamais dans l\'historique', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  await rec.record(snap({ status: { mode: 'mirror', status: 'mirror' } }));
  assert.equal((await store.list()).length, 0);
});

test('un instantané vide n\'ouvre pas de séance', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  await rec.record({ server: {}, session: {}, cars: [] });
  await rec.record(null);
  assert.equal((await store.list()).length, 0);
});

test('la signature distingue deux courses du même soir', () => {
  const a = sessionSignature(snap());
  const b = sessionSignature(snap({ session: { type: 'qualify', index: 5 } }));
  const c = sessionSignature(snap({ server: { name: 'GDSP #1', track: 'shuto' } }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, sessionSignature(snap()));
});

// --- routes : l'historique se remplit par le push et se lit publiquement ------

test('routes : un push entre dans l\'historique, lisible par /api/live/sessions', async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-live-routes-'));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_PUSH_TOKEN: 'jeton-test',
      LIVE_TIMING_ENABLED: '1',
      AC_LISTEN_PORT: '0',
      LIVE_MIRROR_FILE: 'off',
      // Historique en fichier temporaire : le test ne touche ni base ni dépôt.
      LIVE_HISTORY_FILE: path.join(dir, 'history.json'),
      DATABASE_URL: '',
      EVENTS_DATABASE_URL: ''
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error('Server exited ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // Vide au départ.
  const empty = await (await fetch(`${base}/api/live/sessions`)).json();
  assert.equal(empty.history, true);
  assert.equal(empty.sessions.length, 0);

  // Deux pushes de la même séance : une seule ligne, mise à jour.
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/live/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-live-token': 'jeton-test' },
      body: JSON.stringify(snap())
    });
    assert.equal(r.status, 200);
  }
  const list = await (await fetch(`${base}/api/live/sessions`)).json();
  assert.equal(list.sessions.length, 1, 'une seule séance, pas une par push');
  const row = list.sessions[0];
  assert.equal(row.track, 'oesterreichring1979');
  assert.equal(row.session_type, 'race');
  assert.equal(row.server_name, 'GDSP #1');

  // Détail : le classement complet est là.
  const detail = await (await fetch(`${base}/api/live/sessions?id=${row.id}`)).json();
  assert.equal(detail.session.id, row.id);
  assert.equal(detail.session.classification[0].name, 'A');
  assert.equal(detail.session.snapshot.server.name, 'GDSP #1');

  // Séance inconnue : 404, pas de page fantôme.
  const missing = await fetch(`${base}/api/live/sessions?id=999`);
  assert.equal(missing.status, 404);
});

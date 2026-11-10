'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const { PushHub, validateSnapshot } = require('../tools/live-timing/push-hub');

function snapshot(overrides = {}) {
  return {
    server: { name: 'GDSP #1', track: 'oesterreichring1979' },
    session: { type: 'practice', elapsed: '1:00.000' },
    cars: [{ carId: 0, name: 'Kami_Kaze31', laps: 2, bestLap: '1:58.907' }],
    bestLaps: [{ name: 'Kami_Kaze31', bestLap: '1:58.907' }],
    events: [],
    status: { mode: 'acsp', status: 'live', host: 'PC-DE-JIM' },
    ...overrides
  };
}

test('Refuse les instantanés malformés', () => {
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot({}).ok, false);
  assert.equal(validateSnapshot({ server: {}, session: {} }).ok, false);
  assert.equal(validateSnapshot({ server: {}, session: {}, cars: 'nope' }).ok, false);
  assert.equal(validateSnapshot({ server: {}, session: {}, cars: [{ carId: 'x', name: 'a' }] }).ok, false);
  assert.equal(validateSnapshot({ server: {}, session: {}, cars: [], events: {} }).ok, false);
  assert.equal(validateSnapshot(snapshot()).ok, true);
});

test('Garde le dernier instantané, le marque frais puis périmé', async () => {
  const hub = new PushHub({ ttlMs: 50 });
  assert.equal(hub.current(), null);
  assert.equal(hub.publish(snapshot()).ok, true);
  const fresh = hub.current();
  assert.equal(fresh.status.status, 'live');
  assert.equal(fresh.status.mode, 'push');
  assert.equal(fresh.status.pushedFrom, 'PC-DE-JIM');
  await new Promise(r => setTimeout(r, 80));
  const stale = hub.current();
  assert.equal(stale.status.status, 'stale');
  assert.equal(stale.status.fresh, false);
  assert.ok(stale.status.receivedAgoMs >= 50);
  assert.equal(stale.server.name, 'GDSP #1');
  // La dernière photo reste disponible pour l'affichage, mais pas indéfiniment.
  hub.receivedAt = Date.now() - 10 * 60 * 1000;
  assert.equal(hub.current(), null);
});

test('HTTP : jeton obligatoire, mise à jour puis lecture par /api/live/status', async t => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_PUSH_TOKEN: 'jeton-test',
      LIVE_TIMING_ENABLED: '1',
      AC_LISTEN_PORT: '0'
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error('Server exited ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  const config = await (await fetch(`${base}/api/live/config`)).json();
  assert.equal(config.push.enabled, true);

  const noToken = await fetch(`${base}/api/live/push`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot())
  });
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`${base}/api/live/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-live-token': 'faux' },
    body: JSON.stringify(snapshot())
  });
  assert.equal(badToken.status, 401);

  const invalid = await fetch(`${base}/api/live/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-live-token': 'jeton-test' },
    body: JSON.stringify({ cars: [] })
  });
  assert.equal(invalid.status, 400);

  const ok = await fetch(`${base}/api/live/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-live-token': 'jeton-test' },
    body: JSON.stringify(snapshot())
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);

  const status = await (await fetch(`${base}/api/live/status`)).json();
  assert.equal(status.status.mode, 'push');
  assert.equal(status.status.status, 'live');
  assert.equal(status.cars[0].name, 'Kami_Kaze31');

  // Les commandes admin ne peuvent pas viser un PC distant.
  const cmd = await fetch(`${base}/api/live/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.ADMIN_PASSWORD || 'x') },
    body: JSON.stringify({ action: 'chat', message: 'coucou' })
  });
  assert.ok([401, 409].includes(cmd.status), 'statut inattendu : ' + cmd.status);
});

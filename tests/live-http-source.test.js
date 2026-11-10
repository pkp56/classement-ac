'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const {
  parseEntryPage, buildStandings, parseAcTime, RemoteHttpSource
} = require('../tools/live-timing/http-source');

// Extrait réaliste d'un /ENTRY d'acServer (essais) : un pilote qui a roulé,
// un deuxième, puis des emplacements vides avec des temps « --:--:--- ».
const PRACTICE_HTML = `<html><body>
<h2>Session: PRACTICE [Essai], TIME LEFT 27:50</h2>
<table>
<tr><th>ID</th><th>Driver</th><th>Car</th><th>Team</th><th>Ping</th><th>Laps</th><th>Last</th><th>Best</th><th>Total</th><th>Guid</th></tr>
<tr><td>1</td><td>Assassin&apos;s Street</td><td>alfa_romeo_giulietta_spider</td><td>ECURIE GDSP #2</td><td>32</td><td>19</td><td>1:19:501</td><td>1:15:576</td><td>29:13:468</td><td>76561198015862674</td></tr>
<tr><td>2</td><td>Kimy Hoyer7</td><td>alfa_romeo_giulietta_spider</td><td>Ecurie GDSP #1</td><td>48</td><td>12</td><td>1:22:100</td><td>1:16:900</td><td>19:02:000</td><td>76561198000000002</td></tr>
<tr><td>3</td><td></td><td>alfa_romeo_giulietta_spider</td><td></td><td>DC</td><td>0</td><td>--:--:---</td><td>--:--:---</td><td>--:--:---</td><td></td></tr>
</table></body></html>`;

// Page /ENTRY en course : les colonnes changent (POS, Time, Diff).
const RACE_HTML = `<html><body>
<p>Session: RACE [Course], TIME LEFT 12:05</p>
<table>
<tr><th>POS</th><th>Driver</th><th>Car</th><th>Team</th><th>Laps</th><th>Time</th><th>Diff</th></tr>
<tr><td>0</td><td>Kami_Kaze31</td><td>actk_lola_t290</td><td>Scuderia Tolosa</td><td>8</td><td>16:15:120</td><td></td></tr>
<tr><td>1</td><td>TofuSan21</td><td>actk_lola_t290</td><td>ECURIE GDSP #2</td><td>8</td><td>16:18:400</td><td>+0:03:280</td></tr>
</table></body></html>`;

test('Convertit les temps Assetto (minutes:secondes:millièmes)', () => {
  assert.equal(parseAcTime('1:15:576'), 75576);
  assert.equal(parseAcTime('29:13:468'), 1753468);
  assert.equal(parseAcTime('+0:03:280'), 3280);
  assert.equal(parseAcTime('1:19:501'), 79501);
  assert.equal(parseAcTime('--:--:---'), null);
  assert.equal(parseAcTime(''), null);
  assert.equal(parseAcTime('2.345'), 2345);
});

test('Lit la feuille de temps d\'un serveur en essais', () => {
  const parsed = parseEntryPage(PRACTICE_HTML);
  assert.equal(parsed.session.type, 'practice');
  assert.equal(parsed.mode, 'practice');
  assert.equal(parsed.cars.length, 2, 'les emplacements vides sont ignorés');
  assert.equal(parsed.cars[0].name, "Assassin's Street");
  assert.equal(parsed.cars[0].team, 'ECURIE GDSP #2');
  assert.equal(parsed.cars[0].laps, 19);
  assert.equal(parsed.cars[0].bestLapMs, 75576);
  assert.equal(parsed.cars[0].lastLapMs, 79501);
  assert.equal(parsed.cars[0].ping, 32);
  const rows = buildStandings(parsed);
  assert.equal(rows[0].name, "Assassin's Street");
  assert.equal(rows[0].bestLap, '1:15.576');
  assert.equal(rows[0].gap, 'leader');
  assert.equal(rows[1].gap, '+1.324'); // 1:16.900 - 1:15.576
  assert.equal(rows[1].gapEstimated, true);
});

test('Lit une page de course (positions et écarts officiels)', () => {
  const parsed = parseEntryPage(RACE_HTML);
  assert.equal(parsed.mode, 'race');
  const rows = buildStandings(parsed);
  assert.deepEqual(rows.map(r => r.name), ['Kami_Kaze31', 'TofuSan21']);
  assert.equal(rows[0].gap, 'leader');
  assert.equal(rows[1].gap, '+3.280');
  assert.equal(rows[0].total, '16:15.120');
});

test('Une entrée sans pilote ni guid n\'apparaît pas', () => {
  const empty = parseEntryPage('<table><tr><th>ID</th><th>Driver</th></tr><tr><td>4</td><td></td></tr></table>');
  assert.equal(empty.cars.length, 0);
  assert.deepEqual(buildStandings(empty), []);
});

test('La source HTTP fabrique un instantané lisible depuis /INFO et /ENTRY', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/INFO') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        name: '{GDSP_ Server test 1', track: 'ks_monza66-junior', clients: 1, maxclients: 8,
        pass: false, port: 16834, cport: 16835, session: 1, sessiontypes: [1, 2, 3],
        durations: [60], timeleft: 1670
      }));
    }
    if (req.url === '/ENTRY') {
      res.setHeader('content-type', 'text/html');
      return res.end(PRACTICE_HTML);
    }
    res.statusCode = 404; res.end('nope');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const source = new RemoteHttpSource({ url: `http://127.0.0.1:${server.address().port}` });
  await source.poll();
  const snap = source.snapshot();
  assert.equal(snap.status.mode, 'http-remote');
  assert.equal(snap.status.status, 'live');
  assert.equal(snap.status.readOnly, true);
  assert.equal(snap.server.name, '{GDSP_ Server test 1');
  assert.equal(snap.server.track, 'ks_monza66-junior');
  assert.equal(snap.server.httpMaxClients, 8);
  assert.equal(snap.session.type, 'practice');
  assert.equal(snap.session.remaining, '27:50.000');
  assert.equal(snap.cars.length, 2);
  assert.equal(snap.bestLaps[0].bestLap, '1:15.576');
});

test('Un serveur injoignable remonte une erreur sans casser l\'instantané', async () => {
  const source = new RemoteHttpSource({ url: 'http://127.0.0.1:1', intervalMs: 60000 });
  await source.poll();
  const snap = source.snapshot();
  assert.equal(snap.status.status, 'offline');
  assert.match(String(snap.status.error), /ECONNREFUSED|HTTP|délai/);
  assert.deepEqual(snap.cars, []);
});


test('Bout en bout : LIVE_HTTP_SOURCES (lien acstuff) alimente /api/live/status?source=', async t => {
  const { spawn } = require('node:child_process');
  const pathm = require('node:path');
  const acServer = http.createServer((req, res) => {
    if (req.url === '/INFO') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        name: '{GDSP_ Server test 1', track: 'ks_monza66-junior', clients: 1, maxclients: 8,
        pass: false, port: 16834, cport: 16835, session: 1, sessiontypes: [1], durations: [60], timeleft: 1650
      }));
    }
    if (req.url === '/ENTRY') return res.end(PRACTICE_HTML);
    res.statusCode = 404; res.end('');
  });
  acServer.listen(0, '127.0.0.1');
  await once(acServer, 'listening');
  t.after(() => acServer.close());
  const acPort = acServer.address().port;

  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));

  // Comme un utilisateur : un lien acstuff (join?ip=…&httpPort=…) en variable d'env.
  const acstuffLink = `https://acstuff.club/s/q:race/online/join?ip=127.0.0.1&httpPort=${acPort}`;
  const child = spawn(process.execPath, ['app.js'], {
    cwd: pathm.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_HTTP_SOURCES: acstuffLink,
      LIVE_HTTP_INTERVAL_MS: '200',
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
  assert.equal(config.httpSources.length, 1);
  assert.equal(config.httpSources[0].url, `http://127.0.0.1:${acPort}`);

  // Premier relevé : on laisse la source faire son premier poll.
  for (let i = 0; i < 20; i++) {
    const snap = await (await fetch(`${base}/api/live/status?source=0`)).json();
    if (snap.status.mode === 'http-remote' && snap.cars.length) {
      assert.equal(snap.server.name, '{GDSP_ Server test 1');
      assert.equal(snap.cars[0].name, "Assassin's Street");
      assert.equal(snap.session.remaining, '27:30.000');
      assert.equal(snap.status.readOnly, true);
      // Les commandes admin sont refusées sur une source publique.
      const cmd = await fetch(`${base}/api/live/command?source=0`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify({ action: 'chat', message: 'test' })
      });
      assert.ok([401, 409].includes(cmd.status));
      return;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  assert.fail('la source HTTP n\'a jamais produit d\'instantané');
});

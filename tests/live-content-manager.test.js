'use strict';
/*
 * Serveur lancé par Content Manager : deux choses doivent être vérifiées.
 *
 * 1. `set-plugin-ports.js` sait ajouter / corriger les deux lignes de plugin UDP
 *    dans un server_cfg.ini, sans toucher au reste et sans casser les CRLF.
 * 2. L'agent, en mode UDp local (= serveur AC sur le même PC, cas Content
 *    Manager), relaie bien jusqu'au site : bout en bout, comme une vraie
 *    session lancée depuis CM.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { patchIni, DEFAULT_LISTEN, DEFAULT_LOCAL } = require('../tools/live-timing/set-plugin-ports');

function tmpIni(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-cfg-'));
  const file = path.join(dir, 'server_cfg.ini');
  fs.writeFileSync(file, content);
  return file;
}

test('ajoute les deux lignes de plugin dans une section [SERVER] sans elles', () => {
  const { text, changes } = patchIni('[SERVER]\nNAME=GDSP\nMAX_CLIENTS=8\n\n[PRACTICE]\nTIME=60\n');
  assert.equal(changes.length, 2);
  assert.match(text, /UDP_PLUGIN_ADDRESS=127\.0\.0\.1:12000/);
  assert.match(text, /UDP_PLUGIN_LOCAL_PORT=12001/);
  // Les lignes doivent être DANS [SERVER], avant [PRACTICE].
  const server = text.slice(text.indexOf('[SERVER]'), text.indexOf('[PRACTICE]'));
  assert.match(server, /UDP_PLUGIN_ADDRESS/);
  assert.match(server, /UDP_PLUGIN_LOCAL_PORT/);
  assert.equal(DEFAULT_LISTEN, '127.0.0.1:12000');
  assert.equal(DEFAULT_LOCAL, '12001');
});

test('corrige des ports déjà présents (CM en a mis d\'autres)', () => {
  const { text, changes } = patchIni('[SERVER]\nUDP_PLUGIN_ADDRESS=127.0.0.1:11000\nUDP_PLUGIN_LOCAL_PORT=11001\n');
  assert.equal(changes.length, 2);
  assert.match(text, /UDP_PLUGIN_ADDRESS=127\.0\.0\.1:12000/);
  assert.match(text, /UDP_PLUGIN_LOCAL_PORT=12001/);
  assert.doesNotMatch(text, /11000/);
  // Une seule occurrence par clé : CM relit le fichier, pas de doublon.
  assert.equal((text.match(/UDP_PLUGIN_ADDRESS/g) || []).length, 1);
});

test('ne touche pas un fichier déjà correct et ne duplique rien', () => {
  const good = `[SERVER]\nNAME=GDSP\nUDP_PLUGIN_ADDRESS=${DEFAULT_LISTEN}\nUDP_PLUGIN_LOCAL_PORT=${DEFAULT_LOCAL}\n\n[RACE]\nTIME=30\n`;
  const { text, changes } = patchIni(good);
  assert.equal(changes.length, 0);
  assert.equal(text, good);
});

test('les autres sections et les fins de ligne CRLF sont préservées', () => {
  const file = tmpIni('[SERVER]\r\nNAME=GDSP\r\nMAX_CLIENTS=8\r\n\r\n[PRACTICE]\r\nTIME=60\r\n');
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'live-timing', 'set-plugin-ports.js'), file], { encoding: 'utf8' });
  assert.match(out, /UDP_PLUGIN_ADDRESS/);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('\r\n'), 'les CRLF doivent rester');
  assert.ok(!/[^\r]\n/.test(raw), 'pas de LF isolé');
  assert.match(raw, /MAX_CLIENTS=8/);
  assert.match(raw, /\[PRACTICE\]/);
  // Sauvegarde créée, une seule fois.
  assert.ok(fs.existsSync(file + '.bak'));
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'live-timing', 'set-plugin-ports.js'), file], { encoding: 'utf8' });
  assert.ok(!fs.readFileSync(file + '.bak', 'utf8').includes('UDP_PLUGIN_ADDRESS'), 'la sauvegarde doit rester l\'original');
});

test('un fichier sans [SERVER] est refusé, sans écriture', () => {
  const { changes, error } = patchIni('[RACE]\nTIME=30\n');
  assert.equal(changes.length, 0);
  assert.match(error, /\[SERVER\]/);
});

test('mode Content Manager : UDP local → agent → site (bout en bout)', async t => {
  // Ports libres pour ne pas gêner un vrai serveur AC sur la machine.
  const freeUdp = async () => new Promise(resolve => {
    const s = require('node:dgram').createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const freeTcp = async () => new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const listenPort = await freeUdp();   // = UDP_PLUGIN_ADDRESS  (le site/agent écoute)
  const pluginPort = await freeUdp();   // = UDP_PLUGIN_LOCAL_PORT (acServer écoute)
  const sitePort = await freeTcp();

  const site = spawn(process.execPath, ['app.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(sitePort), BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_PUSH_TOKEN: 'jeton-cm', LIVE_MIRROR_FILE: 'off'
    },
    stdio: 'ignore'
  });
  const sim = spawn(process.execPath, [path.join('tools', 'live-timing', 'simulate-acserver.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SIM_LISTEN_PORT: String(pluginPort), SIM_TARGET_PORT: String(listenPort), SIM_SPEED: '25' },
    stdio: 'ignore'
  });
  const agent = spawn(process.execPath, [path.join('tools', 'live-timing', 'agent.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, SITE_URL: `http://127.0.0.1:${sitePort}`, PUSH_TOKEN: 'jeton-cm',
      AC_LISTEN_PORT: String(listenPort), AC_PLUGIN_PORT: String(pluginPort), PUSH_INTERVAL_MS: '400'
    },
    stdio: 'ignore'
  });
  t.after(() => { for (const p of [agent, sim, site]) p.kill('SIGKILL'); });

  let snap = null;
  for (let i = 0; i < 60 && !snap; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${sitePort}/api/live/status`);
      if (res.ok) {
        const body = await res.json();
        if (body.status && body.status.status === 'live' && (body.cars || []).length) snap = body;
      }
    } catch (e) { /* pas prêt */ }
  }
  assert.ok(snap, 'le site doit recevoir un direct par l\'agent');
  assert.equal(snap.status.mode, 'push');
  assert.ok(snap.cars.length >= 1);
  assert.ok(snap.cars[0].name);
  // Données complètes de l'UDP (ce que le HTTP ne donne pas).
  assert.ok(snap.cars.some(c => typeof c.speedKmh === 'number'), 'les vitesses doivent être présentes en UDP');
  assert.ok(snap.server.track);
});

test('l\'agent n\'envoie rien quand il n\'y a ni voiture ni session', async t => {
  // Évite de faire croire au site qu'un direct est en cours hors session.
  const port = await new Promise(resolve => {
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const received = [];
  const site = http.createServer((req, res) => {
    received.push(req.url);
    res.statusCode = 200; res.end('{"ok":true}');
  });
  site.listen(port, '127.0.0.1');
  t.after(() => site.close());

  const freeUdp = await new Promise(resolve => {
    const s = require('node:dgram').createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'live-timing', 'agent.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, SITE_URL: `http://127.0.0.1:${port}`, PUSH_TOKEN: 'x',
      // Aucun acServer en face : collector vide.
      AC_LISTEN_PORT: String(freeUdp), AC_PLUGIN_PORT: String(freeUdp + 1), PUSH_INTERVAL_MS: '200'
    },
    stdio: 'ignore'
  });
  t.after(() => agent.kill('SIGKILL'));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(received.filter(u => u === '/api/live/push').length, 0, 'aucun envoi ne doit partir à vide');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { importLocalCircuit, mountLocalCircuitImport } = require('../tools/lib/local-circuits');

const ROOT = path.resolve(__dirname, '..');
const lineData = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/tremblant/line.json'), 'utf8'));

function fastLaneBuffer() {
  const points = lineData.data;
  const buffer = Buffer.alloc(16 + points.length * 20);
  buffer.writeInt32LE(7, 0);
  buffer.writeInt32LE(points.length, 4);
  points.forEach(([x, y, z], index) => {
    const offset = 16 + index * 20;
    buffer.writeFloatLE(x, offset);
    buffer.writeFloatLE(y, offset + 4);
    buffer.writeFloatLE(z, offset + 8);
  });
  return buffer;
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gdsp-local-circuit-'));
  const root = path.join(temp, 'content');
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  async function write(file, data) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.isBuffer(data) ? data : String(data));
    return target;
  }
  return { temp, root, write };
}

async function addCompleteLayout(write, prefix = 'tracks/test-track/gp') {
  await write(`${prefix}/ai/fast_lane.ai`, fastLaneBuffer());
  await write(`${prefix}/data/surfaces.ini`, [
    '[SURFACE_0]', 'KEY=ROAD', 'FRICTION=0.99', 'IS_VALID_TRACK=1',
    '[SURFACE_1]', 'KEY=GRASS', 'FRICTION=0.6', 'IS_VALID_TRACK=0'
  ].join('\n'));
  await write(`${prefix}/overlays.ini`, [
    '[SECTOR_0]', 'START=0', '[SECTOR_1]', 'START=0.4', '[SECTOR_2]', 'START=0.72'
  ].join('\n'));
  await write('tracks/test-track/ui/gp/ui_track.json', JSON.stringify({
    name: 'Test Track GP', layout: 'Grand Prix', country: 'France', city: 'Hillion',
    geographicLocation: '48.5° N · 2.7° W', year: 2026, author: 'GDSP',
    version: '1.0', pitboxes: '24', width: '10 m', run: 'clockwise'
  }));
}

test('la fiche locale réutilise le tracé, les surfaces, les secteurs et les métadonnées du mod', async t => {
  const { root, write } = await fixture(t);
  await addCompleteLayout(write);
  const result = await importLocalCircuit({
    roots: [root], trackId: 'test-track', layoutId: 'gp', name: 'Sélection catalogue',
    date: '2027-04-14', round: 2
  });
  assert.equal(result.source, 'local');
  assert.equal(result.round.round, 2);
  assert.equal(result.round.label, 'M2');
  assert.equal(result.round.name, 'Test Track GP');
  assert.equal(result.round.shortName, 'Test Track GP');
  assert.equal(result.round.driverFolder, 'test-track');
  assert.equal(result.round.layoutId, 'gp');
  assert.equal(result.round.layout, 'Grand Prix');
  assert.equal(result.round.country, 'France');
  assert.equal(result.round.city, 'Hillion');
  assert.equal(result.round.date, '2027-04-14');
  assert.equal(result.round.status, 'upcoming');
  assert.ok(result.round.outline.path.startsWith('M'));
  assert.ok(result.round.profile.path.startsWith('M'));
  assert.ok(result.round.lengthM > 4000);
  assert.equal(result.round.sectorSplits.length, 3);
  assert.equal(result.round.surfaces.find(row => row.key === 'ROAD').grip, 99);
  assert.equal(result.files.line.name, 'gp/ai/fast_lane.ai');
  assert.equal(result.files.ui.name, 'ui/gp/ui_track.json');
  assert.deepEqual(result.warnings, []);
});

test('un mod incomplet ne bloque pas le calendrier et ne fabrique pas une fiche sans fast_lane.ai', async t => {
  const { root, write } = await fixture(t);
  await write('tracks/no-line/ui/ui_track.json', JSON.stringify({ name: 'Circuit sans tracé' }));
  const result = await importLocalCircuit({ roots: [root], trackId: 'no-line', date: '2027-04-14' });
  assert.equal(result.round, null);
  assert.ok(result.warnings.some(w => /fast_lane\.ai absent/.test(w)));
  await assert.rejects(importLocalCircuit({ roots: [root], trackId: '../private' }), /Identifiant de circuit invalide/);
  await assert.rejects(importLocalCircuit({ roots: [root], trackId: 'no-line', date: '2027-02-30' }), /Date invalide/);
});

test('un lien de mod sortant de la racine configurée est ignoré', async t => {
  const { root, temp, write } = await fixture(t);
  const outside = path.join(temp, 'outside-track');
  await fs.mkdir(path.join(outside, 'ai'), { recursive: true });
  await fs.writeFile(path.join(outside, 'ai/fast_lane.ai'), fastLaneBuffer());
  await fs.mkdir(path.join(root, 'tracks'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'tracks/escape'), 'junction');
  const result = await importLocalCircuit({ roots: [root], trackId: 'escape' });
  assert.equal(result.round, null);
  assert.ok(result.warnings.some(w => /Circuit absent/.test(w)));
});

test('API locale authentifiée : absence de tracé signalée sans perdre la réponse calendrier', async t => {
  const { root, write } = await fixture(t);
  await write('tracks/calendar-only/ui/ui_track.json', JSON.stringify({ name: 'Calendrier uniquement' }));
  const app = express();
  app.use(express.json());
  mountLocalCircuitImport(app, {
    roots: [root],
    authorize: async (req, res) => {
      if (req.headers.authorization === 'Bearer test') return true;
      res.status(401).json({ error: 'auth' });
      return false;
    }
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/circuits/import-local`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ trackId: 'calendar-only', date: '2027-04-14', roots: ['/outside'] })
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.round, null);
  assert.ok(result.warnings.some(w => /fast_lane\.ai absent/.test(w)));
});

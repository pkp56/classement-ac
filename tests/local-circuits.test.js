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
    name: 'Test Track GP', layout: 'Grand Prix', country: 'France', countryCode: 'FRA', city: 'Hillion',
    geotags: ['48.5° N', '2.7° W'], year: 2026, author: 'GDSP',
    version: '1.0', pitboxes: '24', width: '10 m', run: 'clockwise',
    description: 'Test <b>track</b><br>Two &amp; corners', tags: ['historic', '<b>F1</b>'],
    length: '4.260 km', url: 'https://example.com/test-track'
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
  assert.equal(result.round.countryCode, 'FRA');
  assert.equal(result.round.city, 'Hillion');
  assert.equal(result.round.gps, '48.5° N · 2.7° W');
  assert.equal(result.round.year, '2026');
  assert.equal(result.round.author, 'GDSP');
  assert.equal(result.round.version, '1.0');
  assert.equal(result.round.width, '10 m');
  assert.equal(result.round.pitboxes, '24');
  assert.equal(result.round.direction, 'clockwise');
  assert.equal(result.round.description, 'Test track\nTwo & corners');
  assert.deepEqual(result.round.tags, ['historic', 'F1']);
  assert.equal(result.round.officialLength, '4.260 km');
  assert.equal(result.round.officialLengthM, 4260);
  assert.equal(result.round.trackUrl, 'https://example.com/test-track');
  assert.equal(result.round.date, '2027-04-14');
  assert.equal(result.round.status, 'upcoming');
  assert.deepEqual(result.round.importWarnings, []);
  assert.ok(result.round.outline.path.startsWith('M'));
  assert.ok(result.round.profile.path.startsWith('M'));
  assert.ok(result.round.lengthM > 4000);
  assert.equal(result.round.sectorSplits.length, 3);
  assert.equal(result.round.surfaces.find(row => row.key === 'ROAD').grip, 99);
  assert.equal(result.files.line.name, 'gp/ai/fast_lane.ai');
  assert.equal(result.files.ui.name, 'ui/gp/ui_track.json');
  assert.deepEqual(result.warnings, []);
});

test('recherche aussi les fichiers techniques rangés dans data/<variante> des mods locaux', async t => {
  const { root, write } = await fixture(t);
  await write('tracks/data-layout/ai/fast_lane.ai', Buffer.from('base layout should not be selected'));
  await write('tracks/data-layout/ai/gp/fast_lane.ai', fastLaneBuffer());
  await write('tracks/data-layout/data/gp/surfaces.ini', '[SURFACE_0]\nKEY=ROAD\nFRICTION=0.99\nIS_VALID_TRACK=1');
  await write('tracks/data-layout/data/gp/overlays.ini', '[SECTOR_0]\nSTART=0\n[SECTOR_1]\nSTART=0.5');
  await write('tracks/data-layout/ui/gp/ui_track.json', JSON.stringify({
    name: 'Circuit variante data', layout: 'GP', country: 'France'
  }));
  const result = await importLocalCircuit({ roots: [root], trackId: 'data-layout', layoutId: 'gp' });
  assert.equal(result.round.name, 'Circuit variante data');
  assert.ok(result.round.outline.path.startsWith('M'));
  assert.equal(result.round.surfaces[0].label, 'Asphalte');
  assert.equal(result.round.surfaceFile, 'data/gp/surfaces.ini');
  assert.equal(result.round.overlaysFile, 'data/gp/overlays.ini');
  assert.equal(result.round.sectorSplits.length, 2);
  assert.deepEqual(result.warnings, []);
});

test('un mod sans fast_lane.ai conserve une fiche partielle fondée sur ui_track.json', async t => {
  const { root, write } = await fixture(t);
  await write('tracks/no-line/ui/ui_track.json', JSON.stringify({
    name: 'Circuit sans tracé', country: 'France', length: '3200',
    description: 'Tracé en préparation', tags: ['historic'], url: 'javascript:alert(1)'
  }));
  await write('tracks/no-line/data/surfaces.ini', '[SURFACE_0]\nKEY=ROAD\nFRICTION=0.98\nIS_VALID_TRACK=1');
  await write('tracks/no-line/data/overlays.ini', '[SECTOR_0]\nSTART=0\n[SECTOR_1]\nSTART=0.5');
  const result = await importLocalCircuit({ roots: [root], trackId: 'no-line', date: '2027-04-14' });
  assert.equal(result.round.name, 'Circuit sans tracé');
  assert.equal(result.round.technicalUnavailable, true);
  assert.equal(result.round.outline, null);
  assert.equal(result.round.lengthStr, '3,200 km (ui_track.json)');
  assert.equal(result.round.description, 'Tracé en préparation');
  assert.deepEqual(result.round.tags, ['historic']);
  assert.equal(result.round.trackUrl, null);
  assert.equal(result.round.surfaces[0].label, 'Asphalte');
  assert.equal(result.round.surfaceFile, 'data/surfaces.ini');
  assert.equal(result.round.overlaysFile, 'data/overlays.ini');
  assert.equal(result.round.sectorSplits.length, 2);
  assert.equal(result.round.sectorSplits[1].to, 3200);
  assert.equal(result.round.sectorFractions.length, 2);
  assert.ok(result.round.importWarnings.some(w => /fast_lane\.ai absent/.test(w)));
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
  assert.equal(result.round.name, 'Calendrier uniquement');
  assert.equal(result.round.technicalUnavailable, true);
  assert.equal(result.round.outline, null);
  assert.ok(result.round.importWarnings.some(w => /fast_lane\.ai absent/.test(w)));
  assert.ok(result.warnings.some(w => /fast_lane\.ai absent/.test(w)));
});

test('import local : sections nommées et coordonnées pour explorer la carte et le profil',async t=>{
  const {root,write}=await fixture(t);
  await addCompleteLayout(write);
  await write('tracks/test-track/gp/data/sections.ini','[SECTION_0]\nIN=0.1\nOUT=0.2\nTEXT=Prima Curva\n[SECTION_1]\nIN=2\nOUT=3\nTEXT=Incorrect');
  const {round,files}=await importLocalCircuit({roots:[root],trackId:'test-track',layoutId:'gp'});
  assert.equal(files.sections.name,'gp/data/sections.ini');
  const pin=round.outline.corners.find(p=>p.name==='Prima Curva');
  assert.ok(pin.norm>=0.1&&pin.norm<=0.2);
  assert.ok(Math.abs(pin.dist-round.lengthM*pin.norm)<10);
  assert.ok(Number.isFinite(pin.altitude));
  assert.ok(round.outline.samples.length>2&&round.outline.samples.length<=241);
  assert.ok(!round.outline.corners.some(p=>p.name==='Incorrect'));
});

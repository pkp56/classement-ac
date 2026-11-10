const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const drive = require('../tools/lib/drive-circuits');

const ROOT = path.resolve(__dirname, '..');

test("L'identifiant Drive est extrait des différentes formes d'URL", () => {
  const id = '1PE4sTPInE1ZGmoxEkiEA4Ne1UzhWfqvJ';
  assert.equal(drive.driveId(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(drive.driveId(`https://drive.google.com/drive/u/1/folders/${id}`), id);
  assert.equal(drive.driveId(`https://drive.google.com/file/d/${id}/view`), id);
  assert.equal(drive.driveId(`https://example.com/?id=${id}`), id);
  assert.equal(drive.driveId(id), id);
  assert.equal(drive.driveId('pas un lien'), null);
  assert.equal(drive.driveId(''), null);
  assert.equal(drive.driveId(null), null);
});

test('Un fast_lane.ai se décode et sa longueur correspond au line.json', () => {
  const line = JSON.parse(fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/sebring/line.json'), 'utf8'));
  const n = line.data.length;
  const buf = Buffer.alloc(16 + n * 20);
  buf.writeInt32LE(7, 0);
  buf.writeInt32LE(n, 4);
  line.data.forEach(([x, y, z], i) => {
    const o = 16 + i * 20;
    buf.writeFloatLE(x, o);
    buf.writeFloatLE(y, o + 4);
    buf.writeFloatLE(z, o + 8);
  });

  const track = drive.decodeFastLane(buf);
  assert.equal(track.points.length, n);
  assert.ok(Math.abs(track.lengthM - line.lengthM) < 25, `longueur ${track.lengthM} vs ${line.lengthM}`);
  assert.ok(Math.abs(track.elevMin - line.elevation.min) < 1);
  assert.ok(Math.abs(track.elevMax - line.elevation.max) < 1);
  // La ligne complète doit tout de même produire des virages.
  assert.ok(drive.detectCorners(track.points).length >= 5);
});

test('Un fast_lane.ai tronqué est rejeté explicitement', () => {
  const bad = Buffer.alloc(20);
  bad.writeInt32LE(7, 0);
  bad.writeInt32LE(99, 4);
  assert.throws(() => drive.decodeFastLane(bad), /tronqué/);
  assert.throws(() => drive.decodeFastLane(Buffer.alloc(4)), /trop court/);
});

test('surfaces.ini : le nom vient de KEY=, pas du nom de section', () => {
  const ini = [
    '[SURFACE_0]', 'KEY=ROAD', 'FRICTION=0.99', 'IS_VALID_TRACK=1',
    '[SURFACE_1]', 'KEY=GRASS', 'FRICTION=0.6', 'IS_VALID_TRACK=0',
    '[SURFACE_2]', 'KEY=PIT', 'FRICTION=0.95', 'IS_VALID_TRACK=1'
  ].join('\n');
  const rows = drive.readSurfaces(ini);
  assert.deepEqual(rows.map(r => r.key), ['ROAD', 'GRASS', 'PIT']);
  assert.deepEqual(rows.map(r => r.grip), [99, 60, 95]);
  assert.deepEqual(rows.map(r => r.valid), [true, false, true]);
  assert.deepEqual(rows.map(r => r.pit), [false, false, true]);
});

test('surfaces.ini réel du mod Sebring fournit des grips plausibles', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/sebring/surfaces.ini'), 'utf8');
  const rows = drive.readSurfaces(txt);
  assert.ok(rows.length >= 4, `${rows.length} surfaces lues`);
  const road = rows.find(r => r.key === 'ROAD');
  assert.ok(road, 'surface ROAD absente');
  assert.equal(road.grip, 99);
  assert.equal(road.valid, true);
  for (const r of rows) {
    assert.ok(r.grip === null || (r.grip >= 0 && r.grip <= 100), `grip hors bornes: ${r.key}=${r.grip}`);
  }
});

test('overlays.ini : N départs => N secteurs, le dernier allant jusqu\'à 1', () => {
  const ini = ['[SECTOR_0]', 'START=0', '[SECTOR_1]', 'START=0.3', '[SECTOR_2]', 'START=0.7'].join('\n');
  const splits = drive.readSectorSplits(ini);
  assert.equal(splits.length, 3);
  assert.deepEqual(splits.map(s => s.label), ['S1', 'S2', 'S3']);
  assert.deepEqual(splits.map(s => s.from), [0, 0.3, 0.7]);
  assert.deepEqual(splits.map(s => s.to), [0.3, 0.7, 1]);
  // Couverture complète, sans trou.
  assert.equal(splits[0].from, 0);
  assert.equal(splits[splits.length - 1].to, 1);
  for (let i = 1; i < splits.length; i++) assert.equal(splits[i].from, splits[i - 1].to);
});

test('overlays.ini sans secteur ne fait pas planter', () => {
  assert.deepEqual(drive.readSectorSplits(''), []);
  assert.deepEqual(drive.readSectorSplits('[AUTRE]\nFOO=1'), []);
});

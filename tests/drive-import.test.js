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

test('La fiche importée contient tout ce que l\'onglet Circuit consomme', () => {
  const line = JSON.parse(fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/tremblant/line.json'), 'utf8'));
  const points = line.data.map(([x, y, z]) => ({ x, y, z }));
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    points[i].d = acc;
  }
  points[0].d = 0;
  const track = { points, lengthM: acc };

  const { buildRound } = require('../tools/lib/circuit-round');
  const round = buildRound(track, { name: 'Test', round: 1 }, {
    sectors: [0, 0.28, 0.65, 1],
    cornerNorms: line.corners
  });

  // Champs lus par circuit() dans site.js
  for (const key of ['outline', 'profile', 'profiles', 'lengthM', 'lengthStr', 'elevation', 'sectorSplits', 'cornerCount', 'sectorCount']) {
    assert.ok(round[key] !== undefined && round[key] !== null, `champ manquant : ${key}`);
  }
  assert.match(round.outline.path, /^M[\d.]+ [\d.]+ L/);
  assert.ok(round.outline.corners.length > 0, 'aucun virage placé sur le tracé');
  // Bornes internes : 2 repères pour 3 secteurs.
  assert.equal(round.outline.sectors.length, 2);
  assert.equal(round.sectorSplits.length, 3);
  assert.equal(round.sectorSplits[2].to, round.lengthM);
  assert.ok(round.profile.delta > 0, 'dénivelé nul');
});

test('Les secteurs produits couvrent le tour sans trou', () => {
  const { buildSectorSplits } = require('../tools/lib/circuit-round');
  const splits = buildSectorSplits([0, 0.25, 0.6, 1], 4000);
  assert.deepEqual(splits, [
    { label: 'S1', from: 0, to: 1000 },
    { label: 'S2', from: 1000, to: 2400 },
    { label: 'S3', from: 2400, to: 4000 }
  ]);
  // Sans borne interne, le tour entier forme un seul secteur.
  assert.deepEqual(buildSectorSplits([0, 1], 1000), [{ label: 'S1', from: 0, to: 1000 }]);
  assert.deepEqual(buildSectorSplits([], 1000), []);
});

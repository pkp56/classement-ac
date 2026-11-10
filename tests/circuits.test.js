const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/circuits.json'), 'utf8'));

test('Le calendrier expose les 6 manches dans l’ordre du site', () => {
  assert.equal(data.rounds.length, 6);
  assert.deepEqual(data.rounds.map(r => r.label), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  assert.equal(data.totalCount, 6);
  // M5 = Mexico, M6 = Österreichring (correction validée avec la Direction de course).
  assert.match(data.rounds[4].id, /mexico/);
  assert.match(data.rounds[5].id, /oesterreichring/);
  assert.equal(data.completedCount, 5);
});

test('Aucune date n’est inventée pour une manche non disputée', () => {
  const last = data.rounds[5];
  assert.equal(last.status, 'upcoming');
  assert.equal(last.date, null);
  for (const r of data.rounds.slice(0, 5)) {
    assert.equal(r.status, 'done');
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('Chaque manche fournit un tracé exploitable et un profil altimétrique', () => {
  for (const r of data.rounds) {
    assert.ok(r.outline && typeof r.outline.path === 'string' && r.outline.path.startsWith('M'), `${r.label} sans tracé`);
    assert.ok(r.outline.path.length > 200, `${r.label} tracé trop court`);
    assert.ok(r.outline.start && Number.isFinite(r.outline.start.x), `${r.label} sans ligne de départ`);
    assert.ok(Array.isArray(r.outline.corners) && r.outline.corners.length >= 5, `${r.label} sans virages`);
    for (const c of r.outline.corners) {
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `${r.label} virage hors grille`);
    }
    assert.ok(r.profile && r.profile.path.startsWith('M'), `${r.label} sans profil`);
    assert.ok(r.lengthM > 3000 && r.lengthM < 7000, `${r.label} longueur incohérente`);
    assert.ok(Number.isFinite(r.elevation.delta));
  }
});

test('Les virages restent dans la zone de dessin de la carte', () => {
  for (const r of data.rounds) {
    const pts = [...r.outline.corners, ...(r.outline.sectors || []), r.outline.start];
    for (const p of pts) {
      assert.ok(p.x >= 0 && p.x <= 1000, `${r.label} x=${p.x}`);
      assert.ok(p.y >= 0 && p.y <= 560, `${r.label} y=${p.y}`);
    }
  }
});

test('Les fiches de manche disputée portent vainqueur, date et chronos', () => {
  for (const r of data.rounds.slice(0, 5)) {
    assert.ok(r.winner, `${r.label} sans vainqueur`);
    assert.ok(r.dateLabel, `${r.label} sans date lisible`);
    assert.ok(r.stats && Number.isFinite(r.stats.races), `${r.label} sans stats`);
  }
  const midOhio = data.rounds[3];
  assert.equal(midOhio.winner, 'Kimy Hoyer');
  const mexico = data.rounds[4];
  assert.equal(mexico.winner, 'Kami_Kaze31');
});

test('Le meilleur tour de la saison provient des sessions importées', () => {
  assert.ok(data.seasonBest);
  assert.equal(data.seasonBest.time, '1:31.417');
  assert.equal(data.seasonBest.driver, '51R Sherman');
});

test('Chaque fiche référence ses sources locales', () => {
  for (const r of data.rounds) {
    assert.ok(r.source, `${r.label} sans source`);
    if (r.id !== 'oesterreichring-1979') {
      assert.match(r.source, /assets\/tracks\//);
      assert.ok(r.hero && r.hero.startsWith('maquette-circuit/assets/tracks/'), `${r.label} sans photo`);
    }
  }
});

test('Les secteurs couvrent tout le tour, sans trou ni chevauchement', () => {
  // Régression : le build utilisait `.slice(1, -1)` sur les bornes, ce qui
  // supprimait le dernier secteur (2 secteurs sur 3, dernier tiers orphelin).
  for (const r of data.rounds) {
    const splits = r.sectorSplits;
    assert.equal(splits.length, 3, `${r.label} doit avoir 3 secteurs`);
    assert.deepEqual(splits.map(s => s.label), ['S1', 'S2', 'S3'], `${r.label} : libellés`);
    assert.equal(splits[0].from, 0, `${r.label} : le 1er secteur part de 0`);
    assert.equal(splits[splits.length - 1].to, r.lengthM, `${r.label} : le dernier secteur finit sur la longueur`);
    for (let i = 1; i < splits.length; i++) {
      assert.equal(splits[i].from, splits[i - 1].to, `${r.label} : S${i} et S${i + 1} doivent être contigus`);
      assert.ok(splits[i].to > splits[i].from, `${r.label} : secteur ${i + 1} vide`);
    }
  }
});

test('Le détecteur de virages et le compacteur restent utilisables', () => {
  const { readFastLane, detectCorners } = require('../tools/lib/read-fast-lane');
  const { pack } = require('../tools/lib/pack-fast-lane');
  assert.equal(typeof readFastLane, 'function');
  assert.equal(typeof detectCorners, 'function');
  assert.equal(typeof pack, 'function');
  // Détection sur une petite boucle synthétique : au moins un virage.
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 80, y: 0, z: Math.sin(a) * 80, d: (i / 120) * 502.6 });
  }
  assert.ok(detectCorners(pts).length >= 1);
});

'use strict';
/*
 * Grille « finir ensemble » : classement du plus mauvais au meilleur rythme de
 * qualification, avec un écart qui compense exactement la différence de rythme
 * sur la distance de course.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildGrid, paceOf } = require('../tools/grille-temps-moyens');

/** Session minimale : un pilote = une liste de temps au tour en ms. */
function sessionOf(drivers, extra) {
  const Laps = [];
  const Result = [];
  let id = 0;
  for (const [name, times] of Object.entries(drivers)) {
    const guid = 'g' + (++id);
    for (const t of times) Laps.push({ DriverName: name, DriverGuid: guid, LapTime: t });
    Result.push({ DriverName: name, DriverGuid: guid, NumLaps: times.length });
  }
  return Object.assign({ Type: 'QUALIFY', TrackName: 'test', Laps, Result }, extra || {});
}

test('le rythme médian ignore les tours hors des +4 %', () => {
  // 100 s, 101 s, 102 s, 103 s propres, puis un tour de sortie de stands à 150 s.
  const p = paceOf([100000, 101000, 102000, 103000, 150000], { mode: 'median' });
  assert.equal(p.kept, 4);
  assert.equal(p.pace, 101500); // médiane de 100/101/102/103
  assert.equal(p.laps, 5);
});

test('le mode moyenne et le mode meilleur tour donnent des rythmes différents', () => {
  const times = [100000, 101000, 102000, 103000];
  assert.equal(paceOf(times, { mode: 'mean' }).pace, 101500);
  assert.equal(paceOf(times, { mode: 'best' }).pace, 100000);
  // Un tour à +6 % sort de la fenêtre des +4 % : il ne pèse pas sur la moyenne.
  assert.equal(paceOf([100000, 101000, 106000], { mode: 'mean' }).pace, 100500);
});

test('un pilote avec trop peu de tours propres n’est pas classé', () => {
  const p = paceOf([100000, 160000, 170000], { mode: 'median' });
  assert.equal(p.kept, 1);
  const grid = buildGrid(sessionOf({ seul: [100000, 160000, 170000] }), { laps: 10, minLaps: 2 });
  assert.equal(grid.drivers[0].classified, false);
  assert.equal(grid.drivers[0].gapSec, null);
});

test('le plus mauvais part devant et le meilleur derrière', () => {
  const grid = buildGrid(sessionOf({
    lent: [110000, 111000, 112000],
    moyen: [105000, 106000, 107000],
    rapide: [100000, 101000, 102000]
  }), { laps: 20 });
  assert.deepEqual(grid.drivers.map(d => d.name), ['lent', 'moyen', 'rapide']);
  assert.deepEqual(grid.drivers.map(d => d.position), [1, 2, 3]);
  // Le meilleur a zéro handicap, c'est la référence.
  assert.equal(grid.drivers[2].gapSec, 0);
});

test('le handicap vaut l’écart de rythme × le nombre de tours', () => {
  const grid = buildGrid(sessionOf({
    lent: [110000, 110000],
    rapide: [100000, 100000]
  }), { laps: 15 });
  // 10 s au tour d'écart × 15 tours = 150 s à rattraper.
  assert.equal(grid.drivers[0].gapSec, 150);
  assert.equal(grid.drivers[0].gapPerLapSec, 10);
  assert.equal(grid.drivers[1].gapSec, 0);
});

test('--cap compresse les écarts sans changer l’ordre', () => {
  const session = sessionOf({ lent: [110000, 110000], rapide: [100000, 100000] });
  const libre = buildGrid(session, { laps: 20 });           // 200 s d'écart
  const plafonne = buildGrid(session, { laps: 20, cap: 50 }); // plafonné à 50 s
  assert.deepEqual(plafonne.drivers.map(d => d.name), libre.drivers.map(d => d.name));
  assert.equal(plafonne.drivers[0].gapSec, 50);
  assert.equal(plafonne.drivers[1].gapSec, 0);
  assert.ok(plafonne.meta.scale < 1);
});

test('la distance en mètres est déduite de la longueur du circuit', () => {
  // 5000 m en 100 s → 50 m/s. 10 s d'écart au tour sur 10 tours = 100 s = 5000 m.
  const grid = buildGrid(sessionOf({
    lent: [110000, 110000],
    rapide: [100000, 100000]
  }), { laps: 10, lengthM: 5000 });
  assert.equal(grid.drivers[0].gapM, 5000);
});

test('aucun pilote classé : grille vide, pas de plantage', () => {
  const grid = buildGrid({ Type: 'QUALIFY', Laps: [], Result: [] }, { laps: 10 });
  assert.equal(grid.drivers.length, 0);
  assert.equal(grid.meta.classified, 0);
});

test('le nombre de tours maximum est celui où la grille tient dans un tour', () => {
  // 100 s au tour, 10 s d'écart au tour entre le plus lent et le meilleur :
  // 1 tour de handicap tous les 10 tours → 10 tours maximum pour un peloton
  // d'un tour, 5 tours pour un demi-tour.
  const grid = buildGrid(sessionOf({
    lent: [110000, 110000],
    rapide: [100000, 100000]
  }), { laps: 5, lengthM: 5000 });
  const f = grid.meta.feasible;
  assert.equal(f.pleine[0].laps, 10);      // 1 tour de circuit
  assert.equal(f.pleine[1].laps, 5);       // 1/2 tour
  assert.equal(f.demi[0].laps, 20);        // écarts divisés par deux
});

test('les écarts réduits doublent la distance faisable', () => {
  const grid = buildGrid(sessionOf({
    lent: [106000, 106000],
    rapide: [100000, 100000]
  }), { laps: 12, lengthM: 4000 });
  const f = grid.meta.feasible;
  assert.equal(f.demi[0].laps, f.pleine[0].laps * 2);
});

test('la faisabilité est absente quand aucun pilote n’est classé', () => {
  const grid = buildGrid({ Type: 'QUALIFY', Laps: [], Result: [] }, { laps: 10 });
  assert.equal(grid.meta.feasible.pleine[0].laps, null);
});

// --- Placement sur le tracé réel (tools/grille-sur-circuit.js) ---
const { readLine, pointAt, placeGrid } = require('../tools/grille-sur-circuit');

test('le tracé de Mont-Tremblant est lu avec la bonne longueur', () => {
  const line = readLine('tremblant');
  assert.ok(line.lengthM > 4100 && line.lengthM < 4400, `longueur ${line.lengthM}`);
  // le premier point est à la distance 0, le dernier avant la boucle
  assert.equal(line.points[0].d, 0);
  assert.ok(line.points[line.points.length - 1].d < line.lengthM);
});

test('pointAt interpole et boucle correctement', () => {
  const line = readLine('tremblant');
  const a = pointAt(line, 0);
  const b = pointAt(line, line.lengthM);
  assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.z - b.z) < 1, 'un tour complet ramène au départ');
  const mid = pointAt(line, line.lengthM / 2);
  assert.ok(Number.isFinite(mid.headingRad));
});

test('la voiture n°1 est la plus avancée, juste derrière la ligne', () => {
  const line = readLine('tremblant');
  const grid = buildGrid(sessionOf({
    lent: [110000, 110000],
    moyen: [105000, 105000],
    rapide: [100000, 100000]
  }), { laps: 10, lengthM: Math.round(line.lengthM) });
  const placed = placeGrid(grid, line, { marge: 30, minSpacing: 10 });
  assert.equal(placed.cars[0].name, 'lent');
  assert.equal(placed.cars[0].behindLineM, 30);
  // les voitures reculent dans l'ordre de la grille
  assert.ok(placed.cars[1].behindLineM > placed.cars[0].behindLineM);
  assert.ok(placed.cars[2].behindLineM > placed.cars[1].behindLineM);
  // et ne se chevauchent pas
  assert.equal(placed.cars.filter(c => c.overlapping).length, 0);
});

test('l’espacement minimum évite les voitures superposées', () => {
  const line = readLine('tremblant');
  // 0,02 s au tour sur 10 tours = 0,2 s ≈ 8 m : sous l'espacement minimum
  const grid = buildGrid(sessionOf({
    a: [100020, 100020],
    b: [100000, 100000]
  }), { laps: 10, lengthM: Math.round(line.lengthM) });
  const placed = placeGrid(grid, line, { marge: 30, minSpacing: 10 });
  assert.ok(placed.cars[1].gapToCarAheadM >= 10, `écart ${placed.cars[1].gapToCarAheadM}`);
  assert.equal(placed.adjusted, 1);
});

test('une grille plus longue qu’un tour est signalée comme impossible', () => {
  const line = readLine('tremblant');
  const grid = buildGrid(sessionOf({
    lent: [120000, 120000],
    rapide: [100000, 100000]
  }), { laps: 40, lengthM: Math.round(line.lengthM) });
  const placed = placeGrid(grid, line, { marge: 30 });
  assert.equal(placed.valid, false);
  assert.ok(placed.wrapRisk);
});

test('le bloc AC sort des positions et des orientations exploitables', () => {
  const line = readLine('tremblant');
  const grid = buildGrid(sessionOf({ a: [100000, 100000] }), { laps: 5, lengthM: Math.round(line.lengthM) });
  const placed = placeGrid(grid, line, {});
  const { renderAcBlock } = require('../tools/grille-sur-circuit');
  const block = renderAcBlock(placed);
  assert.match(block, /\[START_0\]/);
  assert.match(block, /POS=-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+/);
  assert.match(block, /ORIENTATION=-?\d+\.\d+/);
});

test('le squelette de layout AC contient un kn5 par layout et le bon nombre de boxes', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path_ = require('node:path');
  const { writeLayoutSkeleton } = require('../tools/grille-sur-circuit');
  const line = readLine('tremblant');
  const grid = buildGrid(sessionOf({
    a: [100000, 100000], b: [101000, 101000], c: [102000, 102000]
  }), { laps: 10, lengthM: Math.round(line.lengthM) });
  const placed = placeGrid(grid, line, {});
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), 'gdsp-layout-'));
  writeLayoutSkeleton(dir, placed, line, { layout: 'gdsp', track: 'mt-tremblant_69' });

  // un models_<layout>.ini qui pointe un kn5 dédié, jamais la piste d'origine
  const models = fs.readFileSync(path_.join(dir, 'models_gdsp.ini'), 'utf8');
  assert.match(models, /FILE=go_gdsp\.kn5/);
  // les start positions et le nombre de boxes suivent la grille
  const starts = fs.readFileSync(path_.join(dir, 'gdsp.start.txt'), 'utf8');
  assert.equal((starts.match(/\[START_\d+\]/g) || []).length, 3);
  const ui = JSON.parse(fs.readFileSync(path_.join(dir, 'gdsp', 'ui', 'ui_track.json'), 'utf8'));
  assert.equal(ui.pitboxes, '3');
  fs.rmSync(dir, { recursive: true, force: true });
});

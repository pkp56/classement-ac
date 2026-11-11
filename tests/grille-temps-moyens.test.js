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

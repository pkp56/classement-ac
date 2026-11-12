'use strict';
/*
 * Télémétrie / BoP : le calcul qui décide du poids d'une voiture dans un
 * championnat. Ces tests verrouillent les propriétés qui rendent le résultat
 * défendable — et surtout celles qui l'empêchent d'être faux.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { lapStats, evaluateCarSetup, lapsInTime, timeForLaps, compareCars, buildModel, fmtLap } = require('../tools/telemetry/bop');

const CAR_FAST_THIRSTY = {
  car: 'actk_lola_t290', circuit: 'monza',
  medianLapMs: 74902, fuelPerLap: 2.4, fuelCapacity: 30,
  tyreWearPerLap: 2.2, pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000
};
const CAR_SLOW_FRUGAL = {
  car: 'alfa_giulietta_spider', circuit: 'monza',
  medianLapMs: 75576, fuelPerLap: 1.5, fuelCapacity: 45,
  tyreWearPerLap: 1.4, pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000
};

test('lapStats : médiane et écart-type, insensibles à un tour aberrant', () => {
  const stats = lapStats([75000, 75100, 75200, 75300, 75050, 130000]);
  assert.equal(stats.count, 6);
  assert.equal(stats.best, 75000);
  assert.ok(stats.median > 75000 && stats.median < 75300, 'la mediane ignore le tour a 130 s');
  assert.ok(stats.stdev < 5000, 'la regularite ne doit pas etre dominee par un seul tour rate');
});

test('lapStats : accepte {ms} comme des nombres, et refuse le vide', () => {
  assert.deepEqual(lapStats([{ ms: 80000 }, { ms: 81000 }]).median, 80500);
  assert.equal(lapStats([]).median, null);
  assert.equal(lapStats([null, 0, -5]).count, 0);
});

test('evaluateCarSetup refuse de calculer s\'il manque une mesure', () => {
  const partial = evaluateCarSetup({ medianLapMs: 75000, fuelPerLap: 2 });
  assert.equal(partial.ok, false);
  assert.ok(partial.missing.some(m => /réservoir/i.test(m)));
  assert.ok(partial.missing.some(m => /ravitaillement/i.test(m)));
  assert.ok(partial.missing.some(m => /gommes/i.test(m)));
});

test('autonomie = min(réservoir/conso, gomme/usure)', () => {
  const fast = evaluateCarSetup(buildModel(CAR_FAST_THIRSTY));
  assert.ok(Math.abs(fast.fuelStintLaps - 12.5) < 0.001);
  assert.ok(Math.abs(fast.tyreStintLaps - 45.4545) < 0.01);
  const slow = evaluateCarSetup(buildModel(CAR_SLOW_FRUGAL));
  assert.ok(Math.abs(slow.fuelStintLaps - 30) < 0.001);
});

test('une voiture plus rapide mais gourmande peut perdre la course (cœur du BoP)', () => {
  const fast = buildModel(CAR_FAST_THIRSTY);
  const slow = buildModel(CAR_SLOW_FRUGAL);
  const raceFast = lapsInTime(fast, 20 * 60000);
  const raceSlow = lapsInTime(slow, 20 * 60000);

  // La Lola est ~0,7 s plus rapide au tour…
  assert.ok(fast.medianLapMs < slow.medianLapMs);
  // …mais elle s'arrête, l'Alfa non.
  assert.equal(raceSlow.stops, 0);
  assert.ok(raceFast.stops >= 1);

  // Sur la distance du vainqueur, la Lola perd du temps (delta positif).
  const rows = compareCars([CAR_FAST_THIRSTY, CAR_SLOW_FRUGAL], [20]);
  const lola = rows.find(r => r.car === 'actk_lola_t290').fixed[20];
  const alfa = rows.find(r => r.car === 'alfa_giulietta_spider').fixed[20];
  assert.equal(alfa.deltaToBestMs, 0, "l'Alfa est la reference sur 20 min");
  assert.ok(lola.deltaToBestMs > 5000, 'la Lola doit payer son arret (plus de 5 s)');
  assert.equal(lola.refLaps, alfa.refLaps, 'on compare a distance egale');
});

test('course à distance égale : le nombre de tours est le même pour toutes', () => {
  const fast = buildModel(CAR_FAST_THIRSTY);
  const slow = buildModel(CAR_SLOW_FRUGAL);
  for (const laps of [10, 15, 23, 35]) {
    const a = timeForLaps(fast, laps);
    const b = timeForLaps(slow, laps);
    assert.equal(a.laps, laps);
    assert.equal(b.laps, laps);
    // Moins d'arrêts, c'est moins de temps perdu : vérifiable à la main.
    if (a.stops < b.stops) assert.ok(a.stopTimeMs < b.stopTimeMs);
  }
});

test('un arrêt peut couvrir essence ET gommes en même temps', () => {
  // Réservoir de 6 tours, gommes de 6 tours : les deux tombent ensemble.
  const model = buildModel({
    car: 'x', medianLapMs: 60000, fuelPerLap: 5, fuelCapacity: 30,
    tyreWearPerLap: 100 / 6, pitLaneLossMs: 20000, refuelRateLps: 10, tyreChangeMs: 8000
  });
  const plan = timeForLaps(model, 12);
  assert.equal(plan.stops, 1, 'un seul passage, pas deux');
  assert.equal(plan.fuelStops, 1);
  assert.equal(plan.tyreStops, 1);
  // 20 s de pit-lane + 3 s de plein (30 L à 10 L/s) + 8 s de gommes
  assert.equal(plan.stopTimeMs, 20000 + 3000 + 8000);
});

test('aucun arrêt inutile après le dernier tour', () => {
  const model = buildModel({
    car: 'x', medianLapMs: 60000, fuelPerLap: 5, fuelCapacity: 50,
    tyreWearPerLap: 2, pitLaneLossMs: 20000, refuelRateLps: 5, tyreChangeMs: 8000
  });
  // 10 tours d'autonomie essence, 50 de gommes : 10 tours = 0 arrêt.
  const plan = timeForLaps(model, 10);
  assert.equal(plan.stops, 0);
  assert.equal(plan.raceTimeMs, 10 * 60000);
});

test('les durées 20/30/45 min produisent des arrêts croissants', () => {
  const model = buildModel(CAR_FAST_THIRSTY);
  let previous = -1;
  for (const min of [20, 30, 45]) {
    const r = lapsInTime(model, min * 60000);
    assert.ok(r.ok && r.laps > 0);
    assert.ok(r.laps * model.medianLapMs <= min * 60000 + 1, 'on ne peut pas depasser la duree');
    assert.ok(r.stops >= previous, 'les arrêts ne diminuent pas quand la course s\'allonge');
    previous = r.stops;
  }
});

test('compareCars marque les voitures incomplètes au lieu de les noter', () => {
  const rows = compareCars([
    CAR_SLOW_FRUGAL,
    { car: 'inconnue', medianLapMs: 70000 } // tout le reste manque
  ], [20]);
  const incomplete = rows.find(r => r.car === 'inconnue');
  assert.equal(incomplete.model.ok, false);
  assert.equal(incomplete.fixed[20], undefined, 'aucun resultat invente');
  const ok = rows.find(r => r.car === 'alfa_giulietta_spider');
  assert.ok(ok.fixed[20].raceTimeMs > 0);
});

test('fmtLap : format chrono lisible', () => {
  assert.equal(fmtLap(75576), '1:15.576');
  assert.equal(fmtLap(9000), '9.000');
  assert.equal(fmtLap(null), '—');
});

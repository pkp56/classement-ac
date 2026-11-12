'use strict';
/*
 * Rapport BoP : les trois formats (CSV, Markdown, HTML) et le protocole de
 * campagne de 10 jours. Le rapport ne doit jamais partir si le protocole est
 * incomplet — sinon un chiffre non défendable servirait à modifier les voitures.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildReport, buildRows, DURATIONS } = require('../tools/telemetry/export');
const { evaluateCampaign, DAYS } = require('../tools/telemetry/campaign');

const CARS = [
  {
    car: 'actk_lola_t290', circuit: 'ks_monza66-junior',
    medianLapMs: 74902, fuelPerLap: 2.4, fuelCapacity: 30, tyreWearPerLap: 2.2,
    pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000
  },
  {
    car: 'alfa_giulietta_spider', circuit: 'ks_monza66-junior',
    medianLapMs: 75576, fuelPerLap: 1.5, fuelCapacity: 45, tyreWearPerLap: 1.4,
    pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000
  }
];

const MATRIX = {
  cars: ['actk_lola_t290', 'alfa_giulietta_spider'],
  driversCommon: ['76561198015862674'],
  cells: {
    '76561198015862674|actk_lola_t290': { medianLapMs: 74902 },
    '76561198015862674|alfa_giulietta_spider': { medianLapMs: 75576 }
  },
  carDeltas: {
    actk_lola_t290: { deltaMs: 0, drivers: 1 },
    alfa_giulietta_spider: { deltaMs: 674, drivers: 1 }
  }
};

test('les trois formats sont générés et contiennent les mêmes chiffres', () => {
  const report = buildReport(CARS, { campaign: 'test-monza', matrix: MATRIX });
  const { csv, markdown, html } = report.files;
  assert.ok(csv.length > 100 && markdown.length > 100 && html.length > 500);
  // Les chiffres clés apparaissent dans les trois.
  for (const needle of ['actk_lola_t290', 'alfa_giulietta_spider', '1:14.902', '1:15.576']) {
    assert.ok(csv.includes(needle), `CSV sans ${needle}`);
    assert.ok(markdown.includes(needle), `Markdown sans ${needle}`);
    assert.ok(html.includes(needle), `HTML sans ${needle}`);
  }
});

test('le CSV est fait pour un tableur français : point-virgule, virgule décimale, BOM', () => {
  const { csv } = buildReport(CARS, { campaign: 'x' }).files;
  assert.ok(csv.startsWith('\uFEFF'), 'BOM UTF-8 pour Excel');
  assert.ok(csv.includes('\r\n'), 'fins de ligne Windows');
  const header = csv.split('\r\n').find(l => l.startsWith('voiture;'));
  assert.ok(header, 'en-tête avec séparateur point-virgule');
  assert.ok(csv.includes('2,40'), 'décimale à la française');
  assert.ok(!/;\s*2\.40/.test(csv), 'aucun point décimal dans les mesures');
  // Une colonne par durée demandée, pour les trois durées.
  for (const min of DURATIONS) assert.ok(header.includes(`${min}min`), `colonne manquante pour ${min} min`);
});

test('le rapport compare à distance égale (même nombre de tours)', () => {
  const rows = buildRows(CARS, {});
  const lola = rows.find(r => r.car === 'actk_lola_t290');
  const alfa = rows.find(r => r.car === 'alfa_giulietta_spider');
  for (const min of DURATIONS) {
    assert.equal(lola.byDuration[min].refLaps, alfa.byDuration[min].refLaps,
      `distance différente pour ${min} min : la comparaison serait fausse`);
  }
});

test('le Markdown inclut la matrice pilote × voiture et son avertissement', () => {
  const { markdown } = buildReport(CARS, { campaign: 'x', matrix: MATRIX }).files;
  assert.ok(markdown.includes('Matrice pilote × voiture'));
  assert.ok(markdown.includes('à pilote constant'));
  assert.ok(markdown.includes('+0.674') || markdown.includes('0.674'));
});

test('sans matrice complète, le Markdown dit clairement que la comparaison est impossible', () => {
  const { markdown } = buildReport(CARS, {
    campaign: 'x',
    matrix: { cars: ['a', 'b'], drivers: [], driversCommon: [], cells: {}, carDeltas: {} }
  }).files;
  assert.ok(/Aucun pilote n'a roulé dans toutes les voitures/.test(markdown));
});

test('une voiture incomplète est signalée, jamais notée', () => {
  const rows = buildRows([{ car: 'mystere', medianLapMs: 70000 }], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].incomplete, true);
  assert.ok(rows[0].missing.length > 0);
  const { html } = buildReport([{ car: 'mystere', medianLapMs: 70000 }], { campaign: 'x' }).files;
  assert.ok(/données incomplètes/.test(html));
});

test('le HTML est autonome (pas de ressource externe) et imprimable', () => {
  const { html } = buildReport(CARS, { campaign: 'x' }).files;
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(/@media print/.test(html));
  assert.ok(!/<link[^>]+href="http/i.test(html), 'aucun CSS externe');
  assert.ok(!/<script/i.test(html), 'aucun script : un rapport ne doit rien exécuter');
});

// --- protocole de campagne ---------------------------------------------------

const SESSION_OK = { track: 'ks_monza66-junior', fuel_rate: 100, tyre_wear_rate: 100 };
const PIT_OK = { pit_lane_loss_ms: 22000, refuel_rate_lps: 2.5, tyre_change_ms: 12000 };

function fullCampaign() {
  const laps = [];
  for (const guid of ['G1', 'G2']) {
    for (const car of ['lola', 'alfa']) {
      for (let i = 1; i <= 10; i++) {
        laps.push({ driver_guid: guid, driver_name: guid, car, lap_number: i, lap_ms: 75000 + i * 100, fuel_used_l: 1.8, tyre_wear_pct: 1.6, measured: true });
      }
    }
  }
  return { laps, session: SESSION_OK, pitProfile: PIT_OK, reproDeltaMs: 40 };
}

test('les 10 jours sont décrits avec un objectif et un risque', () => {
  assert.equal(DAYS.length, 10);
  for (const day of DAYS) {
    assert.ok(day.title);
    assert.ok(day.purpose.length > 20, `J${day.day} sans objectif clair`);
    assert.ok(day.invalidates.length > 20, `J${day.day} sans risque documenté`);
    assert.ok(Array.isArray(day.records) && day.records.length > 0);
  }
});

test('une campagne complète est validée', () => {
  const evaluation = evaluateCampaign(fullCampaign());
  assert.equal(evaluation.days.length, 10);
  assert.ok(evaluation.ready, `jours bloquants : ${evaluation.blocking.join(' | ')}`);
  assert.equal(evaluation.coverage.drivers, 2);
  assert.equal(evaluation.coverage.cars, 2);
});

test('sans mesures de carburant et d\'usure, la campagne est bloquée', () => {
  const data = fullCampaign();
  for (const lap of data.laps) { lap.fuel_used_l = null; lap.tyre_wear_pct = null; }
  const evaluation = evaluateCampaign(data);
  assert.equal(evaluation.ready, false);
  const blockedDays = evaluation.days.filter(d => !d.ok).map(d => d.day);
  assert.ok(blockedDays.includes(2), 'le jour conso/usure doit être bloqué');
  assert.ok(blockedDays.includes(10), 'le rapport final doit être bloqué');
  assert.ok(evaluation.blocking.some(b => /carburant/i.test(b)));
});

test('sans mesure du pit-lane, le rapport final est bloqué (temps de course inexistants)', () => {
  const data = fullCampaign();
  data.pitProfile = null;
  const evaluation = evaluateCampaign(data);
  assert.equal(evaluation.ready, false);
  assert.ok(evaluation.blocking.some(b => /pit-lane/i.test(b)));
});

test('un seul pilote empêche la comparaison entre voitures', () => {
  const data = fullCampaign();
  data.laps = data.laps.filter(l => l.driver_guid === 'G1');
  const evaluation = evaluateCampaign(data);
  assert.equal(evaluation.ready, false);
  const day3 = evaluation.days.find(d => d.day === 3);
  assert.equal(day3.ok, false);
  assert.ok(day3.missing.some(m => /seul pilote/i.test(m)));
});

test('les tours estimés (measured=false) ne comptent pas dans la campagne', () => {
  const data = fullCampaign();
  for (const lap of data.laps) lap.measured = false;
  const evaluation = evaluateCampaign(data);
  assert.equal(evaluation.coverage.laps, 0);
  assert.equal(evaluation.ready, false);
});

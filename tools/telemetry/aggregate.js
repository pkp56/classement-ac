'use strict';
/*
 * Agrégation de la télémétrie en métriques utilisables par le BoP.
 *
 * Deux règles, non négociables :
 *  1. seules les données MARQUÉES `measured = true` entrent dans un calcul de
 *     BoP — une estimation ne doit jamais servir à équilibrer une voiture ;
 *  2. on calcule par (voiture, circuit, pilote) puis on agrège : la comparaison
 *     finale se fait à pilote constant, sinon on mesure le talent du pilote et
 *     on déséquilibre le championnat en croyant équilibrer les voitures.
 */

const { lapStats, avg } = require('./bop');

/** Lit un champ écrit tantôt en camelCase (agent), tantôt en snake_case (base). */
function field(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null) return row[n];
  }
  return null;
}

/** Regroupe les tours par clé arbitraire. */
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/**
 * Profil d'une voiture sur un circuit, à partir des tours mesurés.
 * @returns {{car, circuit, drivers, laps, bestLapMs, medianLapMs, stdevMs,
 *            fuelPerLap, tyreWearPerLap, maxSpeedKmh, measuredOnly}}
 */
function carProfile(sessionInfo, laps) {
  const clean = (laps || []).filter(l => l.measured !== false && Number.isFinite(Number(field(l, 'lapMs', 'lap_ms'))));
  const stats = lapStats(clean.map(l => ({ ms: Number(field(l, 'lapMs', 'lap_ms')) })));
  // Une conso n'est fiable que sur un tour propre : un tour coupé (cuts) ou
  // passé aux stands fausse complètement la mesure.
  const fuel = clean
    .filter(l => !(Number(field(l, 'cuts')) > 0))
    .map(l => Number(field(l, 'fuel_used_l', 'fuelUsedL')))
    .filter(v => Number.isFinite(v) && v > 0);
  const wear = clean
    .map(l => Number(field(l, 'tyre_wear_pct', 'tyreWearPct')))
    .filter(v => Number.isFinite(v) && v > 0);
  const speeds = clean
    .map(l => Number(field(l, 'speed_max_kmh', 'speedMaxKmh')))
    .filter(Number.isFinite);
  return {
    car: sessionInfo.car,
    circuit: sessionInfo.track,
    circuitConfig: sessionInfo.trackConfig || null,
    sessionId: sessionInfo.sessionId ?? null,
    drivers: [...new Set(clean.map(l => field(l, 'driver_guid', 'driverGuid')).filter(Boolean))],
    laps: clean.length,
    bestLapMs: stats.best,
    medianLapMs: stats.median,
    stdevMs: stats.stdev,
    fuelPerLap: avg(fuel),
    tyreWearPerLap: avg(wear),
    maxSpeedKmh: speeds.length ? Math.max(...speeds) : null,
    measuredOnly: true
  };
}

/**
 * Un identifiant de voiture doit désigner une voiture. `function: 0x…` est le
 * tostring d'un champ Lua (bug car.id du 13/11, corrigé) : ces tours restent
 * visibles dans la synthèse, mais aucune comparaison entre voitures ne peut
 * s'appuyer dessus — ça comparerait une voiture avec elle-même.
 */
function plausibleCarId(car) {
  const s = String(car == null ? '' : car).trim();
  return !!s && !/^function\s*:/i.test(s);
}

/**
 * Matrice pilote × voiture sur un circuit : la seule base honnête pour un BoP
 * multi-voitures. Chaque cellule est le tour médian du pilote dans la voiture.
 *
 * @returns {{circuit, drivers:string[], cars:string[],
 *            cells:Object, carDeltas:Object, driversCommon:string[]}}
 */
function driverCarMatrix(laps) {
  const all = (laps || []).filter(l => l.measured !== false
    && field(l, 'driver_guid', 'driverGuid') && field(l, 'car'));
  const excludedUnidentified = [...new Set(all
    .filter(l => !plausibleCarId(field(l, 'car')))
    .map(l => field(l, 'car')))].length;
  const clean = all.filter(l => plausibleCarId(field(l, 'car')));
  const groups = groupBy(clean, l => `${field(l, 'driver_guid', 'driverGuid')}|${field(l, 'car')}`);
  const cells = {};
  const drivers = new Set();
  const cars = new Set();
  for (const [key, rows] of groups) {
    const [guid, car] = key.split('|');
    const stats = lapStats(rows.map(l => ({ ms: Number(field(l, 'lapMs', 'lap_ms')) })));
    cells[key] = {
      driverGuid: guid,
      car,
      medianLapMs: stats.median,
      bestLapMs: stats.best,
      stdevMs: stats.stdev,
      laps: stats.count
    };
    drivers.add(guid);
    cars.add(car);
  }

  // Un pilote n'entre dans la comparaison entre voitures que s'il a roulé
  // dans TOUTES les voitures comparées : sinon son delta mesure son absence.
  const carList = [...cars].sort();
  const driverList = [...drivers];
  const driversCommon = driverList.filter(guid => carList.every(car => cells[`${guid}|${car}`]));

  // Delta par voiture = moyenne, à pilote constant, de (voiture - meilleure
  // voiture du pilote). Positif = plus lent que la référence du pilote.
  const carDeltas = {};
  for (const car of carList) carDeltas[car] = { samples: [], deltaMs: null };
  for (const guid of driversCommon) {
    const perDriver = carList.map(car => ({ car, ms: cells[`${guid}|${car}`].medianLapMs })).filter(x => Number.isFinite(x.ms));
    if (perDriver.length < 2) continue;
    const ref = Math.min(...perDriver.map(x => x.ms));
    for (const entry of perDriver) carDeltas[entry.car].samples.push(entry.ms - ref);
  }
  for (const car of carList) {
    const s = carDeltas[car].samples;
    carDeltas[car].deltaMs = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    carDeltas[car].drivers = s.length;
  }

  return {
    circuit: clean.length ? (field(clean[0], 'track') || null) : null,
    drivers: driverList,
    cars: carList,
    driversCommon,
    cells,
    carDeltas,
    excludedUnidentified
  };
}

/** Contexte de session exigé pour qu'un tour soit comparable. */
function sessionContextMissing(session) {
  const missing = [];
  if (!session) return ['session'];
  if (!session.track) missing.push('circuit');
  if (session.fuel_rate == null) missing.push('FUEL_RATE du serveur');
  if (session.tyre_wear_rate == null) missing.push('TYRE_WEAR_RATE du serveur');
  return missing;
}

module.exports = { groupBy, carProfile, driverCarMatrix, sessionContextMissing, field, plausibleCarId };

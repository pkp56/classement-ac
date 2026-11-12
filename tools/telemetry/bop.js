'use strict';
/*
 * Moteur de calcul BoP (Balance of Performance) — GDSP télémétrie.
 *
 * Objectif : répondre à une question de course, pas à une question de
 * chrono. Deux voitures ne se comparent pas sur leur meilleur tour mais sur
 * le TEMPS DE COURSE qu'elles produisent, arrêts aux stands compris :
 *
 *   une voiture plus rapide qui boit ou use plus doit s'arrêter plus souvent,
 *   et peut perdre la course malgré un meilleur tour.
 *
 * Tout ce qui n'est pas mesuré est refusé : ce module ne devine pas. S'il
 * manque le réservoir, la conso ou le débit de ravitaillement, la fonction
 * répond `null` avec une raison explicite (`missing`), jamais un chiffre
 * plausible mais faux.
 */

const METRIC_FIELDS = ['lapMs', 'fuelPerLap', 'tyreWearPerLap', 'fuelCapacity', 'pitLaneLossMs', 'refuelRateLps', 'tyreChangeMs'];

/**
 * Statistiques robustes d'une série de tours.
 * - `median` plutôt que moyenne : un tour raté (trafic, erreur) ne fausse rien.
 * - on écarte les tours à plus de 3 écarts-types de la médiane (aberrants).
 */
function lapStats(laps) {
  const clean = (Array.isArray(laps) ? laps : [])
    .map(v => (typeof v === 'number' ? v : v && Number(v.ms)))
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!clean.length) return { count: 0, best: null, median: null, mean: null, stdev: null, min: null, max: null };
  const median = clean.length % 2 ? clean[(clean.length - 1) / 2]
    : (clean[clean.length / 2 - 1] + clean[clean.length / 2]) / 2;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  // Régularité : on se base sur l'écart médian absolu (MAD), puis on ne garde
  // que les tours à moins de 3 sigma du MAD. Un écart-type calculé sur la
  // moyenne serait dominé par un seul tour raté et ne mesurerait plus la
  // constance du pilote, qui est justement ce qu'on veut comparer.
  const deviations = clean.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 ? deviations[(deviations.length - 1) / 2]
    : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2;
  const sigma = mad * 1.4826;
  const near = sigma > 0
    ? clean.filter(v => Math.abs(v - median) <= Math.max(3 * sigma, 1))
    : clean;
  const base = near.length >= 3 ? near : clean;
  const meanNear = base.reduce((a, b) => a + b, 0) / base.length;
  const stdev = Math.sqrt(base.reduce((a, b) => a + (b - meanNear) ** 2, 0) / base.length);
  return { count: clean.length, best: clean[0], median, mean, stdev, min: clean[0], max: clean[clean.length - 1] };
}

/** Moyenne d'une série de valeurs non nulles. */
function avg(values) {
  const list = (values || []).filter(v => Number.isFinite(v) && v > 0);
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * Modèle d'un relais / d'une voiture pour la simulation.
 * Tous les champs sont OBLIGATOIRES : la simulation refuse de tourner avec un
 * trou plutôt que de combler au hasard.
 */
function evaluateCarSetup(setup) {
  const missing = [];
  const need = (key, label) => {
    const v = setup ? setup[key] : null;
    if (!Number.isFinite(v) || v <= 0) missing.push(label);
    return v;
  };
  const medianLapMs = need('medianLapMs', 'tour médian');
  const fuelPerLap = need('fuelPerLap', 'consommation par tour (L)');
  const fuelCapacity = need('fuelCapacity', 'réservoir utilisable (L)');
  const tyreWearPerLap = need('tyreWearPerLap', 'usure pneus par tour (%/tour)');
  const pitLaneLossMs = need('pitLaneLossMs', 'temps perdu au pit-lane (ms)');
  const refuelRateLps = need('refuelRateLps', 'débit de ravitaillement (L/s)');
  const tyreChangeMs = need('tyreChangeMs', 'durée changement de gommes (ms)');
  if (missing.length) return { ok: false, missing };

  const fuelStintLaps = fuelCapacity / fuelPerLap;
  const tyreStintLaps = 100 / tyreWearPerLap;
  return {
    ok: true,
    fuelStintLaps,
    tyreStintLaps,
    stintLaps: Math.min(fuelStintLaps, tyreStintLaps),
    medianLapMs, fuelPerLap, fuelCapacity, tyreWearPerLap,
    pitLaneLossMs, refuelRateLps, tyreChangeMs
  };
}

/**
 * Construit le plan d'arrêts pour un nombre de tours donné.
 * Un arrêt couvre à la fois l'essence et les gommes quand les deux l'exigent :
 * c'est ce qui se passe en piste, et ça change la conclusion d'un BoP.
 */
function planForLaps(model, totalLaps) {
  const fuelStint = model.fuelCapacity / model.fuelPerLap;
  const tyreStint = 100 / model.tyreWearPerLap;
  let lapsLeft = totalLaps;
  let fuelLeft = fuelStint;      // plein au départ
  let tyreLeft = tyreStint;      // gommes neuves
  let stops = 0, fuelStops = 0, tyreStops = 0, stopTimeMs = 0;

  while (lapsLeft > 0) {
    const run = Math.min(Math.floor(fuelLeft), Math.floor(tyreLeft), lapsLeft);
    if (run > 0) {
      lapsLeft -= run;
      fuelLeft -= run;
      tyreLeft -= run;
      continue;
    }
    // Il reste des tours mais une ressource est vide : passage aux stands.
    const needFuel = fuelLeft < 1;
    const needTyres = tyreLeft < 1;
    let thisStop = model.pitLaneLossMs;
    if (needFuel) {
      const litres = model.fuelCapacity - Math.max(0, fuelLeft) * model.fuelPerLap;
      thisStop += (litres / model.refuelRateLps) * 1000;
      fuelStops += 1;
      fuelLeft = fuelStint;
    }
    if (needTyres) {
      thisStop += model.tyreChangeMs;
      tyreStops += 1;
      tyreLeft = tyreStint;
    }
    stops += 1;
    stopTimeMs += thisStop;
  }

  return {
    ok: true, laps: totalLaps, stops, fuelStops, tyreStops, stopTimeMs,
    drivingMs: totalLaps * model.medianLapMs,
    raceTimeMs: totalLaps * model.medianLapMs + stopTimeMs,
    effectiveLapMs: (totalLaps * model.medianLapMs + stopTimeMs) / totalLaps,
    fuelStintLaps: fuelStint, tyreStintLaps: tyreStint
  };
}

/** Temps pour parcourir exactement `laps` tours (distance fixe). */
function timeForLaps(model, laps) {
  if (!model || !model.ok) return { ok: false, missing: (model && model.missing) || METRIC_FIELDS };
  const n = Math.floor(Number(laps));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, missing: ['nombre de tours'] };
  return planForLaps(model, n);
}

/**
 * Nombre de tours parcourus en `raceMs`, et temps réellement mis pour les
 * boucler (arrêts intermédiaires inclus, pas l'arrêt après le drapeau).
 */
function lapsInTime(model, raceMs) {
  if (!model || !model.ok) return { ok: false, missing: (model && model.missing) || METRIC_FIELDS };
  const targetMs = Number(raceMs);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return { ok: false, missing: ['durée de course'] };
  const fuelStint = model.fuelCapacity / model.fuelPerLap;
  const tyreStint = 100 / model.tyreWearPerLap;
  let fuelLeft = fuelStint, tyreLeft = tyreStint;
  let laps = 0, stops = 0, fuelStops = 0, tyreStops = 0, stopTimeMs = 0;
  let clock = 0;

  while (true) {
    const run = Math.min(Math.floor(fuelLeft), Math.floor(tyreLeft));
    if (run > 0) {
      const lapsToFinish = Math.floor((targetMs - clock) / model.medianLapMs);
      const doLaps = Math.min(run, lapsToFinish);
      laps += doLaps;
      clock += doLaps * model.medianLapMs;
      fuelLeft -= doLaps;
      tyreLeft -= doLaps;
      if (doLaps < run) break;              // temps écoulé
      if (lapsToFinish === doLaps) break;   // dernier tour au drapeau
    }
    // Arrêt nécessaire : s'il ne rentre pas dans le temps restant, on s'arrête là.
    const needFuel = fuelLeft < 1;
    const needTyres = tyreLeft < 1;
    let thisStop = model.pitLaneLossMs;
    if (needFuel) {
      const litres = model.fuelCapacity - Math.max(0, fuelLeft) * model.fuelPerLap;
      thisStop += (litres / model.refuelRateLps) * 1000;
    }
    if (needTyres) thisStop += model.tyreChangeMs;
    if (clock + thisStop >= targetMs) break;
    if (needFuel) { fuelStops += 1; fuelLeft = fuelStint; }
    if (needTyres) { tyreStops += 1; tyreLeft = tyreStint; }
    stops += 1;
    stopTimeMs += thisStop;
    clock += thisStop;
  }

  return {
    ok: true, laps, stops, fuelStops, tyreStops, stopTimeMs,
    drivingMs: laps * model.medianLapMs,
    raceTimeMs: clock,
    effectiveLapMs: laps ? clock / laps : null,
    fuelStintLaps: fuelStint, tyreStintLaps: tyreStint
  };
}

/** Compatibilité : une course de `raceMs` = nombre de tours bouclés dedans. */
function simulateRace(model, opts = {}) {
  if (Number.isFinite(Number(opts.laps))) return timeForLaps(model, opts.laps);
  return lapsInTime(model, opts.raceMs);
}

/** Écart en ms entre deux résultats de course (a - b). */
function raceDelta(a, b) {
  if (!a || !a.ok || !b || !b.ok) return null;
  return a.raceTimeMs - b.raceTimeMs;
}

function buildModel(car) {
  return evaluateCarSetup({
    medianLapMs: car.medianLapMs,
    fuelPerLap: car.fuelPerLap,
    fuelCapacity: car.fuelCapacity,
    tyreWearPerLap: car.tyreWearPerLap,
    pitLaneLossMs: car.pitLaneLossMs,
    refuelRateLps: car.refuelRateLps,
    tyreChangeMs: car.tyreChangeMs
  });
}

/**
 * Compare plusieurs voitures sur des durées de course (20 / 30 / 45 min).
 *
 * Méthode : dans une course à durée fixe, la distance de référence est celle
 * du vainqueur (le plus de tours bouclés). On compare ensuite le TEMPS mis par
 * chaque voiture pour couvrir cette même distance — sinon on comparerait un
 * tour de moins chez l'une, ce qui n'a aucun sens.
 */
function compareCars(cars, durationsMin = [20, 30, 45]) {
  const rows = (cars || []).map(car => {
    const model = buildModel(car);
    const byDuration = {};
    for (const min of durationsMin) {
      byDuration[min] = model.ok ? lapsInTime(model, min * 60000) : { ok: false, missing: model.missing };
    }
    return { car: car.car, circuit: car.circuit || null, driver: car.driver || null, model, byDuration, fixed: {} };
  });

  for (const min of durationsMin) {
    const runnable = rows.filter(r => r.byDuration[min] && r.byDuration[min].ok);
    if (!runnable.length) continue;
    // Distance de référence = celle de la voiture qui boucle le plus de tours.
    const refLaps = Math.max(...runnable.map(r => r.byDuration[min].laps));
    if (!refLaps) continue;
    for (const r of runnable) {
      const fixed = timeForLaps(r.model, refLaps);
      r.fixed[min] = fixed;
    }
    const best = Math.min(...runnable.map(r => r.fixed[min].raceTimeMs));
    for (const r of runnable) {
      r.fixed[min].deltaToBestMs = r.fixed[min].raceTimeMs - best;
      r.fixed[min].refLaps = refLaps;
      r.fixed[min].lapsInTime = r.byDuration[min].laps;
    }
  }
  return rows;
}

// --- formatage lisible -------------------------------------------------------

function fmtLap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mm = String(total % 1000).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${mm}` : `${s}.${mm}`;
}

function fmtDelta(ms) {
  if (!Number.isFinite(ms)) return '—';
  // Un delta nul affiché « 0.000 » se lit mal à côté de « +9.510 » : la
  // référence est une position, pas une avance.
  if (Math.abs(ms) < 0.5) return 'réf.';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  const mm = String(Math.round(abs % 1000)).padStart(3, '0');
  const m = Math.floor(s / 60);
  if (m > 0) return `${sign}${m}:${String(s % 60).padStart(2, '0')}.${mm}`;
  return `${sign}${s}.${mm}`;
}

module.exports = {
  lapStats,
  avg,
  evaluateCarSetup,
  planForLaps,
  timeForLaps,
  lapsInTime,
  buildModel,
  simulateRace,
  raceDelta,
  compareCars,
  fmtLap,
  fmtDelta,
  METRIC_FIELDS
};

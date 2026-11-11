#!/usr/bin/env node
/*
 * Grille « finir ensemble » à partir du rythme moyen en qualification.
 *
 * Principe demandé : on prend la session de qualification, on calcule le
 * rythme de chaque pilote (moyenne/médiane de ses tours), on classe du plus
 * mauvais au meilleur, et on place le plus mauvais devant sur la grille. On
 * laisse entre chaque pilote un écart qui vaut exactement ce qu'il aurait
 * perdu sur la distance de course : tous les pilotes passent la ligne au même
 * instant si chacun roule à son rythme de qualification.
 *
 *     écart i = (rythme i − rythme du meilleur) × nombre de tours de course
 *
 * Choix de calcul (défaut) : le rythme est la MÉDIANE des tours « propres »,
 * c.-à-d. les tours à moins de +4 % du meilleur tour du pilote. Ça jette le
 * tour de sortie des stands, le tour d'entrée, les tours d'attaque ratés et
 * les tours sous drapeau. --mode=mean (moyenne des tours propres) et
 * --mode=best (meilleur tour) sont aussi disponibles.
 *
 * Aucune dépendance, aucune écriture réseau : on lit un JSON de session
 * Assetto Corsa (`Result`, `Laps`, `Cars`, `TrackName`, `SessionConfig`).
 *
 * Usage :
 *   node tools/grille-temps-moyens.js data/2026_9_9_21_37_QUALIFY.json --laps=20
 *   node tools/grille-temps-moyens.js <session.json> --laps=15 --mode=mean --csv=grille.csv
 *   node tools/grille-temps-moyens.js <session.json> --laps=20 --json
 *
 * Options :
 *   --laps=N        distance de course en tours (défaut 20)
 *   --mode=x        median (défaut) | mean | best
 *   --trim=P        tours retenus si ≤ meilleur tour × (1 + P/100) (défaut 4)
 *   --min-laps=N    nombre minimum de tours propres pour être classé (défaut 2)
 *   --length=M      longueur du circuit en mètres (sinon lue dans data/circuits.json)
 *   --cap=SEC       compresse toute la grille proportionnellement pour que le
 *                   handicap du plus lent ne dépasse pas SEC secondes
 *   --csv=FICHIER   écrit aussi un CSV
 *   --json          sortie JSON au lieu du tableau
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Lit une session Assetto Corsa (objet déjà parsé accepté aussi). */
function readSession(input) {
  if (input && typeof input === 'object') return input;
  return JSON.parse(fs.readFileSync(input, 'utf8'));
}

/**
 * Rythme d'un pilote à partir de ses temps au tour (ms).
 * @returns {{pace:number, laps:number, kept:number, best:number}}
 */
function paceOf(lapTimesMs, opts) {
  const o = opts || {};
  const trim = Number.isFinite(o.trim) ? o.trim : 4;
  const mode = o.mode || 'median';
  const times = (lapTimesMs || []).map(Number).filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const best = times.length ? times[0] : Infinity;
  const kept = times.filter(t => t <= best * (1 + trim / 100));
  let pace = Infinity;
  if (kept.length) {
    if (mode === 'best') pace = kept[0];
    else if (mode === 'mean') pace = kept.reduce((a, b) => a + b, 0) / kept.length;
    else {
      const n = kept.length;
      pace = n % 2 ? kept[(n - 1) / 2] : (kept[n / 2 - 1] + kept[n / 2]) / 2;
    }
  }
  return { pace, laps: times.length, kept: kept.length, best };
}

/**
 * Construit la grille.
 *
 * @param {object} session  JSON de session (QUALIFY de préférence)
 * @param {object} opts     { laps, mode, trim, minLaps, lengthM }
 * @returns {{session:object, drivers:Array, meta:object}}
 *   drivers : triés du plus mauvais au meilleur rythme (position 1 = devant),
 *   `gapSec` = handicap cumulé à rattraper sur la course (secondes),
 *   `gapM`   = le même écart converti en mètres de piste.
 */
function buildGrid(session, opts) {
  const o = opts || {};
  const laps = Number.isFinite(o.laps) && o.laps > 0 ? o.laps : 20;
  const minLaps = Number.isFinite(o.minLaps) ? o.minLaps : 2;
  const cap = Number.isFinite(o.cap) && o.cap > 0 ? o.cap : null;

  // Les tours sont dans `Laps` (liste) ; on regroupe par GUID quand il existe.
  const byDriver = new Map();
  const names = new Map();
  const guids = new Map();
  for (const l of (session.Laps || [])) {
    const key = l.DriverGuid || l.DriverName;
    if (!key) continue;
    if (!byDriver.has(key)) byDriver.set(key, []);
    byDriver.get(key).push(l.LapTime);
    names.set(key, l.DriverName || key);
    if (l.DriverGuid) guids.set(key, l.DriverGuid);
  }
  // Le Result complète les pilotes qui n'ont pas bouclé un seul tour.
  for (const r of (session.Result || [])) {
    const key = r.DriverGuid || r.DriverName;
    if (!key) continue;
    if (!byDriver.has(key)) byDriver.set(key, []);
    if (!names.has(key)) names.set(key, r.DriverName || key);
    if (r.DriverGuid) guids.set(key, r.DriverGuid);
  }

  const rows = [];
  for (const [key, times] of byDriver) {
    const p = paceOf(times, { mode: o.mode, trim: o.trim });
    rows.push({
      key,
      guid: guids.get(key) || null,
      name: names.get(key) || key,
      pace: p.pace,
      best: p.best,
      laps: p.laps,
      kept: p.kept,
      classified: p.kept >= minLaps
    });
  }

  const classified = rows.filter(r => r.classified && Number.isFinite(r.pace));
  const unclassified = rows.filter(r => !r.classified);

  // Référence = meilleur rythme. On classe du plus mauvais au meilleur :
  // pace décroissant, donc le plus mauvais reçoit la position 1.
  classified.sort((a, b) => b.pace - a.pace);
  const bestPace = classified.length ? classified[classified.length - 1].pace : Infinity;

  const lapTimeRef = classified.length
    ? classified[classified.length - 1].best
    : (Number.isFinite(o.lengthM) && o.lengthM > 0 ? null : null);
  const lengthM = Number.isFinite(o.lengthM) && o.lengthM > 0 ? o.lengthM : null;
  // Vitesse de référence pour convertir les secondes en mètres.
  const speed = (lengthM && Number.isFinite(lapTimeRef) && lapTimeRef > 0) ? lengthM / (lapTimeRef / 1000) : null;

  // --cap : on garde le classement et l'ordre, on comprime les écarts.
  const rawTop = classified.length ? (classified[0].pace - bestPace) / 1000 * laps : 0;
  const scale = (cap && rawTop > cap) ? cap / rawTop : 1;

  classified.forEach((r, i) => {
    r.position = i + 1;
    r.gapSec = (r.pace - bestPace) / 1000 * laps * scale;
    r.gapPerLapSec = (r.pace - bestPace) / 1000;
    r.gapM = speed ? r.gapSec * speed : null;
    r.lapsEquivalent = Number.isFinite(lapTimeRef) && lapTimeRef > 0 ? r.gapSec / (lapTimeRef / 1000) : null;
  });
  // Les non classés (moins de tours propres que le minimum) vont derrière.
  unclassified.sort((a, b) => a.name.localeCompare(b.name)).forEach((r, i) => {
    r.position = classified.length + i + 1;
    r.gapSec = null; r.gapPerLapSec = null; r.gapM = null; r.lapsEquivalent = null;
  });

  const spreadSec = classified.length ? (classified[0].pace - bestPace) / 1000 : 0;
  // Distance maximale « tenable » : au-delà, le handicap du plus lent dépasse
  // un tour de circuit et la grille ne peut plus être posée sur la piste.
  const lapSec = Number.isFinite(lapTimeRef) && lapTimeRef > 0 ? lapTimeRef / 1000 : null;
  const maxLapsForOneLap = (lapSec && spreadSec > 0) ? lapSec / spreadSec : null;
  // « Combien de tours au maximum pour que ce soit faisable ? »
  // Un tour d'écart = au-delà, le plus lent serait hors de la piste au moment
  // où le meilleur passe la ligne. On expose donc la distance max de course
  // pour plusieurs fenêtres de peloton, à écarts normaux et à écarts divisés
  // par deux (les deux pilotes se rejoignent à mi-course).
  const fracs = [1, 0.5, 1 / 3, 0.25];
  const limite = (frac, compression) =>
    (lapSec && spreadSec > 0) ? (frac * lapSec) / (spreadSec * compression) : null;
  const feasibilty = {
    // grille = la totalité de l'écart de rythme (finir ensemble, handicap réel)
    pleine: fracs.map(f => ({ frac: f, laps: limite(f, 1) })),
    // peloton divisé par deux : les voitures se croisent vers la mi-course
    demi: fracs.map(f => ({ frac: f, laps: limite(f, 0.5) }))
  };
  const totalGridM = classified.length > 0 && speed ? (classified[0].gapSec || 0) * speed : null;

  return {
    session: {
      type: session.Type,
      track: session.TrackName,
      config: session.TrackConfig,
      date: session.Date,
      minutes: session.SessionConfig && session.SessionConfig.time
    },
    drivers: classified.concat(unclassified),
    meta: {
      laps,
      mode: o.mode || 'median',
      trim: Number.isFinite(o.trim) ? o.trim : 4,
      minLaps,
      drivers: rows.length,
      classified: classified.length,
      bestPaceMs: Number.isFinite(bestPace) ? bestPace : null,
      spreadSec,
      lapSec,
      lengthM,
      speed,
      maxLapsForOneLap,
      feasible: feasibilty,
      cap,
      scale,
      totalGridM
    }
  };
}

/** Formate des millisecondes en mm:ss.mmm. */
function fmtLap(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms >= 1e17) return '—';
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

function fmtSec(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}s`;
}

function fmtM(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`;
}

/** Tableau texte lisible dans un terminal. */
function renderTable(grid) {
  const m = grid.meta;
  const lines = [];
  lines.push(`Session ${grid.session.type || '?'} · ${grid.session.track || '?'}`
    + (grid.session.config ? ` (${grid.session.config})` : '')
    + (m.minutes ? ` · ${m.minutes} min` : ''));
  lines.push(`Rythme = ${m.mode === 'mean' ? 'moyenne' : m.mode === 'best' ? 'meilleur tour' : 'médiane'}`
    + ` des tours à +${m.trim}% max · course de ${m.laps} tours`
    + (m.cap ? ` · plafond ${m.cap}s` : ''));
  lines.push('');
  const head = ['Grille', 'Pilote', 'Tours', 'Rythme', 'Écart/tour', 'Handicap total', 'Distance']
    .map((h, i) => (i === 0 ? h.padStart(6) : i === 1 ? h.padEnd(20) : h.padStart(14))).join(' ');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const d of grid.drivers) {
    lines.push([
      String(d.position).padStart(6),
      (d.name || '').slice(0, 20).padEnd(20),
      String(d.laps).padStart(14),
      fmtLap(d.pace).padStart(14),
      (Number.isFinite(d.gapPerLapSec) ? fmtSec(d.gapPerLapSec) : '—').padStart(14),
      (Number.isFinite(d.gapSec) ? fmtSec(d.gapSec) : '—').padStart(14),
      fmtM(d.gapM).padStart(14)
    ].join(' '));
  }
  lines.push('');
  if (Number.isFinite(m.spreadSec)) {
    lines.push(`Écart de rythme entre le plus lent et le meilleur : ${m.spreadSec.toFixed(3)} s au tour`);
    if (Number.isFinite(m.totalGridM)) {
      lines.push(`Longueur de grille totale (position 1 → dernier) : ${fmtM(m.totalGridM)}`
        + (m.scale && m.scale < 1 ? `  (grille compressée ×${m.scale.toFixed(2)} par --cap=${m.cap}s)` : ''));
    }
    const top = grid.drivers.find(d => Number.isFinite(d.lapsEquivalent));
    if (top) {
      lines.push(`Poids du handicap du plus lent : ${top.lapsEquivalent.toFixed(2)} tour(s) de circuit`
        + (top.lapsEquivalent > 1 ? '  ⚠ au-delà d’un tour, la grille ne tient plus sur la piste' : ''));
    }
    if (Number.isFinite(m.maxLapsForOneLap)) {
      lines.push(`Distance maximale avant de dépasser 1 tour d’écart : ${m.maxLapsForOneLap.toFixed(1)} tours`
        + (m.laps > m.maxLapsForOneLap ? '  ⚠ ta course est plus longue' : '  ✓ ta course est dans les clous'));
      lines.push('');
      lines.push(renderFeasible(m));
    }
  }
  return lines.join('\n');
}

function renderCsv(grid) {
  const out = ['position;pilote;guid;tours;tours_retenus;rythme_ms;ecart_par_tour_s;handicap_s;distance_m;classe'];
  for (const d of grid.drivers) {
    out.push([
      d.position,
      `"${(d.name || '').replace(/"/g, '""')}"`,
      d.guid || '',
      d.laps,
      d.kept,
      Number.isFinite(d.pace) ? d.pace.toFixed(0) : '',
      Number.isFinite(d.gapPerLapSec) ? d.gapPerLapSec.toFixed(3) : '',
      Number.isFinite(d.gapSec) ? d.gapSec.toFixed(3) : '',
      Number.isFinite(d.gapM) ? d.gapM.toFixed(0) : '',
      d.classified ? 'oui' : 'non'
    ].join(';'));
  }
  return out.join('\n');
}

/**
 * Tableau « nombre de tours maximum » : jusqu'où la course peut aller pour que
 * la grille tienne sur la piste, selon la fraction de tour qu'on accepte
 * d'occuper et selon qu'on garde les écarts pleins ou divisés par deux.
 */
function renderFeasible(m) {
  const label = f => (f === 1 ? '1 tour' : f === 0.5 ? '1/2 tour' : f === 1 / 3 ? '1/3 de tour' : '1/4 de tour');
  const col = v => (Number.isFinite(v) ? v.toFixed(1) + ' tr' : '—').padStart(10);
  const out = [];
  out.push('Longueur de grille tolérée → nombre de tours de course maximum');
  out.push('  peloton                          écarts pleins    écarts ÷ 2');
  m.feasible.pleine.forEach((p, i) => {
    const d = m.feasible.demi[i];
    out.push('  ' + label(p.frac).padEnd(32) + col(p.laps) + col(d.laps));
  });
  const full = m.feasible.pleine[0];
  if (Number.isFinite(full.laps)) {
    out.push(`  → avec toute la grille sur un tour de circuit : ${full.laps.toFixed(1)} tours maximum`);
    out.push(`  → pour une course de ${m.laps} tours : la grille doit tenir dans `
      + `${((m.spreadSec * m.laps) / m.lapSec).toFixed(2)} tour(s), `
      + (m.spreadSec * m.laps / m.lapSec <= 1 ? 'c’est bon' : 'trop long : réduire la distance ou compresser (--cap)'));
  }
  return out.join('\n');
}

/** Ordre GRID_ORDER= attendu par server_cfg.ini (pole → fond de grille). */
function renderGridOrder(grid) {
  const ids = grid.drivers.filter(d => d.guid).map(d => d.guid);
  return ids.length ? `GRID_ORDER=${ids.join(',')}` : '';
}

/** Longueur du circuit, lue dans data/circuits.json quand elle y est. */
function trackLength(trackName, config) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/circuits.json'), 'utf8'));
    const rounds = Array.isArray(c.rounds) ? c.rounds : [];
    const hit = rounds.find(r =>
      (r.driverFolder && trackName && r.driverFolder === trackName) ||
      (r.layoutKey && config && r.layoutKey === config));
    return hit && Number.isFinite(hit.lengthM) ? hit.lengthM : null;
  } catch (e) { return null; }
}

function parseArgs(argv) {
  const out = { file: null };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { if (!out.file) out.file = a; continue; }
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = m[2];
    if (k === 'json') out.json = true;
    else if (k === 'csv') out.csv = v || 'grille.csv';
    else if (['laps', 'trim', 'minLaps', 'length', 'cap'].includes(k) && v !== undefined) out[k] = Number(v);
    else if (k === 'mode') out.mode = v;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage : node tools/grille-temps-moyens.js <session_qualify.json> [--laps=20] [--mode=median|mean|best] [--trim=4] [--csv=fichier.csv] [--json]');
    process.exit(2);
  }
  const session = readSession(args.file);
  if (Number.isFinite(args.length) && !Number.isFinite(args.lengthM)) args.lengthM = args.length;
  if (session.Type && session.Type !== 'QUALIFY') {
    console.error(`⚠ Cette session est de type ${session.Type} ; l’outil est prévu pour une qualification (rythme sur plusieurs tours).`);
  }
  if (!args.length) {
    const len = trackLength(session.TrackName, session.TrackConfig);
    if (len) args.lengthM = len;
  }
  const grid = buildGrid(session, args);
  if (args.json) console.log(JSON.stringify(grid, null, 2));
  else console.log(renderTable(grid));
  if (args.csv) {
    fs.writeFileSync(args.csv, renderCsv(grid) + '\n');
    if (!args.json) console.error(`\nCSV écrit : ${args.csv}`);
  }
  if (!args.json) {
    const order = renderGridOrder(grid);
    if (order) console.log(`\n${order}`);
  }
}

module.exports = { buildGrid, paceOf, renderTable, renderFeasible, renderCsv, renderGridOrder, fmtLap };

if (require.main === module) main();

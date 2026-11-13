'use strict';
/*
 * Export du rapport BoP dans les trois formats demandés :
 *   - CSV  → tableur (Excel / LibreOffice), séparateur « ; », décimales à la
 *            française, encodage UTF-8 avec BOM pour qu'Excel n'abîme pas les
 *            accents ;
 *   - Markdown → lisible dans GitHub / un message ;
 *   - HTML → imprimable en PDF, mise en page GDSP.
 *
 * Le contenu est identique dans les trois : mêmes chiffres, mêmes unités,
 * même avertissement sur les données estimées. Un rapport ne doit pas changer
 * de sens selon le format dans lequel on l'ouvre.
 */

const { compareCars, fmtLap, fmtDelta } = require('./bop');
const { plausibleCarId } = require('./aggregate');

const DURATIONS = [20, 30, 45];

/** Valeur numérique → texte français (virgule décimale). */
function num(v, decimals = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(decimals).replace('.', ',');
}

/**
 * Libellé de voiture dans le rapport : un identifiant hérité du bug car.id
 * (`function: 0x…`) ne désigne aucune voiture — on le dit au lieu de le
 * présenter comme un modèle.
 */
function carLabel(row) {
  return row && row.unidentified ? '(voiture non identifiée)' : row && row.car;
}

/** Construit les lignes du rapport (une par voiture). */
function buildRows(cars, opts = {}) {
  const durations = opts.durationsMin || DURATIONS;
  const rows = [];
  for (const row of compareCars(cars, durations)) {
    if (!row.model || !row.model.ok) {
      rows.push({
        car: row.car, unidentified: !plausibleCarId(row.car),
        circuit: row.circuit, driver: row.driver,
        incomplete: true,
        missing: (row.model && row.model.missing) || [],
        medianLapMs: null, bestLapMs: opts.bestLaps ? opts.bestLaps[row.car] : null
      });
      continue;
    }
    const m = row.model;
    const out = {
      car: row.car,
      unidentified: !plausibleCarId(row.car),
      circuit: row.circuit || null,
      driver: row.driver || null,
      medianLapMs: m.medianLapMs,
      bestLapMs: opts.bestLaps && opts.bestLaps[row.car] != null ? opts.bestLaps[row.car] : null,
      fuelPerLap: m.fuelPerLap,
      tyreWearPerLap: m.tyreWearPerLap,
      fuelCapacity: m.fuelCapacity,
      refuelRateLps: m.refuelRateLps,
      pitLaneLossMs: m.pitLaneLossMs,
      tyreChangeMs: m.tyreChangeMs,
      fuelStintLaps: m.fuelStintLaps,
      tyreStintLaps: m.tyreStintLaps,
      incomplete: false,
      byDuration: {}
    };
    for (const min of durations) {
      const f = row.fixed[min];
      const b = row.byDuration[min];
      out.byDuration[min] = f ? {
        refLaps: f.refLaps,
        raceTimeMs: f.raceTimeMs,
        deltaToBestMs: f.deltaToBestMs,
        stops: f.stops,
        fuelStops: f.fuelStops,
        tyreStops: f.tyreStops,
        stopTimeMs: f.stopTimeMs,
        effectiveLapMs: f.effectiveLapMs,
        lapsInTime: b ? b.laps : null,
        lapsLost: b && f.refLaps != null ? f.refLaps - b.laps : null
      } : null;
    }
    rows.push(out);
  }
  // Classement : meilleure voiture en tête, selon le delta de la PREMIÈRE durée
  // demandée (20 min par défaut). Les incomplètes vont en fin de tableau.
  const first = durations[0];
  return rows.sort((a, b) => {
    if (a.incomplete !== b.incomplete) return a.incomplete ? 1 : -1;
    const da = a.byDuration && a.byDuration[first] ? a.byDuration[first].deltaToBestMs : Infinity;
    const db = b.byDuration && b.byDuration[first] ? b.byDuration[first].deltaToBestMs : Infinity;
    if (da !== db) return da - db;
    return String(a.car).localeCompare(String(b.car), 'fr');
  });
}

const HEADER = [
  'voiture', 'circuit', 'pilote',
  'meilleur tour', 'tour médian', 'régularité (s)',
  'L/tour', 'gomme %/tour', 'réservoir (L)', 'autonomie essence (tours)', 'autonomie gomme (tours)',
  'pit-lane (s)', 'ravitaillement (L/s)', 'changement gommes (s)'
];
for (const min of DURATIONS) {
  HEADER.push(
    `${min}min — tours au drapeau`, `${min}min — arrêts`, `${min}min — temps aux stands (s)`,
    `${min}min — temps de course à distance égale`, `${min}min — delta`
  );
}

function rowToArray(row) {
  if (row.incomplete) {
    const base = [carLabel(row), row.circuit || '—', row.driver || '—'];
    base.push(fmtLap(row.bestLapMs), '—', '—', '—', '—', '—', '—', '—', '—', '—', '—');
    for (let i = 0; i < DURATIONS.length; i++) base.push('—', '—', '—', '—', 'données incomplètes');
    return base;
  }
  const base = [
    carLabel(row),
    row.circuit || '—',
    row.driver || '—',
    fmtLap(row.bestLapMs),
    fmtLap(row.medianLapMs),
    num(row.modelStdevMs != null ? row.modelStdevMs / 1000 : null, 3),
    num(row.fuelPerLap, 2),
    num(row.tyreWearPerLap, 2),
    num(row.fuelCapacity, 1),
    num(row.fuelStintLaps, 1),
    num(row.tyreStintLaps, 1),
    num(row.pitLaneLossMs / 1000, 1),
    num(row.refuelRateLps, 2),
    num(row.tyreChangeMs / 1000, 1)
  ];
  for (const min of DURATIONS) {
    const d = row.byDuration[min];
    if (!d) { base.push('—', '—', '—', '—', '—'); continue; }
    base.push(
      String(d.refLaps != null ? d.refLaps : '—'),
      String(d.stops),
      num(d.stopTimeMs / 1000, 1),
      fmtLap(d.raceTimeMs),
      fmtDelta(d.deltaToBestMs)
    );
  }
  return base;
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, meta = {}) {
  const lines = [];
  lines.push(csvEscape(`Rapport BoP GDSP — ${meta.campaign || 'campagne'} — généré le ${meta.generatedAt || new Date().toISOString()}`));
  lines.push(csvEscape(`Circuits : ${[...new Set(rows.map(r => r.circuit).filter(Boolean))].join(', ') || '—'}`));
  lines.push(csvEscape('Mesures réelles uniquement ; toute valeur estimée est exclue du calcul.'));
  lines.push('');
  lines.push(HEADER.map(csvEscape).join(';'));
  for (const row of rows) lines.push(rowToArray(row).map(csvEscape).join(';'));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function mdEscape(v) { return String(v == null ? '—' : v).replace(/\|/g, '\\|'); }

function toMarkdown(rows, matrix = null, meta = {}) {
  const out = [];
  out.push(`# Rapport BoP GDSP — ${meta.campaign || 'campagne'}`);
  out.push('');
  out.push(`Généré le ${meta.generatedAt || new Date().toISOString()}.`);
  out.push('');
  out.push('> Seules les **mesures réelles** entrent dans ce rapport. Une valeur estimée');
  out.push('> est exclue du calcul : mieux vaut une case vide qu\'un chiffre faux.');
  out.push('');
  out.push('## Synthèse par voiture');
  out.push('');
  out.push('| Voiture | Circuit | Tour médian | L/tour | Gomme %/tour | Autonomie essence | Autonomie gomme |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    if (r.incomplete) {
      out.push(`| ${mdEscape(carLabel(r))} | ${mdEscape(r.circuit)} | — | — | — | — | — |`);
      continue;
    }
    out.push(`| ${mdEscape(carLabel(r))} | ${mdEscape(r.circuit)} | ${fmtLap(r.medianLapMs)} | ${num(r.fuelPerLap)} | ${num(r.tyreWearPerLap)} | ${num(r.fuelStintLaps, 1)} tours | ${num(r.tyreStintLaps, 1)} tours |`);
  }
  out.push('');
  out.push('## Temps de course simulés');
  for (const min of DURATIONS) {
    out.push('');
    out.push(`### ${min} minutes`);
    out.push('');
    out.push('| Voiture | Tours au drapeau | Arrêts | Temps aux stands | Course (distance égale) | Delta |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const d = r.byDuration && r.byDuration[min];
      if (!d) { out.push(`| ${mdEscape(carLabel(r))} | — | — | — | — | — |`); continue; }
      out.push(`| ${mdEscape(carLabel(r))} | ${d.refLaps} | ${d.stops} | ${num(d.stopTimeMs / 1000, 1)} s | ${fmtLap(d.raceTimeMs)} | ${fmtDelta(d.deltaToBestMs)} |`);
    }
  }
  if (matrix) {
    out.push('');
    out.push('## Matrice pilote × voiture (tour médian)');
    out.push('');
    if (matrix.cars.length < 2) {
      out.push('_Une seule voiture identifiée : la comparaison entre voitures attendra');
      out.push('la deuxième._');
    } else if (!matrix.driversCommon.length) {
      out.push('_Aucun pilote n\'a roulé dans toutes les voitures comparées : la comparaison');
      out.push('entre voitures n\'est pas encore possible sans mélanger le talent du pilote');
      out.push('et la performance de la voiture._');
    } else {
      out.push(`| Pilote | ${matrix.cars.map(c => mdEscape(c)).join(' | ')} |`);
      out.push(`| --- | ${matrix.cars.map(() => '---').join(' | ')} |`);
      for (const guid of matrix.driversCommon) {
        const cells = matrix.cars.map(car => {
          const cell = matrix.cells[`${guid}|${car}`];
          return cell ? fmtLap(cell.medianLapMs) : '—';
        });
        out.push(`| ${mdEscape(guid)} | ${cells.join(' | ')} |`);
      }
      out.push('');
      out.push('| Voiture | Delta moyen à pilote constant |');
      out.push('| --- | --- |');
      for (const car of matrix.cars) {
        const d = matrix.carDeltas[car];
        out.push(`| ${mdEscape(car)} | ${fmtDelta(d.deltaMs)} (${d.drivers} pilote${d.drivers > 1 ? 's' : ''}) |`);
      }
    }
    if (matrix.excludedUnidentified) {
      out.push('');
      out.push(`_${matrix.excludedUnidentified} voiture${matrix.excludedUnidentified > 1 ? 's' : ''} non identifiée${matrix.excludedUnidentified > 1 ? 's' : ''} (identifiant illisible, bug corrigé depuis) : tours conservés dans la synthèse, hors comparaison._`);
    }
  }
  out.push('');
  out.push('## Lecture');
  out.push('');
  out.push('- **Temps de course à distance égale** : temps mis pour couvrir la distance du');
  out.push('  vainqueur. C\'est le chiffre qui compte, pas le meilleur tour.');
  out.push('- **Delta** : retard sur la meilleure voiture. Positif = plus lente en course.');
  out.push('- **Arrêts** : passages aux stands nécessaires (essence **ou** gommes).');
  out.push('  Une voiture rapide mais gourmande apparaît ici.');
  out.push('');
  return out.join('\n');
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toHtml(rows, matrix = null, meta = {}) {
  const durations = DURATIONS;
  const cell = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
  const carRows = rows.map(r => {
    if (r.incomplete) {
      return `<tr><td class="car">${esc(carLabel(r))}</td>${cell(r.circuit)}<td colspan="10" class="warn">données incomplètes : ${esc((r.missing || []).join(', '))}</td></tr>`;
    }
    const stops = durations.map(min => {
      const d = r.byDuration[min];
      return d ? `<td class="num">${d.stops}${d.stopTimeMs ? `<span class="sub">${num(d.stopTimeMs / 1000, 1)} s</span>` : ''}</td>` : cell('—');
    }).join('');
    const races = durations.map(min => {
      const d = r.byDuration[min];
      if (!d) return cell('—');
      const cls = d.deltaToBestMs === 0 ? 'best' : d.deltaToBestMs > 30000 ? 'bad' : '';
      return `<td class="num ${cls}">${esc(fmtLap(d.raceTimeMs))}<span class="sub">${esc(fmtDelta(d.deltaToBestMs))}</span></td>`;
    }).join('');
    return `<tr>
      <td class="car">${esc(carLabel(r))}</td>
      <td>${esc(r.circuit || '—')}</td>
      <td class="num">${esc(fmtLap(r.bestLapMs))}</td>
      <td class="num">${esc(fmtLap(r.medianLapMs))}</td>
      <td class="num">${esc(num(r.fuelPerLap))}</td>
      <td class="num">${esc(num(r.tyreWearPerLap))}</td>
      <td class="num">${esc(num(r.fuelStintLaps, 1))}</td>
      <td class="num">${esc(num(r.tyreStintLaps, 1))}</td>
      ${stops}
      ${races}
    </tr>`;
  }).join('\n');

  const matrixNote = matrix && matrix.excludedUnidentified
    ? `<p class="note">${matrix.excludedUnidentified} voiture${matrix.excludedUnidentified > 1 ? 's' : ''} non identifiée${matrix.excludedUnidentified > 1 ? 's' : ''} (identifiant illisible, bug corrigé depuis) : tours conservés dans la synthèse, hors comparaison.</p>` : '';
  const matrixHtml = !matrix
    ? ''
    : matrix.cars.length < 2
    ? `<h2>Matrice pilote × voiture</h2><p class="warn">Une seule voiture identifiée : la comparaison entre voitures attendra la deuxième.</p>${matrixNote}`
    : matrix.driversCommon.length
    ? `<h2>Matrice pilote × voiture</h2>
       <p class="note">Comparaison à pilote constant : le delta ne mesure que la voiture.</p>
       <table class="bop">
         <thead><tr><th>Pilote</th>${matrix.cars.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
         <tbody>
         ${matrix.driversCommon.map(guid => `<tr><td>${esc(guid)}</td>${matrix.cars.map(car => {
           const c = matrix.cells[`${guid}|${car}`];
           return `<td class="num">${esc(c ? fmtLap(c.medianLapMs) : '—')}</td>`;
         }).join('')}</tr>`).join('')}
         </tbody>
       </table>
       <table class="bop small"><thead><tr><th>Voiture</th><th>Delta moyen à pilote constant</th></tr></thead><tbody>
       ${matrix.cars.map(car => `<tr><td>${esc(car)}</td><td class="num">${esc(fmtDelta(matrix.carDeltas[car].deltaMs))}</td></tr>`).join('')}
       </tbody></table>${matrixNote}`
    : `<h2>Matrice pilote × voiture</h2><p class="warn">Aucun pilote n'a roulé dans toutes les voitures comparées : la comparaison entre voitures n'est pas encore possible sans confondre le pilote et la voiture.</p>${matrixNote}`;

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>Rapport BoP — ${esc(meta.campaign || 'GDSP')}</title>
<style>
  :root{--ink:#12303a;--paper:#f8f3e6;--gold:#d7a347;--red:#9c3021;--line:#cbbf9e}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:var(--paper);color:var(--ink);font:13px/1.5 "Helvetica Neue",Arial,sans-serif}
  h1{font-family:Impact,sans-serif;font-weight:normal;letter-spacing:1px;text-transform:uppercase;font-size:26px;margin:0 0 4px}
  h2{font-family:Impact,sans-serif;font-weight:normal;letter-spacing:1px;text-transform:uppercase;font-size:17px;margin:26px 0 8px;border-bottom:2px solid var(--gold);padding-bottom:5px}
  .meta{color:#5b6b6a;font-size:12px;margin-bottom:16px}
  table.bop{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08)}
  table.bop th{background:var(--ink);color:#f8f2e4;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;padding:7px 6px;text-align:left;vertical-align:bottom}
  table.bop td{padding:6px;border-bottom:1px solid #e6dfcd;vertical-align:top}
  table.bop tr:nth-child(even) td{background:#fdfbf5}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sub{display:block;font-size:10px;color:#7a8785}
  .car{font-weight:bold}
  .best{background:#e8f5e9!important}
  .bad{background:#fdecea!important}
  .warn{color:var(--red);font-weight:bold}
  .note{color:#5b6b6a;font-size:12px}
  table.small{width:auto;margin-top:10px}
  footer{margin-top:26px;font-size:11px;color:#7a8785;border-top:1px solid var(--line);padding-top:10px}
  @media print{body{background:#fff;padding:0}table.bop{box-shadow:none;border:1px solid #ddd}h2{page-break-after:avoid}}
</style></head><body>
<h1>Balance of Performance — GDSP</h1>
<div class="meta">Campagne ${esc(meta.campaign || '—')} · généré le ${esc(meta.generatedAt || new Date().toISOString())} · ${rows.length} voiture${rows.length > 1 ? 's' : ''}</div>
<div class="note">Seules les <b>mesures réelles</b> entrent dans ce rapport. Une valeur estimée est exclue : mieux vaut une case vide qu'un chiffre faux.</div>

<h2>Synthèse par voiture</h2>
<table class="bop">
  <thead><tr>
    <th>Voiture</th><th>Circuit</th><th>Meilleur tour</th><th>Tour médian</th>
    <th>L/tour</th><th>Gomme %/tour</th><th>Autonomie essence</th><th>Autonomie gomme</th>
    <th>Arrêts 20′</th><th>Arrêts 30′</th><th>Arrêts 45′</th>
    <th>Course 20′</th><th>Course 30′</th><th>Course 45′</th>
  </tr></thead>
  <tbody>
${carRows}
  </tbody>
</table>
${matrixHtml}
<footer>
  Temps de course « à distance égale » : temps mis pour couvrir la distance du vainqueur, arrêts inclus.
  Delta positif = retard sur la meilleure voiture. Une voiture rapide mais gourmande paie ses arrêts ici.
</footer>
</body></html>`;
}

/** Génère les trois formats d'un coup. */
function buildReport(cars, opts = {}) {
  const meta = {
    campaign: opts.campaign || 'campagne',
    generatedAt: opts.generatedAt || new Date().toISOString()
  };
  const rows = buildRows(cars, opts);
  return {
    rows,
    meta,
    files: {
      csv: toCsv(rows, meta),
      markdown: toMarkdown(rows, opts.matrix, meta),
      html: toHtml(rows, opts.matrix, meta)
    }
  };
}

module.exports = { buildRows, buildReport, toCsv, toMarkdown, toHtml, HEADER, DURATIONS };

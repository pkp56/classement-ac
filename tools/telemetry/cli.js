#!/usr/bin/env node
'use strict';
/*
 * Ligne de commande du rapport BoP.
 *
 *   node tools/telemetry/cli.js report --campaign campagne-2026-11
 *   node tools/telemetry/cli.js report --campaign test-monza --cars cars.json
 *   node tools/telemetry/cli.js campaign --campaign campagne-2026-11
 *   node tools/telemetry/cli.js demo --out reports/   (jeu d'exemple, vérifiable)
 *
 * `cars.json` : tableau d'objets { car, circuit, medianLapMs, fuelPerLap,
 * fuelCapacity, tyreWearPerLap, pitLaneLossMs, refuelRateLps, tyreChangeMs }.
 *
 * Le rapport n'est généré que si la campagne est complète ; `--force` passe
 * outre mais inscrit un avertissement en tête des trois fichiers.
 */

const fs = require('fs');
const path = require('path');
const { buildReport } = require('./export');
const { evaluateCampaign } = require('./campaign');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function writeFiles(report, outDir, prefix) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, prefix);
  const files = {};
  for (const [ext, content] of Object.entries(report.files)) {
    const name = ext === 'markdown' ? `${base}.md` : `${base}.${ext}`;
    fs.writeFileSync(name, content, 'utf8');
    files[ext] = name;
  }
  return files;
}

function loadCampaignData(campaign, baseDir = process.cwd()) {
  const file = path.join(baseDir, 'data', 'telemetry', `${campaign}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const cmd = args._[0] || 'report';
  // `demo` lit le jeu d'exemple du dépôt : sans --campaign, il doit tomber
  // dessus tout seul (c'est la commande que le README fait lancer).
  const campaign = args.campaign || (cmd === 'demo' ? 'demo-monza-junior' : 'campagne');
  const outDir = path.resolve(args.out || 'reports');
  const cwd = process.cwd();

  const data = args.cars
    ? { cars: JSON.parse(fs.readFileSync(path.resolve(args.cars), 'utf8')) }
    : loadCampaignData(campaign, cwd);

  if (!data || !Array.isArray(data.cars) || !data.cars.length) {
    console.error(`Aucune donnée pour la campagne « ${campaign} ».`);
    console.error(`Attendu : data/telemetry/${campaign}.json avec un tableau "cars",`);
    console.error('ou un fichier passé avec --cars.');
    return 2;
  }

  if (cmd === 'campaign') {
    const evaluation = evaluateCampaign(data);
    console.log(`Campagne ${campaign} — ${evaluation.days.filter(d => d.ok).length}/${evaluation.days.length} jours validés`);
    for (const d of evaluation.days) {
      console.log(`${d.ok ? '✓' : '✗'} J${String(d.day).padStart(2)} ${d.title}${d.ok ? '' : ' — ' + d.missing.join(' ; ')}`);
    }
    console.log(`\nCouverture : ${evaluation.coverage.laps} tours, ${evaluation.coverage.lapsWithFuel} avec carburant, ` +
      `${evaluation.coverage.lapsWithTyre} avec usure, ${evaluation.coverage.drivers} pilote(s), ${evaluation.coverage.cars} voiture(s).`);
    if (!evaluation.ready) {
      console.log('\nCampagne incomplète : le rapport BoP ne serait pas défendable.');
      return 1;
    }
    return 0;
  }

  if (cmd === 'report' || cmd === 'demo') {
    const evaluation = evaluateCampaign(data);
    if (!evaluation.ready && !args.force) {
      console.error('Campagne incomplète — rapport non généré.');
      for (const block of evaluation.blocking) console.error(`  ✗ ${block}`);
      console.error('\nLance `node tools/telemetry/cli.js campaign` pour le détail, ou ajoute --force');
      console.error('(le rapport portera alors un avertissement explicite).');
      return 1;
    }
    const report = buildReport(data.cars, { campaign, matrix: data.matrix || null });
    if (!evaluation.ready) {
      const warn = 'AVERTISSEMENT : campagne incomplète, chiffres à ne pas utiliser pour une décision de BoP.';
      report.files.csv = report.files.csv.replace('Mesures réelles uniquement', warn + ' Mesures réelles uniquement');
      report.files.markdown = report.files.markdown.replace('# Rapport BoP', `> ⚠️ ${warn}\n\n# Rapport BoP`);
      report.files.html = report.files.html.replace('<h1>', `<div class="warn" style="font-weight:bold;color:#9c3021;margin-bottom:10px">${warn}</div>\n<h1>`);
    }
    const files = writeFiles(report, outDir, `bop-${campaign}-${new Date().toISOString().slice(0, 10)}`);
    console.log(`Rapport généré pour ${campaign} (${report.rows.length} voiture${report.rows.length > 1 ? 's' : ''}) :`);
    for (const [kind, file] of Object.entries(files)) console.log(`  ${kind.padEnd(9)} ${path.relative(cwd, file)}`);
    return 0;
  }

  console.error(`Commande inconnue : ${cmd}`);
  console.error('Commandes : report, campaign, demo');
  return 2;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { main, parseArgs, loadCampaignData };

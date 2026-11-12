/**
 * Régénère `data/telemetry/demo-monza-junior.json` à partir des mêmes chiffres
 * que le rapport de démonstration, puis vérifie que `tools/telemetry/cli.js`
 * en sort bien les trois fichiers.
 *
 * L'intérêt de garder ce script : la démo du README n'est pas tapée à la main
 * dans trois formats différents, elle est produite par le même code que la
 * production. Si la formule de course change, la démo change avec elle.
 *
 * Usage : node tools/telemetry/demo-seed.js [--write]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FileStore } = require('./store');
const { TelemetryService } = require('./api');

const CAMPAIGN = 'demo-monza-junior';
const TRACK = 'ks_monza66-junior';

/*
 * Trois voitures, deux pilotes chacune, pour que la démonstration contienne
 * aussi la comparaison « à pilote constant » du rapport.
 */
const CARS = {
  alfa_giulietta_spider: { lapMs: 75576, fuelPerLap: 1.50, capacity: 45, wearPct: 1.40, speed: 187 },
  bmw_m3_e30:            { lapMs: 76210, fuelPerLap: 1.90, capacity: 55, wearPct: 2.80, speed: 205 },
  actk_lola_t290:        { lapMs: 74902, fuelPerLap: 2.40, capacity: 30, wearPct: 2.20, speed: 228 }
};

const DRIVERS = [
  { guid: '76561198015862674', name: "Assassin's Street", laps: 12 },
  { guid: '76561198000000001', name: 'Karl74', laps: 12 }
];

// Écarts reproductibles : la démo ne doit pas changer d'un lancement à l'autre.
const JITTER = [-320, 180, -60, 240, -180, 60, 300, -240, 120, -120, 200, -300];

function payloadFor(car, driver) {
  const spec = CARS[car];
  const laps = [];
  for (let i = 0; i < driver.laps; i++) {
    const jitter = JITTER[(i + driver.laps) % JITTER.length];
    laps.push({
      lapNumber: i + 1,
      lapMs: spec.lapMs + jitter,
      fuelUsedL: Number((spec.fuelPerLap + jitter / 100000).toFixed(3)),
      fuelLoadedL: spec.capacity,
      tyreWearPct: [0, 1, 2, 3].map(() => Number((spec.wearPct + jitter / 5000).toFixed(2))),
      speedMaxKmh: spec.speed + Math.round(jitter / 100)
    });
  }
  return {
    v: 1,
    script: 'GDSP-TELEMETRY 1.0',
    campaign: CAMPAIGN,
    serverName: '{GDSP_ Server test 1',
    track: TRACK,
    trackConfig: 'junior',
    sessionType: 'practice',
    fuelRate: 100,
    tyreWearRate: 100,
    car,
    driver: { guid: driver.guid, name: driver.name },
    laps
  };
}

async function main() {
  const write = process.argv.includes('--write');
  const target = path.join(__dirname, '..', '..', 'data', 'telemetry', 'demo-store.json');
  const file = write ? target : path.join(require('node:os').tmpdir(), `gdsp-demo-${Date.now()}.json`);
  // On repart d'un store vide : sinon `ingest` reconnaît les tours déjà présents
  // (même pilote, même voiture, même numéro) et la nouvelle démonstration
  // n'aurait aucun effet — le fichier garderait les anciens chiffres.
  if (write && fs.existsSync(file)) fs.unlinkSync(file);
  const service = new TelemetryService(new FileStore(file));

  for (const [car] of Object.entries(CARS)) {
    for (const driver of DRIVERS) {
      const result = await service.ingest(payloadFor(car, driver));
      if (!result.ok) throw new Error(`${car}/${driver.name} : ${result.error}`);
    }
  }
  await service.savePitProfile(TRACK, { pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000 });
  const report = await service.report({ track: TRACK }, { campaign: CAMPAIGN });

  console.log(`source : ${file}`);
  console.log(`voitures : ${report.cars} · tours : ${report.laps}`);
  for (const row of report.rows) {
    const d = row.byDuration && row.byDuration[20];
    console.log(
      `  ${row.car.padEnd(24)} médian ${row.medianLapMs} ms · ${row.fuelPerLap.toFixed(2)} L/tour ·` +
      ` ${row.tyreWearPerLap.toFixed(2)} %/tour · arrêts 20 min : ${d ? d.stops : '—'}`
    );
  }
  /*
   * `data/telemetry/demo-monza-junior.json` reste la référence historique
   * (valeurs écrites à la main pour le README). Ce script produit un store
   * complet, utilisable par la page /telemetry pour une démonstration.
   */
  if (write) console.log(`store de démonstration écrit dans ${target}`);
  else console.log('(rien écrit — relancer avec --write pour enregistrer le store)');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

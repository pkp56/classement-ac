'use strict';
/*
 * Stockage et collecte de la télémétrie.
 * Deux propriétés à ne jamais casser :
 *   - l'isolation du schéma `telemetry` (le championnat ne doit jamais être
 *     touché, ni lisible par ce module) ;
 *   - aucune valeur inventée : ce qui n'est pas mesuré reste vide.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SCHEMA, SCHEMA_SQL, schemaStatements, FileStore, openStore } = require('../tools/telemetry/store');
const { TelemetryCollector } = require('../tools/telemetry/collector');
const { carProfile, driverCarMatrix, sessionContextMissing, field } = require('../tools/telemetry/aggregate');

function tmpFile(name = 'telemetry.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-tel-'));
  return path.join(dir, name);
}

test('le schéma s\'appelle telemetry et ne référence aucune table du championnat', () => {
  assert.equal(SCHEMA, 'telemetry');
  // Aucune clé étrangère vers autre chose que telemetry.*
  const fkRefs = [...SCHEMA_SQL.matchAll(/REFERENCES\s+([a-z_.]+)/gi)].map(m => m[1]);
  assert.ok(fkRefs.length > 0);
  for (const ref of fkRefs) assert.match(ref, /^telemetry\./, `référence hors schéma : ${ref}`);
  // Aucune mention des tables du site.
  for (const forbidden of ['sessions', 'events', 'championship', 'penalties']) {
    assert.doesNotMatch(SCHEMA_SQL, new RegExp(`\\b${forbidden}\\b`, 'i'), `le schéma ne doit pas toucher « ${forbidden} »`);
  }
});

test('le schéma crée les quatre tables attendues', () => {
  const stmts = schemaStatements().join('\n');
  for (const table of ['session', 'stint', 'lap', 'circuit_profile']) {
    assert.match(stmts, new RegExp(`CREATE TABLE IF NOT EXISTS telemetry\\.${table}`, 'i'));
  }
  assert.ok(stmts.includes('CREATE SCHEMA IF NOT EXISTS telemetry'));
});

test('le schéma ne met aucune expression dans une contrainte UNIQUE de table', () => {
  // Postgres refuse `CONSTRAINT x UNIQUE (a, COALESCE(b,''))` : « syntax error
  // at or near "(" ». Le schéma échouait donc à l'initialisation, et TOUTE la
  // télémétrie échouait alors que la base était branchée. L'unicité sur
  // expression doit passer par un CREATE UNIQUE INDEX.
  for (const stmt of schemaStatements()) {
    if (/^\s*CREATE TABLE/i.test(stmt)) {
      assert.doesNotMatch(stmt, /UNIQUE\s*\([^)]*\(/i,
        `expression dans une contrainte UNIQUE : ${stmt.split('\n')[0]}`);
    }
  }
  const stmts = schemaStatements().join('\n');
  assert.match(stmts, /CREATE UNIQUE INDEX IF NOT EXISTS session_unique_run\s+ON telemetry\.session \(started_at, track, COALESCE\(track_config, ''\)\)/i);
  assert.match(stmts, /CREATE UNIQUE INDEX IF NOT EXISTS circuit_profile_unique/i);
});

test('une session sans circuit est refusée (sinon rien n\'est comparable)', async () => {
  const collector = new TelemetryCollector(new FileStore(null));
  await assert.rejects(() => collector.openSession({ fuelRate: 100 }), /circuit/);
});

test('un tour sans identité pilote ou sans temps est refusé', async () => {
  const collector = new TelemetryCollector(new FileStore(null));
  await collector.openSession({ track: 'monza' });
  await assert.rejects(() => collector.recordLap({ car: 'alfa', lapMs: 75000 }), /pilote/);
  await assert.rejects(() => collector.recordLap({ car: 'alfa', driverGuid: 'G1' }), /LapTime|tour invalide/);
  await assert.rejects(() => collector.recordLap({ driverGuid: 'G1', lapMs: 75000 }), /voiture/);
});

test('un tour sans mesure de conso garde la conso vide, sans rien inventer', async () => {
  const store = new FileStore(tmpFile());
  const collector = new TelemetryCollector(store);
  await collector.openSession({ track: 'monza', fuelRate: 100, tyreWearRate: 100 });
  const lap = await collector.recordLap({ driverGuid: 'G1', car: 'alfa', lapMs: 75000 });
  assert.equal(lap.fuel_used_l, null);
  assert.equal(lap.tyre_wear_pct, null);
  assert.equal(lap.measured, true, 'le chrono, lui, est bien mesuré');
});

test('un même tour renvoyé deux fois n\'est compté qu\'une fois', async () => {
  const collector = new TelemetryCollector(new FileStore(null));
  await collector.openSession({ track: 'monza' });
  const lap = { driverGuid: 'G1', car: 'alfa', lapNumber: 4, lapMs: 75000, fuelUsedL: 1.5 };
  await collector.recordLap(lap);
  await collector.recordLap(lap);
  await collector.recordLap(Object.assign({}, lap, { lapMs: 75003 })); // renvoi arrondi
  assert.equal(collector.stats.laps, 1);
  assert.equal(collector.stats.duplicates, 2);
});

test('les données survivent à une réouverture (d\'une session à l\'autre)', async () => {
  const file = tmpFile();
  const store = new FileStore(file);
  const collector = new TelemetryCollector(store);
  await collector.openSession({ track: 'monza', fuelRate: 100, tyreWearRate: 100 });
  await collector.recordLap({ driverGuid: 'G1', car: 'alfa', lapNumber: 1, lapMs: 75000, fuelUsedL: 1.5, tyreWearPct: 1.4 });
  await store.close();

  const reopened = new FileStore(file);
  const laps = await reopened.select('lap');
  assert.equal(laps.length, 1);
  assert.equal(Number(laps[0].fuel_used_l), 1.5);
});

test('openStore sans DATABASE_URL utilise le fichier, avec la même API', async () => {
  const saved = process.env.TELEMETRY_DATABASE_URL;
  delete process.env.TELEMETRY_DATABASE_URL;
  try {
    const store = await openStore({ file: tmpFile('s.json') });
    assert.equal(store.kind, 'file');
    await store.insert('session', { track: 'monza' });
    assert.equal((await store.select('session')).length, 1);
  } finally {
    if (saved != null) process.env.TELEMETRY_DATABASE_URL = saved;
  }
});

test('carProfile lit aussi bien le camelCase de l\'agent que le snake_case de la base', () => {
  const camel = [{ driverGuid: 'G1', car: 'alfa', lapMs: 75000, fuelUsedL: 1.5, tyreWearPct: 1.4, speedMaxKmh: 190 }];
  const snake = [{ driver_guid: 'G1', car: 'alfa', lap_ms: 75000, fuel_used_l: 1.5, tyre_wear_pct: 1.4, speed_max_kmh: 190 }];
  const a = carProfile({ car: 'alfa', track: 'monza' }, camel);
  const b = carProfile({ car: 'alfa', track: 'monza' }, snake);
  assert.equal(a.medianLapMs, 75000);
  assert.equal(b.medianLapMs, 75000);
  assert.equal(a.fuelPerLap, 1.5);
  assert.equal(b.fuelPerLap, 1.5);
  assert.equal(field(snake[0], 'lapMs', 'lap_ms'), 75000);
});

test('un tour coupé est exclu du calcul de consommation', () => {
  const laps = [
    { driverGuid: 'G1', car: 'alfa', lapMs: 75000, cuts: 0, fuelUsedL: 1.5 },
    { driverGuid: 'G1', car: 'alfa', lapMs: 82000, cuts: 3, fuelUsedL: 0.4 } // tour raté, conso absurde
  ];
  const profile = carProfile({ car: 'alfa', track: 'monza' }, laps);
  assert.equal(profile.fuelPerLap, 1.5, 'la conso d\'un tour coupé ne doit pas polluer la moyenne');
});

test('matrice pilote × voiture : seuls les pilotes ayant roulé TOUTES les voitures comptent', () => {
  const laps = [
    { driverGuid: 'A', car: 'lola', lapMs: 74902 },
    { driverGuid: 'A', car: 'alfa', lapMs: 75576 },
    { driverGuid: 'B', car: 'lola', lapMs: 75310 },
    { driverGuid: 'B', car: 'alfa', lapMs: 75880 },
    { driverGuid: 'C', car: 'lola', lapMs: 74000 } // n'a jamais roulé l'Alfa
  ];
  const matrix = driverCarMatrix(laps);
  assert.deepEqual(matrix.cars, ['alfa', 'lola']);
  assert.deepEqual(matrix.driversCommon.sort(), ['A', 'B']);
  // Delta moyen à pilote constant : la Lola est 0,622 s plus rapide.
  assert.ok(Math.abs(matrix.carDeltas.lola.deltaMs) < 1, 'la Lola est la référence');
  assert.ok(Math.abs(matrix.carDeltas.alfa.deltaMs - 622) < 1);
  assert.equal(matrix.carDeltas.alfa.drivers, 2);
});

test('une session sans FUEL_RATE / TYRE_WEAR_RATE est signalée comme incomparable', () => {
  assert.deepEqual(sessionContextMissing({ track: 'monza' }), ['FUEL_RATE du serveur', 'TYRE_WEAR_RATE du serveur']);
  assert.deepEqual(sessionContextMissing({ track: 'monza', fuel_rate: 100, tyre_wear_rate: 100 }), []);
});

test('un échec d\'initialisation nomme l\'instruction fautive', async () => {
  const { PgStore } = require('../tools/telemetry/store');
  const pool = {
    async query(sql) {
      if (/UNIQUE INDEX/i.test(sql)) throw new Error('syntax error at or near "("');
      return { rows: [] };
    }
  };
  await assert.rejects(
    () => new PgStore(pool).init(),
    /schéma telemetry : syntax error.*CREATE UNIQUE INDEX/i,
    'le message doit dire QUELLE instruction a échoué'
  );
});

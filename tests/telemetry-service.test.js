'use strict';
/*
 * Télémétrie — chaîne complète, de la voiture au rapport.
 *
 * Ces tests couvrent la partie qui n'existait pas encore : le service qui reçoit
 * les tours, les filtres (voiture / circuit / pilote), le rapport branché sur des
 * données réelles, et le script CSP lui-même.
 *
 * Deux propriétés ne doivent jamais casser :
 *   1. l'étanchéité : la télémétrie ne lit ni n'écrit ailleurs que dans
 *      `telemetry`, et son API ne répond pas sur les routes du championnat ;
 *   2. aucune valeur inventée : ce qui n'est pas mesuré reste `null`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { FileStore } = require('../tools/telemetry/store');
const { TelemetryService, validatePush, filterRows } = require('../tools/telemetry/api');

const ROOT = path.resolve(__dirname, '..');

/**
 * Compile un texte Lua avec fengari (même interpréteur que le harnais CSP).
 * Sert à vérifier ce que le site SERT réellement, config injectée comprise :
 * `assert.match(txt, /__GDSP_TELEMETRY__/)` laissait passer une table en JSON,
 * que CSP refuse en bloc (« '}' expected near ':' »).
 * @returns {{error:string|null}}
 */
function spawnLuaCheck(source) {
  const fengari = require('fengari');
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  if (lauxlib.luaL_loadbuffer(L, to_luastring(source), source.length, '@served') !== lua.LUA_OK) {
    return { error: to_jsstring(lua.lua_tostring(L, -1)) };
  }
  return { error: null };
}

function tempStore(name = 'telemetry.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-tel-api-'));
  return new FileStore(path.join(dir, name));
}

/** Un envoi tel que le produit le script CSP, avec des mesures réelles. */
function pushPayload(overrides = {}) {
  return {
    v: 1,
    script: 'GDSP-TELEMETRY 1.0',
    campaign: 'campagne-2026-11',
    serverName: '{GDSP_ Server test 1',
    track: 'ks_monza66-junior',
    trackConfig: 'junior',
    sessionType: 'practice',
    fuelRate: 100,
    tyreWearRate: 100,
    driver: { guid: '76561198015862674', name: "Assassin's Street" },
    car: 'alfa_giulietta_spider',
    laps: [
      { lapNumber: 1, lapMs: 75576, fuelUsedL: 1.504, fuelLoadedL: 45, tyreWearPct: [1.3, 1.35, 1.45, 1.5], speedMaxKmh: 187 },
      { lapNumber: 2, lapMs: 75780, fuelUsedL: 1.498, fuelLoadedL: 43.5, tyreWearPct: [1.32, 1.33, 1.44, 1.49], speedMaxKmh: 189 },
      { lapNumber: 3, lapMs: 75410, fuelUsedL: 1.501, fuelLoadedL: 42, tyreWearPct: [1.31, 1.34, 1.43, 1.48], speedMaxKmh: 188 }
    ],
    ...overrides
  };
}

// --- validation d'un envoi ----------------------------------------------------

test('un envoi sans circuit, sans pilote ou sans voiture est refusé', () => {
  assert.equal(validatePush(null).ok, false);
  assert.equal(validatePush({}).ok, false);
  assert.match(validatePush(pushPayload({ track: '' })).error, /circuit/);
  assert.match(validatePush(pushPayload({ driver: {} })).error, /pilote/);
  assert.match(validatePush(pushPayload({ car: '' })).error, /voiture/);
  assert.match(validatePush(pushPayload({ laps: [] })).error, /aucun tour/);
  assert.equal(validatePush(pushPayload()).ok, true);
});

test('un tour sans temps est écarté, les autres passent', () => {
  const check = validatePush(pushPayload({
    laps: [
      { lapNumber: 1, lapMs: 0 },
      { lapNumber: 2, lapMs: null },
      { lapNumber: 3, lapMs: 75576 }
    ]
  }));
  assert.equal(check.ok, true);
  assert.equal(check.clean.laps.length, 1);
  assert.equal(check.clean.laps[0].lapNumber, 3);
});

test("l'usure par roue est convertie en usure moyenne par tour ; une valeur absente reste nulle", () => {
  const withWear = validatePush(pushPayload()).clean.laps[0];
  assert.ok(Math.abs(withWear.tyreWearPct - (1.3 + 1.35 + 1.45 + 1.5) / 4) < 1e-9);
  const withoutWear = validatePush(pushPayload({
    laps: [{ lapNumber: 1, lapMs: 75000, fuelUsedL: 1.5 }]
  })).clean.laps[0];
  assert.equal(withoutWear.tyreWearPct, null, 'pas d\'usure mesurée = null, jamais 0');
  assert.equal(withoutWear.fuelUsedL, 1.5);
});

test('une usure scalaire reste en pourcentage : 1,4 ne devient pas 140', () => {
  const lap = validatePush(pushPayload({
    laps: [{ lapNumber: 1, lapMs: 75000, tyreWearPct: 1.4 }]
  })).clean.laps[0];
  assert.equal(lap.tyreWearPct, 1.4);
  // En revanche une fraction d'origine (0,014) est bien convertie.
  const fraction = validatePush(pushPayload({
    laps: [{ lapNumber: 1, lapMs: 75000, tyreWearPct: 0.014 }]
  })).clean.laps[0];
  assert.ok(Math.abs(fraction.tyreWearPct - 1.4) < 1e-9);
});

test('une consommation nulle ou négative est rejetée (ce ne serait pas une mesure)', () => {
  const lap = validatePush(pushPayload({
    laps: [{ lapNumber: 1, lapMs: 75000, fuelUsedL: 0, tyreWearPct: 0 }]
  })).clean.laps[0];
  assert.equal(lap.fuelUsedL, null);
  assert.equal(lap.tyreWearPct, null);
});

// --- service : ingestion, déduplication, filtres ------------------------------

test('un même tour renvoyé deux fois n\'est enregistré qu\'une fois', async () => {
  const service = new TelemetryService(tempStore());
  const first = await service.ingest(pushPayload());
  assert.equal(first.ok, true);
  assert.equal(first.added, 3);
  const again = await service.ingest(pushPayload());
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 3);
  assert.equal((await service.rows()).length, 3);
});

test('deux envois successifs alimentent la même session (pas de session par redémarrage)', async () => {
  const store = tempStore();
  const service = new TelemetryService(store);
  await service.ingest(pushPayload());
  await service.ingest(pushPayload({
    laps: [{ lapNumber: 4, lapMs: 75200, fuelUsedL: 1.49, tyreWearPct: [1.3, 1.3, 1.4, 1.4] }]
  }));
  const { session } = store.data;
  assert.equal(session.length, 1, 'une seule session pour un même contexte');
  assert.equal((await service.rows()).length, 4);
});

test('le profil d\'une voiture agrège les mesures réelles', async () => {
  const service = new TelemetryService(tempStore());
  await service.ingest(pushPayload());
  const summary = await service.summary({});
  assert.equal(summary.cars.length, 1);
  const car = summary.cars[0];
  assert.equal(car.car, 'alfa_giulietta_spider');
  assert.equal(car.laps, 3);
  assert.equal(car.bestLapMs, 75410);
  assert.equal(car.medianLapMs, 75576);
  assert.ok(Math.abs(car.fuelPerLap - 1.501) < 0.01);
  assert.ok(Math.abs(car.tyreWearPerLap - 1.4) < 0.06);
  assert.equal(car.fuelCapacity, 45, 'capacité = plus gros plein observé, pas une valeur devinée');
});

test('les filtres voiture / circuit / pilote portent sur les bonnes lignes', async () => {
  const service = new TelemetryService(tempStore());
  await service.ingest(pushPayload());
  await service.ingest(pushPayload({
    car: 'actk_lola_t290',
    driver: { guid: '76561198000000001', name: 'Karl74' },
    laps: [
      { lapNumber: 1, lapMs: 74902, fuelUsedL: 2.4, tyreWearPct: [2.1, 2.2, 2.3, 2.4] },
      { lapNumber: 2, lapMs: 74880, fuelUsedL: 2.41, tyreWearPct: [2.1, 2.2, 2.3, 2.4] }
    ]
  }));
  await service.ingest(pushPayload({
    track: 'ks_brands_hatch',
    laps: [{ lapNumber: 1, lapMs: 51000, fuelUsedL: 1.1 }]
  }));

  const all = await service.summary({});
  assert.equal(all.rows, 6);

  const onlyLola = await service.summary({ car: 'actk_lola_t290' });
  assert.equal(onlyLola.rows, 2);
  assert.deepEqual(onlyLola.cars.map(c => c.car), ['actk_lola_t290']);
  assert.equal(onlyLola.cars[0].fuelPerLap == null, false);

  const onlyMonza = await service.summary({ track: 'ks_monza66-junior' });
  assert.equal(onlyMonza.rows, 5);

  const onlyKarl = await service.summary({ driver: '76561198000000001' });
  assert.equal(onlyKarl.rows, 2);
  assert.equal(onlyKarl.cars[0].car, 'actk_lola_t290');

  const combined = await service.summary({ track: 'ks_monza66-junior', driver: '76561198015862674' });
  assert.equal(combined.rows, 3);

  const byDriver = await service.summary({ byDriver: true });
  // Le troisième envoi garde le pilote par défaut : deux couples seulement.
  assert.equal(byDriver.cars.length, 2, 'une ligne par couple voiture × pilote');
  assert.deepEqual(byDriver.cars.map(c => c.driver).sort(), ['76561198000000001', '76561198015862674']);
});

test('le catalogue ne propose que des valeurs réellement présentes', async () => {
  const service = new TelemetryService(tempStore());
  await service.ingest(pushPayload());
  await service.ingest(pushPayload({ car: 'bmw_m3_e30', driver: { guid: 'G2', name: 'Pilote 2' } }));
  const catalog = await service.catalog();
  assert.deepEqual(catalog.cars, ['alfa_giulietta_spider', 'bmw_m3_e30']);
  assert.deepEqual(catalog.tracks, ['ks_monza66-junior']);
  assert.deepEqual(catalog.drivers, ['76561198015862674', 'G2']);
  assert.equal(catalog.driverNames['76561198015862674'], "Assassin's Street");
});

test('filterRows ignore une valeur de filtre absente', () => {
  const rows = [{ car: 'a', track: 't', driver_guid: 'g' }];
  assert.equal(filterRows(rows, {}).length, 1);
  assert.equal(filterRows(rows, { car: '' }).length, 1);
  assert.equal(filterRows(rows, { car: 'b' }).length, 0);
});

// --- rapport ----------------------------------------------------------------

test('sans mesures pit-lane, le rapport est produit mais signale le trou', async () => {
  const service = new TelemetryService(tempStore());
  await service.ingest(pushPayload());
  const report = await service.report({});
  assert.equal(report.missingPitProfile, true);
  assert.ok(report.files.csv.length > 0);
  // Une voiture sans pit-lane ni capacité ne peut pas être simulée : elle doit
  // apparaître comme incomplète, pas avec un temps de course fabriqué.
  const row = report.rows[0];
  assert.equal(row.incomplete, true);
  assert.ok(row.missing.length > 0);
  assert.match(report.files.markdown, /données incomplètes|Aucun pilote|—/i);
});

test('avec les mesures pit-lane, le rapport simule les arrêts sur les trois durées', async () => {
  const service = new TelemetryService(tempStore());
  await service.ingest(pushPayload({
    laps: Array.from({ length: 12 }, (_, i) => ({
      lapNumber: i + 1,
      lapMs: 75000 + (i % 3) * 300,
      fuelUsedL: 2.4,
      fuelLoadedL: 30,
      tyreWearPct: [2.2, 2.2, 2.2, 2.2]
    }))
  }));
  await service.savePitProfile('ks_monza66-junior', {
    pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000
  });
  const report = await service.report({ track: 'ks_monza66-junior' });
  assert.equal(report.missingPitProfile, false);
  const row = report.rows[0];
  assert.equal(row.incomplete, false, 'toutes les mesures sont là');
  assert.ok(row.byDuration[20].stops >= 1, 'la voiture doit s\'arrêter sur 20 minutes');
  for (const min of [20, 30, 45]) {
    assert.ok(row.byDuration[min].raceTimeMs > 0);
    assert.ok(report.files.csv.includes('20') || min > 20);
  }
  assert.match(report.files.markdown, /20 minutes/);
  // La référence est désignée comme telle : « 0.000 » se lirait comme un écart.
  assert.match(report.files.markdown, /\| réf\. \|/);
  assert.match(report.files.markdown, /45 minutes/);
  assert.match(report.files.html, /Balance of Performance/);
});

test('la mesure pit-lane enregistrée est relue et peut être corrigée', async () => {
  const service = new TelemetryService(tempStore());
  await service.savePitProfile('ks_monza66-junior', { pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000 });
  assert.equal((await service.pitProfile('ks_monza66-junior')).pit_lane_loss_ms, 22000);
  await service.savePitProfile('ks_monza66-junior', { pitLaneLossMs: 20000, refuelRateLps: 3, tyreChangeMs: 11000 });
  const updated = await service.pitProfile('ks_monza66-junior');
  assert.equal(updated.pit_lane_loss_ms, 20000);
  assert.equal(updated.refuel_rate_lps, 3);
});

// --- isolation vis-à-vis du championnat --------------------------------------

test('le service ne touche aucune table hors du schéma telemetry', async () => {
  const store = tempStore();
  const service = new TelemetryService(store);
  await service.ingest(pushPayload());
  await service.savePitProfile('ks_monza66-junior', { pitLaneLossMs: 22000, refuelRateLps: 2.5, tyreChangeMs: 12000 });
  assert.deepEqual(Object.keys(store.data).sort(), ['circuit_profile', 'lap', 'seq', 'session', 'stint']);
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'telemetry', 'api.js'), 'utf8');
  // Aucune requête SQL, aucun accès direct à une table du site.
  for (const forbidden of ['championship', 'FROM events', 'api/events', 'api/championship', 'driver_profile']) {
    assert.equal(source.includes(forbidden), false, `api.js ne doit pas mentionner « ${forbidden} »`);
  }
});

// --- script CSP --------------------------------------------------------------

const { simulate, setCar } = require('./helpers/lua-harness');

/** Un tour complet : niveau de départ, consommation, usure, compteur qui monte. */
function unTour(steps = []) {
  return [
    0.016,                                                   // relevé initial
    (L) => setCar(L, 'fuel', 29.0),                           // 1,5 L consommés
    (L) => setCar(L, 'wheels', [
      { tyreWear: 0.986 }, { tyreWear: 0.986 }, { tyreWear: 0.985 }, { tyreWear: 0.985 }
    ]),
    0.016,                                                   // l'usure de départ est mémorisée
    (L) => setCar(L, 'lapCount', 2),                          // le tour est bouclé
    0.016,
    ...Array.from({ length: 60 }, () => 0.1),                 // laisse passer l'intervalle d'envoi
    ...steps
  ];
}

test('le script CSP se charge, annonce ce qu il lit et envoie un JSON valide', () => {
  const result = simulate({ steps: unTour() });
  assert.equal(result.error, null);
  // Le message affiché en jeu est le diagnostic : c'est lui qu'on demande au
  // pilote de lire si un chiffre manque sur le site.
  assert.ok(result.messages.some(m => /carburant lu/.test(m)), result.messages.join(' | '));
  assert.ok(result.messages.some(m => /pneus lus/.test(m)), result.messages.join(' | '));
  assert.equal(result.sent.length, 1);

  const payload = JSON.parse(result.sent[0]);
  assert.equal(payload.driver.guid, '76561198015862674');
  assert.equal(payload.car, 'alfa_giulietta_spider');
  assert.equal(payload.track, 'ks_monza66-junior');
  assert.equal(payload.sessionType, 'practice');
  assert.equal(payload.fuelRate, 100);
  assert.equal(payload.laps.length, 1);

  const lap = payload.laps[0];
  assert.equal(lap.lapNumber, 2);
  assert.equal(lap.lapMs, 75576);
  assert.ok(Math.abs(lap.fuelUsedL - 1.5) < 0.001, `conso ${lap.fuelUsedL}`);
  assert.equal(lap.tyreWearPct.length, 4);
  lap.tyreWearPct.forEach(v => assert.ok(Math.abs(v - 1.4) < 0.01, `usure ${v}`));
  // Et surtout : ce que le script produit est accepté par le serveur.
  const check = validatePush(payload);
  assert.equal(check.ok, true, check.error);
  assert.ok(Math.abs(check.clean.laps[0].tyreWearPct - 1.4) < 0.01);
});

test('si CSP n\'expose ni carburant ni usure, le script le dit et n\'invente rien', () => {
  const result = simulate({
    steps: unTour(),
    car: { fuel: undefined, wheels: undefined }
  });
  assert.equal(result.error, null, 'le script doit continuer à tourner, pas planter');
  assert.ok(result.messages.some(m => /carburant NON LU/.test(m)));
  assert.ok(result.messages.some(m => /pneus NON LUS/.test(m)));
  const payload = JSON.parse(result.sent[0]);
  const lap = payload.laps[0];
  assert.equal(lap.fuelUsedL, undefined, 'aucun carburant inventé');
  assert.equal(lap.tyreWearPct, undefined, 'aucune usure inventée');
  // Le chrono, lui, reste mesuré : ce tour compte pour la régularité et le
  // tour médian, mais pas pour le BoP consommation.
  assert.equal(lap.lapMs, 75576);
  assert.equal(validatePush(payload).ok, true);
});

test('un ravitaillement n\'est pas compté comme une consommation négative', () => {
  const result = simulate({
    steps: [
      0.016,
      (L) => setCar(L, 'fuel', 38.0),         // plein de 6 L : le niveau monte
      (L) => setCar(L, 'lapCount', 2),
      0.016,
      ...Array.from({ length: 60 }, () => 0.1)
    ]
  });
  assert.equal(result.error, null);
  const payload = JSON.parse(result.sent[0]);
  assert.equal(payload.laps[0].fuelUsedL, undefined, 'une hausse du niveau ne compte pas comme une conso');
});

test('plusieurs tours partent groupés, chacun avec son numéro', () => {
  const steps = [0.016];
  for (let lap = 2; lap <= 5; lap++) {
    steps.push((L) => setCar(L, 'fuel', 30.5 - 1.5 * (lap - 1)));
    steps.push((L) => setCar(L, 'lapCount', lap));
    steps.push(0.016);
  }
  steps.push(...Array.from({ length: 60 }, () => 0.1));
  const result = simulate({ steps });
  assert.equal(result.error, null);
  const payload = JSON.parse(result.sent[0]);
  // Le script envoie par lots (intervalle de 5 s) : ce qui compte, c'est que
  // chaque tour mesuré arrive une fois et une seule, avec son numéro.
  const laps = result.sent.flatMap(body => JSON.parse(body).laps);
  assert.deepEqual(laps.map(l => l.lapNumber), [2, 3, 4, 5]);
  laps.forEach(l => assert.ok(Math.abs(l.fuelUsedL - 1.5) < 0.01));
});

test('un envoi en échec garde les tours et les renvoie (sans doublon côté serveur)', async () => {
  // Premier envoi : le réseau tombe. Le script doit conserver le tour et le
  // remettre dans un envoi suivant — sinon un hoquet de Wi-Fi perdrait la
  // séance entière.
  const result = simulate({
    steps: [
      0.016,
      (L) => setCar(L, 'fuel', 29.0),
      (L) => setCar(L, 'lapCount', 2),
      0.016,
      ...Array.from({ length: 60 }, () => 0.1),
      ...Array.from({ length: 60 }, () => 0.1)
    ],
    failPost: n => n === 1
  });
  assert.equal(result.error, null);
  assert.equal(result.sent.length, 2, 'le tour doit repartir après l\'échec');
  assert.deepEqual(JSON.parse(result.sent[0]).laps.map(l => l.lapNumber), [2]);
  assert.deepEqual(JSON.parse(result.sent[1]).laps.map(l => l.lapNumber), [2]);

  // Et le serveur, lui, ne compte qu'une fois le tour renvoyé.
  const service = new TelemetryService(tempStore());
  await service.ingest(JSON.parse(result.sent[0]));
  const second = await service.ingest(JSON.parse(result.sent[1]));
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 1);
});

// --- routes HTTP -------------------------------------------------------------

test('HTTP : jeton exigé à l\'envoi, admin exigé à la lecture, rapport servi', async t => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-tel-http-'));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_TIMING_ENABLED: '0',
      TELEMETRY_TOKEN: 'jeton-tel',
      ADMIN_PASSWORD: 'motdepasse-test',
      ADMIN_USERNAME: 'admin',
      TELEMETRY_DATABASE_URL: '',
      TELEMETRY_STORE_FILE: path.join(dir, 'store.json')
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('serveur arrêté ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // 1. sans jeton → refus
  const noToken = await fetch(`${base}/api/telemetry/push`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pushPayload())
  });
  assert.equal(noToken.status, 401);

  // 2. avec jeton → accepté
  const accepted = await fetch(`${base}/api/telemetry/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telemetry-Token': 'jeton-tel' },
    body: JSON.stringify(pushPayload())
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.added, 3);

  // 3. lecture sans admin → refus
  const anonymous = await fetch(`${base}/api/telemetry/summary`);
  assert.equal(anonymous.status, 401);

  // 3 bis. connexion : login local → {token} (JWT), puis verify → {ok}
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'motdepasse-test' })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(typeof loginBody.token, 'string');
  assert.equal(loginBody.token.split('.').length, 3, 'un JWT a trois segments');
  assert.notEqual(loginBody.token, 'motdepasse-test', 'le mot de passe ne circule plus en clair');
  const verify = await (await fetch(`${base}/api/admin/verify`, {
    headers: { Authorization: 'Bearer ' + loginBody.token }
  })).json();
  assert.equal(verify.ok, true);

  // 4. lecture avec admin → les tours sont là
  const auth = { Authorization: 'Bearer ' + loginBody.token };
  const summary = await (await fetch(`${base}/api/telemetry/summary`, { headers: auth })).json();
  assert.equal(summary.rows, 3);
  assert.equal(summary.cars[0].car, 'alfa_giulietta_spider');
  assert.equal(summary.cars[0].medianLapMs, 75576);

  // 5. rapport CSV et Markdown
  const csv = await fetch(`${base}/api/telemetry/report?format=csv`, { headers: auth });
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /alfa_giulietta_spider/);
  const md = await (await fetch(`${base}/api/telemetry/report?format=md`, { headers: auth })).text();
  assert.match(md, /# Rapport BoP/);

  // 6. la page existe et pointe vers l'API de télémétrie
  const page = await fetch(`${base}/telemetry`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /api\/telemetry\/summary/);

  // 7. le script CSP est servi avec ses valeurs injectées
  const lua = await fetch(`${base}/csp/telemetry.lua`);
  assert.equal(lua.status, 200);
  const luaText = await lua.text();
  assert.match(luaText, /__GDSP_TELEMETRY__/);
  assert.match(luaText, /\/api\/telemetry\/push/);
  assert.match(luaText, /jeton-tel/);

  // 7 bis. le script TEL QU'IL EST SERVI doit être du Lua valide.
  // Une table écrite en JSON (`{"url":"…"}`) fait tout rejeter par CSP :
  // « Failed to parse: '}' expected near ':' » puis « <Server Script: SCRIPT_2>
  // failed to load ». Le script ne tourne alors jamais, sans autre message.
  assert.ok(!/__GDSP_TELEMETRY__\s*=\s*\{"/.test(luaText), 'la config injectée est une table Lua, pas du JSON');
  const verif = spawnLuaCheck(luaText);
  assert.equal(verif.error, null, `le script servi doit compiler : ${verif.error}`);

  // 8. l'API de télémétrie ne déborde pas sur le championnat
  const events = await fetch(`${base}/api/telemetry/events`, { headers: auth });
  assert.ok(events.status === 404 || events.status === 502, 'aucune route « events » dans la télémétrie');
});

// --- stockage PostgreSQL (sans base) -----------------------------------------

/** Faux pool `pg` : enregistre le SQL et répond comme le vrai. */
function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: await handler(sql, params) };
    }
  };
}

test('le backend PostgreSQL parle uniquement le schéma telemetry', async () => {
  const { PgStore, SCHEMA } = require('../tools/telemetry/store');
  const pool = fakePool((sql, params) => {
    if (/^INSERT INTO/.test(sql)) return [Object.assign({ id: 1 }, params[0])];
    return [{ id: 1, car: 'a' }];
  });
  const store = new PgStore(pool);

  await store.insert('lap', { session_id: 1, car: 'a', lap_ms: 75000 });
  await store.select('lap', { car: 'a' });
  await store.update('lap', 1, { car: 'b' });

  assert.match(pool.calls[0].sql, new RegExp(`^INSERT INTO ${SCHEMA}\\.lap \\(`));
  assert.match(pool.calls[0].sql, /RETURNING \*/);
  assert.match(pool.calls[0].sql, /\$1, \$2, \$3/);
  assert.match(pool.calls[1].sql, new RegExp(`^SELECT \\* FROM ${SCHEMA}\\.lap WHERE "car" = \\$1`));
  assert.deepEqual(pool.calls[1].params, ['a']);
  assert.match(pool.calls[2].sql, new RegExp(`^UPDATE ${SCHEMA}\\.lap SET "car" = \\$1 WHERE id = \\$2`));
  assert.deepEqual(pool.calls[2].params, ['b', 1]);

  // Règle d'isolation : aucune requête ne sort de `telemetry`.
  for (const { sql } of pool.calls) {
    assert.ok(sql.includes(`${SCHEMA}.`), `requête hors schéma : ${sql}`);
    assert.equal(/\b(public|championship|events|drivers)\b/.test(sql), false, sql);
  }
});

test('savePitProfile corrige la mesure existante, même sur PostgreSQL', async () => {
  const { PgStore } = require('../tools/telemetry/store');
  let stored = {
    id: 1, track: 'ks_monza66-junior', track_config: null,
    pit_lane_loss_ms: 22000, refuel_rate_lps: 2.5, tyre_change_ms: 12000
  };
  const pool = fakePool((sql, params) => {
    if (/^SELECT/.test(sql)) return [stored];
    if (/^UPDATE/.test(sql)) {
      // Les colonnes sont lues dans le SQL : l'ordre des paramètres suit l'objet.
      const cols = [...sql.matchAll(/"(\w+)" = \$\d+/g)].map(m => m[1]);
      cols.forEach((col, i) => { stored[col] = params[i]; });
      return [stored];
    }
    throw new Error('insert inattendu : la mesure existante aurait été dupliquée');
  });
  const service = new TelemetryService(new PgStore(pool));
  const saved = await service.savePitProfile('ks_monza66-junior', {
    pitLaneLossMs: 20000, refuelRateLps: 3, tyreChangeMs: 11000
  });
  assert.equal(saved.pit_lane_loss_ms, 20000);
  assert.equal(saved.refuel_rate_lps, 3);
  assert.equal(pool.calls.filter(c => /^UPDATE/.test(c.sql)).length, 1);
  assert.equal(pool.calls.filter(c => /^INSERT/.test(c.sql)).length, 0, 'mise à jour, pas doublon');
});

// --- diagnostic de connexion admin -------------------------------------------

test('admin : « refusé » et « backend injoignable » ne se confondent pas', async t => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-tel-auth-'));
  // BACKEND_URL pointe sur un port fermé : l'équivalent d'un backend Render
  // endormi. C'est exactement le cas qui affichait « Reconnecte-toi. » à un
  // administrateur dont les identifiants étaient bons.
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_TIMING_ENABLED: '0',
      TELEMETRY_TOKEN: 'jeton-tel',
      ADMIN_PASSWORD: 'motdepasse-test',
      ADMIN_USERNAME: 'gdspadmin',
      TELEMETRY_DATABASE_URL: '',
      TELEMETRY_STORE_FILE: path.join(dir, 'store.json')
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('serveur arrêté ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // 1. Aucun jeton : refus net, jamais « service en démarrage ».
  const anonymous = await fetch(`${base}/api/telemetry/summary`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'denied');

  // 2. Jeton bidon : le backend est injoignable, on ne peut pas le déclarer
  //    valable — mais on ne dit pas non plus que la session a expiré.
  const bogus = await fetch(`${base}/api/telemetry/summary`, {
    headers: { Authorization: 'Bearer pas-le-bon' }
  });
  assert.ok([401, 503].includes(bogus.status));
  const bogusBody = await bogus.json();
  assert.ok(bogusBody.code === 'denied' || bogusBody.code === 'unavailable');

  // 3. Le login local travaille sans backend : il signe son propre jeton.
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'gdspadmin', password: 'motdepasse-test' })
  });
  assert.equal(login.status, 200, 'le login ne dépend plus du backend');
  const loginBody = await login.json();
  assert.ok(loginBody.token, 'le login doit fournir un jeton');
  assert.equal(loginBody.warning, undefined, 'plus besoin de mode dégradé : tout est local');

  // 4. Ce jeton ouvre la télémétrie, backend toujours éteint.
  const afterLogin = await fetch(`${base}/api/telemetry/summary`, {
    headers: { Authorization: 'Bearer ' + loginBody.token }
  });
  assert.equal(afterLogin.status, 200, 'le jeton du login doit ouvrir la télémétrie');
  assert.equal((await afterLogin.json()).rows, 0);

  // 5. Le mot de passe lui-même n'est plus un jeton : il ne doit plus rien ouvrir.
  const rawPassword = await fetch(`${base}/api/telemetry/summary`, {
    headers: { Authorization: 'Bearer motdepasse-test' }
  });
  assert.equal(rawPassword.status, 401, 'le mot de passe ne circule plus comme jeton');
});

// --- diagnostic « ping » -----------------------------------------------------

test('le script envoie un ping au démarrage : la chaîne est vérifiable sans rouler', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({
    callInit: true,
    config: { url: 'https://exemple.test/api/telemetry/push', token: 'jeton', campaign: 'essai' }
  });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 1, 'un seul paquet au démarrage');

  const payload = JSON.parse(run.sent[0]);
  assert.equal(payload.kind, 'ping', 'ce n\'est pas un tour : le site ne doit rien stocker');
  assert.equal(payload.track, 'ks_monza66-junior');
  assert.equal(payload.car, 'alfa_giulietta_spider');
  assert.equal(payload.driver.guid, '76561198015862674');
  assert.equal(payload.laps, undefined, 'un ping ne porte aucune mesure');

  // Le pilote doit voir le résultat, sinon le diagnostic ne sert à rien.
  assert.ok(run.messages.some(m => /Connexion au site établie/.test(m)), 'message de succès en jeu');
});

test('le ping n\'est pas un tour : il est accepté et n\'écrit rien dans la base', async () => {
  const store = tempStore();
  const service = new TelemetryService(store);
  const result = await service.ingest({
    v: 1, script: 'GDSP-TELEMETRY 1.0', kind: 'ping', campaign: 'campagne-2026-11',
    track: 'ks_monza66-junior', car: 'alfa_giulietta_spider',
    driver: { guid: '76561198015862674', name: 'Assassin\'s Street' }
  });
  assert.equal(result.ok, true, 'un ping ne doit jamais être rejeté');
  assert.equal(result.ping, true);
  assert.equal(result.added, 0);
  assert.equal(store.data.lap.length, 0, 'aucune mesure inventée');
  assert.equal(store.data.session.length, 0, 'aucune session créée pour un ping');
});

// --- le script ne doit jamais rester silencieux ------------------------------

test('sans URL, le script le dit au lieu de se taire', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({ callInit: true });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 0);
  assert.ok(run.messages.some(m => /pas d'URL/.test(m)),
    'un script muet est indiscernable d\'un script qui ne tourne pas');
});

test('sans web.post, le script le dit et retentera', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({
    callInit: true, noWeb: true,
    config: { url: 'https://exemple.test/api/telemetry/push', token: 'j' }
  });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 0);
  assert.ok(run.messages.some(m => /transport indisponible/.test(m)));
});

test('un seul ping, même après plusieurs images', () => {
  const { simulate } = require('./helpers/lua-harness');
  // La boucle retente le ping tant qu'il n'a pas abouti : il ne doit pas
  // pour autant en envoyer un par image une fois qu'il a réussi.
  const run = simulate({
    callInit: true,
    config: { url: 'https://exemple.test/api/telemetry/push', token: 'j' },
    steps: [{ dt: 0.016 }, { dt: 0.016 }]
  });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 1, 'un seul ping, malgré les images');
  assert.ok(run.messages.some(m => /Connexion au site établie/.test(m)));
});

test('le script expose init ET __init__, sans double initialisation', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({
    callInit: true,
    config: { url: 'https://exemple.test/api/telemetry/push', token: 'j' }
  });
  assert.equal(run.error, null);
  // Un seul ping : si les deux noms d'init étaient appelés, il y en aurait deux.
  assert.equal(run.sent.length, 1);
});

test('drawUI affiche le diagnostic à l\'écran', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({
    callInit: true,
    config: { url: 'https://exemple.test/api/telemetry/push', token: 'j' },
    steps: [{ dt: 0.016 }]
  });
  assert.equal(run.error, null);
  // `drawUI` est le seul canal garanti pour un script en ligne : s'il ne dit
  // rien, on ne peut pas distinguer « script muet » de « script absent ».
  assert.ok(run.ui.length > 0, 'drawUI doit écrire à l\'écran');
  assert.ok(run.ui.some(l => /GDSP-TELEMETRY/.test(l)));
});

test('l\'URL injectée par le site n\'est pas effacée par une section absente', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Cas réel en ligne : la route /csp/telemetry.lua ajoute __GDSP_TELEMETRY__,
  // et le serveur ne déclare aucune section [SCRIPT_2] dans
  // csp_extra_options.ini. `ac.configValues` renvoie alors le layout par défaut
  // (url = '') : il ne doit pas écraser la valeur injectée.
  const run = simulate({
    callInit: true,
    injected: { url: 'https://site.test/api/telemetry/push', token: 'j' },
    config: { url: '', token: '', intervalSec: 0 }
  });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 1, 'l\'URL injectée doit suffire à envoyer');
  assert.ok(run.ui.some(l => /site\.test/.test(l)), 'drawUI montre l\'URL utilisée');
});

test('sans URL ni injection, le diagnostic dit d\'où vient le vide', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({ callInit: true, steps: [{ dt: 0.016 }] });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 0);
  assert.ok(run.ui.some(l => /url\(aucune\): MANQUANTE/.test(l)));
});

test('le script tel que servi en ligne démarre et envoie', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Texte exact du fichier + table injectée en fin de fichier, comme la route
  // /csp/telemetry.lua le construit. Ce test aurait attrapé le bug d'ordre :
  // la config était lue avant que la table n'existe.
  const run = simulate({ served: true, callInit: true, steps: [{ dt: 0.016 }] });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 1, 'le script servi doit envoyer son ping');
  // `sent` contient le corps POSTé, déjà sérialisé en JSON.
  const body = typeof run.sent[0] === 'string' ? JSON.parse(run.sent[0]) : run.sent[0];
  assert.equal(body.kind, 'ping');
  assert.ok(run.ui.some(l => /url\(injectée\)/.test(l)));
});

test('un callback qui ne vient jamais ne laisse pas le ping en attente', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Le POST part, aucune réponse n'arrive (proxy, pare-feu, requête avalée).
  // Sans délai, l'état restait « attente » pour toujours, sans un mot.
  const run = simulate({
    served: true, callInit: true, silentPost: true,
    steps: Array.from({ length: 60 }, () => ({ dt: 0.5 }))
  });
  assert.equal(run.error, null);
  assert.ok(run.ui.some(l => /essais=/.test(l)), 'le diagnostic montre les essais');
  assert.ok(run.messages.some(m => /pas de réponse/.test(m)),
    'un silence de 10 s doit être annoncé, pas subi');
});

test('la requête est retentée quand le callback n\'arrive pas', () => {
  const { simulate } = require('./helpers/lua-harness');
  const run = simulate({
    served: true, callInit: true, silentPost: true,
    steps: Array.from({ length: 60 }, () => ({ dt: 0.5 }))
  });
  assert.ok(run.sent.length >= 2, 'une tentative perdue doit être suivie d\'une autre');
});

test('sans identifiant Steam, le script lit quand même les tours', () => {
  const { simulate, setCar } = require('./helpers/lua-harness');
  // L'API CSP n'expose aucun identifiant Steam (voir SDK, common/ac_state.lua).
  // Exiger un guid condamnait le script au silence sur toutes les voitures :
  // c'est exactement ce que montrait « guid=? » à l'écran.
  const run = simulate({
    served: true, callInit: true, noGuid: true,
    steps: [
      { dt: 0.1 },
      (L) => setCar(L, 'splinePosition', 0.5),
      (L) => setCar(L, 'splinePosition', 0.98),
      (L) => setCar(L, 'lapCount', 2),
      (L) => setCar(L, 'splinePosition', 0.02),
      // le tour a consommé du carburant : la mesure doit survivre au guid absent
      (L) => setCar(L, 'fuel', 29.0),
      ...Array.from({ length: 20 }, () => ({ dt: 0.5 }))
    ]
  });
  assert.equal(run.error, null);
  const avecTours = run.sent.map(x => JSON.parse(x)).filter(b => Array.isArray(b.laps) && b.laps.length);
  assert.ok(avecTours.length > 0, 'un tour doit remonter même sans guid');
  const lap = avecTours[0].laps[0];
  assert.equal(lap.fuelUsedL, 1.5, 'la mesure reste complète malgré le guid absent');
  assert.equal(lap.lapMs, 75576, 'le temps au tour est celui de previousLapTimeMs');
  assert.ok(run.ui.some(l => /ABSENT/.test(l)), 'le diagnostic explique l\'absence de guid');
});

test('le diagnostic affiche la réponse réelle du site', () => {
  const { simulate } = require('./helpers/lua-harness');
  // 401 : le site répond, mais refuse le jeton. C'est une information qu'il
  // faut voir à l'écran, pas un état « en attente » indéfini.
  const run = simulate({ served: true, callInit: true, status: 401, steps: [{ dt: 0.2 }] });
  assert.equal(run.error, null);
  assert.ok(run.ui.some(l => /réponse: HTTP 401/.test(l)), run.ui.join(' | '));
  assert.ok(run.messages.some(m => / refuse/.test(m)));
});

test('la bannière reste affichée tant que le ping n\'a pas abouti', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Elle disparaissait après 20 s ; or un premier tour dure souvent plus.
  const run = simulate({
    served: true, callInit: true, silentPost: true,
    steps: Array.from({ length: 100 }, () => ({ dt: 0.5 }))
  });
  assert.ok(run.ui.length > 0, 'le diagnostic doit rester lisible après 20 s');
  assert.ok(run.ui.some(l => /réponse:/.test(l)), 'la réponse réelle doit être visible');
  assert.ok(run.ui.some(l => /^sonde:/.test(l)), 'la sonde GET doit être visible');
});

test('une erreur de transport est écrite à l\'écran, mot pour mot', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Message d'erreur réel (TLS, DNS, pare-feu) : c'est lui qui dira quoi
  // corriger. Le masquer derrière « attente » ne sert à personne.
  const run = simulate({
    served: true, callInit: true, failPost: () => true, steps: [{ dt: 0.5 }]
  });
  assert.equal(run.error, null);
  assert.ok(run.ui.some(l => /réponse: err=réseau indisponible/.test(l)), run.ui.join(' | '));
  assert.ok(run.messages.some(m => /envoi impossible/.test(m)));
});

test('la sonde GET distingue un blocage réseau d\'un refus du site', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Le POST ne répond pas, mais un GET sur la même origine répond : le réseau
  // va bien, c'est la route POST qui pose problème. Sans cette sonde, on ne
  // peut pas trancher.
  const run = simulate({
    served: true, callInit: true, silentPost: true, steps: [{ dt: 0.5 }, { dt: 0.5 }]
  });
  assert.equal(run.error, null);
  assert.ok(run.ui.some(l => /sonde: GET HTTP 200/.test(l)), run.ui.join(' | '));
  assert.ok(run.messages.some(m => /réseau/.test(m)));
});

// --- une base muette doit produire une erreur, jamais un silence ------------
// Constat de production : le GET /healthz répondait, mais le POST
// /api/telemetry/push ne renvoyait RIEN — ni statut, ni log. Cause : `pg`
// attend indéfiniment par défaut (connectionTimeoutMillis = 0) et la promesse
// d'ouverture ne se résolvait jamais.

test('le pool Postgres est borné dans le temps', () => {
  const { poolConfig } = require('../tools/telemetry/store');
  const cfg = poolConfig('postgres://user:pass@db.example.com:5432/telemetry');
  assert.ok(cfg.connectionTimeoutMillis > 0, 'connectionTimeoutMillis doit être borné');
  assert.ok(cfg.query_timeout > 0, 'query_timeout doit être borné');
  assert.ok(cfg.statement_timeout > 0, 'statement_timeout doit être borné');
  assert.deepStrictEqual(cfg.ssl, { rejectUnauthorized: false });
  const local = poolConfig('postgres://localhost:5432/telemetry');
  assert.strictEqual(local.ssl, false, 'localhost reste sans SSL');
});

test('une base muette rejette au bout du délai, pas jamais', async () => {
  const { createTelemetryService } = require('../tools/telemetry/api');
  // Un pool dont aucune requête ne répond : exactement le symptôme vu en jeu.
  const hungPool = { query: () => new Promise(() => {}) };
  await assert.rejects(
    createTelemetryService({
      databaseUrl: 'postgres://user:pass@db.example.com:5432/telemetry',
      pool: hungPool,
      openTimeoutMs: 25
    }),
    e => e.code === 'GDSP_TELEMETRY_TIMEOUT' && /sans réponse après 25 ms/.test(e.message)
  );
});

test('une base qui répond n\'est pas pénalisée par la borne', async () => {
  const { createTelemetryService } = require('../tools/telemetry/api');
  const store = {
    kind: 'test',
    init: async () => store,
    insert: async (t, row) => row,
    select: async () => [],
    update: async () => null,
    close: async () => {}
  };
  const svc = await createTelemetryService({ store, openTimeoutMs: 25 });
  assert.ok(svc, 'le service doit s\'ouvrir normalement');
});

test('HTTP : une base muette donne une réponse (503/500), jamais un silence', async t => {
  // Reproduction exacte du symptôme vu en jeu : le GET /healthz répond, mais
  // le POST /api/telemetry/push ne renvoyait RIEN. Un serveur TCP qui accepte
  // la connexion sans jamais parler, c'est une base « endormie ». Avant les
  // délais bornés, la requête restait pendante à vie.
  const net = require('node:net');
  const mute = net.createServer(socket => { /* accepté, jamais de réponse */ });
  mute.listen(0, '127.0.0.1');
  await once(mute, 'listening');
  const dbPort = mute.address().port;
  t.after(() => mute.close());

  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));

  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_TIMING_ENABLED: '0',
      TELEMETRY_TOKEN: 'jeton-tel',
      ADMIN_PASSWORD: 'motdepasse-test',
      ADMIN_USERNAME: 'admin',
      TELEMETRY_DATABASE_URL: `postgres://gdsp:gdsp@127.0.0.1:${dbPort}/gdsp`,
      TELEMETRY_STORE_FILE: '/dev/null'
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('serveur arrêté ' + code)); });
  });

  const started = Date.now();
  const replied = await Promise.race([
    fetch(`http://127.0.0.1:${port}/api/telemetry/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telemetry-Token': 'jeton-tel' },
      body: JSON.stringify({
        kind: 'ping', v: 1, script: 'GDSP-TELEMETRY 1.0',
        track: 'ks_monza66-junior', car: 'alfa_giulietta_spider',
        driver: { guid: '76561198015862674', name: 'Test' }
      })
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('AUCUNE RÉPONSE en 20 s — régression du silence')), 20000))
  ]);
  const elapsed = Date.now() - started;
  assert.ok([500, 503].includes(replied.status),
    `statut inattendu : ${replied.status} (après ${elapsed} ms)`);
  assert.ok(elapsed < 15000, `réponse trop lente : ${elapsed} ms`);
  const body = await replied.json();
  assert.ok(body.error && body.error.length > 0, 'le refus doit expliquer la cause');
});

// --- deux variantes de web.post, une seule doit livrer une réponse -----------

test('le POST « nu » porte le jeton dans l\'URL et se verrouille dès qu\'il répond', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Le GET de la sonde passe en jeu ; le POST habillé reste muet. Le mode
  // « nu » (aucun en-tête custom, jeton dans l'URL) a la même silhouette que
  // ce GET qui passe : c'est lui qu'on essaie en premier.
  const run = simulate({ served: true, callInit: true, steps: [{ dt: 0.5 }] });
  assert.equal(run.error, null);
  assert.ok(run.posts.length >= 1, 'un POST au moins est parti');
  assert.equal(run.posts[0].hasHeaders, false, 'premier essai sans en-têtes');
  assert.match(run.posts[0].url, /[?&]token=/, 'jeton dans l\'URL');
  assert.ok(run.ui.some(l => /mode: nu \(fixé\)/.test(l)), run.ui.join(' | '));
  assert.ok(run.ui.some(l => /réponse: HTTP 200/.test(l)));
});

test('sans réponse, le mode alterne : nu, puis en-têtes', () => {
  const { simulate } = require('./helpers/lua-harness');
  // 15 s simulées : essai 1 muet, watchdog à 10 s, essai 2 deux secondes
  // plus tard. Le mode de l'essai 2 doit être l'AUTRE variante.
  const run = simulate({
    served: true, callInit: true, silentPost: true,
    steps: Array.from({ length: 30 }, () => ({ dt: 0.5 }))
  });
  assert.equal(run.error, null);
  const modes = run.posts.map(p => (p.hasHeaders ? 'en-têtes' : 'nu'));
  assert.deepEqual(modes, ['nu', 'en-têtes'], `modes vus : ${modes.join(', ')}`);
  assert.ok(run.ui.some(l => /mode: en-têtes/.test(l)), run.ui.join(' | '));
});

test('une variante refusée par CSP bascule sur l\'autre dans le même essai', () => {
  const { simulate } = require('./helpers/lua-harness');
  // Cette version de CSP refuse l'appel à 3 arguments : le repli doit être
  // immédiat (même essai), sans perdre l'envoi ni le compteur.
  const run = simulate({ served: true, callInit: true, rejectNu: true, steps: [{ dt: 0.5 }] });
  assert.equal(run.error, null);
  assert.ok(run.posts.some(p => p.hasHeaders === true), 'repli sur la variante en-têtes');
  assert.ok(run.ui.some(l => /mode: en-têtes \(fixé\)/.test(l)), run.ui.join(' | '));
  assert.ok(run.ui.some(l => /réponse: HTTP 200/.test(l)));
});

test('HTTP : le POST sans Content-Type JSON est accepté (mode nu de CSP)', async t => {
  // Le mode « nu » n'envoie AUCUN en-tête custom : le corps JSON arrive en
  // texte brut. La route doit le décoder elle-même au lieu de le rejeter.
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-tel-nu-'));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_TIMING_ENABLED: '0',
      TELEMETRY_TOKEN: 'jeton-tel',
      ADMIN_PASSWORD: 'motdepasse-test',
      ADMIN_USERNAME: 'admin',
      TELEMETRY_DATABASE_URL: '',
      TELEMETRY_STORE_FILE: path.join(dir, 'store.json')
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('serveur arrêté ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // 1. jeton dans l'URL (mode nu : aucun en-tête), corps en texte brut.
  const nu = await fetch(`${base}/api/telemetry/push?token=jeton-tel`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(pushPayload())
  });
  assert.equal(nu.status, 200, `statut inattendu : ${nu.status}`);
  const out = await nu.json();
  assert.equal(out.ok, true);
  assert.ok(out.added >= 1, 'les tours du corps texte doivent être enregistrés');

  // 2. corps vide → refus explicite, pas de crash.
  const vide = await fetch(`${base}/api/telemetry/push?token=jeton-tel`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: ''
  });
  assert.equal(vide.status, 400);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const drive = require('../tools/lib/drive-circuits');

const ROOT = path.resolve(__dirname, '..');

test("L'identifiant Drive est extrait des différentes formes d'URL", () => {
  const id = '1PE4sTPInE1ZGmoxEkiEA4Ne1UzhWfqvJ';
  assert.equal(drive.driveId(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(drive.driveId(`https://drive.google.com/drive/u/1/folders/${id}`), id);
  assert.equal(drive.driveId(`https://drive.google.com/file/d/${id}/view`), id);
  assert.equal(drive.driveId(`https://example.com/?id=${id}`), id);
  assert.equal(drive.driveId(id), id);
  assert.equal(drive.driveId('pas un lien'), null);
  assert.equal(drive.driveId(''), null);
  assert.equal(drive.driveId(null), null);
});

test('Un fast_lane.ai se décode et sa longueur correspond au line.json', () => {
  const line = JSON.parse(fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/sebring/line.json'), 'utf8'));
  const n = line.data.length;
  const buf = Buffer.alloc(16 + n * 20);
  buf.writeInt32LE(7, 0);
  buf.writeInt32LE(n, 4);
  line.data.forEach(([x, y, z], i) => {
    const o = 16 + i * 20;
    buf.writeFloatLE(x, o);
    buf.writeFloatLE(y, o + 4);
    buf.writeFloatLE(z, o + 8);
  });

  const track = drive.decodeFastLane(buf);
  assert.equal(track.points.length, n);
  assert.ok(Math.abs(track.lengthM - line.lengthM) < 25, `longueur ${track.lengthM} vs ${line.lengthM}`);
  assert.ok(Math.abs(track.elevMin - line.elevation.min) < 1);
  assert.ok(Math.abs(track.elevMax - line.elevation.max) < 1);
  // La ligne complète doit tout de même produire des virages.
  assert.ok(drive.detectCorners(track.points).length >= 5);
});

test('Un fast_lane.ai tronqué est rejeté explicitement', () => {
  const bad = Buffer.alloc(20);
  bad.writeInt32LE(7, 0);
  bad.writeInt32LE(99, 4);
  assert.throws(() => drive.decodeFastLane(bad), /tronqué/);
  assert.throws(() => drive.decodeFastLane(Buffer.alloc(4)), /trop court/);
});

test('surfaces.ini : le nom vient de KEY=, pas du nom de section', () => {
  const ini = [
    '[SURFACE_0]', 'KEY=ROAD', 'FRICTION=0.99', 'IS_VALID_TRACK=1',
    '[SURFACE_1]', 'KEY=GRASS', 'FRICTION=0.6', 'IS_VALID_TRACK=0',
    '[SURFACE_2]', 'KEY=PIT', 'FRICTION=0.95', 'IS_VALID_TRACK=1'
  ].join('\n');
  const rows = drive.readSurfaces(ini);
  assert.deepEqual(rows.map(r => r.key), ['ROAD', 'GRASS', 'PIT']);
  assert.deepEqual(rows.map(r => r.grip), [99, 60, 95]);
  assert.deepEqual(rows.map(r => r.valid), [true, false, true]);
  assert.deepEqual(rows.map(r => r.pit), [false, false, true]);
});

test('surfaces.ini réel du mod Sebring fournit des grips plausibles', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/sebring/surfaces.ini'), 'utf8');
  const rows = drive.readSurfaces(txt);
  assert.ok(rows.length >= 4, `${rows.length} surfaces lues`);
  const road = rows.find(r => r.key === 'ROAD');
  assert.ok(road, 'surface ROAD absente');
  assert.equal(road.grip, 99);
  assert.equal(road.valid, true);
  for (const r of rows) {
    assert.ok(r.grip === null || (r.grip >= 0 && r.grip <= 100), `grip hors bornes: ${r.key}=${r.grip}`);
  }
});

test('overlays.ini : N départs => N secteurs, le dernier allant jusqu\'à 1', () => {
  const ini = ['[SECTOR_0]', 'START=0', '[SECTOR_1]', 'START=0.3', '[SECTOR_2]', 'START=0.7'].join('\n');
  const splits = drive.readSectorSplits(ini);
  assert.equal(splits.length, 3);
  assert.deepEqual(splits.map(s => s.label), ['S1', 'S2', 'S3']);
  assert.deepEqual(splits.map(s => s.from), [0, 0.3, 0.7]);
  assert.deepEqual(splits.map(s => s.to), [0.3, 0.7, 1]);
  // Couverture complète, sans trou.
  assert.equal(splits[0].from, 0);
  assert.equal(splits[splits.length - 1].to, 1);
  for (let i = 1; i < splits.length; i++) assert.equal(splits[i].from, splits[i - 1].to);
});

test('overlays.ini sans secteur ne fait pas planter', () => {
  assert.deepEqual(drive.readSectorSplits(''), []);
  assert.deepEqual(drive.readSectorSplits('[AUTRE]\nFOO=1'), []);
});

test('La fiche importée contient tout ce que l\'onglet Circuit consomme', () => {
  const line = JSON.parse(fs.readFileSync(path.join(ROOT, 'maquette-circuit/assets/tracks/tremblant/line.json'), 'utf8'));
  const points = line.data.map(([x, y, z]) => ({ x, y, z }));
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    points[i].d = acc;
  }
  points[0].d = 0;
  const track = { points, lengthM: acc };

  const { buildRound } = require('../tools/lib/circuit-round');
  const round = buildRound(track, { name: 'Test', round: 1 }, {
    sectors: [0, 0.28, 0.65, 1],
    cornerNorms: line.corners
  });

  // Champs lus par circuit() dans site.js
  for (const key of ['outline', 'profile', 'profiles', 'lengthM', 'lengthStr', 'elevation', 'sectorSplits', 'cornerCount', 'sectorCount']) {
    assert.ok(round[key] !== undefined && round[key] !== null, `champ manquant : ${key}`);
  }
  assert.match(round.outline.path, /^M[\d.]+ [\d.]+ L/);
  assert.ok(round.outline.corners.length > 0, 'aucun virage placé sur le tracé');
  // Bornes internes : 2 repères pour 3 secteurs.
  assert.equal(round.outline.sectors.length, 2);
  assert.equal(round.sectorSplits.length, 3);
  assert.equal(round.sectorSplits[2].to, round.lengthM);
  assert.ok(round.profile.delta > 0, 'dénivelé nul');
});

test('Les secteurs produits couvrent le tour sans trou', () => {
  const { buildSectorSplits } = require('../tools/lib/circuit-round');
  const splits = buildSectorSplits([0, 0.25, 0.6, 1], 4000);
  assert.deepEqual(splits, [
    { label: 'S1', from: 0, to: 1000 },
    { label: 'S2', from: 1000, to: 2400 },
    { label: 'S3', from: 2400, to: 4000 }
  ]);
  // Sans borne interne, le tour entier forme un seul secteur.
  assert.deepEqual(buildSectorSplits([0, 1], 1000), [{ label: 'S1', from: 0, to: 1000 }]);
  assert.deepEqual(buildSectorSplits([], 1000), []);
});

// --------------------------------------------------------- ouverture aux events

/**
 * Charge des fonctions de `site.js` dans un bac à sable.
 * `site.js` est un script navigateur ; on n'extrait que les fonctions pures
 * pour pouvoir les tester sous Node sans DOM.
 */
function loadSiteFns(names, extra = {}) {
  const src = fs.readFileSync(path.join(ROOT, 'site.js'), 'utf8');

  // Extracteur conscient des chaînes, templates et ${...}.
  function extractFn(name) {
    const sig = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = sig.exec(src);
    if (!m) throw new Error('fonction introuvable : ' + name);
    let i = m.index + 1;
    // sauter la liste de paramètres
    let depth = 0, st = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (st) { if (c === '\\') { i++; continue } if ((st === 's1' && c === "'") || (st === 's2' && c === '"') || (st === 'tpl' && c === '`')) st = null; continue }
      if (c === "'" || c === '"' || c === '`') { st = c === "'" ? 's1' : c === '"' ? 's2' : 'tpl'; continue }
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') { depth--; if (depth === 0) { i++; break } }
    }
    let state = null, exprDepth = 0, braces = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (state === 'line') { if (c === '\n') state = null; continue }
      if (state === 'block') { if (c === '*' && src[i + 1] === '/') { state = null; i++ } continue }
      if (state === 'tpl') {
        if (c === '\\') { i++; continue }
        if (c === '`') state = null;
        else if (c === '$' && src[i + 1] === '{') { state = 'expr'; exprDepth = 1; i++; }
        continue
      }
      if (state === 'expr') {
        if (c === '{') exprDepth++;
        else if (c === '}') { exprDepth--; if (exprDepth === 0) state = 'tpl' }
        continue
      }
      if (state === 's1') { if (c === '\\') { i++; continue } if (c === "'") state = null; continue }
      if (state === 's2') { if (c === '\\') { i++; continue } if (c === '"') state = null; continue }
      if (c === '/' && src[i + 1] === '/') { state = 'line'; i++; continue }
      if (c === '/' && src[i + 1] === '*') { state = 'block'; i++; continue }
      if (c === '`') { state = 'tpl'; continue }
      if (c === "'") { state = 's1'; continue }
      if (c === '"') { state = 's2'; continue }
      if (c === '{') braces++;
      else if (c === '}') { braces--; if (braces === 0) return src.slice(m.index + 1, i + 1) }
    }
    throw new Error('accolade non fermée : ' + name);
  }

  const body = names.map(extractFn).join('\n');
  const ctx = {
    LEGACY_DEFAULT_SLUG: 'lola-t290-2026',
    ACTIVE_LOLA_SLUG: 'lola-t290-gdsp-championnat-2026',
    ...extra
  };
  const fn = new Function(...Object.keys(ctx), body + ';return {' + names.join(',') + '};');
  return fn(...Object.values(ctx));
}

test("L'onglet Circuit est ouvert aux événements hors championnat Lola", () => {
  const site = loadSiteFns(['isLolaEvent'], {
    eventContext: { slug: 'alpha-romeo-cup', name: 'alpha romeo cup', data: {} }
  });
  assert.equal(site.isLolaEvent(), false, "un autre événement ne doit pas être traité comme Lola");
});

test('Une manche importée suffit à rendre l\'onglet visible sur un autre événement', () => {
  const site = loadSiteFns(['hasCircuitData', 'isLolaEvent'], {
    eventContext: { slug: 'alpha-romeo-cup', data: { circuitRounds: [{ round: 1, name: 'Monza' }] } },
    circuitsCache: null, circuitsError: '', circuitsPending: null,
    importedCircuitRounds: () => [{ round: 1, name: 'Monza' }],
    render: () => {}, page: 'event'
  });
  assert.equal(site.hasCircuitData(), true);
});

test('Sans aucune manche, l\'onglet reste masqué une fois le chargement terminé', () => {
  const site = loadSiteFns(['hasCircuitData', 'isLolaEvent'], {
    eventContext: { slug: 'alpha-romeo-cup', data: {} },
    circuitsCache: { rounds: [] }, circuitsError: '', circuitsPending: null,
    importedCircuitRounds: () => [],
    render: () => {}, page: 'event'
  });
  assert.equal(site.hasCircuitData(), false);
});

test('Le championnat Lola garde son onglet même sans manche importée', () => {
  const site = loadSiteFns(['hasCircuitData', 'isLolaEvent'], {
    eventContext: { slug: 'lola-t290-gdsp-championnat-2026', data: {} },
    circuitsCache: null, circuitsError: '', circuitsPending: null,
    importedCircuitRounds: () => [],
    render: () => {}, page: 'event'
  });
  assert.equal(site.isLolaEvent(), true);
  assert.equal(site.hasCircuitData(), true);
});

test('La fusion des manches numérote sans écraser M1', () => {
  const site = loadSiteFns(['mergeCircuitRounds'], {});
  const base = [{ round: 1, label: 'M1', name: 'Tremblant' }, { round: 2, label: 'M2', name: 'Riverside' }];
  // Manche sans numéro : doit prendre M3, pas M1.
  const out = site.mergeCircuitRounds(base, [{ name: 'Nouveau' }]);
  assert.deepEqual(out.map(r => r.label), ['M1', 'M2', 'M3']);
  // Manche importée de même numéro : remplace la statique.
  const replaced = site.mergeCircuitRounds(base, [{ round: 2, name: 'Riverside (maj)' }]);
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].name, 'Riverside (maj)');
  assert.equal(replaced[1].imported, true);
});

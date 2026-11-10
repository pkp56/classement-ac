#!/usr/bin/env node
/*
 * Génère `data/circuits.json` — une fiche par manche du championnat Lola T290.
 *
 * Entrées locales (aucun Excel, aucun ZIP, aucun accès réseau) :
 *   - data/data.json                                  → manches réellement disputées
 *   - tools/lib/championship-tracks.js                → ordre du calendrier + métadonnées
 *   - maquette-circuit/assets/tracks/<asset>/fast_lane.ai  → tracé + profil altimétrique
 *   - maquette-circuit/assets/tracks/<asset>/surfaces.ini  → briefing track limits
 *   - maquette-circuit/assets/tracks/<asset>/overlays.ini  → bornes des secteurs
 *   - maquette-circuit/track-data.js                  → Österreichring 1979 (virages nommés)
 *
 * Les 5 manches disputées prennent les chronos réels de `data/data.json`
 * (meilleur tour, vainqueurs des courses). La manche 6 (Österreichring) reste
 * « à venir » : aucune date n'est inventée, `date: null`.
 *
 * Idempotent : `node tools/build-circuits-data.js` régénère data/circuits.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readFastLane, detectCorners } = require('./lib/read-fast-lane');
const { TRACKS } = require('./lib/championship-tracks');
const shared = require('./lib/circuit-round');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Lit un tracé compact (`line.json`) produit par tools/lib/pack-fast-lane.js
 * et le remet dans la même forme que readFastLane().
 */
function readPackedRaw(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readPackedLine(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pts = raw.data.map(([x, y, z]) => ({ x, y, z, d: 0 }));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].d = acc;
  }
  pts[0].d = 0;
  const lengthM = acc + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z);
  return {
    points: pts,
    lengthM,
    elevMin: Math.min(...pts.map(p => p.y)),
    elevMax: Math.max(...pts.map(p => p.y))
  };
}

const assetPath = (asset, file) => `maquette-circuit/assets/tracks/${asset}/${file}`;

// ---------------------------------------------------------------- utilitaires

const fmtLap = ms => {
  if (!Number.isFinite(ms)) return null;
  const m = Math.floor(ms / 60000);
  const rest = ms - m * 60000;
  const s = Math.floor(rest / 1000);
  const t = Math.round(rest - s * 1000);
  if (t === 1000) return fmtLap(ms + 1);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
};

const lapToMs = txt => {
  const m = String(txt || '').match(/^(\d+):([\d.]+)$/);
  return m ? +m[1] * 60000 + parseFloat(m[2]) * 1000 : Infinity;
};

/** Formate un nombre à la française : 5901.35 → « 5 901,4 ». */
const fr = (n, digits = 1) =>
  Number(n).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const num = (n, digits = 0) =>
  Number(n).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ---------------------------------------------------------------- 1. sessions

const sessions = JSON.parse(read('data/data.json'));

const byDate = new Map();
for (const s of sessions) {
  if (!s || !s.date) continue;
  const day = String(s.date).slice(0, 10);
  if (!byDate.has(day)) byDate.set(day, []);
  byDate.get(day).push(s);
}

const racedDays = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));

/** Retourne les stats d'une manche : vainqueurs, meilleur tour, partiels. */
function roundStats(list) {
  const races = list.filter(s => s.type === 'RACE');
  const qualify = list.filter(s => s.type === 'QUALIFY');
  const names = new Set();
  let fastest = null;
  let fastestRace = null;
  const perDriver = new Map();

  for (const session of list) {
    for (const row of session.results || []) {
      const key = row.id || row.name;
      if (key) names.add(key);
      if (!Number.isFinite(row.best)) continue;
      if (!fastest || row.best < fastest.ms) fastest = { ms: row.best, driver: row.name, session: session.type };
      if (session.type === 'RACE' && (!fastestRace || row.best < fastestRace.ms)) {
        fastestRace = { ms: row.best, driver: row.name };
      }
      if (row.name) {
        const cur = perDriver.get(row.name);
        if (!cur || row.best < cur) perDriver.set(row.name, row.best);
      }
    }
  }

  const winners = races.map(session => {
    const rows = (session.results || [])
      .filter(r => !r.disqualified)
      .sort((a, b) => (a.time ?? 1e18) - (b.time ?? 1e18));
    return rows.length ? rows[0].name : null;
  }).filter(Boolean);

  // Podium de la dernière course de la manche (ordre d'arrivée).
  const lastRace = races[races.length - 1];
  const podium = lastRace
    ? (lastRace.results || [])
        .filter(r => !r.disqualified && Number.isFinite(r.time))
        .sort((a, b) => a.time - b.time)
        .slice(0, 3)
        .map((r, i) => ({ pos: i + 1, name: r.name, team: r.team || '', time: fmtLap(r.time) }))
    : [];

  return {
    qualify: qualify.length,
    races: races.length,
    drivers: names.size,
    winners,
    podium,
    fastestLap: fastest ? { time: fmtLap(fastest.ms), driver: fastest.driver, session: fastest.session } : null,
    fastestRaceLap: fastestRace ? { time: fmtLap(fastestRace.ms), driver: fastestRace.driver } : null
  };
}

// ---------------------------------------------------------------- 2. géométrie

// La construction du tracé et du profil est partagée avec l'import Drive
// (`tools/lib/circuit-round.js`) : un circuit importé et un circuit statique
// ont ainsi exactement la même structure de fiche.
const VIEW = shared.VIEW;
const project = shared.project;
const buildProfile = shared.buildProfile;

/**
 * Tracé SVG + repères, à partir des points du `line.json`.
 * `packed.corners` porte les virages détectés en pleine résolution par
 * `pack-fast-lane.js` ; à défaut on les détecte à la volée.
 */
function buildOutline(track, meta, packed = {}) {
  const norms = Array.isArray(packed.corners) && packed.corners.length
    ? packed.corners
    : detectCorners(track.points).map(c => c.norm);
  return shared.buildOutline(track, { sectors: meta.sectors, cornerNorms: norms });
}

// ---------------------------------------------------------------- 3. fichiers INI

/** Lit `surfaces.ini` : adhérence, validité, voie des stands. */
function readSurfaces(file) {
  let txt;
  try {
    txt = read(file);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const block of txt.split(/\[SURFACE_\d+\]/).slice(1)) {
    const get = key => {
      const m = block.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const key = get('KEY');
    if (!key) continue;
    const friction = parseFloat(get('FRICTION'));
    out.push({
      key,
      grip: Number.isFinite(friction) ? Math.round(friction * 100) : null,
      valid: get('IS_VALID_TRACK') === '1',
      pit: get('IS_PITLANE') === '1'
    });
  }
  return out;
}

/** Traduit les clés AC en libellés pilotes. */
const SURFACE_LABELS = {
  ROAD: { label: 'Asphalte', note: 'Surface de course principale' },
  PITS: { label: 'Stands', note: 'Voie des stands — vitesse limitée' },
  PIT: { label: 'Stands', note: 'Voie des stands — vitesse limitée' },
  PITS1: { label: 'Stands', note: 'Voie des stands — vitesse limitée' },
  CURB: { label: 'Vibreurs', note: 'Franchissables, attention au survirage' },
  KERB: { label: 'Vibreurs', note: 'Franchissables, attention au survirage' },
  CARPET: { label: 'Tapis', note: 'Zone de dégagement — cut sanctionné' },
  GRASS: { label: 'Herbe', note: 'Hors piste — adhérence très faible' },
  SAND: { label: 'Graviers', note: 'Bac à gravier — sortie de piste' },
  PADDOCK: { label: 'Paddock', note: 'Hors piste — validé uniquement aux stands' },
  ASPHALT: { label: 'Asphalte', note: 'Surface de course principale' },
  CONCRETE: { label: 'Béton', note: 'Zone de dégagement' }
};

function surfaceRows(trackMeta) {
  if (!trackMeta.asset) return [];
  const rows = readSurfaces(assetPath(trackMeta.asset, 'surfaces.ini'));
  const seen = new Set();
  return rows
    .map(r => {
      const meta = SURFACE_LABELS[r.key] || { label: r.key, note: '' };
      return { key: r.key, label: meta.label, grip: r.grip, valid: r.valid, pit: r.pit, note: meta.note };
    })
    // Deux clés AC peuvent désigner la même surface (ASPHALT / ROAD) : on garde
    // la première, qui est celle réellement utilisée par la ligne de course.
    .filter(r => {
      if (seen.has(r.label)) return false;
      seen.add(r.label);
      return true;
    })
    .filter(r => r.label !== r.key || /^(ROAD|CURB|GRASS|SAND|PIT|CARPET|KERB)$/.test(r.key))
    .sort((a, b) => {
      const rank = s => /ASPHALT|ROAD/.test(s.key) ? 0 : /CURB|KERB/.test(s.key) ? 1 : /PIT/.test(s.key) ? 2 : /CARPET/.test(s.key) ? 3 : 4;
      return rank(a) - rank(b);
    });
}

// ---------------------------------------------------------------- 4. Österreichring

let ost = null;
try {
  const src = read('maquette-circuit/track-data.js');
  const m = src.match(/window\.OST1979_DATA\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (m) ost = JSON.parse(m[1]);
} catch (e) {
  ost = null;
}

/** Tracé Österreichring construit depuis track-data.js (mêmes points que la v1). */
function ostLayout(key) {
  if (!ost || !ost.layouts || !ost.layouts[key]) return null;
  const L = ost.layouts[key];
  const pts = L.pts.map(p => ({ x: p[0], y: p[1], z: p[2], d: p[3] }));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].d = acc;
  }
  pts[0].d = 0;
  const track = { points: pts, lengthM: acc + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) };
  return { layout: L, track };
}

/** Repères nommés de l'Österreichring (les 9 virages de la v1). */
function ostCorners(layoutKey) {
  if (!ost) return [];
  const built = ostLayout(layoutKey);
  if (!built) return [];
  const P = project(built.track.points);
  const n = built.track.points.length;
  return (ost.sections || []).map((sec, i) => {
    const frac = ((sec.in ?? 0) + (sec.out ?? sec.in ?? 0)) / 2;
    const idx = Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
    const p = built.track.points[idx];
    return { id: sec.id ?? i + 1, name: sec.name, x: P.x(p.x), y: P.y(p.z), dist: sec.dist ?? Math.round(frac * built.track.lengthM) };
  });
}

function ostOutline(layoutKey) {
  const built = ostLayout(layoutKey);
  if (!built) return null;
  const o = buildOutline(built.track, { sectors: ost.sectors.concat(1), cornerThreshold: 99 });
  o.corners = ostCorners(layoutKey);
  o.viewBox = `0 0 ${VIEW.w} ${VIEW.h}`;
  return o;
}

function ostProfile(layoutKey) {
  const built = ostLayout(layoutKey);
  return built ? buildProfile(built.track) : null;
}

// ---------------------------------------------------------------- 5. manches

const rounds = [];

for (const meta of TRACKS) {
  // Priorité au calendrier publié sur le site (référence de l'ordre et des dates).
  const pub = meta.published || {};
  // Les sessions importées enrichissent la fiche quand elles existent pour ce circuit.
  const list = [...byDate.values()].flat().filter(s => String(s.track || '').toLowerCase() === String(meta.driverFolder).toLowerCase());
  const imported = list.length ? roundStats(list) : null;
  const stats = imported;
  const done = pub.date ? true : !!imported;

  const round = {
    round: meta.round,
    label: `M${meta.round}`,
    id: meta.id,
    name: meta.name,
    shortName: meta.shortName,
    layout: meta.layout,
    layoutKey: meta.layoutKey,
    driverFolder: meta.driverFolder,
    country: meta.country,
    countryCode: meta.countryCode,
    city: meta.city,
    gps: meta.gps,
    year: meta.year,
    author: meta.author,
    version: meta.version,
    direction: meta.direction,
    pitboxes: meta.pitboxes,
    width: meta.width,
    driveFolderId: meta.driveFolderId,
    driveName: meta.driveName,
    format: meta.format,
    status: done ? 'done' : 'upcoming',
    date: pub.date || null,
    dateLabel: pub.label || null,
    winner: pub.winner || (imported && imported.winners[0]) || null,
    stats: stats || (pub.date ? { qualify: null, races: meta.format === 'Endurance' ? 1 : 2, drivers: null, winners: pub.winner ? [pub.winner] : [], podium: [], fastestLap: null, fastestRaceLap: null } : null)
  };

  if (meta.asset) {
    // Tracé compact versionné (extrait du fast_lane.ai du mod par
    // tools/lib/pack-fast-lane.js). Le .ai brut reste sur le Drive.
    const file = assetPath(meta.asset, 'line.json');
    const track = readPackedLine(path.join(ROOT, file));
    const profile = buildProfile(track);
    round.lengthM = Math.round(track.lengthM);
    round.lengthStr = `${fr(track.lengthM / 1000, 3)} km`;
    round.elevation = { min: profile.min, max: profile.max, delta: profile.delta };
    round.measuredLengthM = Math.round(track.lengthM);
    round.outline = buildOutline(track, meta, readPackedRaw(path.join(ROOT, file)));
    round.profile = profile;
    round.surfaces = surfaceRows(meta);
    // meta.sectors contient les bornes complètes, 0 et 1 inclus : [0, .28, .65, 1] => 3 secteurs.
    const secBounds = (meta.sectors && meta.sectors.length > 2) ? meta.sectors : [0, 1];
    round.sectorSplits = secBounds.slice(1).map((f, i) => ({
      label: `S${i + 1}`,
      from: Math.round((secBounds[i] ?? 0) * track.lengthM),
      to: Math.round(f * track.lengthM)
    }));
    round.hero = `maquette-circuit/assets/tracks/${meta.asset}/preview.png`;
    round.source = assetPath(meta.asset, 'line.json') + ' (extrait du fast_lane.ai)';
  } else {
    // Österreichring : tracé issu de track-data.js (comme l'onglet Circuit v1).
    const profiles = ['chicane', 'no_chicane'].map(key => {
      const built = ostLayout(key);
      if (!built) return null;
      const prof = buildProfile(built.track);
      return {
        key,
        label: built.layout.shortLabel,
        name: built.layout.name,
        lengthM: Math.round(built.track.lengthM),
        lengthStr: `${fr(built.track.lengthM / 1000, 3)} km`,
        elevation: { min: prof.min, max: prof.max, delta: prof.delta },
        outline: ostOutline(key),
        profile: prof
      };
    }).filter(Boolean);
    const main = profiles.find(p => p.key === 'chicane') || profiles[0];
    round.lengthM = main.lengthM;
    round.lengthStr = main.lengthStr;
    round.elevation = main.elevation;
    round.outline = main.outline;
    round.profile = main.profile;
    round.profiles = profiles;
    round.profileKey = main.key;
    round.surfaces = (ost.surfaces || []).flatMap(s => {
      const base = { grip: s.grip ?? null, valid: s.valid !== false, pit: !!s.pit };
      if (String(s.key).includes('/')) {
        // « OFFTRACK / INSIDE » : deux surfaces distinctes dans le mod.
        return String(s.key).split('/').map(k => ({
          ...base,
          key: k.trim(),
          label: k.trim() === 'OFFTRACK' ? 'Herbe (hors piste)' : 'Intérieur de chicane',
          note: k.trim() === 'OFFTRACK'
            ? 'IS_VALID_TRACK = 0 → cut comptabilisé immédiatement par Assetto Corsa'
            : "Coupe d'intérieur interdite (IS_VALID_TRACK = 0)"
        }));
      }
      return [{ ...base, key: s.key, label: s.label || s.key, note: s.note || '' }];
    });
    // Le mod démarre sa ligne d'arrivée à 0.0006 (soit ~4 m) : on ramène la
    // première borne à 0 pour que la chronométrie couvre le tour entier.
    const ostSectors = (ost.sectors || []).slice();
    if (ostSectors.length) ostSectors[0] = 0;
    const ostBounds = [...ostSectors, 1];
    round.sectorSplits = ostSectors.map((f, i) => ({
      label: `S${i + 1}`,
      from: Math.round((ostBounds[i] ?? 0) * main.lengthM),
      to: Math.round((ostBounds[i + 1] ?? 1) * main.lengthM)
    }));
    round.hero = 'maquette-circuit/preview-chicane.png';
    round.heroByVariant = { chicane: 'maquette-circuit/preview-chicane.png', no_chicane: 'maquette-circuit/preview-nochicane.png' };
    round.source = 'maquette-circuit/track-data.js';
    round.namedCorners = ostCorners('chicane').map((c, i) => ({
      id: c.id,
      name: c.name,
      type: (ost.sections[i] || {}).type || '',
      gear: (ost.sections[i] || {}).gear || '',
      note: (ost.sections[i] || {}).note || '',
      in: (ost.sections[i] || {}).in ?? null,
      out: (ost.sections[i] || {}).out ?? null,
      alt: (ost.sections[i] || {}).alt ?? null,
      slope: (ost.sections[i] || {}).slope ?? null,
      dist: (ost.sections[i] || {}).dist ?? null
    }));
    // Collisions de démonstration : position projetée sur le tracé.
    round.demoCollisions = (ost.demoCollisions || []).map(c => {
      const base = { id: c.id, a: c.a, b: c.b, speed: c.speed, lap: c.lap, clock: c.clock || '', corner: c.corner };
      const built = ostLayout('chicane');
      if (Number.isFinite(c.norm) && built) {
        const P = project(built.track.points);
        const idx = Math.min(built.track.points.length - 1, Math.max(0, Math.round(c.norm * (built.track.points.length - 1))));
        const p = built.track.points[idx];
        base.point = { x: P.x(p.x), y: P.y(p.z) };
      }
      return base;
    });
    round.records = {
      s1: { time: '28.412', driver: 'SHERMAN' },
      s2: { time: '54.188', driver: 'Kimy Hoyer' },
      s3: { time: '21.890', driver: 'Fmherrou' },
      ideal: '1:44.490',
      best: '1:44.812'
    };
  }

  rounds.push(round);
}

// ---------------------------------------------------------------- 6. saison

const done = rounds.filter(r => r.status === 'done');
const upcoming = rounds.filter(r => r.status !== 'done');

const bestLaps = done
  .filter(r => r.stats && r.stats.fastestLap)
  .map(r => ({ time: r.stats.fastestLap.time, driver: r.stats.fastestLap.driver, round: r.label, track: r.shortName, ms: lapToMs(r.stats.fastestLap.time) }))
  .filter(r => Number.isFinite(r.ms))
  .sort((a, b) => a.ms - b.ms);

const winners = done.reduce((sum, r) => sum + (r.stats ? r.stats.winners.length : 0), 0);

const payload = {
  meta: {
    championship: 'International Series Lola T290 - GDSP - Championnat',
    car: 'Lola T290',
    slug: 'lola-t290-gdsp-championnat-2026',
    totalRounds: rounds.length,
    completedRounds: done.length,
    source: 'classement-ac-1.onrender.com',
    generatedFrom: [
      'data/data.json',
      'tools/lib/championship-tracks.js',
      'tools/lib/read-fast-lane.js',
      'maquette-circuit/assets/tracks/*/fast_lane.ai',
      'maquette-circuit/track-data.js'
    ],
    note: "L'ordre des manches suit le calendrier publié sur le site. La manche 6 (Österreichring 1979) n'a pas encore de date : elle affiche « Date à confirmer ».",
    updatedAt: new Date().toISOString().slice(0, 10)
  },
  rounds,
  seasonBest: bestLaps[0] || null,
  bestLaps: bestLaps.slice(0, 5),
  completedCount: done.length,
  totalCount: rounds.length,
  winnersCount: winners
};

fs.writeFileSync(path.join(ROOT, 'data/circuits.json'), JSON.stringify(payload, null, 2) + '\n');

console.log(`data/circuits.json écrit : ${rounds.length} manches`);
for (const r of rounds) {
  console.log(
    `  ${r.label} ${r.name.padEnd(28)} ${(r.status === 'done' ? r.date : 'date à confirmer').padEnd(16)} ` +
    `${r.lengthStr.padStart(9)} · ${String((r.outline && r.outline.corners.length) || 0).padStart(2)} virages` +
    (r.stats ? ` · vainqueur ${r.stats.winners[0] || '—'}` : ' · à venir')
  );
}
console.log(`Meilleur tour de la saison : ${payload.seasonBest ? `${payload.seasonBest.time} (${payload.seasonBest.driver}, ${payload.seasonBest.track})` : '—'}`);

#!/usr/bin/env node
/*
 * Génère data/circuits.json — la fiche « Circuit » affichée dans l'onglet
 * Circuits de la section championnat.
 *
 * Sources (toutes locales, aucun Excel / ZIP) :
 *  - data/data.json            : manches réellement disputées (dates, séances, chronos)
 *  - maquette-circuit/track-data.js : tracé Österreichring 1979 (outline, dénivelé,
 *                                     longueurs, virages) extrait de fast_lane.ai
 *  - maquette-circuit/circuits-data.js : métadonnées des 5 circuits du championnat
 *
 * Le script est idempotent : `node tools/build-circuits-data.js` régénère
 * data/circuits.json sans toucher au reste du dépôt.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- 1. Sessions importées ----------
const sessions = JSON.parse(read('data/data.json'));

const TRACK_NAMES = {
  'mt-tremblant_69': 'Mont-Tremblant 1969',
  'riverside': 'Riverside',
  'sebring_90s': 'Sebring',
  'mid_ohio': 'Mid-Ohio'
};

const fmtLap = ms => {
  if (!Number.isFinite(ms)) return null;
  const m = Math.floor(ms / 60000);
  const rest = ms - m * 60000;
  const s = Math.floor(rest / 1000);
  const t = Math.round(rest - s * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
};

const byDate = new Map();
for (const s of sessions) {
  if (!s || !s.date) continue;
  const day = String(s.date).slice(0, 10);
  if (!byDate.has(day)) byDate.set(day, []);
  byDate.get(day).push(s);
}

const raced = [...byDate.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([day, list], i) => {
    const races = list.filter(s => s.type === 'RACE');
    const qualify = list.filter(s => s.type === 'QUALIFY');
    const names = new Set();
    let fastest = null;
    let fastestRaceLap = null;
    for (const session of list) {
      for (const row of session.results || []) {
        if (row.id || row.name) names.add(row.id || row.name);
        if (Number.isFinite(row.best)) {
          if (!fastest || row.best < fastest.ms) fastest = { ms: row.best, driver: row.name, session: session.type };
          if (session.type === 'RACE' && (!fastestRaceLap || row.best < fastestRaceLap.ms)) {
            fastestRaceLap = { ms: row.best, driver: row.name };
          }
        }
      }
    }
    const winners = races.map(session => {
      const rows = (session.results || [])
        .filter(r => !r.disqualified)
        .sort((a, b) => (a.time ?? 1e18) - (b.time ?? 1e18));
      return rows.length ? rows[0].name : null;
    }).filter(Boolean);
    return {
      round: i + 1,
      label: `M${i + 1}`,
      date: day,
      trackId: list[0].track,
      name: TRACK_NAMES[list[0].track] || list[0].track,
      qualify: qualify.length,
      races: races.length,
      drivers: names.size,
      winners,
      fastestLap: fastest ? { time: fmtLap(fastest.ms), driver: fastest.driver, session: fastest.session } : null,
      fastestRaceLap: fastestRaceLap ? { time: fmtLap(fastestRaceLap.ms), driver: fastestRaceLap.driver } : null
    };
  });

// ---------- 2. Tracé Österreichring 1979 ----------
const trackSource = read('maquette-circuit/track-data.js');
const ostMatch = trackSource.match(/window\.OST1979_DATA\s*=\s*(\{[\s\S]*?\});\s*\n/);
if (!ostMatch) throw new Error('OST1979_DATA introuvable dans maquette-circuit/track-data.js');
const ost = JSON.parse(ostMatch[1]);

/** Réduit le tracé à ~220 points et le projette en viewBox 0 0 1000 560. */
function outline(layoutKey, markers = []) {
  const pts = ost.layouts[layoutKey].pts;
  const step = Math.max(1, Math.ceil(pts.length / 220));
  const picked = pts.filter((_, i) => i % step === 0);
  const xs = pts.map(p => p[0]);
  const zs = pts.map(p => p[2]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 34;
  const w = 1000 - pad * 2, h = 560 - pad * 2;
  const scale = Math.min(w / (maxX - minX), h / (maxZ - minZ));
  const offX = pad + (w - (maxX - minX) * scale) / 2;
  const offZ = pad + (h - (maxZ - minZ) * scale) / 2;
  const toX = x => +(offX + (x - minX) * scale).toFixed(1);
  const toY = z => +(offZ + (z - minZ) * scale).toFixed(1);
  const d = picked.map((p, i) => `${i ? 'L' : 'M'}${toX(p[0])} ${toY(p[2])}`).join(' ') + ' Z';
  return {
    path: d,
    start: { x: toX(pts[0][0]), y: toY(pts[0][2]) },
    sectors: ost.sectors.map(frac => {
      const idx = Math.min(pts.length - 1, Math.max(0, Math.round(frac * (pts.length - 1))));
      return { x: toX(pts[idx][0]), y: toY(pts[idx][2]) };
    }),
    corners: markers.map(m => {
      const frac = Math.min(0.999, Math.max(0, Number(m.norm) || 0));
      const idx = Math.round(frac * (pts.length - 1));
      return { id: m.id, name: m.name, x: toX(pts[idx][0]), y: toY(pts[idx][2]) };
    })
  };
}

/** Projette une position normalisée (0→1) du tour sur le tracé réduit. */
function projectPoint(pts, norm) {
  // même logique de cadrage que outline() : on recalcule le viewBox
  const xs = pts.map(p => p[0]);
  const zs = pts.map(p => p[2]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 34;
  const w = 1000 - pad * 2, h = 560 - pad * 2;
  const scale = Math.min(w / (maxX - minX), h / (maxZ - minZ));
  const offX = pad + (w - (maxX - minX) * scale) / 2;
  const offZ = pad + (h - (maxZ - minZ) * scale) / 2;
  const idx = Math.round(Math.min(0.999, Math.max(0, norm)) * (pts.length - 1));
  return { x: +(offX + (pts[idx][0] - minX) * scale).toFixed(1), y: +(offZ + (pts[idx][2] - minZ) * scale).toFixed(1) };
}

const profiles = ['chicane', 'no_chicane'].map(key => {
  const layout = ost.layouts[key];
  const pts = layout.pts;
  // profil altimétrique simplifié (altitude en m) — 120 points suffisent à la lisibilité
  const step = Math.max(1, Math.ceil(pts.length / 120));
  const sampled = pts.filter((_, i) => i % step === 0);
  const ys = sampled.map(p => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys);
  const width = 1000, height = 120;
  const pathD = sampled.map((p, i) => {
    const x = +(i / (sampled.length - 1) * width).toFixed(1);
    const y = +(height - ((p[1] - min) / (max - min || 1)) * (height - 8) - 4).toFixed(1);
    return `${i ? 'L' : 'M'}${x} ${y}`;
  }).join(' ');
  return {
    key,
    label: layout.shortLabel,
    name: layout.name,
    lengthM: Math.round(layout.lengthM),
    lengthStr: `${(layout.lengthM / 1000).toFixed(3).replace('.', ',')} km`,
    elevation: { min: +layout.elevMin.toFixed(1), max: +layout.elevMax.toFixed(1), delta: +layout.elevDelta.toFixed(1) },
    outline: outline(key, (ost.sections || []).map(sec => ({ norm: ((sec.in ?? 0) + (sec.out ?? sec.in ?? 0)) / 2, id: sec.id, name: sec.name }))),
    profile: {
      path: pathD,
      closed: `${pathD} L${width} ${height} L0 ${height} Z`,
      min: +min.toFixed(1),
      max: +max.toFixed(1)
    }
  };
});

// ---------- 3. Métadonnées du championnat ----------
const metaSource = read('maquette-circuit/circuits-data.js');
const metaMatch = metaSource.match(/window\.CIRCUITS_DATA\s*=\s*(\{[\s\S]*?\n\});/);
if (!metaMatch) throw new Error('CIRCUITS_DATA introuvable dans maquette-circuit/circuits-data.js');
const circuitsMeta = Function(`"use strict";const window={};${metaMatch[0].replace('window.CIRCUITS_DATA', 'window.CIRCUITS_DATA')};return window.CIRCUITS_DATA;`)();
const roundsMatch = metaSource.match(/window\.CHAMPIONSHIP_ROUNDS\s*=\s*(\[[\s\S]*?\]);/);
if (!roundsMatch) throw new Error('CHAMPIONSHIP_ROUNDS introuvable');
const roundOrder = Function(`return ${roundsMatch[1]};`)();

const ostMeta = circuitsMeta['oesterreichring-1979'];

// Manche 5 : Österreichring 1979, aucune date inventée.
const upcoming = {
  round: roundOrder.findIndex(r => r.id === 'oesterreichring-1979') + 1 || 5,
  label: 'M5',
  trackId: 'oesterreichring-1979',
  name: ostMeta.name,
  country: ostMeta.country,
  city: ostMeta.city,
  gps: ostMeta.gps,
  year: ostMeta.year,
  author: ostMeta.author,
  pitboxes: ost.pitboxes || ostMeta.pitboxes,
  direction: ostMeta.direction,
  driveFolderId: ostMeta.driveFolderId,
  variants: profiles.map(p => ({ key: p.key, label: p.label, lengthM: p.lengthM, lengthStr: p.lengthStr, elevation: p.elevation })),
  sections: (ost.sections || []).map((s, i) => ({
    id: s.id ?? i + 1,
    name: s.name,
    type: s.type || '',
    gear: s.gear || '',
    note: s.note || '',
    in: Number.isFinite(s.in) ? +s.in : null,
    out: Number.isFinite(s.out) ? +s.out : null,
    alt: Number.isFinite(s.alt) ? +Number(s.alt).toFixed(1) : null,
    slope: Number.isFinite(s.slope) ? +Number(s.slope).toFixed(1) : null,
    dist: Number.isFinite(s.dist) ? +Number(s.dist).toFixed(2) : null
  })),
  surfaces: (ost.surfaces || []).map(s => ({ key: s.key, label: s.label || s.key, grip: s.grip ?? null, valid: s.valid !== false, pit: !!s.pit, note: s.note || '' })),
  demoCollisions: (ost.demoCollisions || []).map(c => {
    const base = { id: c.id, a: c.a, b: c.b, speed: c.speed, lap: c.lap, clock: c.clock || '', corner: c.corner, norm: Number.isFinite(c.norm) ? +c.norm : null };
    const pt = Number.isFinite(c.norm) ? projectPoint(ost.layouts.chicane.pts, c.norm) : null;
    return pt ? { ...base, point: pt } : base;
  }),
  records: ostMeta.records,
  profile: profiles.find(p => p.key === 'chicane'),
  profiles,
  sectors: (ost.sectors || []),
  surfaceFile: 'data/surfaces.ini',
  overlaysFile: 'data/overlays.ini'
};

// Les 4 manches courues reçoivent les infos circuit correspondantes.
for (const round of raced) {
  const meta = circuitsMeta[round.trackId];
  if (meta) {
    round.country = meta.country;
    round.city = meta.city;
    round.lengthStr = meta.lengthStr;
    round.pitboxes = meta.pitboxes;
    round.year = meta.year || null;
  }
}

const payload = {
  meta: {
    championship: 'International Series Lola T290 - GDSP - Championnat',
    car: 'Lola T290',
    generatedFrom: ['data/data.json', 'maquette-circuit/track-data.js', 'maquette-circuit/circuits-data.js'],
    note: 'La manche 5 (Österreichring 1979) n’a pas encore de date : elle sera renseignée par la Direction de course.',
    updatedAt: new Date().toISOString().slice(0, 10)
  },
  rounds: raced,
  upcoming,
  completedCount: raced.length,
  totalCount: roundOrder.length
};

fs.writeFileSync(path.join(ROOT, 'data/circuits.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(`data/circuits.json écrit : ${raced.length} manche(s) disputée(s), manche ${upcoming.round} = ${upcoming.name} (sans date).`);
console.log('Tracés :', profiles.map(p => `${p.label} ${p.lengthStr}`).join(' · '));

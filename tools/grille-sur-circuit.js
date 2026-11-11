#!/usr/bin/env node
/*
 * Placement de la grille « finir ensemble » SUR le tracé d'un circuit.
 *
 * Prend la grille produite par grille-temps-moyens.js (handicap en secondes de
 * chaque pilote) et la convertit en positions réelles le long de la piste :
 *
 *   distance du pilote i sur la piste = (temps à rattraper) × vitesse de référence
 *   distance du leader            = L − marge de sécurité avant la ligne
 *
 * Concrètement le plus lent est posé devant et le meilleur juste derrière, à
 * une distance qui vaut exactement ce qu'il reprendrait en N tours. Tout le
 * monde passe la ligne en même temps si chacun roule à son rythme de qualif.
 *
 * Ce que l'outil produit :
 *   1. un tableau : position sur la grille, distance parcourue (m), coordonnées
 *      monde AC (X, Z), position dans le tour en %, latitude de chaque voiture ;
 *   2. un SVG à l'échelle du tracé (aperçu visuel de la grille) ;
 *   3. les valeurs au format des fichiers `[START_n]` / `[GRID_n]` d'AC
 *      (POS=x,y,z — ORIENTATION en radians pour AC) ;
 *   4. un avertissement de faisabilité : si la grille dépasse un tour de
 *      circuit, elle ne peut pas être posée -> on le dit et on propose --cap.
 *
 * Sources locales uniquement : `maquette-circuit/assets/tracks/<asset>/line.json`
 * (tracé du fast_lane.ai) et `data/circuits.json` (longueurs, secteurs).
 *
 * Usage :
 *   node tools/grille-sur-circuit.js data/2026_9_9_21_37_QUALIFY.json --tours=15
 *   node tools/grille-sur-circuit.js <qualify.json> --tours=15 --cap=40 --svg=grille.svg
 *   node tools/grille-sur-circuit.js <qualify.json> --tours=15 --marge=40 --sens=horaire
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildGrid } = require('./grille-temps-moyens');
const { TRACKS } = require('./lib/championship-tracks');

const ROOT = path.resolve(__dirname, '..');

/** Lit le tracé compacté (`line.json`) d'un dossier d'assets. */
function readLine(asset) {
  const file = path.join(ROOT, 'maquette-circuit', 'assets', 'tracks', asset, 'line.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pts = raw.data.map(([x, y, z], i) => ({ x, y, z, d: 0, i }));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].d = acc;
  }
  const closing = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z);
  return { points: pts, lengthM: acc + closing, closing, source: raw.source || file };
}

/** Bornes de secteur (mètres) publiées dans data/circuits.json pour une manche. */
function sectorsOf(roundId, line) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'circuits.json'), 'utf8'));
    const r = (c.rounds || []).find(x => x.id === roundId);
    if (r && Array.isArray(r.sectorSplits) && r.sectorSplits.length) return r.sectorSplits;
    // sinon : 3 secteurs égaux (approximation affichée comme telle)
    return [1, 2].map(i => ({ label: 'S' + i, from: line.lengthM * (i - 1) / 3, to: line.lengthM * i / 3 }));
  } catch (e) { return []; }
}

/** Trouve la manche du championnat correspondant à une session. */
function findRound(trackName, config) {
  const name = String(trackName || '').toLowerCase();
  return TRACKS.find(t => t.driverFolder.toLowerCase() === name)
    || TRACKS.find(t => String(config || '').toLowerCase() === String(t.layoutKey || '').toLowerCase())
    || null;
}

/** Point du tracé à une distance donnée (interpolation linéaire), + cap. */
function pointAt(line, dist) {
  const L = line.lengthM;
  let d = ((dist % L) + L) % L;
  const pts = line.points;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[(lo + 1) % pts.length];
  const segLen = (b.d === a.d) ? Math.max(1e-6, L - a.d) : (b.d - a.d);
  const t = Math.max(0, Math.min(1, (d - a.d) / segLen));
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = a.z + (b.z - a.z) * t;
  // Cap AC : 0 = +Z, sens trigonométrique positif autour de Y.
  const headingRad = Math.atan2(b.x - a.x, b.z - a.z);
  return { x, y, z, d, headingRad, seg: lo };
}

/** Distance signée entre deux points du tracé (le long du sens de la piste). */
function signedDelta(line, from, to) {
  const L = line.lengthM;
  let d = to - from;
  while (d > L / 2) d -= L;
  while (d < -L / 2) d += L;
  return d;
}

/** Quatre coins d'une voiture autour d'un point (pour le SVG). */
function carBox(line, p, lenM, widM) {
  const dx = Math.sin(p.headingRad), dz = Math.cos(p.headingRad);
  const nx = dz, nz = -dx;
  const hx = dx * lenM / 2, hz = dz * lenM / 2;
  const wx = nx * widM / 2, wz = nz * widM / 2;
  return [
    [p.x + hx + wx, p.z + hz + wz],
    [p.x + hx - wx, p.z + hz - wz],
    [p.x - hx - wx, p.z - hz - wz],
    [p.x - hx + wx, p.z - hz + wz]
  ];
}

/**
 * Place la grille sur le tracé.
 *
 * Convention : la voiture n°1 (la plus lente) est la plus AVANCÉE, juste avant
 * la ligne. Chaque voiture suivante est posée derrière, à la distance qui vaut
 * l'écart de handicap avec celle qui la précède. On part donc de la ligne et on
 * recule d'une voiture à l'autre ; quand le recul dépasse un tour, la voiture se
 * retrouve « sur le tour précédent » (recul > longueur du circuit) : c'est
 * exactement la situation où la grille ne tient pas sur la piste.
 *
 * @param {object} grid   sortie de buildGrid()
 * @param {object} line   sortie de readLine()
 * @param {object} opts   { marge=30, minSpacing=10, carLength=4.1, carWidth=1.9 }
 */
function placeGrid(grid, line, opts) {
  const o = opts || {};
  const marge = Number.isFinite(o.marge) ? o.marge : 30;
  const minSpacing = Number.isFinite(o.minSpacing) ? o.minSpacing : 10;
  const carLength = Number.isFinite(o.carLength) ? o.carLength : 4.1;
  const carWidth = Number.isFinite(o.carWidth) ? o.carWidth : 1.9;
  const L = line.lengthM;

  const classified = grid.drivers.filter(d => d.classified && Number.isFinite(d.gapSec));
  if (!classified.length) return { cars: [], valid: false, reason: 'aucun pilote classé' };

  const speed = grid.meta.speed;
  // Handicap de chaque voiture en mètres (le plus lent a le plus grand).
  const ideals = classified.map(d => d.gapSec * speed);

  // Recul de chaque voiture depuis la ligne de départ.
  const behind = [marge];
  let pushed = 0;
  for (let i = 1; i < ideals.length; i++) {
    const wanted = ideals[i - 1] - ideals[i];       // écart idéal avec celle devant
    const gap = Math.max(wanted, minSpacing);        // jamais moins que l'espacement mini
    if (gap > wanted + 1e-6) pushed++;
    behind.push(behind[i - 1] + gap);
  }

  const cars = classified.map((d, i) => {
    const dist = ((L - behind[i]) % L + L) % L;
    const p = pointAt(line, dist);
    const gapToAhead = i > 0 ? behind[i] - behind[i - 1] : null;
    return {
      position: i + 1,
      name: d.name,
      guid: d.guid,
      pace: d.pace,
      handicapSec: d.gapSec,
      behindLineM: behind[i],
      lapsBack: Math.floor(behind[i] / L),
      dist,
      lapFrac: dist / L,
      x: p.x, y: p.y, z: p.z,
      headingRad: p.headingRad,
      headingDeg: (p.headingRad * 180 / Math.PI + 360) % 360,
      gapToCarAheadM: gapToAhead,
      overlapping: gapToAhead !== null && gapToAhead < carLength * 1.2,
      box: carBox(line, p, carLength, carWidth)
    };
  });

  const gridLengthM = behind[behind.length - 1] - marge; // du 1er au dernier
  const worstGapM = behind[behind.length - 1];
  const valid = worstGapM < L;
  // Repère pratique : au-delà d'un demi-tour, la moitié du peloton est très
  // loin du meneur. Ça n'invalide pas la formule (chacun passe la ligne au même
  // instant), mais le tour de formation devient très long et une voiture qui
  // perd du temps est vite à un tour : on le signale sans bloquer.
  const wrapRisk = worstGapM > L * 0.5;
  const minGap = Math.min(...cars.filter(c => c.gapToCarAheadM !== null).map(c => c.gapToCarAheadM));

  return {
    cars,
    lengthM: L,
    speed,
    marge,
    minSpacing,
    gridLengthM,
    worstGapM,
    gridLaps: worstGapM / L,
    minGapM: Number.isFinite(minGap) ? minGap : null,
    adjusted: pushed,
    valid,
    wrapRisk,
    reason: valid ? null : `la grille fait ${(worstGapM / L).toFixed(2)} tour(s) : le plus lent serait hors piste`
  };
}

/** Conversion monde AC -> coordonnées du SVG (même projection que l'onglet Circuit). */
function projector(line, width, height, pad) {
  const xs = line.points.map(p => p.x), zs = line.points.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const spanX = Math.max(1e-6, maxX - minX), spanZ = Math.max(1e-6, maxZ - minZ);
  const s = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanZ);
  const offX = (width - spanX * s) / 2, offZ = (height - spanZ * s) / 2;
  return {
    x: x => offX + (x - minX) * s,
    y: z => offZ + (z - minZ) * s,
    scale: s,
    spanX, spanZ
  };
}

/** SVG : tracé à l'échelle + une voiture par pilote, numérotée. */
function renderSvg(placed, line, opts) {
  const o = opts || {};
  const width = o.width || 1100, height = o.height || 780, pad = 40;
  const pr = projector(line, width, height, pad);
  const d = line.points.map((p, i) => `${i ? 'L' : 'M'}${pr.x(p.x).toFixed(1)} ${pr.y(p.z).toFixed(1)}`).join(' ') + 'Z';
  const usable = placed.valid;
  const scaleNote = `échelle : 1 px ≈ ${(1 / pr.scale).toFixed(2)} m`;

  // Les voitures sont grossies pour rester visibles à l'échelle de la carte :
  // 4 m de voiture valent moins de 3 px, on impose un marqueur de 13 px.
  const markerR = 7;
  const cars = placed.cars.map(c => {
    const px = pr.x(c.x), py = pr.y(c.z);
    const dx = Math.sin(c.headingRad), dz = Math.cos(c.headingRad);
    const tip = 11;
    return `<g><line x1="${(px - dx * tip).toFixed(1)}" y1="${(py - dz * tip).toFixed(1)}"`
      + ` x2="${(px + dx * tip).toFixed(1)}" y2="${(py + dz * tip).toFixed(1)}" stroke="#c62828" stroke-width="1.6"/>`
      + `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${markerR}" fill="${c.overlapping ? '#c62828' : '#132d35'}" stroke="#f7ecd5" stroke-width="1.2"/>`
      + `<text x="${px.toFixed(1)}" y="${(py + 3.4).toFixed(1)}" font-size="9" font-weight="bold" fill="#f7ecd5" text-anchor="middle" font-family="sans-serif">${c.position}</text></g>`;
  }).join('\n');

  // Repères : secteurs + ligne de départ
  const sectors = (o.sectors || []).map(s => {
    const p = pointAt(line, s.from);
    return `<circle cx="${pr.x(p.x).toFixed(1)}" cy="${pr.y(p.z).toFixed(1)}" r="5" fill="none" stroke="#b98a2e" stroke-width="1.4"/>`
      + `<text x="${pr.x(p.x).toFixed(1)}" y="${(pr.y(p.z) - 8).toFixed(1)}" font-size="9" fill="#8a6a20" text-anchor="middle" font-family="sans-serif">${s.label}</text>`;
  }).join('\n');
  const fin = pointAt(line, line.lengthM);
  const finish = `<g><line x1="${pr.x(fin.x) - 9}" y1="${pr.y(fin.z)}" x2="${pr.x(fin.x) + 9}" y2="${pr.y(fin.z)}" stroke="#c62828" stroke-width="2.5"/>`
    + `<text x="${pr.x(fin.x)}" y="${(pr.y(fin.z) - 12)}" font-size="10" fill="#c62828" text-anchor="middle" font-family="sans-serif">LIGNE</text></g>`;

  const legend = placed.cars
    .slice(0, 12)
    .map(c => `#${c.position} ${c.name}`).join(' · ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#f8f2e4"/>
<text x="${pad}" y="24" font-size="17" font-family="sans-serif" fill="#102a32">${o.title || 'Grille'} — ${placed.cars.length} voitures · ${(placed.lengthM / 1000).toFixed(3)} km · ${scaleNote}</text>
<path d="${d}" fill="none" stroke="#cfc4a8" stroke-width="${(9 * pr.scale).toFixed(1)}" stroke-linejoin="round"/>
<path d="${d}" fill="none" stroke="#6f6650" stroke-width="0.8" stroke-dasharray="4 4"/>
${sectors}
${finish}
${cars}
<text x="${pad}" y="${height - 30}" font-size="11" font-family="sans-serif" fill="${usable ? '#2e7d32' : '#c62828'}">${usable
    ? `OK — la grille tient dans un tour (${placed.gridLengthM.toFixed(0)} m, ${(placed.gridLaps * 100).toFixed(0)} % du tour)`
    : `IMPOSSIBLE — la grille fait ${placed.gridLaps.toFixed(2)} tour de circuit (${placed.gridLengthM.toFixed(0)} m)`}</text>
<text x="${pad}" y="${height - 14}" font-size="10" font-family="sans-serif" fill="#6f6650">${legend || ''}</text>
<text x="${width - pad}" y="${height - 14}" font-size="10" font-family="sans-serif" fill="#6f6650" text-anchor="end">marqueurs grossis (voitures à l'échelle dans le zoom)</text>
</svg>`;
}

/**
 * Zoom sur un tronçon du tracé (par défaut la ligne de départ ± 450 m), à une
 * échelle où l'on voit vraiment les voitures : c'est là qu'on vérifie que le
 * peloton ne se chevauche pas.
 */
function renderZoomSvg(placed, line, opts) {
  const o = opts || {};
  const width = o.width || 1100, height = o.height || 520, pad = 46;
  const L = line.lengthM;
  const around = Number.isFinite(o.around) ? o.around : 450;
  // Tronçon : de L-around à L, puis de 0 à around (on boucle).
  const want = [];
  const seg = line.points.length;
  for (let i = 0; i < seg; i++) {
    const d = line.points[i].d;
    const inTail = d >= L - around;
    const inHead = d <= around;
    if (inTail || inHead) want.push(line.points[i]);
  }
  if (!want.length) return '';

  const xs = want.map(p => p.x), zs = want.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const spanX = Math.max(1e-6, maxX - minX), spanZ = Math.max(1e-6, maxZ - minZ);
  const sc = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanZ);
  const offX = (width - spanX * sc) / 2, offZ = (height - spanZ * sc) / 2;
  const px = x => offX + (x - minX) * sc;
  const pz = z => offZ + (z - minZ) * sc;

  const path = want.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${pz(p.z).toFixed(1)}`).join(' ');
  const inZone = placed.cars.filter(c => {
    const b = c.dist;
    return b >= L - around || b <= around;
  });
  // Voitures grossies ×3 minimum pour rester lisibles, contour + numéro.
  const grow = Math.max(1, (14 / (4.1 * sc)));
  const cars = inZone.map(c => {
    const dx = Math.sin(c.headingRad), dz = Math.cos(c.headingRad);
    const nx = dz, nz = -dx;
    const hl = 4.1 * grow / 2, hw = 1.9 * grow / 2;
    const corners = [
      [c.x + dx * hl + nx * hw, c.z + dz * hl + nz * hw],
      [c.x + dx * hl - nx * hw, c.z + dz * hl - nz * hw],
      [c.x - dx * hl - nx * hw, c.z - dz * hl - nz * hw],
      [c.x - dx * hl + nx * hw, c.z - dz * hl + nz * hw]
    ];
    const pts = corners.map(([x, z]) => `${px(x).toFixed(1)},${pz(z).toFixed(1)}`).join(' ');
    return `<polygon points="${pts}" fill="#132d35" stroke="#f7ecd5" stroke-width="0.7"/>`
      + `<text x="${px(c.x).toFixed(1)}" y="${(pz(c.z) + 3).toFixed(1)}" font-size="8" fill="#f7ecd5" text-anchor="middle" font-family="sans-serif">${c.position}</text>`
      + `<text x="${px(c.x).toFixed(1)}" y="${(pz(c.z) - 12).toFixed(1)}" font-size="9" fill="#102a32" text-anchor="middle" font-family="sans-serif">${(c.name || '').slice(0, 16)}</text>`;
  }).join('\n');

  const fin = pointAt(line, line.lengthM);
  const finish = `<line x1="${px(fin.x)}" y1="${pz(fin.z) - 22}" x2="${px(fin.x)}" y2="${pz(fin.z) + 22}" stroke="#c62828" stroke-width="2.5"/>`
    + `<text x="${px(fin.x) + 6}" y="${pz(fin.z) - 24}" font-size="10" fill="#c62828" font-family="sans-serif">LIGNE</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#f8f2e4"/>
<text x="${pad}" y="24" font-size="15" font-family="sans-serif" fill="#102a32">${o.title || 'Zoom'} — zone de la ligne (±${around} m), 1 px ≈ ${(1 / sc).toFixed(2)} m</text>
<path d="${path}" fill="none" stroke="#cfc4a8" stroke-width="${(9 * sc).toFixed(1)}" stroke-linejoin="round"/>
<path d="${path}" fill="none" stroke="#6f6650" stroke-width="0.7" stroke-dasharray="3 3"/>
${finish}
${cars}
<text x="${pad}" y="${height - 16}" font-size="10" font-family="sans-serif" fill="#6f6650">${inZone.length} voiture(s) dans la zone · écart mini du peloton : ${placed.minGapM ? placed.minGapM.toFixed(0) + ' m' : '—'} · voitures grossies ×${grow.toFixed(1)}</text>
</svg>`;
}

/**
 * Génère l'arborescence d'un layout AC autonome à partir du tracé :
 *
 *   <dir>/models_gdsp.ini      un seul kn5 (go_gdsp.kn5) qui porte les AC_START_n
 *   <dir>/go_gdsp.kn5          à produire dans ksEditor (objets vides, voir .txt)
 *   <dir>/gdsp/data/…          surfaces.ini, overlays.ini, ai/fast_lane.ai à copier
 *   <dir>/gdsp/ui/ui_track.json   pitboxes = nombre de voitures de la grille
 *
 * models_gdsp.ini suffit à ajouter le layout sur une piste déjà installée : le
 * jeu charge le kn5 d'origine (via son propre models.ini) plus celui-ci.
 */
function writeLayoutSkeleton(dir, placed, line, opts) {
  const o = opts || {};
  const fsx = require('fs');
  const layout = o.layout || 'gdsp';
  const track = o.track || 'track';
  const mk = p => fsx.mkdirSync(p, { recursive: true });

  mk(path.join(dir, `${layout}`, 'data'));
  mk(path.join(dir, `${layout}`, 'ui'));
  mk(path.join(dir, `${layout}`, 'ai'));

  fsx.writeFileSync(path.join(dir, `models_${layout}.ini`),
    `; Ajouté par tools/grille-sur-circuit.js\n`
    + `; Les AC_START_n de la grille GDSP vivent dans go_${layout}.kn5.\n`
    + `[MODEL_0]\nFILE=go_${layout}.kn5\nPOSITION=0,0,0\nROTATION=0,0,0\n`);

  const ui = {
    name: `${track} — Grille GDSP (${placed.cars.length} voitures)`,
    description: `Layout généré pour un départ à écarts calculés depuis la qualification. `
      + `${placed.cars.length} positions de départ, écart 1er→dernier ${placed.worstGapM.toFixed(0)} m `
      + `(${(placed.gridLaps * 100).toFixed(0)} % d'un tour).`,
    tags: ['gdsp', 'grille', 'rolling start'],
    country: '',
    city: '',
    length: String(Math.round(line.lengthM)),
    width: '',
    pitboxes: String(placed.cars.length),
    run: 'clockwise',
    year: 2026,
    author: 'GDSP',
    version: '1.0',
    url: null
  };
  fsx.writeFileSync(path.join(dir, layout, 'ui', 'ui_track.json'), JSON.stringify(ui, null, 2) + '\n');

  const readme = [];
  readme.push(`Layout « ${layout} » — ${placed.cars.length} positions de départ`);
  readme.push('');
  readme.push('1. Dans ksEditor (ou Blender), crée un objet vide par voiture, nommé');
  readme.push(`   AC_START_0 … AC_START_${placed.cars.length - 1}, avec les POS/ORIENTATION`);
  readme.push(`   du fichier ${layout}.start.txt (même repère que le kn5 de la piste).`);
  readme.push(`2. Exporte ces objets dans go_${layout}.kn5 (eux seuls, aucun mesh).`);
  readme.push(`3. Vérifie ui/ui_track.json : "pitboxes" = ${placed.cars.length}, sinon le serveur`);
  readme.push('   refusera plus de voitures que de boxes.');
  readme.push(`4. Installe le dossier dans content/tracks/${track}/ puis`);
  readme.push(`   TRACK=${track} et CONFIG_TRACK=${layout} dans server_cfg.ini.`);
  readme.push('');
  readme.push('Note : le serveur dédié n\'a besoin que de surfaces.ini, drs_zones.ini et');
  readme.push(`models_${layout}.ini, mais il lui faut AUSSI go_${layout}.kn5 pour connaître la`);
  readme.push('grille (les positions ne sont pas dans un .ini).');
  fsx.writeFileSync(path.join(dir, 'LIRE-MOI.txt'), readme.join('\n') + '\n');
  fsx.writeFileSync(path.join(dir, `${layout}.start.txt`), renderAcBlock(placed));
  return dir;
}

/** Bloc texte prêt à coller dans un fichier de piste AC. */
function renderAcBlock(placed) {
  const out = [];
  out.push('# Convention utilisée : les positions sont dans l\'ordre de la grille,');
  out.push('# la n°1 étant la plus AVANCÉE (juste avant la ligne). POS=x,y,z en');
  out.push('# mètres (monde AC), ORIENTATION en radians (0 = +Z).');
  for (const c of placed.cars) {
    out.push(`[START_${c.position - 1}]`);
    out.push(`POS=${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}`);
    out.push(`ORIENTATION=${c.headingRad.toFixed(5)}`);
    out.push('');
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const out = { marge: 30, widthMm: 1900, lengthMm: 4100 };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { if (!out.file) out.file = a; continue; }
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = m[2];
    if (k === 'laps' && v !== undefined) out.tours = Number(v);
    else if (['tours', 'cap', 'marge', 'trim', 'minLaps', 'length', 'espacement', 'longueurVoiture'].includes(k) && v !== undefined) out[k] = Number(v);
    else if (['svg', 'txt', 'mode', 'sens', 'asset', 'layoutDir', 'layout'].includes(k)) out[k] = v;
    else if (k === 'zoom' && v !== undefined) out.zoom = Number(v);
    else if (k === 'json') out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage : node tools/grille-sur-circuit.js <session_qualify.json> --tours=15 [--cap=40] [--marge=30] [--svg=grille.svg]');
    process.exit(2);
  }
  const session = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const round = findRound(session.TrackName, session.TrackConfig);
  if (!round || !round.asset) {
    console.error(`Circuit inconnu ou sans tracé local : « ${session.TrackName} » / « ${session.TrackConfig} ». `
      + 'Les circuits disponibles sont : ' + TRACKS.filter(t => t.asset).map(t => t.driverFolder).join(', '));
    process.exit(1);
  }
  const line = readLine(round.asset);
  const laps = Number.isFinite(args.tours) ? args.tours : 15;

  const grid = buildGrid(session, {
    laps,
    cap: args.cap,
    mode: args.mode,
    trim: args.trim,
    minLaps: args.minLaps,
    lengthM: Math.round(line.lengthM)
  });
  if (!Number.isFinite(grid.meta.speed)) {
    console.error('Impossible de déduire une vitesse de référence : session sans temps au tour exploitable.');
    process.exit(1);
  }

  if (Number.isFinite(args.espacement)) args.minSpacing = args.espacement;
  if (Number.isFinite(args.longueurVoiture)) args.lengthMm = args.longueurVoiture * 1000;
  const placed = placeGrid(grid, line, {
    marge: args.marge,
    minSpacing: args.minSpacing,
    carLength: args.lengthMm / 1000,
    carWidth: args.widthMm / 1000
  });

  const title = `${round.shortName} · ${laps} tours`;
  if (args.json) {
    console.log(JSON.stringify({ round: round.id, laps, meta: grid.meta, placed }, null, 2));
  } else {
    console.log(`${round.name} — ${round.layout} — tracé ${(line.lengthM / 1000).toFixed(3)} km (${round.width})`);
    console.log(`Course de ${laps} tours · marge avant la ligne ${args.marge} m`
      + ` · espacement mini ${placed.minSpacing} m`
      + (args.cap ? ` · écarts plafonnés à ${args.cap} s` : ''));
    console.log(`Grille : ${placed.cars.length} voitures sur ${placed.gridLengthM.toFixed(0)} m `
      + `(${(placed.gridLaps * 100).toFixed(0)} % d'un tour ; `
      + `${(placed.gridLengthM / Math.max(1, placed.cars.length - 1)).toFixed(0)} m en moyenne entre deux voitures)\n`);
    console.log('N°  Pilote                 Handicap  Recul ligne  Position tour   X (m)      Z (m)     Cap');
    console.log('-'.repeat(102));
    for (const c of placed.cars) {
      console.log(
        String(c.position).padStart(2) + '  ' +
        (c.name || '').slice(0, 20).padEnd(20) + '  ' +
        (c.handicapSec.toFixed(1) + ' s').padStart(8) + '  ' +
        (c.behindLineM.toFixed(0) + ' m' + (c.lapsBack ? ' (-1 tr)' : '')).padStart(12) + '  ' +
        ((c.lapFrac * 100).toFixed(1) + ' %').padStart(12) + '  ' +
        c.x.toFixed(1).padStart(9) + '  ' +
        c.z.toFixed(1).padStart(9) + '  ' +
        c.headingDeg.toFixed(0).padStart(4) + '°');
    }
    console.log('');
    if (placed.valid) {
      console.log(`✓ Faisable : le plus lent est à ${placed.gridLengthM.toFixed(0)} m du leader, `
        + `soit ${(placed.gridLaps * 100).toFixed(0)} % d'un tour.`);
      if (placed.adjusted) {
        console.log(`  ⚠ ${placed.adjusted} voiture(s) relevées à l'espacement minimum de ${placed.minSpacing} m `
          + `(l'écart idéal était plus court : elles se chevauchaient).`);
      }
      if (Number.isFinite(placed.minGapM)) {
        console.log(`  Écart le plus court du peloton : ${placed.minGapM.toFixed(0)} m.`);
      }
      if (placed.wrapRisk) {
        console.log(`  ⚠ La grille couvre ${(placed.gridLaps * 100).toFixed(0)} % d'un tour : les premières voitures`);
        console.log('    passeraient « un tour devant » une course comptée en tours. Pour du comptage en tours,');
        console.log('    viser ≤ 50 % d\'un tour (--cap ou --tours plus petit).');
      }
    } else {
      console.log(`✗ Impossible à poser : ${placed.reason}.`);
      console.log('  → utiliser --cap=40 (écarts compressés), ou --tours plus petit '
        + `(maximum ici : ${grid.meta.feasible.pleine[0].laps.toFixed(1)} tours).`);
    }
  }

  const outDir = path.join(ROOT, 'exports');
  if (!args.json) fs.mkdirSync(outDir, { recursive: true });
  const svgFile = args.svg || path.join(outDir, `grille-${round.id}-${laps}t.svg`);
  fs.writeFileSync(svgFile, renderSvg(placed, line, {
    title,
    sectors: sectorsOf(round.id, line)
  }));
  const txtFile = args.txt || svgFile.replace(/\.svg$/, '') + '.ini.txt';
  fs.writeFileSync(txtFile, renderAcBlock(placed));
  if (args.layoutDir) {
    writeLayoutSkeleton(args.layoutDir, placed, line, {
      layout: args.layout || 'gdsp',
      track: round.driverFolder
    });
    if (!args.json) console.error(`Layout AC : ${args.layoutDir}`);
  }
  const zoomFile = svgFile.replace(/\.svg$/, '') + '-zoom.svg';
  fs.writeFileSync(zoomFile, renderZoomSvg(placed, line, { title, around: args.zoom || 450 }));
  if (!args.json) console.error(`\nSVG : ${svgFile}\nZoom ligne : ${zoomFile}\nBloc AC : ${txtFile}`);
}

module.exports = { readLine, pointAt, placeGrid, renderSvg, renderZoomSvg, renderAcBlock, writeLayoutSkeleton, findRound, signedDelta };

if (require.main === module) main();

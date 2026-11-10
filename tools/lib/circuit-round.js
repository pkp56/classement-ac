'use strict';
/**
 * Construction d'une fiche de manche « prête à afficher » à partir d'un tracé.
 *
 * Utilisé par :
 *   - `tools/build-circuits-data.js` (fichier statique `data/circuits.json`)
 *   - `tools/lib/drive-circuits.js` (import depuis Google Drive)
 *
 * Produire la fiche au même endroit évite que l'onglet Circuit sache afficher
 * un circuit statique mais pas un circuit importé (ou l'inverse).
 *
 * Sortie : les champs consommés par `circuit()` dans `site.js`
 * (`outline`, `profile`, `profiles`, `lengthM`, `elevation`, `surfaces`,
 * `sectorSplits`…).
 */

const VIEW = { w: 1000, h: 560, pad: 34 };

/** Projection x/z -> viewBox, en conservant le sens de rotation. */
function project(pts) {
  const xs = pts.map(p => p.x);
  const zs = pts.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const w = VIEW.w - VIEW.pad * 2;
  const h = VIEW.h - VIEW.pad * 2;
  const scale = Math.min(w / (maxX - minX || 1), h / (maxZ - minZ || 1));
  const offX = VIEW.pad + (w - (maxX - minX) * scale) / 2;
  const offY = VIEW.pad + (h - (maxZ - minZ) * scale) / 2;
  return {
    // z vers le bas : le nord reste en haut, le sens du tour est préservé.
    x: x => +(offX + (x - minX) * scale).toFixed(1),
    y: z => +(offY + (z - minZ) * scale).toFixed(1),
    scale
  };
}

/**
 * Tracé SVG + repères (départ, secteurs, virages).
 *
 * @param {{points:Array<{x:number,y:number,z:number,d:number}>, lengthM:number}} track
 * @param {{sectors?:number[], cornerNorms?:number[]}} [opts]
 *   `sectors` : bornes complètes en fraction de tour, 0 et 1 inclus.
 *   `cornerNorms` : virages déjà détectés (sinon aucun repère de virage).
 */
function buildOutline(track, opts = {}) {
  const { points } = track;
  if (!points || !points.length) return null;
  const P = project(points);
  const n = points.length;
  const stride = Math.max(1, Math.ceil(n / 240));
  const picked = points.filter((_, i) => i % stride === 0);
  if (picked[picked.length - 1] !== points[n - 1]) picked.push(points[n - 1]);

  const d = picked.map((p, i) => `${i ? 'L' : 'M'}${P.x(p.x)} ${P.y(p.z)}`).join(' ') + ' Z';
  const at = frac => {
    const idx = Math.min(n - 1, Math.max(0, Math.round((Number(frac) || 0) * (n - 1))));
    return { x: P.x(points[idx].x), y: P.y(points[idx].z) };
  };

  const totalDist = points[n - 1].d || 1;

  const cornerNorms = Array.isArray(opts.cornerNorms) ? opts.cornerNorms : [];
  const corners = cornerNorms.map((norm, i) => {
    const clamped = Math.min(0.9999, Math.max(0, Number(norm) || 0));
    const idx = Math.min(n - 1, Math.max(0, Math.round(clamped * (n - 1))));
    const pt = points[idx];
    return {
      id: i + 1,
      x: P.x(pt.x),
      y: P.y(pt.z),
      dist: Math.round(pt.d),
      norm: +clamped.toFixed(4)
    };
  });

  // Bornes internes : [0, .28, .65, 1] => 2 repères (S1, S2).
  const bounds = Array.isArray(opts.sectors) && opts.sectors.length > 2 ? opts.sectors : [];
  const sectors = bounds.slice(1, -1).map((f, i) => {
    const idx = Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))));
    return {
      x: P.x(points[idx].x),
      y: P.y(points[idx].z),
      at: +f.toFixed(4),
      label: `S${i + 1}`,
      dist: Math.round(f * totalDist)
    };
  });

  return {
    path: d,
    start: { x: P.x(points[0].x), y: P.y(points[0].z) },
    sectors,
    corners,
    viewBox: `0 0 ${VIEW.w} ${VIEW.h}`
  };
}

/** Profil altimétrique sur un tour, normalisé dans une viewBox 1000×120. */
function buildProfile(track) {
  const pts = track.points;
  if (!pts || pts.length < 2) return null;
  const stride = Math.max(1, Math.ceil(pts.length / 140));
  const picked = pts.filter((_, i) => i % stride === 0);
  if (picked[picked.length - 1] !== pts[pts.length - 1]) picked.push(pts[pts.length - 1]);
  const ys = picked.map(p => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const H = 120;

  // Lissage léger pour éviter le bruit de la télémétrie.
  const smooth = ys.map((_, i) => {
    const win = ys.slice(Math.max(0, i - 2), Math.min(ys.length, i + 3));
    return win.reduce((a, b) => a + b, 0) / win.length;
  });

  const pathD = smooth.map((y, i) => {
    const x = +((i / (smooth.length - 1)) * VIEW.w).toFixed(1);
    const yy = +(H - ((y - min) / (max - min || 1)) * (H - 8) - 4).toFixed(1);
    return `${i ? 'L' : 'M'}${x} ${yy}`;
  }).join(' ');

  return {
    path: pathD,
    closed: `${pathD} L${VIEW.w} ${H} L0 ${H} Z`,
    min: +min.toFixed(1),
    max: +max.toFixed(1),
    delta: +(max - min).toFixed(1)
  };
}

/**
 * Secteurs au format consommé par l'onglet : `[{label, from, to}]` en MÈTRES.
 * @param {number[]} bounds bornes complètes en fraction de tour
 * @param {number} lengthM
 */
function buildSectorSplits(bounds, lengthM) {
  if (!Array.isArray(bounds) || bounds.length < 2) return [];
  return bounds.slice(1).map((f, i) => ({
    label: `S${i + 1}`,
    from: Math.round((bounds[i] ?? 0) * lengthM),
    to: Math.round(f * lengthM)
  }));
}

/**
 * Assemble la fiche complète.
 *
 * @param {object} track `{points, lengthM}` (points avec `d` calculé)
 * @param {object} meta  champs de la manche à conserver
 * @param {{sectors?:number[], cornerNorms?:number[]}} [opts]
 */
function buildRound(track, meta = {}, opts = {}) {
  const lengthM = Math.round(track.lengthM);
  const outline = buildOutline(track, { sectors: opts.sectors, cornerNorms: opts.cornerNorms });
  const profile = buildProfile(track);
  const bounds = Array.isArray(opts.sectors) && opts.sectors.length > 2 ? opts.sectors : [0, 1];
  const cornerNorms = Array.isArray(opts.cornerNorms) ? opts.cornerNorms : [];

  return {
    ...meta,
    lengthM,
    lengthStr: `${(lengthM / 1000).toFixed(3).replace('.', ',')} km`,
    measuredLengthM: lengthM,
    elevation: profile ? { min: profile.min, max: profile.max, delta: profile.delta } : null,
    outline,
    profile,
    profiles: profile ? { default: profile } : {},
    sectorSplits: buildSectorSplits(bounds, lengthM),
    sectorCount: buildSectorSplits(bounds, lengthM).length,
    cornerCount: cornerNorms.length
  };
}

module.exports = { VIEW, project, buildOutline, buildProfile, buildSectorSplits, buildRound };

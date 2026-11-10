'use strict';
/**
 * Lecture des `fast_lane.ai` d'Assetto Corsa et détection des virages.
 *
 * Format binaire d'un `fast_lane.ai` :
 *   en-tête de 16 octets : [version(int32), count(int32), 0, 0]
 *   puis `count` enregistrements de 20 octets : { float x, float y (altitude), float z, float distance, uint32 id }
 *
 * Ce module est volontairement sans dépendance : il sert au build
 * (`tools/build-circuits-data.js`) et à l'outil de compactage
 * (`tools/lib/pack-fast-lane.js`).
 */

const fs = require('fs');

/**
 * Lit un `fast_lane.ai` et renvoie la ligne rapide sous forme exploitable.
 * @param {string} file chemin du fichier `.ai`
 * @returns {{points: Array<{x:number,y:number,z:number,d:number,id:number}>, lengthM:number, elevMin:number, elevMax:number, version:number}}
 */
function readFastLane(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 16) throw new Error(`fast_lane.ai illisible (fichier trop court) : ${file}`);

  const version = buf.readInt32LE(0);
  const count = buf.readInt32LE(4);
  if (!Number.isFinite(count) || count <= 0) throw new Error(`fast_lane.ai sans points : ${file}`);
  if (buf.length < 16 + count * 20) throw new Error(`fast_lane.ai tronqué : ${file}`);

  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 20;
    points[i] = {
      x: buf.readFloatLE(o),
      y: buf.readFloatLE(o + 4),
      z: buf.readFloatLE(o + 8),
      d: buf.readFloatLE(o + 12),
      id: buf.readUInt32LE(o + 16)
    };
  }

  // La distance embarquée n'est pas toujours cohérente : on la recalcule
  // en fermant la boucle (dernier point → premier point).
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    points[i].d = acc;
  }
  points[0].d = 0;
  const closing = Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z);
  const lengthM = acc + closing;

  let elevMin = Infinity;
  let elevMax = -Infinity;
  for (const p of points) {
    if (p.y < elevMin) elevMin = p.y;
    if (p.y > elevMax) elevMax = p.y;
  }

  return { points, lengthM, elevMin, elevMax, version };
}

/** Lissage par moyenne glissante centrée (fenêtre `span` de chaque côté). */
function smooth(values, span) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -span; k <= span; k++) {
      const j = (i + k + values.length) % values.length;
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

/**
 * Détecte les virages à partir de la courbure de la ligne rapide.
 *
 * Méthode (validée sur les 5 tracés du championnat) : on calcule l'angle de
 * braquage entre deux tangentes espacées de ±`TANGENT`, on lisse ce signal,
 * puis on retient les pics locaux suffisamment marqués, espacés d'au moins
 * `minDist` mètres. Un pic donne une fraction de tour (`norm`, 0→1).
 *
 * Important : appeler cette fonction sur la ligne **pleine résolution**.
 * La décimer d'abord fait fusionner les virages rapprochés (résultat : 2–4
 * virages au lieu de 9–17).
 *
 * @param {Array<{x:number,y:number,z:number,d:number}>} points
 * @param {{minDist?:number, absMin?:number, ratio?:number, span?:number, tangent?:number}} [opts]
 * @returns {Array<{norm:number, dist:number, angle:number, id:number}>} virages triés par `norm`
 */
function detectCorners(points, opts = {}) {
  const n = points.length;
  if (!Array.isArray(points) || n < 12) return [];

  const minDist = opts.minDist ?? 45;
  const absMin = opts.absMin ?? 0.0012;
  const ratio = opts.ratio ?? 0.10;
  const span = opts.span ?? 10;
  const tangent = opts.tangent ?? 4;

  const total = points[n - 1].d || 1;

  // Angle signé entre le segment entrant et le segment sortant, en unités de
  // courbure par mètre (rad / m).
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[(i - tangent + n) % n];
    const b = points[i];
    const c = points[(i + tangent) % n];
    const v1 = Math.atan2(b.x - a.x, b.z - a.z);
    const v2 = Math.atan2(c.x - b.x, c.z - b.z);
    let delta = v2 - v1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const ds = Math.max(1e-3, Math.hypot(c.x - a.x, c.z - a.z));
    raw[i] = Math.abs(delta) / ds;
  }

  const curve = smooth(raw, span);

  // Seuil adaptatif : proportion du pic le plus fort, avec plancher absolu.
  let max = 0;
  for (const v of curve) if (v > max) max = v;
  const threshold = Math.max(absMin, max * ratio);
  if (max < absMin) return [];

  // Pics locaux : fenêtre étroite en POINTS (±3), sinon deux virages séparés
  // de ~60 m fusionnent. L'espacement minimal en MÈTRES est appliqué plus bas.
  const win = 3;
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const v = curve[i];
    if (v < threshold) continue;
    let isPeak = true;
    for (let k = -win; k <= win; k++) {
      if (k === 0) continue;
      const j = (i + k + n) % n;
      if (curve[j] > v || (curve[j] === v && j < i)) { isPeak = false; break; }
    }
    if (isPeak) candidates.push({ i, v });
  }

  // Fusion des pics trop proches (on garde le plus fort).
  candidates.sort((a, b) => b.v - a.v);
  const kept = [];
  for (const c of candidates) {
    const dist = points[c.i].d;
    const tooClose = kept.some(k => {
      const gap = Math.abs(points[k.i].d - dist);
      return Math.min(gap, total - gap) < minDist;
    });
    if (!tooClose) kept.push(c);
  }

  return kept
    .map(c => ({
      norm: +((points[c.i].d || 0) / total).toFixed(4),
      dist: Math.round(points[c.i].d || 0),
      angle: +c.v.toFixed(6)
    }))
    .sort((a, b) => a.norm - b.norm)
    .map((c, i) => ({ ...c, id: i + 1 }));
}

module.exports = { readFastLane, detectCorners };

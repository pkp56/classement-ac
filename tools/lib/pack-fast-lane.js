'use strict';
/**
 * Compacte un `fast_lane.ai` d'Assetto Corsa en `line.json` versionnable.
 *
 * Le `.ai` brut pèse plusieurs Mo et ne doit pas entrer dans Git ; `line.json`
 * ne garde que ce qui est nécessaire à l'onglet Circuit (tracé, profil
 * altimétrique, virages), soit ~4–8 Ko.
 *
 * Usage CLI :
 *   node tools/lib/pack-fast-lane.js <fast_lane.ai> <line.json>
 *
 * Usage module :
 *   const { pack } = require('./pack-fast-lane');
 *   pack('chemin/fast_lane.ai', 'chemin/line.json');
 *
 * Format produit :
 *   {
 *     source: "tremblant/fast_lane.ai",   // origine du tracé
 *     points: 210,                        // nombre de points conservés
 *     lengthM: 4237.8,                    // longueur du tour, boucle fermée
 *     elevation: { min, max },            // altitude (m)
 *     data: [[x, y, z], ...],             // points arrondis à 0,1 m
 *     corners: [0.0696, ...]              // virages en fraction de tour (0→1)
 *   }
 *
 * Important : les virages sont détectés sur la ligne **pleine résolution**,
 * APRÈS quoi les points sont arrondis. Décimer avant de détecter ferait
 * fusionner les virages rapprochés (2–4 au lieu de 9–17).
 */

const fs = require('fs');
const path = require('path');
const { readFastLane, detectCorners } = require('./read-fast-lane');

const round1 = v => Math.round(v * 10) / 10;

/**
 * @param {string} input  chemin du `fast_lane.ai`
 * @param {string} output chemin du `line.json` à écrire
 * @param {{corners?: boolean, minDist?: number}} [opts]
 * @returns {{out:string, points:number, corners:number, lengthM:number}}
 */
function pack(input, output, opts = {}) {
  const track = readFastLane(input);
  const { points } = track;

  // Détection AVANT arrondi : on travaille sur la géométrie d'origine.
  const corners = opts.corners === false
    ? []
    : detectCorners(points, opts.minDist ? { minDist: opts.minDist } : undefined);

  const data = points.map(p => [round1(p.x), round1(p.y), round1(p.z)]);

  // Source lisible : dossier parent + nom du fichier.
  const source = path.basename(path.dirname(input)) + '/' + path.basename(input);

  const out = {
    source,
    points: data.length,
    lengthM: Math.round(track.lengthM * 10) / 10,
    elevation: {
      min: Math.round(track.elevMin * 10) / 10,
      max: Math.round(track.elevMax * 10) / 10
    },
    data,
    corners: corners.map(c => +c.norm.toFixed(4))
  };

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(out), 'utf8');

  return { out: output, points: data.length, corners: out.corners.length, lengthM: out.lengthM };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage : node tools/lib/pack-fast-lane.js <fast_lane.ai> <line.json>');
    process.exit(1);
  }
  const res = pack(input, output);
  console.log(`${res.out} — ${res.points} points · ${res.lengthM} m · ${res.corners} virages`);
}

module.exports = { pack };

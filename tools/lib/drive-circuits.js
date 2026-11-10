'use strict';
/**
 * Import d'un circuit depuis un dossier Google Drive partagé par lien.
 *
 * Aucune clé API n'est nécessaire : le dossier doit être partagé
 * « tout le monde disposant du lien ». On colle dans l'admin l'URL du dossier
 * (ou son ID) et l'outil va chercher les fichiers du mod Assetto Corsa.
 *
 * Ce module est utilisé par le serveur (`app.js`, route
 * `POST /api/admin/circuits/import`) et peut l'être par le navigateur.
 *
 * Fichiers recherchés dans le dossier, par ordre d'importance :
 *   fast_lane.ai   → tracé + profil d'altitude + virages  (obligatoire)
 *   surfaces.ini   → grip et validité des surfaces       (optionnel)
 *   overlays.ini   → bornes de secteurs                  (optionnel)
 *   ui_track.json  → nom du circuit, longueur, virages   (optionnel)
 */

const https = require('https');

// ---------------------------------------------------------------- utilitaires

/**
 * Extrait l'ID d'un dossier (ou fichier) Drive depuis une URL ou un ID brut.
 * Accepte : https://drive.google.com/drive/folders/<id>?usp=sharing
 *           https://drive.google.com/drive/u/1/folders/<id>
 *           <id> brut
 * @param {string} input
 * @returns {string|null}
 */
function driveId(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  // ID brut (25+ caractères alphanumériques, tirets, underscores)
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  const patterns = [
    /\/folders\/([A-Za-z0-9_-]{20,})/,
    /\/d\/([A-Za-z0-9_-]{20,})/,
    /[?&]id=([A-Za-z0-9_-]{20,})/
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Requête HTTPS simple qui suit les redirections et renvoie un Buffer. */
function fetchBuffer(url, { redirects = 5, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, res => {
      // Drive redirige vers googleusercontent : on suit.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return fetchBuffer(res.headers.location, { redirects: redirects - 1, timeout }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode} pour ${url}`);
        err.status = res.statusCode;
        return reject(err);
      }
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé en contactant Google Drive')));
    req.on('error', reject);
  });
}

/**
 * Liste le contenu public d'un dossier Drive.
 * Utilise la vue HTML `embeddedfolderview` (pas de clé API requise).
 * @param {string} folderId
 * @returns {Promise<Array<{id:string,name:string,isFolder:boolean}>>}
 */
async function listPublicFolder(folderId) {
  const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
  const html = (await fetchBuffer(url)).toString('utf8');

  const files = [];
  const seen = new Set();
  // Chaque entrée : <div class="flip-entry" id="entry-<id>" ...> ... <div class="flip-entry-title">nom</div>
  const entryRe = /id="entry-([A-Za-z0-9_-]+)"[\s\S]{0,800}?flip-entry-title">([^<]*)</g;
  let m;
  while ((m = entryRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = decodeEntities(m[2]).trim();
    files.push({ id, name, isFolder: /folder/i.test(m[0]) || !/\.[a-z0-9]{1,5}$/i.test(name) });
  }

  if (!files.length && /request access|Demander l['’]accès|Sign in/i.test(html)) {
    const err = new Error("Dossier Drive inaccessible : vérifiez qu'il est partagé « tout le monde disposant du lien ».");
    err.status = 403;
    throw err;
  }
  return files;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Télécharge un fichier public par son ID. */
async function downloadPublicFile(fileId) {
  return fetchBuffer(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`);
}

// ------------------------------------------------------- décodage fast_lane.ai

/**
 * Décode un `fast_lane.ai` depuis un Buffer.
 * En-tête 16 o [version, count, 0, 0] puis count × 20 o {x, y, z, d, id}.
 * @returns {{points:Array<{x:number,y:number,z:number,d:number}>, lengthM:number, elevMin:number, elevMax:number}}
 */
function decodeFastLane(buf) {
  if (!buf || buf.length < 16) throw new Error('fast_lane.ai trop court');
  const count = buf.readInt32LE(4);
  if (!Number.isFinite(count) || count <= 0) throw new Error('fast_lane.ai sans points');
  if (buf.length < 16 + count * 20) throw new Error('fast_lane.ai tronqué');

  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 20;
    points[i] = { x: buf.readFloatLE(o), y: buf.readFloatLE(o + 4), z: buf.readFloatLE(o + 8) };
  }
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    points[i].d = acc;
  }
  points[0].d = 0;
  const closing = Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z);
  let elevMin = Infinity, elevMax = -Infinity;
  for (const p of points) { if (p.y < elevMin) elevMin = p.y; if (p.y > elevMax) elevMax = p.y; }
  return { points, lengthM: acc + closing, elevMin, elevMax };
}

// -------------------------------------------------- détection des virages

function smooth(values, span) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let k = -span; k <= span; k++) { sum += values[(i + k + values.length) % values.length]; n++; }
    out[i] = sum / n;
  }
  return out;
}

/**
 * Détecte les virages par pics de courbure lissée.
 * À appeler sur la ligne PLEINE RÉSOLUTION (décimer d'abord fusionne les virages).
 * @returns {Array<{norm:number, dist:number}>}
 */
function detectCorners(points, opts = {}) {
  const n = points.length;
  if (n < 12) return [];
  const minDist = opts.minDist ?? 45;
  const absMin = opts.absMin ?? 0.0012;
  const ratio = opts.ratio ?? 0.10;
  const span = opts.span ?? 10;
  const tangent = opts.tangent ?? 4;
  const total = points[n - 1].d || 1;

  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[(i - tangent + n) % n], b = points[i], c = points[(i + tangent) % n];
    const v1 = Math.atan2(b.x - a.x, b.z - a.z);
    const v2 = Math.atan2(c.x - b.x, c.z - b.z);
    let delta = v2 - v1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    raw[i] = Math.abs(delta) / Math.max(1e-3, Math.hypot(c.x - a.x, c.z - a.z));
  }
  const curve = smooth(raw, span);
  let max = 0;
  for (const v of curve) if (v > max) max = v;
  if (max < absMin) return [];
  const threshold = Math.max(absMin, max * ratio);

  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (curve[i] < threshold) continue;
    let isPeak = true;
    for (let k = -3; k <= 3; k++) {
      if (k === 0) continue;
      const j = (i + k + n) % n;
      if (curve[j] > curve[i] || (curve[j] === curve[i] && j < i)) { isPeak = false; break; }
    }
    if (isPeak) candidates.push({ i, v: curve[i] });
  }

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
    .map(c => ({ norm: +((points[c.i].d || 0) / total).toFixed(4), dist: Math.round(points[c.i].d || 0) }))
    .sort((a, b) => a.norm - b.norm);
}

// ------------------------------------------------------------------ parsing INI

/**
 * Parse un `surfaces.ini` / `overlays.ini` d'Assetto Corsa.
 * @returns {Object<string, Object<string,string>>} sections -> clés
 */
function parseIni(text) {
  const out = {};
  let section = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sm = line.match(/^\[(.+)\]$/);
    if (sm) { section = sm[1].trim(); out[section] = out[section] || {}; continue; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (kv && section) out[section][kv[1].toUpperCase()] = kv[2].trim();
  }
  return out;
}

/** Extrait les lignes de surface (grip, validité) d'un `surfaces.ini`. */
function readSurfaces(text) {
  const ini = parseIni(text);
  const rows = [];
  for (const [key, kv] of Object.entries(ini)) {
    if (!/^SURFACE_/.test(key)) continue;
    // Dans un surfaces.ini d'AC, la section est `[SURFACE_0]` et le vrai nom
    // de surface est dans `KEY=` : c'est lui qu'il faut lire en priorité.
    const name = String(kv.KEY || key.replace(/^SURFACE_/, '')).toUpperCase();
    const gripRaw = kv.GRIP ?? kv.FRICTION;
    const grip = Number.isFinite(Number(gripRaw)) ? Math.round((Number(gripRaw) <= 1.5 ? Number(gripRaw) * 100 : Number(gripRaw))) : null;
    rows.push({
      key: name,
      grip,
      valid: kv.IS_VALID_TRACK === undefined ? true : String(kv.IS_VALID_TRACK).trim() === '1',
      pit: /^PIT/i.test(name)
    });
  }
  return rows;
}

/**
 * Secteurs depuis un `overlays.ini`.
 *
 * Chaque section `[SECTOR_n]` porte le DÉBUT du secteur n (en fraction de tour).
 * `[SECTOR_0] START=0`, `[SECTOR_1] START=0.3`, `[SECTOR_2] START=0.7`
 * décrit donc 3 secteurs, et non 4 : le dernier va jusqu'à 1.
 *
 * @returns {Array<{label:string, from:number, to:number}>} fractions de tour
 */
function readSectorSplits(text) {
  const ini = parseIni(text);
  const starts = [];
  for (const [key, kv] of Object.entries(ini)) {
    if (!/SECTOR/i.test(key)) continue;
    const f = Number(kv.START ?? kv.POSITION ?? kv.SPLIT);
    if (Number.isFinite(f)) starts.push(Math.max(0, Math.min(1, f)));
  }
  const uniq = [...new Set(starts)].sort((a, b) => a - b);
  if (!uniq.length) return [];
  // Une borne à 1 ne démarre aucun secteur : on l'ignore si elle est seule en fin.
  if (uniq.length > 1 && uniq[uniq.length - 1] === 1) uniq.pop();
  return uniq.map((from, i) => ({
    label: `S${i + 1}`,
    from: +from.toFixed(4),
    to: +(uniq[i + 1] ?? 1).toFixed(4)
  }));
}

// ------------------------------------------------------------------- import

const WANTED = {
  line: /^fast_lane\.ai$/i,
  surfaces: /^surfaces\.ini$/i,
  overlays: /^overlays\.ini$/i,
  ui: /^ui_track\.json$/i
};

/**
 * Importe un circuit depuis un dossier Drive public.
 *
 * @param {string} folderInput URL ou ID du dossier
 * @param {{name?:string, round?:number}} [opts] métadonnées de la manche
 * @returns {Promise<object>} `{ round, source, files, warnings }` — la manche
 *   prête à être fusionnée dans `data/circuits.json`.
 */
async function importFromDrive(folderInput, opts = {}) {
  const folderId = driveId(folderInput);
  if (!folderId) {
    const err = new Error("Lien Drive invalide : collez l'URL du dossier (…/folders/…) ou son identifiant.");
    err.status = 400;
    throw err;
  }

  const listing = await listPublicFolder(folderId);
  const find = re => listing.find(f => re.test(f.name));
  const lineFile = find(WANTED.line);
  if (!lineFile) {
    const err = new Error('Aucun fast_lane.ai trouvé dans ce dossier Drive. Vérifiez qu\'il est bien partagé et non vide.');
    err.status = 422;
    throw err;
  }

  const warnings = [];
  const fileMap = { line: lineFile };
  for (const [key, re] of Object.entries(WANTED)) {
    if (key === 'line') continue;
    const f = find(re);
    if (f) fileMap[key] = f;
    else warnings.push(`${re.source.replace(/\^|\\|\$|\//g, '').replace(/\./g, '.')} absent du dossier Drive`);
  }

  // --- tracé
  const lineBuf = await downloadPublicFile(lineFile.id);
  const track = decodeFastLane(lineBuf);
  const corners = detectCorners(track.points);

  // --- surfaces
  let surfaces = [];
  if (fileMap.surfaces) {
    try { surfaces = readSurfaces((await downloadPublicFile(fileMap.surfaces.id)).toString('utf8')); }
    catch (e) { warnings.push(`surfaces.ini illisible : ${e.message}`); }
  }

  // --- secteurs
  let sectors = [];
  if (fileMap.overlays) {
    try { sectors = readSectorSplits((await downloadPublicFile(fileMap.overlays.id)).toString('utf8')); }
    catch (e) { warnings.push(`overlays.ini illisible : ${e.message}`); }
  }

  // --- ui_track.json
  let ui = null;
  if (fileMap.ui) {
    try { ui = JSON.parse((await downloadPublicFile(fileMap.ui.id)).toString('utf8')); }
    catch (e) { warnings.push(`ui_track.json illisible : ${e.message}`); }
  }

  const name = opts.name || (ui && (ui.name || ui.Name)) || lineFile.name.replace(/\.ai$/i, '');

  const round = {
    round: opts.round || null,
    name,
    layout: (ui && (ui.layout || ui.Layout)) || null,
    driverFolder: (ui && (ui.trackId || ui.id)) || null,
    lengthM: Math.round(track.lengthM),
    points: track.points.length,
    elevation: { min: +track.elevMin.toFixed(1), max: +track.elevMax.toFixed(1) },
    corners: corners.map(c => c.norm),
    cornerCount: corners.length,
    surfaces,
    sectorSplits: sectors,
    sectorCount: sectors.length,
    uiTrack: ui,
    driveFolderId: folderId,
    driveName: (ui && (ui.trackId || ui.id)) || null,
    importedAt: new Date().toISOString()
  };

  if (!sectors.length) {
    warnings.push('aucun secteur officiel détecté : la chronométrie utilisera les 3 tiers du tour');
  }
  if (!surfaces.length) warnings.push('aucune surface lue : la fiche Briefing restera vide');

  return { round, files: Object.fromEntries(Object.entries(fileMap).map(([k, v]) => [k, { id: v.id, name: v.name }])), warnings };
}

module.exports = {
  driveId, listPublicFolder, downloadPublicFile, decodeFastLane,
  detectCorners, parseIni, readSurfaces, readSectorSplits, importFromDrive
};

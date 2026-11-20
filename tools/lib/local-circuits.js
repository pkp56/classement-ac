'use strict';

const { safeTrackText } = require('./track-text');

// Import technique en lecture seule depuis les mods Assetto Corsa installés
// sur le PC qui héberge GDSP Node. Les chemins reçus du navigateur sont des
// identifiants de dossiers, jamais des chemins de fichiers.
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildRound, buildSectorSplits } = require('./circuit-round');
const { cachePreview } = require('./mod-previews');
const drive = require('./drive-circuits');
const { configuredRoots, within } = require('./local-mods');

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_POINTS = 200000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UI_BYTES = 1024 * 1024;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeSegment(value, { optional = false } = {}) {
  if (optional && value === '') return true;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && value === value.trim()
    && !/^\.+$/.test(value)
    && !/[. ]$/.test(value)
    && !/[\\/\0<>:"|?*]/.test(value);
}

function errorHint(error) {
  return error && typeof error.code === 'string'
    ? error.code
    : String(error && error.message || 'erreur inconnue').slice(0, 200);
}

function validDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError('Date invalide (format attendu : AAAA-MM-JJ).');
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw httpError('Date invalide (format attendu : AAAA-MM-JJ).');
  }
  return value;
}

function safeTrackTags(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(tag => safeTrackText(tag, 80)).filter(Boolean);
}

function safeTrackUrl(value) {
  const url = safeTrackText(value, 500);
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function unique(items) {
  return [...new Set(items)];
}

async function resolveInside(file, rootReal) {
  try {
    const real = await fs.realpath(file);
    if (!within(real, rootReal)) return null;
    const stat = await fs.stat(real);
    return { path: real, stat };
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

async function findDirectory(candidates, rootReal) {
  for (const candidate of candidates) {
    const found = await resolveInside(candidate, rootReal);
    if (found && found.stat.isDirectory()) return found.path;
  }
  return null;
}

async function findFile(candidates, rootReal, maxBytes) {
  for (const candidate of candidates) {
    const found = await resolveInside(candidate, rootReal);
    if (!found || !found.stat.isFile()) continue;
    if (found.stat.size > maxBytes) return { tooLarge: true, path: found.path };
    return { path: found.path, size: found.stat.size };
  }
  return null;
}

function layoutDirectories(trackDir, layoutId) {
  const candidates = [];
  if (layoutId) {
    // Les mods AC ne rangent pas tous leurs fichiers de variante au même
    // endroit : certains ont `tracks/id/layout`, d'autres `data/layout` ou
    // `layouts/layout/data`. On ne parcourt que ces chemins connus, sous la
    // racine autorisée, sans suivre de liens sortants.
    candidates.push(
      path.join(trackDir, layoutId),
      path.join(trackDir, 'layouts', layoutId),
      path.join(trackDir, 'data', layoutId),
      path.join(trackDir, 'data', 'layouts', layoutId),
      path.join(trackDir, layoutId, 'data'),
      path.join(trackDir, 'layouts', layoutId, 'data'),
      path.join(trackDir, 'data', layoutId, 'data')
    );
  }
  candidates.push(trackDir, path.join(trackDir, 'data'));
  return unique(candidates);
}

function lineCandidates(trackDir, layoutId, dataDirs) {
  const candidates = [];
  if (layoutId) {
    // Une variante sélectionnée doit passer avant un éventuel fast_lane.ai
    // générique à la racine du circuit.
    candidates.push(
      path.join(trackDir, layoutId, 'fast_lane.ai'),
      path.join(trackDir, layoutId, 'ai', 'fast_lane.ai'),
      path.join(trackDir, 'layouts', layoutId, 'fast_lane.ai'),
      path.join(trackDir, 'layouts', layoutId, 'ai', 'fast_lane.ai'),
      path.join(trackDir, 'data', layoutId, 'fast_lane.ai'),
      path.join(trackDir, 'data', layoutId, 'ai', 'fast_lane.ai'),
      path.join(trackDir, 'data', 'layouts', layoutId, 'fast_lane.ai'),
      path.join(trackDir, 'data', 'layouts', layoutId, 'ai', 'fast_lane.ai'),
      path.join(trackDir, 'ai', layoutId, 'fast_lane.ai'),
      path.join(trackDir, 'ai', 'layouts', layoutId, 'fast_lane.ai')
    );
  }
  for (const dir of dataDirs) {
    candidates.push(path.join(dir, 'fast_lane.ai'));
    candidates.push(path.join(dir, 'ai', 'fast_lane.ai'));
  }
  return unique(candidates);
}

function textCandidates(dataDirs, filename) {
  const candidates = [];
  for (const dir of dataDirs) {
    candidates.push(path.join(dir, filename));
    candidates.push(path.join(dir, 'data', filename));
  }
  return unique(candidates);
}

async function readJson(fileInfo, warnings) {
  if (!fileInfo) return null;
  if (fileInfo.tooLarge) {
    warnings.push('ui_track.json trop volumineux : métadonnées ignorées');
    return null;
  }
  try {
    const raw = await fs.readFile(fileInfo.path, 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('format invalide');
    return data;
  } catch (error) {
    warnings.push(`ui_track.json illisible : ${errorHint(error)}`);
    return null;
  }
}

async function readIni(fileInfo, label, warnings, reader) {
  if (!fileInfo) {
    warnings.push(`${label} absent du mod sélectionné`);
    return [];
  }
  if (fileInfo.tooLarge) {
    warnings.push(`${label} trop volumineux : fichier ignoré`);
    return [];
  }
  try {
    return reader(await fs.readFile(fileInfo.path, 'utf8'));
  } catch (error) {
    warnings.push(`${label} illisible : ${errorHint(error)}`);
    return [];
  }
}

function readNamedSections(text){
  return Object.entries(drive.parseIni(text)).filter(([key])=>/^SECTION_\d+$/i.test(key)).map(([,row])=>({
    from:parseFloat(row.IN),to:parseFloat(row.OUT),name:safeTrackText(row.TEXT,100)
  })).filter(s=>s.name&&s.from>=0&&s.to<=1&&s.from<s.to).slice(0,128);
}

const KNOWN_TRACK_PLACES = Object.freeze({
  prague: { country: 'République tchèque', city: 'Prague' },
  spa: { country: 'Belgique', city: 'Francorchamps' },
  monza: { country: 'Italie', city: 'Monza' },
  imola: { country: 'Italie', city: 'Imola' },
  mugello: { country: 'Italie', city: 'Scarperia' },
  silverstone: { country: 'Grande-Bretagne', city: 'Silverstone' },
  nurburgring: { country: 'Allemagne', city: 'Nürburg' },
  nordschleife: { country: 'Allemagne', city: 'Nürburg' },
  zandvoort: { country: 'Pays-Bas', city: 'Zandvoort' },
  brands_hatch: { country: 'Grande-Bretagne', city: 'Longfield' },
  laguna_seca: { country: 'États-Unis', city: 'Monterey' },
  red_bull_ring: { country: 'Autriche', city: 'Spielberg' },
  spielberg: { country: 'Autriche', city: 'Spielberg' },
  barcelona: { country: 'Espagne', city: 'Montmeló' },
  vallelunga: { country: 'Italie', city: 'Campagnano' },
  magione: { country: 'Italie', city: 'Magione' }
});

function inferTrackPlace(trackId) {
  const clean = String(trackId || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (Object.prototype.hasOwnProperty.call(KNOWN_TRACK_PLACES, clean)) return KNOWN_TRACK_PLACES[clean];
  for (const [key, place] of Object.entries(KNOWN_TRACK_PLACES)) {
    if (clean.includes(key)) return place;
  }
  return null;
}

function formatTrackLabel(value) {
  const words = String(value || '').replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.map(w => (/^(gp|gt|f1|rev)$/i.test(w) ? (w.toLowerCase() === 'rev' ? 'Reverse' : w.toUpperCase()) : w[0].toUpperCase() + w.slice(1))).join(' ');
}

function parseModelsIni(raw, filename = '') {
  const sections = drive.parseIni(raw);
  const files = Object.entries(sections)
    .filter(([key]) => /^MODEL_\d+$/i.test(key))
    .map(([, row]) => safeTrackText(row && row.FILE, 120))
    .filter(Boolean);
  const lower = String(filename || '').toLowerCase();
  const match = lower.match(/^models_(.+)\.ini$/);
  const variant = match ? match[1] : '';
  return {
    variant,
    files,
    isReverse: /(?:^|_)rev(?:_|$)/.test(variant),
    isShort: /(?:^|_)short(?:_|$)/.test(variant)
  };
}

function parseExtConfig(raw) {
  const sections = drive.parseIni(raw);
  const findSec = name => Object.entries(sections).find(([k]) => k.toUpperCase() === name)?.[1] || {};
  const about = findSec('ABOUT');
  const author = safeTrackText(about.AUTHOR, 120);
  const version = safeTrackText(about.VERSION, 80);
  const release = safeTrackText(about.DATE_RELEASE, 80);
  const yearMatch = release.match(/\b(19\d\d|20[0-2]\d)\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const keys = Object.keys(sections).map(k => k.toUpperCase());
  const hasRain = keys.some(k => k === 'RAIN_FX' || k.startsWith('RAIN_FX_'));
  const hasGrass = keys.some(k => k === 'GRASS_FX' || k.startsWith('GRASS_FX_'));
  const hasLights = keys.some(k => k.startsWith('LIGHT_SERIES_'));
  const hasWater = keys.some(k => k === 'MATERIAL_WATER');
  const tags = [];
  if (hasRain) tags.push('RainFX');
  if (hasGrass) tags.push('GrassFX');
  if (hasLights) tags.push('Éclairage CSP');
  if (hasWater) tags.push('Eau / Rivière');

  const rain = findSec('RAIN_FX');
  const grass = findSec('GRASS_FX');
  const matPool = [rain.PUDDLES_MATERIALS, rain.SOAKING_MATERIALS, rain.ROUGH_MATERIALS, rain.LINES_MATERIALS, grass.GRASS_MATERIALS]
    .filter(Boolean).join(',').toLowerCase();
  const surfaces = [];
  const addSurf = (key, label, valid, note) => {
    if (!surfaces.some(s => s.key === key)) surfaces.push({ key, label, grip: null, valid, pit: false, note });
  };
  if (/asphalt|tarmac/.test(matPool)) addSurf('ASPHALT', 'Asphalte', true, 'Détecté dans ext_config.ini (surfaces.ini absent)');
  if (/cobble/.test(matPool)) addSurf('COBBLE', 'Pavés', true, 'Détecté dans ext_config.ini (surfaces.ini absent)');
  if (/concrete/.test(matPool)) addSurf('CONCRETE', 'Béton', true, 'Détecté dans ext_config.ini (surfaces.ini absent)');
  if (/rumble|curb/.test(matPool)) addSurf('CURB', 'Vibreurs', true, 'Détecté dans ext_config.ini (surfaces.ini absent)');
  if (hasGrass || /\bgrass\b|dirt/.test(matPool)) addSurf('GRASS', 'Herbe / bas-côté', false, 'Détecté dans ext_config.ini (surfaces.ini absent)');

  return { author, version, year, release, lightsCount: safeTrackText(about.LIGHTS_COUNT, 40), tags, surfaces };
}

function parseCamerasIni(raw) {
  const sections = drive.parseIni(raw);
  const header = sections.HEADER || {};
  const setName = safeTrackText(header.SET_NAME, 120);
  const authorMatch = setName.match(/\bby\s+([^(\r\n]+)$/i);
  const author = authorMatch ? safeTrackText(authorMatch[1], 80) : '';
  const cameras = [];
  for (const [key, row] of Object.entries(sections)) {
    if (!/^CAMERA_\d+$/i.test(key) || !row || !row.POSITION) continue;
    const parts = String(row.POSITION).split(',').map(v => Number(v.trim()));
    if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) continue;
    const inPoint = Number(row.IN_POINT);
    const outPoint = Number(row.OUT_POINT);
    cameras.push({
      name: safeTrackText(row.NAME, 60),
      x: parts[0],
      y: parts[1],
      z: parts[2],
      inPoint: Number.isFinite(inPoint) ? inPoint : null,
      outPoint: Number.isFinite(outPoint) ? outPoint : null
    });
  }
  return { setName, cameraCount: Number(header.CAMERA_COUNT) || cameras.length, author, cameras };
}

function buildTrackFromCameras(cameras) {
  if (!Array.isArray(cameras) || cameras.length < 8) return null;
  const withIn = cameras.filter(c => c.inPoint != null);
  const ordered = withIn.length >= Math.floor(cameras.length * 0.7)
    ? cameras.slice().sort((a, b) => (a.inPoint ?? 0) - (b.inPoint ?? 0))
    : cameras.slice();
  const deduped = [];
  for (const cam of ordered) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.hypot(cam.x - prev.x, cam.z - prev.z) >= 1) deduped.push(cam);
  }
  if (deduped.length < 8) return null;
  const subSteps = Math.max(2, Math.min(8, Math.ceil(160 / deduped.length)));
  const points = [];
  for (let i = 0; i < deduped.length; i++) {
    const a = deduped[i], b = deduped[(i + 1) % deduped.length];
    for (let s = 0; s < subSteps; s++) {
      const t = s / subSteps;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  let acc = 0;
  points[0].d = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    points[i].d = acc;
  }
  const closing = Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z);
  const lengthM = acc + closing;
  if (!Number.isFinite(lengthM) || lengthM < 200 || lengthM > 50000) return null;
  let elevMin = Infinity, elevMax = -Infinity;
  for (const p of points) {
    if (p.y < elevMin) elevMin = p.y;
    if (p.y > elevMax) elevMax = p.y;
  }
  return { points, lengthM, elevMin, elevMax, cameraCount: deduped.length };
}

function parseAiHints(raw) {
  const sections = drive.parseIni(raw);
  const dangerZones = [];
  for (const [key, row] of Object.entries(sections)) {
    if (!/^(?:DANGER|HINT|BRAKE)_\d+$/i.test(key) || !row) continue;
    const start = Number(row.START), end = Number(row.END);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1) {
      dangerZones.push({ kind: key.split('_')[0].toUpperCase(), start, end });
    }
  }
  return dangerZones;
}

function parseAudioSources(raw) {
  const sections = drive.parseIni(raw);
  const features = new Set();
  for (const [key, row] of Object.entries(sections)) {
    if (!/^REVERB_\d+$/i.test(key) || !row) continue;
    const node = String(row.NODE || '').toUpperCase();
    if (node.includes('TUNNEL')) features.add('tunnels');
    if (node.includes('BRIDGE')) features.add('ponts / arches');
    if (node.includes('HILL')) features.add('colline');
    if (String(row.PRESET || '').toUpperCase() === 'CITY') features.add('zone urbaine');
  }
  return [...features];
}

function fileLabel(fileInfo, trackDir) {
  if (!fileInfo || !fileInfo.path) return null;
  const relative = path.relative(trackDir, fileInfo.path);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    return path.basename(fileInfo.path);
  }
  return relative.split(path.sep).join('/');
}

function parseOfficialLength(value) {
  const raw = safeTrackText(value, 80).replace(',', '.');
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|m|met(?:er|re)s?)?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(/^km|^kilomet/i.test(match[2] || '') ? number * 1000 : number);
}

function formatOfficialLength(value, meters) {
  if (meters) return `${(meters / 1000).toFixed(3).replace('.', ',')} km (ui_track.json)`;
  return safeTrackText(value, 80) || null;
}

function buildMetadata(ui, { trackId, layoutId, name, date, round, extras = {} }) {
  const uiName = safeTrackText(ui && (ui.name || ui.Name));
  const selectedName = safeTrackText(name);
  const fallbackName = layoutId && !layoutId.toLowerCase().startsWith(trackId.toLowerCase())
    ? `${formatTrackLabel(trackId)} · ${formatTrackLabel(layoutId)}`
    : formatTrackLabel(layoutId || trackId);
  const resolvedName = uiName || selectedName || fallbackName || trackId;
  const uiLayout = safeTrackText(ui && (ui.layout || ui.Layout || ui.layoutName || ui.LayoutName));
  const geotags = ui && (ui.geotags || ui.Geotags);
  const gps = safeTrackText(ui && (ui.geographicLocation || ui.GeographicLocation))
    || (Array.isArray(geotags) ? geotags.map(tag => safeTrackText(tag, 80)).filter(Boolean).join(' · ') : safeTrackText(geotags, 160));
  const uiTags = safeTrackTags(ui && (ui.tags || ui.Tags));
  const tags = uiTags.length ? uiTags : safeTrackTags(extras.tags || []);
  const number = Number.isInteger(Number(round)) && Number(round) > 0 ? Number(round) : null;
  const officialLength = safeTrackText(ui && (ui.length || ui.Length), 80);
  const officialLengthM = parseOfficialLength(officialLength);
  const rawDescription = safeTrackText(ui && (ui.description || ui.Description), 1200);
  const description = rawDescription || safeTrackText(extras.description, 1200);
  const trackUrl = safeTrackUrl(ui && (ui.url || ui.URL));
  const rawPitboxes = ui && (ui.pitboxes ?? ui.Pitboxes);
  const pitboxes = safeTrackText(rawPitboxes, 16);
  const place = inferTrackPlace(trackId);
  const country = safeTrackText(ui && (ui.country || ui.Country)) || (extras.hasExtras && place ? place.country : '') || 'À confirmer';
  const city = safeTrackText(ui && (ui.city || ui.City)) || (extras.hasExtras && place ? place.city : '') || null;
  const author = safeTrackText(ui && (ui.author || ui.Author)) || safeTrackText(extras.author) || null;
  const version = safeTrackText(ui && (ui.version || ui.Version), 80) || safeTrackText(extras.version, 80) || null;
  const year = safeTrackText(ui && (ui.year ?? ui.Year), 32) || safeTrackText(extras.year, 32) || null;
  const direction = ui && (ui.run || ui.Run)
    ? (/anticlock/i.test(String(ui.run || ui.Run)) ? 'counterclockwise' : 'clockwise')
    : (extras.isReverse ? 'counterclockwise' : 'clockwise');

  return {
    id: `local:${date || 'undated'}:${trackId}${layoutId ? '/' + layoutId : ''}`,
    round: number,
    label: number ? `M${number}` : null,
    name: resolvedName,
    shortName: resolvedName,
    layout: uiLayout || (layoutId ? (uiName || formatTrackLabel(layoutId) || layoutId) : null),
    layoutKey: layoutId || '',
    driverFolder: trackId,
    trackId,
    layoutId: layoutId || '',
    country,
    countryCode: safeTrackText(ui && (ui.countryCode || ui.CountryCode), 12),
    city,
    gps: /^lat\s*·\s*lon$/i.test(gps) ? null : gps || null,
    year,
    author,
    version,
    description: description || null,
    tags,
    officialLength: officialLength || null,
    officialLengthM,
    trackUrl: trackUrl || null,
    direction,
    pitboxes: pitboxes || null,
    width: safeTrackText(ui && (ui.width || ui.Width)) || null,
    format: safeTrackText(ui && (ui.format || ui.Format)) || 'À confirmer',
    status: 'upcoming',
    date: date || null,
    dateLabel: null,
    winner: null,
    stats: null,
    localTrackId: trackId,
    localLayoutId: layoutId || '',
    driveName: safeTrackText(ui && (ui.trackId || ui.id)) || trackId,
    source: 'Mod local Assetto Corsa',
    hero: null,
    importedAt: new Date().toISOString()
  };
}

function metadataOnlyRound(metadata, { trackDir, surfaces, sectors, surfaceFile, overlaysFile, warnings, files }) {
  const bounds = sectors.length
    ? [0, ...sectors.map(item => item.from).filter(value => value > 0 && value < 1), 1]
    : [];
  const sectorSplits = metadata.officialLengthM && bounds.length > 1
    ? buildSectorSplits(bounds, metadata.officialLengthM)
    : [];
  return {
    ...metadata,
    lengthM: null,
    lengthStr: formatOfficialLength(metadata.officialLength, metadata.officialLengthM),
    measuredLengthM: null,
    elevation: null,
    outline: null,
    profile: null,
    profiles: {},
    sectorSplits,
    sectorFractions: sectors.map((sector, index) => ({
      label: sector.label || `S${index + 1}`,
      from: sector.from,
      to: sector.to
    })),
    sectorCount: sectorSplits.length || sectors.length,
    cornerCount: 0,
    surfaces,
    surfaceFile: surfaceFile && !surfaceFile.tooLarge ? fileLabel(surfaceFile, trackDir) : null,
    overlaysFile: overlaysFile && !overlaysFile.tooLarge ? fileLabel(overlaysFile, trackDir) : null,
    technicalUnavailable: true,
    importWarnings: warnings.slice(0, 20),
    importedFiles: Object.values(files).map(file => file.name).filter(Boolean)
  };
}

async function readTrackExtras({ trackDir, trackId, layoutId, dataDirs, rootReal }) {
  const extras = { hasExtras: false, tags: [], surfaces: [], extraFiles: [] };
  const extCandidates = [
    ...(layoutId ? [path.join(trackDir, layoutId, 'extension', 'ext_config.ini')] : []),
    path.join(trackDir, 'extension', 'ext_config.ini'),
    path.join(trackDir, 'ext_config.ini')
  ];
  const extFile = await findFile(extCandidates, rootReal, MAX_TEXT_BYTES);
  if (extFile && !extFile.tooLarge) {
    try {
      const ext = parseExtConfig(await fs.readFile(extFile.path, 'utf8'));
      extras.hasExtras = true;
      if (ext.author) extras.author = ext.author;
      if (ext.version) extras.version = ext.version;
      if (ext.year) extras.year = ext.year;
      if (ext.tags.length) extras.tags.push(...ext.tags);
      if (ext.surfaces.length) extras.surfaces = ext.surfaces;
      extras.extFile = extFile;
      extras.extraFiles.push(fileLabel(extFile, trackDir));
    } catch {}
  }

  const modelCandidates = unique([
    ...(layoutId ? [
      path.join(trackDir, `models_${layoutId}.ini`),
      path.join(trackDir, `models_${trackId}_${layoutId}.ini`)
    ] : []),
    path.join(trackDir, `models_${trackId}.ini`),
    path.join(trackDir, 'models.ini')
  ]);
  const modelFile = await findFile(modelCandidates, rootReal, MAX_TEXT_BYTES);
  if (modelFile && !modelFile.tooLarge) {
    try {
      const m = parseModelsIni(await fs.readFile(modelFile.path, 'utf8'), path.basename(modelFile.path));
      extras.hasExtras = true;
      extras.isReverse = m.isReverse;
      extras.modelFiles = m.files;
      extras.extraFiles.push(fileLabel(modelFile, trackDir));
    } catch {}
  }

  const camCandidates = [];
  for (const name of ['cameras.ini', 'cameras_1.ini', 'cameras_2.ini', 'cameras_3.ini', 'cameras_4.ini', 'cameras_10.ini', 'cameras_3.txt']) {
    camCandidates.push(...textCandidates(dataDirs, name));
  }
  const camFile = await findFile(unique(camCandidates), rootReal, MAX_TEXT_BYTES);
  if (camFile && !camFile.tooLarge) {
    try {
      const cam = parseCamerasIni(await fs.readFile(camFile.path, 'utf8'));
      const camTrack = buildTrackFromCameras(cam.cameras);
      if (camTrack || cam.cameras.length) {
        extras.hasExtras = true;
        extras.cameraInfo = cam;
        extras.cameraTrack = camTrack;
        extras.cameraFile = camFile;
        extras.extraFiles.push(fileLabel(camFile, trackDir));
        if (!extras.author && cam.author) extras.author = cam.author;
      }
    } catch {}
  }

  const aiFile = await findFile(textCandidates(dataDirs, 'ai_hints.ini'), rootReal, MAX_TEXT_BYTES);
  if (aiFile && !aiFile.tooLarge) {
    try {
      extras.aiDangerZones = parseAiHints(await fs.readFile(aiFile.path, 'utf8'));
      if (extras.aiDangerZones.length) {
        extras.hasExtras = true;
        extras.extraFiles.push(fileLabel(aiFile, trackDir));
      }
    } catch {}
  }

  const audioFile = await findFile(textCandidates(dataDirs, 'audio_sources.ini'), rootReal, MAX_TEXT_BYTES);
  if (audioFile && !audioFile.tooLarge) {
    try {
      extras.audioFeatures = parseAudioSources(await fs.readFile(audioFile.path, 'utf8'));
      if (extras.audioFeatures.length) {
        extras.hasExtras = true;
        extras.extraFiles.push(fileLabel(audioFile, trackDir));
      }
    } catch {}
  }

  const descParts = [];
  if (extras.modelFiles && extras.modelFiles.length) descParts.push(`Scène 3D : ${extras.modelFiles.length} fichier(s) KN5 (${extras.modelFiles.slice(0, 6).join(', ')}).`);
  if (extras.cameraInfo && extras.cameraInfo.cameras.length) descParts.push(`Caméras TV : ${extras.cameraInfo.setName || 'Pack caméras'} (${extras.cameraInfo.cameras.length} caméras).`);
  if (extras.aiDangerZones && extras.aiDangerZones.length) {
    const zones = extras.aiDangerZones.map(z => `${Math.round(z.start * 100)}–${Math.round(z.end * 100)} %`).join(', ');
    descParts.push(`Zones d’alerte IA : ${zones} du tour.`);
  }
  if (extras.audioFeatures && extras.audioFeatures.length) descParts.push(`Environnement sonore : ${extras.audioFeatures.join(', ')}.`);
  if (descParts.length) extras.description = descParts.join('\n');
  extras.tags = unique(extras.tags);
  return extras;
}

/**
 * Importe une fiche locale complète quand `fast_lane.ai` est présent.
 * Si la ligne rapide manque, les métadonnées UI, caméras, ext_config et surfaces
 * disponibles restent enregistrées au lieu d'être abandonnées.
 */
async function importLocalCircuit({ roots = configuredRoots(), trackId, layoutId = '', name, date, round } = {}) {
  if (!safeSegment(trackId)) throw httpError('Identifiant de circuit invalide.');
  if (!safeSegment(layoutId, { optional: true })) throw httpError('Identifiant de variante invalide.');
  const plannedDate = validDate(date);
  if (round != null && round !== '' && (!Number.isInteger(Number(round)) || Number(round) < 1 || Number(round) > 1000)) {
    throw httpError('Numéro de manche invalide.');
  }

  const warnings = [];
  let metadataFallback = null;
  const fileScore = candidate => (candidate.ui ? 5 : 0)
    + (candidate.uiFile && !candidate.uiFile.tooLarge ? 2 : 0)
    + (candidate.surfacesFile && !candidate.surfacesFile.tooLarge ? 2 : 0)
    + (candidate.overlaysFile && !candidate.overlaysFile.tooLarge ? 1 : 0)
    + (candidate.extras && candidate.extras.cameraTrack ? 2 : 0)
    + (candidate.extras && candidate.extras.hasExtras ? 1 : 0);
  const fileEntries = (trackDir, { lineFile, surfacesFile, overlaysFile, uiFile }) => {
    const files = {};
    for (const [key, file] of Object.entries({ line: lineFile, surfaces: surfacesFile, overlays: overlaysFile, ui: uiFile })) {
      if (file && !file.tooLarge) files[key] = { name: fileLabel(file, trackDir) };
    }
    return files;
  };

  for (const configuredRoot of roots) {
    let rootReal;
    try {
      rootReal = await fs.realpath(configuredRoot);
      if (!(await fs.stat(rootReal)).isDirectory()) continue;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      warnings.push('Une racine de mods est inaccessible.');
      continue;
    }

    const trackDir = await findDirectory([path.join(rootReal, 'tracks', trackId)], rootReal);
    if (!trackDir) continue;
    const dataDirs = [];
    for (const candidate of layoutDirectories(trackDir, layoutId)) {
      const resolved = await findDirectory([candidate], rootReal);
      if (resolved) dataDirs.push(resolved);
    }
    const orderedDataDirs = unique(dataDirs);

    const uiCandidates = layoutId
      ? [
          path.join(trackDir, 'ui', layoutId, 'ui_track.json'),
          path.join(trackDir, layoutId, 'ui', 'ui_track.json'),
          path.join(trackDir, 'layouts', layoutId, 'ui', 'ui_track.json'),
          path.join(trackDir, 'ui', 'ui_track.json'),
          path.join(trackDir, 'ui_track.json')
        ]
      : [path.join(trackDir, 'ui', 'ui_track.json'), path.join(trackDir, 'ui_track.json')];
    const uiFile = await findFile(uiCandidates, rootReal, MAX_UI_BYTES);
    const uiWarnings = [];
    if (!uiFile) uiWarnings.push('ui_track.json absent du mod sélectionné');
    const ui = await readJson(uiFile, uiWarnings);
    const surfacesFile = await findFile(textCandidates(orderedDataDirs, 'surfaces.ini'), rootReal, MAX_TEXT_BYTES);
    const overlaysFile = await findFile(textCandidates(orderedDataDirs, 'overlays.ini'), rootReal, MAX_TEXT_BYTES);
    const extras = await readTrackExtras({ trackDir, trackId, layoutId, dataDirs: orderedDataDirs, rootReal });
    const previewCandidates=uiCandidates.flatMap(file=>['preview.png','preview.jpg'].map(n=>path.join(path.dirname(file),n)));
    const preview=()=>cachePreview(trackDir,previewCandidates).catch(()=>null);
    const fallback = { preview,trackDir, ui, uiFile, surfacesFile, overlaysFile, uiWarnings, dataDirs: orderedDataDirs, extras };
    if (!metadataFallback || fileScore(fallback) > fileScore(metadataFallback)) metadataFallback = fallback;

    const lineFile = await findFile(lineCandidates(trackDir, layoutId, orderedDataDirs), rootReal, MAX_LINE_BYTES);
    if (!lineFile) continue;
    if (lineFile.tooLarge) {
      warnings.push('fast_lane.ai trop volumineux : fiche géométrique non importée');
      continue;
    }

    const files = fileEntries(trackDir, { lineFile, surfacesFile, overlaysFile, uiFile });
    const selectedWarnings = [...uiWarnings];
    let surfaces = await readIni(surfacesFile, 'surfaces.ini', selectedWarnings, drive.readSurfaces);
    if (!surfaces.length && extras.surfaces.length) surfaces = extras.surfaces;
    const sectors = await readIni(overlaysFile, 'overlays.ini', selectedWarnings, drive.readSectorSplits);
    if (!sectors.length) selectedWarnings.push('aucun secteur officiel détecté : la chronométrie utilisera les 3 tiers du tour');
    if (!surfaces.length) selectedWarnings.push('aucune surface lue : la fiche Briefing restera vide');

    try {
      const lineBuffer = await fs.readFile(lineFile.path);
      if (lineBuffer.length >= 8 && lineBuffer.readInt32LE(4) > MAX_LINE_POINTS) {
        throw new Error('nombre de points excessif');
      }
      const track = drive.decodeFastLane(lineBuffer);
      const corners = drive.detectCorners(track.points);
      const sectorBounds = sectors.length
        ? [0, ...sectors.map(item => item.from).filter(value => value > 0 && value < 1), 1]
        : [0, 1 / 3, 2 / 3, 1];
      const metadata = buildMetadata(ui || {}, {
        trackId,
        layoutId,
        name,
        date: plannedDate,
        round,
        extras
      });
      metadata.hero=await preview();
      const sectionsFile=await findFile(textCandidates(orderedDataDirs,'sections.ini'),rootReal,MAX_TEXT_BYTES);
      const sections=sectionsFile?await readIni(sectionsFile,'sections.ini',selectedWarnings,readNamedSections):[];
      if(sections.length)files.sections={name:fileLabel(sectionsFile,trackDir)};
      const markers=corners.map(c=>({...c,name:sections.find(s=>s.from<=c.norm&&c.norm<=s.to)?.name}));
      for(const section of sections){
        if(!corners.some(c=>section.from<=c.norm&&c.norm<=section.to))markers.push({norm:(section.from+section.to)/2,name:section.name});
      }
      markers.sort((a,b)=>a.norm-b.norm);
      const full = buildRound(track, metadata, {
        sectors: sectorBounds,
        cornerNorms: markers.map(marker => marker.norm)
      });
      full.outline.corners.forEach((pin,i)=>{const section=sections.find(s=>s.from<=markers[i].norm&&markers[i].norm<=s.to);if(section)Object.assign(pin,{name:section.name,from:section.from,to:section.to});});
      full.hasNamedSections=sections.length>0;
      full.estimatedSectors=!sectors.length;
      full.surfaces = surfaces;
      full.surfaceFile = surfacesFile && !surfacesFile.tooLarge ? fileLabel(surfacesFile, trackDir) : (extras.extFile && extras.surfaces.length ? fileLabel(extras.extFile, trackDir) : null);
      full.overlaysFile = overlaysFile && !overlaysFile.tooLarge ? fileLabel(overlaysFile, trackDir) : null;
      full.importWarnings = selectedWarnings.slice(0, 20);
      full.importedFiles = unique([...Object.values(files).map(file => file.name).filter(Boolean), ...extras.extraFiles]);
      return { round: full, source: 'local', files, warnings: selectedWarnings };
    } catch (error) {
      const message = `fast_lane.ai illisible : ${errorHint(error)}`;
      warnings.push(message);
      if (metadataFallback === fallback) metadataFallback.uiWarnings.push(message);
    }
  }

  if (metadataFallback) {
    const { trackDir, ui, uiFile, surfacesFile, overlaysFile, extras = { hasExtras: false, tags: [], surfaces: [], extraFiles: [] } } = metadataFallback;
    const fallbackWarnings = [...new Set([...metadataFallback.uiWarnings, ...warnings])];
    let surfaces = await readIni(surfacesFile, 'surfaces.ini', fallbackWarnings, drive.readSurfaces);
    if (!surfaces.length && extras.surfaces.length) surfaces = extras.surfaces;
    const sectors = await readIni(overlaysFile, 'overlays.ini', fallbackWarnings, drive.readSectorSplits);
    if (!sectors.length) fallbackWarnings.push('aucun secteur officiel détecté : la chronométrie utilisera les 3 tiers du tour');
    if (!surfaces.length) fallbackWarnings.push('aucune surface lue : la fiche Briefing restera vide');
    const files = fileEntries(trackDir, { surfacesFile, overlaysFile, uiFile });
    const metadata = buildMetadata(ui || {}, { trackId, layoutId, name, date: plannedDate, round, extras });
    if (extras.cameraTrack) {
      const camLabel = extras.cameraFile ? fileLabel(extras.cameraFile, trackDir) : 'cameras.ini';
      if (!warnings.some(message => /fast_lane\.ai/i.test(message))) {
        fallbackWarnings.push(`fast_lane.ai absent : tracé et dénivelé estimés depuis ${camLabel} (${extras.cameraTrack.cameraCount} caméras TV)`);
      }
      metadata.hero = await metadataFallback.preview();
      const corners = drive.detectCorners(extras.cameraTrack.points);
      const sectorBounds = sectors.length
        ? [0, ...sectors.map(item => item.from).filter(value => value > 0 && value < 1), 1]
        : [0, 1 / 3, 2 / 3, 1];
      const estimated = buildRound(extras.cameraTrack, metadata, {
        sectors: sectorBounds,
        cornerNorms: corners.map(c => c.norm)
      });
      estimated.approximateOutline = true;
      estimated.outlineSource = camLabel;
      estimated.estimatedSectors = !sectors.length;
      estimated.surfaces = surfaces;
      estimated.surfaceFile = surfacesFile && !surfacesFile.tooLarge ? fileLabel(surfacesFile, trackDir) : (extras.extFile && extras.surfaces.length ? fileLabel(extras.extFile, trackDir) : null);
      estimated.overlaysFile = overlaysFile && !overlaysFile.tooLarge ? fileLabel(overlaysFile, trackDir) : null;
      estimated.importWarnings = fallbackWarnings.slice(0, 20);
      estimated.importedFiles = unique([...Object.values(files).map(file => file.name).filter(Boolean), ...extras.extraFiles]);
      return { round: estimated, source: 'local', files, warnings: fallbackWarnings };
    }
    if (!warnings.some(message => /fast_lane\.ai/i.test(message))) {
      fallbackWarnings.push('fast_lane.ai absent du mod sélectionné : la géométrie du tracé ne peut pas être affichée');
    }
    if (ui || surfaces.length || sectors.length || extras.hasExtras) {
      metadata.hero=await metadataFallback.preview();
      const partial = metadataOnlyRound(metadata, {
        trackDir, surfaces, sectors, surfaceFile: surfacesFile, overlaysFile, warnings: fallbackWarnings, files
      });
      if (!partial.surfaceFile && extras.extFile && extras.surfaces.length) partial.surfaceFile = fileLabel(extras.extFile, trackDir);
      partial.importedFiles = unique([...(partial.importedFiles || []), ...extras.extraFiles]);
      return { round: partial, source: 'local', files, warnings: fallbackWarnings };
    }
    return { round: null, source: 'local', files, warnings: fallbackWarnings };
  }

  return {
    round: null,
    source: 'local',
    files: {},
    warnings: warnings.length
      ? [...warnings, 'Circuit absent des racines de mods configurées : seule l’entrée au calendrier sera conservée.']
      : ['Circuit absent des racines de mods configurées : seule l’entrée au calendrier sera conservée.']
  };
}

function importCircuitFilesPayload({ trackId = '', layoutId = '', name, date, round, files = [] } = {}) {
  const cleanFiles = Array.isArray(files) ? files.slice(0, 40).filter(f => f && typeof f.name === 'string' && typeof f.content === 'string' && f.content.length <= MAX_TEXT_BYTES) : [];
  if (!cleanFiles.length) throw httpError('Aucun fichier circuit lisible fourni.');
  const plannedDate = validDate(date);
  if (round != null && round !== '' && (!Number.isInteger(Number(round)) || Number(round) < 1 || Number(round) > 1000)) {
    throw httpError('Numéro de manche invalide.');
  }

  let ui = null, surfaces = [], sectors = [], sections = [], extFileName = null, surfaceFileName = null, overlaysFileName = null;
  const extras = { hasExtras: false, tags: [], surfaces: [], extraFiles: [] };
  const warnings = [];
  const importedNames = [];
  const cameraCandidates = [];
  const modelVariants = [];

  for (const file of cleanFiles) {
    const base = path.basename(file.name.trim()).slice(0, 120);
    const lower = base.toLowerCase();
    if (lower === 'ui_track.json') {
      try {
        const parsed = JSON.parse(file.content.replace(/^\uFEFF/, ''));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          ui = parsed;
          importedNames.push(base);
        }
      } catch { warnings.push('ui_track.json illisible'); }
    } else if (lower === 'surfaces.ini') {
      surfaces = drive.readSurfaces(file.content);
      surfaceFileName = base;
      importedNames.push(base);
    } else if (lower === 'overlays.ini') {
      sectors = drive.readSectorSplits(file.content);
      overlaysFileName = base;
      importedNames.push(base);
    } else if (lower === 'sections.ini') {
      sections = readNamedSections(file.content);
      if (sections.length) importedNames.push(base);
    } else if (lower === 'ext_config.ini') {
      const ext = parseExtConfig(file.content);
      extras.hasExtras = true;
      if (ext.author) extras.author = ext.author;
      if (ext.version) extras.version = ext.version;
      if (ext.year) extras.year = ext.year;
      if (ext.tags.length) extras.tags.push(...ext.tags);
      if (ext.surfaces.length) extras.surfaces = ext.surfaces;
      extFileName = base;
      importedNames.push(base);
    } else if (/^models_(.+)\.ini$/i.test(lower)) {
      const m = parseModelsIni(file.content, lower);
      extras.hasExtras = true;
      modelVariants.push(m);
      importedNames.push(base);
    } else if (/^cameras.*\.(?:ini|txt)$/i.test(lower)) {
      const cam = parseCamerasIni(file.content);
      const camTrack = buildTrackFromCameras(cam.cameras);
      cameraCandidates.push({ base, cam, camTrack });
      if (camTrack || cam.cameras.length) {
        extras.hasExtras = true;
        importedNames.push(base);
      }
    } else if (lower === 'ai_hints.ini') {
      const zones = parseAiHints(file.content);
      if (zones.length) {
        extras.hasExtras = true;
        extras.aiDangerZones = zones;
        importedNames.push(base);
      }
    } else if (lower === 'audio_sources.ini') {
      const audio = parseAudioSources(file.content);
      if (audio.length) {
        extras.hasExtras = true;
        extras.audioFeatures = audio;
        importedNames.push(base);
      }
    }
  }

  let inferredTrackId = safeSegment(trackId) ? trackId : '';
  if (!inferredTrackId && modelVariants.length) {
    const shortest = modelVariants.slice().sort((a, b) => a.variant.length - b.variant.length)[0];
    const baseVariant = shortest.variant.replace(/(?:_short)?(?:_rev)?$/i, '');
    if (safeSegment(baseVariant)) inferredTrackId = baseVariant;
  }
  if (!inferredTrackId) inferredTrackId = 'custom-track';

  const matchingModel = modelVariants.find(m => m.variant === layoutId)
    || modelVariants.find(m => m.variant === inferredTrackId)
    || modelVariants[0];
  if (matchingModel) {
    extras.isReverse = matchingModel.isReverse;
    extras.modelFiles = matchingModel.files;
  }

  cameraCandidates.sort((a, b) => {
    const score = item => (item.base.toLowerCase() === 'cameras.ini' ? 100 : 0) + (item.camTrack ? item.camTrack.cameraCount : 0);
    return score(b) - score(a);
  });
  const bestCam = cameraCandidates.find(c => c.camTrack) || cameraCandidates[0];
  if (bestCam) {
    extras.cameraInfo = bestCam.cam;
    extras.cameraTrack = bestCam.camTrack;
    extras.cameraFileName = bestCam.base;
    if (!extras.author && bestCam.cam.author) extras.author = bestCam.cam.author;
  }

  const descParts = [];
  if (extras.modelFiles && extras.modelFiles.length) descParts.push(`Scène 3D : ${extras.modelFiles.length} fichier(s) KN5 (${extras.modelFiles.slice(0, 6).join(', ')}).`);
  if (modelVariants.length > 1) descParts.push(`Variantes détectées : ${modelVariants.map(m => m.variant).join(', ')}.`);
  if (extras.cameraInfo && extras.cameraInfo.cameras.length) descParts.push(`Caméras TV : ${extras.cameraInfo.setName || 'Pack caméras'} (${extras.cameraInfo.cameras.length} caméras).`);
  if (extras.aiDangerZones && extras.aiDangerZones.length) {
    descParts.push(`Zones d’alerte IA : ${extras.aiDangerZones.map(z => `${Math.round(z.start * 100)}–${Math.round(z.end * 100)} %`).join(', ')} du tour.`);
  }
  if (extras.audioFeatures && extras.audioFeatures.length) descParts.push(`Environnement sonore : ${extras.audioFeatures.join(', ')}.`);
  if (descParts.length) extras.description = descParts.join('\n');
  extras.tags = unique(extras.tags);

  if (!surfaces.length && extras.surfaces.length) surfaces = extras.surfaces;
  if (!ui) warnings.push('ui_track.json absent des fichiers fournis');
  if (!sectors.length) warnings.push('aucun secteur officiel détecté : la chronométrie utilisera les 3 tiers du tour');
  if (!surfaces.length) warnings.push('aucune surface lue : la fiche Briefing restera vide');

  const metadata = buildMetadata(ui || {}, {
    trackId: inferredTrackId,
    layoutId: safeSegment(layoutId, { optional: true }) ? layoutId : '',
    name,
    date: plannedDate,
    round,
    extras
  });

  if (extras.cameraTrack) {
    const camLabel = extras.cameraFileName || 'cameras.ini';
    warnings.push(`fast_lane.ai absent : tracé et dénivelé estimés depuis ${camLabel} (${extras.cameraTrack.cameraCount} caméras TV)`);
    const corners = drive.detectCorners(extras.cameraTrack.points);
    const sectorBounds = sectors.length
      ? [0, ...sectors.map(item => item.from).filter(value => value > 0 && value < 1), 1]
      : [0, 1 / 3, 2 / 3, 1];
    const estimated = buildRound(extras.cameraTrack, metadata, {
      sectors: sectorBounds,
      cornerNorms: corners.map(c => c.norm)
    });
    estimated.approximateOutline = true;
    estimated.outlineSource = camLabel;
    estimated.estimatedSectors = !sectors.length;
    estimated.surfaces = surfaces;
    estimated.surfaceFile = surfaceFileName || (extFileName && extras.surfaces.length ? extFileName : null);
    estimated.overlaysFile = overlaysFileName;
    estimated.importWarnings = unique(warnings).slice(0, 20);
    estimated.importedFiles = unique(importedNames);
    return { round: estimated, source: 'files', warnings: unique(warnings) };
  }

  warnings.push('fast_lane.ai absent des fichiers fournis : la géométrie du tracé ne peut pas être affichée');
  const partial = metadataOnlyRound(metadata, {
    trackDir: '',
    surfaces,
    sectors,
    surfaceFile: null,
    overlaysFile: null,
    warnings: unique(warnings),
    files: {}
  });
  partial.surfaceFile = surfaceFileName || (extFileName && extras.surfaces.length ? extFileName : null);
  partial.overlaysFile = overlaysFileName;
  partial.importedFiles = unique(importedNames);
  return { round: partial, source: 'files', warnings: unique(warnings) };
}

function mountLocalCircuitImport(app, { roots = configuredRoots(), authorize } = {}) {
  app.post('/api/admin/circuits/import-local', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof authorize !== 'function' || !(await authorize(req, res))) return undefined;
    try {
      const body = req.body || {};
      const result = await importLocalCircuit({
        roots,
        trackId: body.trackId,
        layoutId: typeof body.layoutId === 'string' ? body.layoutId : '',
        name: typeof body.name === 'string' ? body.name : undefined,
        date: body.date,
        round: body.round
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = error && Number.isInteger(error.status) ? error.status : 500;
      return res.status(status).json({ error: error.message || 'Import local du circuit impossible.' });
    }
  });

  app.post('/api/admin/circuits/import-files', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof authorize !== 'function' || !(await authorize(req, res))) return undefined;
    try {
      const body = req.body || {};
      const result = importCircuitFilesPayload({
        trackId: typeof body.trackId === 'string' ? body.trackId : '',
        layoutId: typeof body.layoutId === 'string' ? body.layoutId : '',
        name: typeof body.name === 'string' ? body.name : undefined,
        date: body.date,
        round: body.round,
        files: body.files
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = error && Number.isInteger(error.status) ? error.status : 500;
      return res.status(status).json({ error: error.message || 'Import des fichiers du circuit impossible.' });
    }
  });
}

module.exports = {
  importLocalCircuit,
  importCircuitFilesPayload,
  mountLocalCircuitImport,
  safeSegment,
  validDate,
  parseModelsIni,
  parseExtConfig,
  parseCamerasIni,
  buildTrackFromCameras,
  parseAiHints,
  parseAudioSources,
  inferTrackPlace
};

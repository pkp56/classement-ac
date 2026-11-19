'use strict';

// Import technique en lecture seule depuis les mods Assetto Corsa installés
// sur le PC qui héberge GDSP Node. Les chemins reçus du navigateur sont des
// identifiants de dossiers, jamais des chemins de fichiers.
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildRound } = require('./circuit-round');
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

function safeTrackText(value, max = 300) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, max) : '';
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
    candidates.push(path.join(trackDir, layoutId));
    candidates.push(path.join(trackDir, 'layouts', layoutId));
  }
  candidates.push(trackDir);
  return unique(candidates);
}

function lineCandidates(trackDir, layoutId, dataDirs) {
  const candidates = [];
  for (const dir of dataDirs) {
    candidates.push(path.join(dir, 'fast_lane.ai'));
    candidates.push(path.join(dir, 'ai', 'fast_lane.ai'));
  }
  if (layoutId) {
    candidates.push(path.join(trackDir, 'ai', layoutId, 'fast_lane.ai'));
    candidates.push(path.join(trackDir, 'layouts', layoutId, 'ai', 'fast_lane.ai'));
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

function fileLabel(fileInfo, trackDir) {
  if (!fileInfo || !fileInfo.path) return null;
  const relative = path.relative(trackDir, fileInfo.path);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    return path.basename(fileInfo.path);
  }
  return relative.split(path.sep).join('/');
}

function buildMetadata(ui, { trackId, layoutId, name, date, round }) {
  const uiName = safeTrackText(ui && (ui.name || ui.Name));
  const selectedName = safeTrackText(name);
  const resolvedName = uiName || selectedName || trackId;
  const uiLayout = safeTrackText(ui && (ui.layout || ui.Layout || ui.layoutName || ui.LayoutName));
  const tags = ui && (ui.geotags || ui.Geotags);
  const gps = safeTrackText(ui && (ui.geographicLocation || ui.GeographicLocation))
    || (Array.isArray(tags) ? tags.map(safeTrackText).filter(Boolean).join(' · ') : '');
  const number = Number.isInteger(Number(round)) && Number(round) > 0 ? Number(round) : null;

  return {
    id: `local:${date || 'undated'}:${trackId}${layoutId ? '/' + layoutId : ''}`,
    round: number,
    label: number ? `M${number}` : null,
    name: resolvedName,
    shortName: resolvedName,
    layout: uiLayout || (layoutId ? (uiName || layoutId) : null),
    layoutKey: layoutId || '',
    driverFolder: trackId,
    trackId,
    layoutId: layoutId || '',
    country: safeTrackText(ui && (ui.country || ui.Country)) || 'À confirmer',
    countryCode: safeTrackText(ui && (ui.countryCode || ui.CountryCode)),
    city: safeTrackText(ui && (ui.city || ui.City)) || null,
    gps: gps || null,
    year: (ui && (ui.year ?? ui.Year)) ?? null,
    author: safeTrackText(ui && (ui.author || ui.Author)) || null,
    version: safeTrackText(ui && (ui.version || ui.Version)) || null,
    direction: /anticlock/i.test(String(ui && (ui.run || ui.Run) || '')) ? 'counterclockwise' : 'clockwise',
    pitboxes: (ui && (ui.pitboxes ?? ui.Pitboxes)) ?? null,
    width: safeTrackText(ui && (ui.width || ui.Width)) || null,
    format: null,
    status: 'upcoming',
    date: date || null,
    dateLabel: null,
    winner: null,
    stats: null,
    localTrackId: trackId,
    localLayoutId: layoutId || '',
    driveName: trackId,
    source: 'Mod local Assetto Corsa',
    hero: null,
    importedAt: new Date().toISOString()
  };
}

/**
 * Importe une fiche locale complète quand `fast_lane.ai` est présent.
 * Une absence de fichier renvoie `round: null` et des avertissements :
 * l'appelant peut tout de même enregistrer l'entrée au calendrier.
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
      ? [path.join(trackDir, 'ui', layoutId, 'ui_track.json'), path.join(trackDir, 'ui', 'ui_track.json')]
      : [path.join(trackDir, 'ui', 'ui_track.json')];
    const uiFile = await findFile(uiCandidates, rootReal, MAX_UI_BYTES);
    const uiWarnings = [];
    const ui = await readJson(uiFile, uiWarnings);
    if (!metadataFallback) {
      metadataFallback = {
        trackDir,
        ui,
        name: safeTrackText(name) || trackId,
        warnings: uiWarnings
      };
    }

    const lineFile = await findFile(lineCandidates(trackDir, layoutId, orderedDataDirs), rootReal, MAX_LINE_BYTES);
    if (!lineFile) continue;
    if (lineFile.tooLarge) {
      warnings.push('fast_lane.ai trop volumineux : fiche technique non importée');
      continue;
    }

    const files = { line: { name: fileLabel(lineFile, trackDir) } };
    const surfacesFile = await findFile(textCandidates(orderedDataDirs, 'surfaces.ini'), rootReal, MAX_TEXT_BYTES);
    const overlaysFile = await findFile(textCandidates(orderedDataDirs, 'overlays.ini'), rootReal, MAX_TEXT_BYTES);
    const selectedWarnings = [...uiWarnings];
    const surfaces = await readIni(surfacesFile, 'surfaces.ini', selectedWarnings, drive.readSurfaces);
    const sectors = await readIni(overlaysFile, 'overlays.ini', selectedWarnings, drive.readSectorSplits);
    if (surfacesFile && !surfacesFile.tooLarge) files.surfaces = { name: fileLabel(surfacesFile, trackDir) };
    if (overlaysFile && !overlaysFile.tooLarge) files.overlays = { name: fileLabel(overlaysFile, trackDir) };
    if (uiFile && !uiFile.tooLarge) files.ui = { name: fileLabel(uiFile, trackDir) };

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
        round
      });
      const full = buildRound(track, metadata, {
        sectors: sectorBounds,
        cornerNorms: corners.map(corner => corner.norm)
      });
      full.surfaces = surfaces;
      full.surfaceFile = surfacesFile ? fileLabel(surfacesFile, trackDir) : null;
      full.overlaysFile = overlaysFile ? fileLabel(overlaysFile, trackDir) : null;
      return {
        round: full,
        source: 'local',
        files,
        warnings: selectedWarnings
      };
    } catch (error) {
      selectedWarnings.push(`fast_lane.ai illisible : ${errorHint(error)}`);
      return { round: null, source: 'local', files, warnings: selectedWarnings };
    }
  }

  if (metadataFallback) {
    warnings.push(...metadataFallback.warnings);
    warnings.push('fast_lane.ai absent du mod sélectionné : fiche technique non importée');
    return { round: null, source: 'local', files: {}, warnings };
  }
  return {
    round: null,
    source: 'local',
    files: {},
    warnings: ['Circuit absent des racines de mods configurées : seule l’entrée au calendrier sera conservée.']
  };
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
}

module.exports = { importLocalCircuit, mountLocalCircuitImport, safeSegment, validDate };

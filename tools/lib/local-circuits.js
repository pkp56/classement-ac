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

function buildMetadata(ui, { trackId, layoutId, name, date, round }) {
  const uiName = safeTrackText(ui && (ui.name || ui.Name));
  const selectedName = safeTrackText(name);
  const resolvedName = uiName || selectedName || trackId;
  const uiLayout = safeTrackText(ui && (ui.layout || ui.Layout || ui.layoutName || ui.LayoutName));
  const geotags = ui && (ui.geotags || ui.Geotags);
  const gps = safeTrackText(ui && (ui.geographicLocation || ui.GeographicLocation))
    || (Array.isArray(geotags) ? geotags.map(tag => safeTrackText(tag, 80)).filter(Boolean).join(' · ') : safeTrackText(geotags, 160));
  const tags = safeTrackTags(ui && (ui.tags || ui.Tags));
  const number = Number.isInteger(Number(round)) && Number(round) > 0 ? Number(round) : null;
  const officialLength = safeTrackText(ui && (ui.length || ui.Length), 80);
  const officialLengthM = parseOfficialLength(officialLength);
  const description = safeTrackText(ui && (ui.description || ui.Description), 1200);
  const trackUrl = safeTrackUrl(ui && (ui.url || ui.URL));
  const rawPitboxes = ui && (ui.pitboxes ?? ui.Pitboxes);
  const pitboxes = safeTrackText(rawPitboxes, 16);

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
    countryCode: safeTrackText(ui && (ui.countryCode || ui.CountryCode), 12),
    city: safeTrackText(ui && (ui.city || ui.City)) || null,
    gps: /^lat\s*·\s*lon$/i.test(gps) ? null : gps || null,
    year: safeTrackText(ui && (ui.year ?? ui.Year), 32) || null,
    author: safeTrackText(ui && (ui.author || ui.Author)) || null,
    version: safeTrackText(ui && (ui.version || ui.Version), 80) || null,
    description: description || null,
    tags,
    officialLength: officialLength || null,
    officialLengthM,
    trackUrl: trackUrl || null,
    direction: /anticlock/i.test(String(ui && (ui.run || ui.Run) || '')) ? 'counterclockwise' : 'clockwise',
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

/**
 * Importe une fiche locale complète quand `fast_lane.ai` est présent.
 * Si la ligne rapide manque, les métadonnées UI et les surfaces disponibles
 * restent enregistrées dans une fiche partielle au lieu d'être abandonnées.
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
    + (candidate.overlaysFile && !candidate.overlaysFile.tooLarge ? 1 : 0);
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
    const previewCandidates=uiCandidates.flatMap(file=>['preview.png','preview.jpg'].map(n=>path.join(path.dirname(file),n)));
    const preview=()=>cachePreview(trackDir,previewCandidates).catch(()=>null);
    const fallback = { preview,trackDir, ui, uiFile, surfacesFile, overlaysFile, uiWarnings, dataDirs: orderedDataDirs };
    if (!metadataFallback || fileScore(fallback) > fileScore(metadataFallback)) metadataFallback = fallback;

    const lineFile = await findFile(lineCandidates(trackDir, layoutId, orderedDataDirs), rootReal, MAX_LINE_BYTES);
    if (!lineFile) continue;
    if (lineFile.tooLarge) {
      warnings.push('fast_lane.ai trop volumineux : fiche géométrique non importée');
      continue;
    }

    const files = fileEntries(trackDir, { lineFile, surfacesFile, overlaysFile, uiFile });
    const selectedWarnings = [...uiWarnings];
    const surfaces = await readIni(surfacesFile, 'surfaces.ini', selectedWarnings, drive.readSurfaces);
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
        round
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
      full.surfaceFile = surfacesFile && !surfacesFile.tooLarge ? fileLabel(surfacesFile, trackDir) : null;
      full.overlaysFile = overlaysFile && !overlaysFile.tooLarge ? fileLabel(overlaysFile, trackDir) : null;
      full.importWarnings = selectedWarnings.slice(0, 20);
      full.importedFiles = Object.values(files).map(file => file.name).filter(Boolean);
      return { round: full, source: 'local', files, warnings: selectedWarnings };
    } catch (error) {
      const message = `fast_lane.ai illisible : ${errorHint(error)}`;
      warnings.push(message);
      if (metadataFallback === fallback) metadataFallback.uiWarnings.push(message);
    }
  }

  if (metadataFallback) {
    const { trackDir, ui, uiFile, surfacesFile, overlaysFile } = metadataFallback;
    const fallbackWarnings = [...new Set([...metadataFallback.uiWarnings, ...warnings])];
    const surfaces = await readIni(surfacesFile, 'surfaces.ini', fallbackWarnings, drive.readSurfaces);
    const sectors = await readIni(overlaysFile, 'overlays.ini', fallbackWarnings, drive.readSectorSplits);
    if (!sectors.length) fallbackWarnings.push('aucun secteur officiel détecté : la chronométrie utilisera les 3 tiers du tour');
    if (!surfaces.length) fallbackWarnings.push('aucune surface lue : la fiche Briefing restera vide');
    if (!warnings.some(message => /fast_lane\.ai/i.test(message))) {
      fallbackWarnings.push('fast_lane.ai absent du mod sélectionné : la géométrie du tracé ne peut pas être affichée');
    }
    const files = fileEntries(trackDir, { surfacesFile, overlaysFile, uiFile });
    const metadata = buildMetadata(ui || {}, { trackId, layoutId, name, date: plannedDate, round });
    if (ui || surfaces.length || sectors.length) {
      metadata.hero=await metadataFallback.preview();
      const partial = metadataOnlyRound(metadata, {
        trackDir, surfaces, sectors, surfaceFile: surfacesFile, overlaysFile, warnings: fallbackWarnings, files
      });
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

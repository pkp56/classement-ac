'use strict';

const zlib = require('zlib');

const MAX_CSP_MOTD_BYTES = 2039;
const CSP_PREFIX = '$CSP0:';
const TAB_HIDE = '\t'.repeat(32);

const PENALTY_KINDS = ['off', 'warn', 'slow_cut', 'drive_through', 'stop_and_go', 'teleport_pits', 'time_penalty'];
const ESCALATION_KINDS = ['none', 'drive_through', 'stop_and_go', 'teleport_pits', 'black_flag', 'time_penalty'];
const CUT_PENALTY_KINDS = ['warn', 'slow_cut', 'drive_through', 'stop_and_go', 'teleport_pits', 'time_penalty'];
const SC_FALLBACK_MODES = ['admin', 'p1', 'off'];

const CFG_DEFAULTS = Object.freeze({
  // Rolling start / Start mode
  enabled: 1,
  everySession: 0,
  formationMode: '2x2',
  poleSide: 'left',
  startLength: 'full',
  formationLaps: 1,
  shortMode: 'distance',
  shortDistanceM: 450,
  shortGreenSpline: 0.18,
  shortSec: 25,
  paceKmh: 90,
  catchupKmh: 35,
  fastKmh: 160,
  fastPct: 75,
  slowKmh: 80,
  bunchM: 80,
  speedTolKmh: 6,
  targetGapM: 16,
  rowAlignTolM: 8,
  laneTolNorm: 0.18,
  oneToGoSpline: 0.72,
  accelZoneStart: 0.88,
  greenLineSpline: 0.0,
  greenTrigger: 'both',
  autoGreenAt: 'line',
  allowP1Green: 0,
  limiterMode: 'limiter',
  penaltyMode: 'warn',
  slowSec: 4,
  driveLaps: 3,
  launchGraceSec: 5,
  maxFormationSec: 240,
  hideHudWhenAppOpen: 1,
  debug: 0,

  // Jump-start (Standing & Rolling)
  jumpEnabled: 1,
  jumpStandingTolM: 0.8,
  jumpStandingMaxKmh: 5,
  jumpRollingCatch: 1,
  jumpPenaltyType: 'drive_through',
  jumpStopGoSec: 10,
  jumpServeLaps: 3,
  jumpEscPenalty: 'stop_and_go',
  jumpEscStopGoSec: 10,
  jumpTimePenaltySec: 15,

  // Track-cut penalty system
  cutEnabled: 1,
  cutEverySession: 0,
  cutWheelsMin: 4,
  cutUseKunosInvalid: 0,
  cutMinDurationSec: 0.35,
  cutMinSpeedKmh: 45,
  cutCooldownSec: 4,
  cutMaxBeforePenalty: 3,
  cutRepeatEvery: 0,
  cutPenaltyType: 'drive_through',
  cutStopGoSec: 10,
  cutSlowSec: 5,
  cutServeLaps: 3,
  cutEscPenalty: 'stop_and_go',
  cutEscStopGoSec: 10,
  cutFinishTimeSec: 20,
  cutTimePenaltySec: 10,
  cutDisabledZones: '',
  scFallback: 'admin',
  safetyCarKey: 'safety',
});

const PRESETS = Object.freeze([
  {
    id: 'gt3_2x2_full',
    label: 'GT3 / ACC Double File (Tour complet, 90 km/h)',
    description: 'Depart lance 2x2 classique sur tour complet + detection cuts (3 tol.) + depart anticipe.',
    values: {
      enabled: 1,
      formationMode: '2x2',
      startLength: 'full',
      formationLaps: 1,
      paceKmh: 90,
      catchupKmh: 35,
      targetGapM: 16,
      greenTrigger: 'both',
      autoGreenAt: 'line',
      limiterMode: 'limiter',
      penaltyMode: 'warn',
      allowP1Green: 0,
      jumpEnabled: 1,
      jumpPenaltyType: 'drive_through',
      cutEnabled: 1,
      cutMaxBeforePenalty: 3,
      cutPenaltyType: 'drive_through',
      cutServeLaps: 3,
      cutEscPenalty: 'stop_and_go',
    },
  },
  {
    id: 'standing_steward',
    label: 'Depart Arrete + Stewards (Faux Depart & Cuts)',
    description: 'Desactive le depart lance pour une grille arretee classique tout en gardant les penalites faux depart et cuts.',
    values: {
      enabled: 0,
      jumpEnabled: 1,
      jumpPenaltyType: 'drive_through',
      jumpServeLaps: 3,
      jumpEscPenalty: 'stop_and_go',
      jumpTimePenaltySec: 15,
      cutEnabled: 1,
      cutMaxBeforePenalty: 3,
      cutPenaltyType: 'drive_through',
      cutServeLaps: 3,
      cutEscPenalty: 'stop_and_go',
      cutFinishTimeSec: 20,
    },
  },
  {
    id: 'single_1x1_full',
    label: 'Monoplace / Prototype 1x1 (Tour complet, 95 km/h)',
    description: 'File indienne 1x1 sur tour complet avec espacement securise et Stop & Go strict sur faux depart.',
    values: {
      enabled: 1,
      formationMode: '1x1',
      startLength: 'full',
      formationLaps: 1,
      paceKmh: 95,
      catchupKmh: 35,
      targetGapM: 18,
      greenTrigger: 'both',
      autoGreenAt: 'line',
      limiterMode: 'limiter',
      penaltyMode: 'warn',
      jumpEnabled: 1,
      jumpPenaltyType: 'stop_and_go',
      jumpStopGoSec: 10,
      cutEnabled: 1,
      cutMaxBeforePenalty: 3,
      cutPenaltyType: 'drive_through',
    },
  },
  {
    id: 'short_2x2_sprint',
    label: 'Sprint 2x2 Depart Court (450 m, 80 km/h)',
    description: 'Ideal sur Nordschleife ou sprints : grille 2x2 lancee sur 450 m avant le drapeau vert.',
    values: {
      enabled: 1,
      formationMode: '2x2',
      startLength: 'short',
      shortMode: 'distance',
      shortDistanceM: 450,
      paceKmh: 80,
      catchupKmh: 30,
      targetGapM: 16,
      greenTrigger: 'both',
      autoGreenAt: 'line',
      limiterMode: 'limiter',
      penaltyMode: 'warn',
      cutEnabled: 1,
      cutMaxBeforePenalty: 2,
      cutPenaltyType: 'drive_through',
      cutServeLaps: 2,
    },
  },
  {
    id: 'manual_race_control',
    label: 'Controle Manuel / Poleman (Race Control)',
    description: 'Formation sous limiteur jusqu\'au Green manuel (!green) ou du poleman, sanctions strictes Stop & Go.',
    values: {
      enabled: 1,
      formationMode: '2x2',
      startLength: 'full',
      formationLaps: 1,
      paceKmh: 85,
      greenTrigger: 'manual',
      allowP1Green: 1,
      limiterMode: 'limiter',
      penaltyMode: 'drive',
      cutEnabled: 1,
      cutMaxBeforePenalty: 3,
      cutPenaltyType: 'stop_and_go',
      cutStopGoSec: 10,
      cutEscPenalty: 'black_flag',
    },
  },
  {
    id: 'test_local_solo',
    label: 'Test Serveur Local (Essais & Course, Court 300 m, Debug)',
    description: 'Active immediatement en Essais/Qualifs/Course (2x2 court 300 m + cuts actifs, quota 2) pour tester vite sur un serveur local.',
    values: {
      enabled: 1,
      everySession: 1,
      formationMode: '2x2',
      startLength: 'short',
      shortMode: 'distance',
      shortDistanceM: 300,
      paceKmh: 85,
      greenTrigger: 'both',
      allowP1Green: 1,
      limiterMode: 'limiter',
      penaltyMode: 'warn',
      jumpEnabled: 1,
      jumpPenaltyType: 'drive_through',
      cutEnabled: 1,
      cutEverySession: 1,
      cutMaxBeforePenalty: 2,
      cutPenaltyType: 'drive_through',
      cutServeLaps: 2,
      scFallback: 'admin',
      debug: 1,
    },
  },
]);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function toInt01(v, fallback) {
  if (v === true || v === '1' || v === 1 || v === 'true') return 1;
  if (v === false || v === '0' || v === 0 || v === 'false') return 0;
  return fallback;
}

function sanitizeCutZones(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const tokens = raw.split(/[,;]+/);
  const cleaned = [];
  for (const tok of tokens) {
    const m = tok.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const s = clamp(Number(m[1]), 0, 0.999);
    const e = clamp(Number(m[2]), 0, 0.999);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    cleaned.push(`${s.toFixed(3)}-${e.toFixed(3)}`);
    if (cleaned.length >= 6) break;
  }
  const joined = cleaned.join(',');
  return joined.length <= 78 ? joined : joined.slice(0, 78).replace(/,[^,]*$/, '');
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeConfig(input = {}) {
  const c = { ...CFG_DEFAULTS };
  for (const key of Object.keys(CFG_DEFAULTS)) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      c[key] = input[key];
    }
  }

  c.enabled = toInt01(c.enabled, 1);
  c.everySession = toInt01(c.everySession, 0);
  c.formationMode = c.formationMode === '1x1' ? '1x1' : '2x2';
  c.poleSide = c.poleSide === 'right' ? 'right' : 'left';
  c.startLength = c.startLength === 'short' ? 'short' : 'full';
  c.formationLaps = clamp(Math.round(numOr(c.formationLaps, 1)), 1, 5);
  c.shortMode = ['distance', 'spline', 'timer'].includes(c.shortMode) ? c.shortMode : 'distance';
  c.shortDistanceM = clamp(Math.round(numOr(c.shortDistanceM, 450)), 80, 5000);
  c.shortGreenSpline = Number(clamp(numOr(c.shortGreenSpline, 0.18), 0.01, 0.98).toFixed(3));
  c.shortSec = clamp(Math.round(numOr(c.shortSec, 25)), 5, 300);
  c.paceKmh = clamp(Math.round(numOr(c.paceKmh, 90)), 40, 180);
  c.catchupKmh = clamp(Math.round(numOr(c.catchupKmh, 35)), 0, 100);
  c.fastKmh = clamp(Math.round(numOr(c.fastKmh, 160)), 40, 200);
  c.fastPct = clamp(Math.round(numOr(c.fastPct, 75)), 25, 100);
  c.slowKmh = clamp(Math.round(numOr(c.slowKmh, 80)), 30, 150);
  c.bunchM = clamp(Math.round(numOr(c.bunchM, 80)), 20, 300);
  c.speedTolKmh = clamp(Math.round(numOr(c.speedTolKmh, 6)), 1, 30);
  c.targetGapM = clamp(Math.round(numOr(c.targetGapM, 16)), 6, 60);
  c.rowAlignTolM = clamp(Math.round(numOr(c.rowAlignTolM, 8)), 2, 25);
  c.laneTolNorm = Number(clamp(numOr(c.laneTolNorm, 0.18), 0.05, 0.50).toFixed(2));
  c.oneToGoSpline = Number(clamp(numOr(c.oneToGoSpline, 0.72), 0.1, 0.96).toFixed(3));
  c.accelZoneStart = Number(clamp(numOr(c.accelZoneStart, 0.88), 0.2, 0.995).toFixed(3));
  c.greenLineSpline = Number(clamp(numOr(c.greenLineSpline, 0.0), 0.0, 0.999).toFixed(3));
  c.greenTrigger = ['auto', 'manual', 'both'].includes(c.greenTrigger) ? c.greenTrigger : 'both';
  c.autoGreenAt = c.autoGreenAt === 'zone' ? 'zone' : 'line';
  c.allowP1Green = toInt01(c.allowP1Green, 0);
  c.limiterMode = ['off', 'limiter', 'hard'].includes(c.limiterMode) ? c.limiterMode : 'limiter';
  c.penaltyMode = ['off', 'warn', 'slow', 'drive'].includes(c.penaltyMode) ? c.penaltyMode : 'warn';
  c.slowSec = clamp(Math.round(numOr(c.slowSec, 4)), 1, 15);
  c.driveLaps = clamp(Math.round(numOr(c.driveLaps, 3)), 1, 10);
  c.launchGraceSec = clamp(Math.round(numOr(c.launchGraceSec, 5)), 0, 20);
  c.maxFormationSec = clamp(Math.round(numOr(c.maxFormationSec, 240)), 0, 600);
  c.hideHudWhenAppOpen = toInt01(c.hideHudWhenAppOpen, 1);
  c.debug = toInt01(c.debug, 0);

  // Jump-start
  c.jumpEnabled = toInt01(c.jumpEnabled, 1);
  c.jumpStandingTolM = Number(clamp(numOr(c.jumpStandingTolM, 0.8), 0.2, 3.0).toFixed(1));
  c.jumpStandingMaxKmh = clamp(Math.round(numOr(c.jumpStandingMaxKmh, 5)), 2, 15);
  c.jumpRollingCatch = toInt01(c.jumpRollingCatch, 1);
  c.jumpPenaltyType = PENALTY_KINDS.includes(c.jumpPenaltyType) ? c.jumpPenaltyType : 'drive_through';
  c.jumpStopGoSec = clamp(Math.round(numOr(c.jumpStopGoSec, 10)), 3, 60);
  c.jumpServeLaps = clamp(Math.round(numOr(c.jumpServeLaps, 3)), 1, 10);
  c.jumpEscPenalty = ESCALATION_KINDS.includes(c.jumpEscPenalty) ? c.jumpEscPenalty : 'stop_and_go';
  c.jumpEscStopGoSec = clamp(Math.round(numOr(c.jumpEscStopGoSec, 10)), 3, 60);
  c.jumpTimePenaltySec = clamp(Math.round(numOr(c.jumpTimePenaltySec, 15)), 5, 180);

  // Track cuts
  c.cutEnabled = toInt01(c.cutEnabled, 1);
  c.cutEverySession = toInt01(c.cutEverySession, 0);
  c.cutWheelsMin = clamp(Math.round(numOr(c.cutWheelsMin, 4)), 2, 4);
  c.cutUseKunosInvalid = toInt01(c.cutUseKunosInvalid, 0);
  c.cutMinDurationSec = Number(clamp(numOr(c.cutMinDurationSec, 0.35), 0.1, 2.0).toFixed(2));
  c.cutMinSpeedKmh = clamp(Math.round(numOr(c.cutMinSpeedKmh, 45)), 10, 120);
  c.cutCooldownSec = clamp(Math.round(numOr(c.cutCooldownSec, 4)), 1, 15);
  c.cutMaxBeforePenalty = clamp(Math.round(numOr(c.cutMaxBeforePenalty, 3)), 0, 15);
  c.cutRepeatEvery = clamp(Math.round(numOr(c.cutRepeatEvery, 0)), 0, 10);
  c.cutPenaltyType = CUT_PENALTY_KINDS.includes(c.cutPenaltyType) ? c.cutPenaltyType : 'drive_through';
  c.cutStopGoSec = clamp(Math.round(numOr(c.cutStopGoSec, 10)), 3, 60);
  c.cutSlowSec = clamp(Math.round(numOr(c.cutSlowSec, 5)), 1, 15);
  c.cutServeLaps = clamp(Math.round(numOr(c.cutServeLaps, 3)), 1, 10);
  c.cutEscPenalty = ESCALATION_KINDS.includes(c.cutEscPenalty) ? c.cutEscPenalty : 'stop_and_go';
  c.cutEscStopGoSec = clamp(Math.round(numOr(c.cutEscStopGoSec, 10)), 3, 60);
  c.cutFinishTimeSec = clamp(Math.round(numOr(c.cutFinishTimeSec, 20)), 5, 180);
  c.cutTimePenaltySec = clamp(Math.round(numOr(c.cutTimePenaltySec, 10)), 2, 120);
  c.cutDisabledZones = sanitizeCutZones(String(c.cutDisabledZones || ''));
  c.scFallback = SC_FALLBACK_MODES.includes(c.scFallback) ? c.scFallback : 'admin';
  c.safetyCarKey = String(c.safetyCarKey || 'safety')
    .replace(/[\r\n\t"'`]/g, '')
    .trim()
    .slice(0, 23) || 'safety';

  return c;
}

function buildCspExtraOptionsIni(rawCfg = {}, options = {}) {
  const cfg = sanitizeConfig(rawCfg);
  const scriptUrl = (options.scriptUrl || 'https://YOUR_HOST/rolling-start/csp/rolling_start.lua').trim();
  const compact = options.compact !== false;

  const lines = [
    '[SCRIPT_1]',
    `SCRIPT=${scriptUrl}`,
  ];

  for (const [k, defVal] of Object.entries(CFG_DEFAULTS)) {
    if (!compact || String(cfg[k]) !== String(defVal)) {
      lines.push(`${k}=${cfg[k]}`);
    }
  }

  return lines.join('\n') + '\n';
}

function encodeCspPayload(iniText) {
  const deflated = zlib.deflateSync(Buffer.from(String(iniText), 'utf8'), { level: 9 });
  const b64 = deflated.toString('base64').replace(/=+$/, '');
  return CSP_PREFIX + b64;
}

function decodeCspPayload(text) {
  const str = String(text || '');
  const idx = str.indexOf(CSP_PREFIX);
  if (idx === -1) {
    throw new Error('No $CSP0: marker found in input');
  }
  const visibleText = str.slice(0, idx).replace(/\t+$/, '');
  const rawB64 = str.slice(idx + CSP_PREFIX.length).trim().split(/\s/)[0];
  const padLen = (4 - (rawB64.length % 4)) % 4;
  const padded = rawB64 + '='.repeat(padLen);
  const buf = Buffer.from(padded, 'base64');
  const iniText = zlib.inflateSync(buf).toString('utf8');
  return { visibleText, iniText };
}

function buildMotdPayload({ welcomeText = '', iniText, maxBytes = MAX_CSP_MOTD_BYTES } = {}) {
  const cleanWelcome = String(welcomeText || '').replace(/\t+$/g, '').trimEnd();
  const encoded = encodeCspPayload(iniText);
  const motd = cleanWelcome + TAB_HIDE + encoded;
  const byteLength = Buffer.byteLength(motd, 'utf8');
  const hasSpacesInPayload = /\s/.test(encoded);
  return {
    motd,
    encoded,
    byteLength,
    maxBytes,
    withinLimit: byteLength <= maxBytes && !hasSpacesInPayload,
    remainingBytes: maxBytes - byteLength,
  };
}

function formatLuaLiteral(v) {
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function injectQueryOverrides(luaSource, query = {}) {
  const overrides = {};
  for (const [k] of Object.entries(CFG_DEFAULTS)) {
    if (query[k] !== undefined && query[k] !== '') {
      overrides[k] = query[k];
    }
  }
  if (Object.keys(overrides).length === 0) return luaSource;
  const sanitized = sanitizeConfig(overrides);
  const entries = Object.keys(overrides)
    .map((k) => `${k} = ${formatLuaLiteral(sanitized[k])}`)
    .join(', ');
  const replacement = `local QUERY_OVERRIDES = { ${entries} }`;
  return luaSource.replace(/local QUERY_OVERRIDES = nil/, replacement);
}

module.exports = {
  MAX_CSP_MOTD_BYTES,
  CSP_PREFIX,
  CFG_DEFAULTS,
  PRESETS,
  PENALTY_KINDS,
  ESCALATION_KINDS,
  CUT_PENALTY_KINDS,
  SC_FALLBACK_MODES,
  sanitizeCutZones,
  sanitizeConfig,
  buildCspExtraOptionsIni,
  encodeCspPayload,
  decodeCspPayload,
  buildMotdPayload,
  injectQueryOverrides,
};

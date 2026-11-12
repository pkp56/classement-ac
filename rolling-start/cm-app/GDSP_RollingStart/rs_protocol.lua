-- GDSP Rolling Start & Race Control — Shared constants, configuration schema,
-- geometry math, cut-zone parser, IPC bridge layout, and steward helpers.
-- Compatible with LuaJIT 2.1 (Assetto Corsa CSP 0.1.79+) and standard Lua 5.1+.

local M = {}

M.VERSION = '1.1.2'
M.ORDER_MAX = 48
M.NONE = 255

-- Phases (Rolling Start)
M.PHASE_IDLE = 0
M.PHASE_FORMATION = 1
M.PHASE_READY = 2
M.PHASE_GREEN = 3
M.PHASE_CAUTION = 4

M.PHASE_NAMES = {
  [M.PHASE_IDLE] = 'STAND BY',
  [M.PHASE_FORMATION] = 'FORMATION',
  [M.PHASE_READY] = 'GET READY',
  [M.PHASE_GREEN] = 'GREEN FLAG',
  [M.PHASE_CAUTION] = 'HOLD / CAUTION',
}

-- Reasons
M.REASON_NONE = 0
M.REASON_LIGHTS = 1
M.REASON_ADMIN = 2
M.REASON_CAUTION = 3

-- Bridge commands (CM App -> CSP Online Script)
M.CMD_NONE = 0
M.CMD_START = 1
M.CMD_READY = 2
M.CMD_GREEN = 3
M.CMD_CAUTION = 4
M.CMD_RESET = 5
M.CMD_APPLY_CFG = 6
M.CMD_CLEAR_PENALTY = 7
M.CMD_ADMIN_ACTION = 8

-- Admin steward actions (cmdParam / cmdTargetSid)
M.ACT_CLEAR_ONE = 1
M.ACT_CLEAR_ALL = 2
M.ACT_RESET_CUTS = 3
M.ACT_GIVE_DT = 4
M.ACT_GIVE_SG = 5
M.ACT_ADD_TIME = 6
M.ACT_SET_STEWARD = 7

-- Penalty codes (wire & bridge)
M.PEN_NONE = 0
M.PEN_DRIVE_THROUGH = 1
M.PEN_STOP_AND_GO = 2
M.PEN_TELEPORT_PITS = 3
M.PEN_BLACK_FLAG = 4
M.PEN_SLOW_CUT = 5
M.PEN_TIME_ONLY = 6

M.PEN_REASON_NONE = 0
M.PEN_REASON_CUT = 1
M.PEN_REASON_JUMP = 2
M.PEN_REASON_FORMATION = 3
M.PEN_REASON_ESCALATED = 4
M.PEN_REASON_ADMIN = 5

M.PEN_LABELS = {
  [M.PEN_NONE] = 'Aucune',
  [M.PEN_DRIVE_THROUGH] = 'DRIVE-THROUGH',
  [M.PEN_STOP_AND_GO] = 'STOP & GO',
  [M.PEN_TELEPORT_PITS] = 'RETOUR STANDS',
  [M.PEN_BLACK_FLAG] = 'DRAPEAU NOIR',
  [M.PEN_SLOW_CUT] = 'COUPURE GAZ',
  [M.PEN_TIME_ONLY] = 'PENALITE TEMPS',
}

M.CFG_DEFAULTS = {
  -- Rolling Start / Start Mode
  enabled = 1,               -- 1 = Depart lance, 0 = Depart arrete
  everySession = 0,          -- 0 = Course seule, 1 = Aussi Essais/Qualifs (Test)
  formationMode = '2x2',     -- '1x1' | '2x2'
  poleSide = 'left',         -- 'left' | 'right'
  startLength = 'full',      -- 'full' | 'short'
  formationLaps = 1,         -- 1..5
  shortMode = 'distance',    -- 'distance' | 'spline' | 'timer'
  shortDistanceM = 450,      -- 80..5000 m
  shortGreenSpline = 0.18,   -- 0.01..0.98
  shortSec = 25,             -- 5..300 s
  greenTrigger = 'both',     -- 'both' | 'auto' | 'manual'
  autoGreenAt = 'line',      -- 'line' | 'zone'
  allowP1Green = 0,          -- 0 | 1
  limiterMode = 'limiter',   -- 'limiter' | 'hard' | 'off'
  paceKmh = 90,              -- 40..180
  catchupKmh = 35,           -- 0..100
  fastKmh = 160,             -- phase 1 : vitesse max (km/h) 40..200
  fastPct = 75,              -- phase 1 : % du tour 25..100
  slowKmh = 80,              -- phase 2 : regroupement (km/h) 30..150
  bunchM = 80,               -- seuil de regroupement (m) 20..300
  speedTolKmh = 6,           -- 1..30
  targetGapM = 16,           -- 6..60
  rowAlignTolM = 8,          -- 2..25
  laneTolNorm = 0.18,        -- 0.05..0.50
  oneToGoSpline = 0.72,      -- 0.10..0.96
  accelZoneStart = 0.88,     -- 0.20..0.995
  greenLineSpline = 0.000,   -- 0.00..0.999
  penaltyMode = 'warn',      -- 'off' | 'warn' | 'slow' | 'drive'
  slowSec = 4,               -- 1..15
  driveLaps = 3,             -- 1..10
  launchGraceSec = 5,        -- 0..20
  maxFormationSec = 240,     -- 0..600
  hideHudWhenAppOpen = 1,    -- 0 | 1
  debug = 0,                 -- 0 | 1

  -- Jump-Start (Depart anticipe — arrete & lance)
  jumpEnabled = 1,           -- 0 | 1
  jumpStandingTolM = 0.8,    -- 0.2..3.0 m
  jumpStandingMaxKmh = 5,    -- 2..15 km/h
  jumpRollingCatch = 1,      -- 0 | 1
  jumpPenaltyType = 'drive_through', -- 'off'|'warn'|'slow_cut'|'drive_through'|'stop_and_go'|'teleport_pits'|'time_penalty'
  jumpStopGoSec = 10,        -- 3..60 s
  jumpServeLaps = 3,         -- 1..10
  jumpEscPenalty = 'stop_and_go',    -- 'none'|'drive_through'|'stop_and_go'|'teleport_pits'|'black_flag'|'time_penalty'
  jumpEscStopGoSec = 10,     -- 3..60 s
  jumpTimePenaltySec = 15,   -- 5..180 s

  -- Track-Cut Penalties
  cutEnabled = 1,            -- 0 | 1
  cutEverySession = 0,       -- 0 | 1
  cutWheelsMin = 4,          -- 2..4
  cutUseKunosInvalid = 0,    -- 0 | 1
  cutMinDurationSec = 0.35,  -- 0.1..2.0 s
  cutMinSpeedKmh = 45,       -- 10..120 km/h
  cutCooldownSec = 4,        -- 1..15 s
  cutMaxBeforePenalty = 3,   -- 0..15 (3 = avertissements 1..3, penalite au 4e)
  cutRepeatEvery = 0,        -- 0 = meme quota, 1..10 = ensuite tous les N cuts
  cutPenaltyType = 'drive_through',  -- 'warn'|'slow_cut'|'drive_through'|'stop_and_go'|'teleport_pits'|'time_penalty'
  cutStopGoSec = 10,         -- 3..60 s
  cutSlowSec = 5,            -- 1..15 s
  cutServeLaps = 3,          -- 1..10
  cutEscPenalty = 'stop_and_go',     -- 'none'|'drive_through'|'stop_and_go'|'teleport_pits'|'black_flag'|'time_penalty'
  cutEscStopGoSec = 10,      -- 3..60 s
  cutFinishTimeSec = 20,     -- 5..180 s (si dernier tour ou non effectue a l'arrivee)
  cutTimePenaltySec = 10,    -- 2..120 s (si time_penalty direct ou 2e pena)
  cutDisabledZones = '',     -- ex: '0.145-0.195,0.610-0.640'

  -- Safety Car & Peloton Cuts visibility
  scFallback = 'admin',      -- 'admin' | 'p1' | 'off' (si aucune Safety Car en piste)
  safetyCarKey = 'safety',   -- Mots-cles voiture/pilote Safety Car (ex: 'safety,[SC]')
}

M.PRESETS = {
  {
    id = 'gt_2x2_full',
    label = '2x2 Tour Complet + Stewards (GT / Proto)',
    values = {
      enabled = 1,
      formationMode = '2x2',
      poleSide = 'left',
      startLength = 'full',
      formationLaps = 1,
      greenTrigger = 'both',
      autoGreenAt = 'line',
      limiterMode = 'limiter',
      paceKmh = 90,
      catchupKmh = 35,
      speedTolKmh = 6,
      targetGapM = 16,
      rowAlignTolM = 8,
      penaltyMode = 'warn',
      jumpEnabled = 1,
      jumpPenaltyType = 'drive_through',
      cutEnabled = 1,
      cutMaxBeforePenalty = 3,
      cutPenaltyType = 'drive_through',
      cutServeLaps = 3,
      cutEscPenalty = 'stop_and_go',
    }
  },
  {
    id = 'standing_steward',
    label = 'Depart Arrete + Faux Depart & Cuts',
    values = {
      enabled = 0,
      jumpEnabled = 1,
      jumpPenaltyType = 'drive_through',
      jumpServeLaps = 3,
      jumpEscPenalty = 'stop_and_go',
      jumpTimePenaltySec = 15,
      cutEnabled = 1,
      cutMaxBeforePenalty = 3,
      cutPenaltyType = 'drive_through',
      cutServeLaps = 3,
      cutEscPenalty = 'stop_and_go',
      cutFinishTimeSec = 20,
    }
  },
  {
    id = 'file_1x1_full',
    label = '1x1 File Indienne — Tour Complet',
    values = {
      enabled = 1,
      formationMode = '1x1',
      startLength = 'full',
      formationLaps = 1,
      greenTrigger = 'both',
      autoGreenAt = 'line',
      limiterMode = 'limiter',
      paceKmh = 95,
      catchupKmh = 35,
      targetGapM = 18,
      penaltyMode = 'warn',
      jumpEnabled = 1,
      jumpPenaltyType = 'stop_and_go',
      jumpStopGoSec = 10,
      cutEnabled = 1,
      cutMaxBeforePenalty = 3,
      cutPenaltyType = 'drive_through',
    }
  },
  {
    id = 'sprint_2x2_short',
    label = '2x2 Depart Court (450 m / Sprint)',
    values = {
      enabled = 1,
      formationMode = '2x2',
      poleSide = 'left',
      startLength = 'short',
      shortMode = 'distance',
      shortDistanceM = 450,
      greenTrigger = 'both',
      autoGreenAt = 'line',
      limiterMode = 'limiter',
      paceKmh = 80,
      catchupKmh = 30,
      targetGapM = 16,
      penaltyMode = 'warn',
      cutEnabled = 1,
      cutMaxBeforePenalty = 2,
      cutPenaltyType = 'drive_through',
      cutServeLaps = 2,
    }
  },
  {
    id = 'manual_rc',
    label = '2x2 Controle Race Control Manuel + Stop&Go',
    values = {
      enabled = 1,
      formationMode = '2x2',
      startLength = 'full',
      formationLaps = 1,
      greenTrigger = 'manual',
      allowP1Green = 1,
      limiterMode = 'limiter',
      paceKmh = 85,
      penaltyMode = 'drive',
      cutEnabled = 1,
      cutMaxBeforePenalty = 3,
      cutPenaltyType = 'stop_and_go',
      cutStopGoSec = 10,
      cutEscPenalty = 'black_flag',
    }
  }
}

function M.frac(x)
  return x - math.floor(x)
end

function M.clamp(x, a, b)
  if x < a then return a end
  if x > b then return b end
  return x
end

function M.wrapSigned(d)
  return d - math.floor(d + 0.5)
end

function M.forwardArc(fromS, toS)
  return M.frac(toS - fromS)
end

function M.sanitizeCutZones(raw)
  if type(raw) ~= 'string' or raw == '' then return '' end
  local out = {}
  for tok in raw:gmatch('[^,;]+') do
    local sStr, eStr = tok:match('^%s*(%d+%.?%d*)%s*%-%s*(%d+%.?%d*)%s*$')
    if sStr and eStr then
      local s = M.clamp(tonumber(sStr) or 0, 0, 0.999)
      local e = M.clamp(tonumber(eStr) or 0, 0, 0.999)
      out[#out + 1] = string.format('%.3f-%.3f', s, e)
      if #out >= 6 then break end
    end
  end
  local joined = table.concat(out, ',')
  if #joined > 78 then
    joined = joined:sub(1, 78):gsub(',[^,]*$', '')
  end
  return joined
end

function M.parseCutZones(raw)
  local list = {}
  if type(raw) ~= 'string' or raw == '' then return list end
  for tok in raw:gmatch('[^,;]+') do
    local sStr, eStr = tok:match('^%s*(%d+%.?%d*)%s*%-%s*(%d+%.?%d*)%s*$')
    if sStr and eStr then
      list[#list + 1] = {
        sStart = M.clamp(tonumber(sStr) or 0, 0, 0.999),
        sEnd = M.clamp(tonumber(eStr) or 0, 0, 0.999),
      }
    end
  end
  return list
end

function M.isSplineInZones(s, zones)
  if not zones or #zones == 0 then return false end
  local sp = M.frac(tonumber(s) or 0)
  for i = 1, #zones do
    local z = zones[i]
    if z.sStart <= z.sEnd then
      if sp >= z.sStart and sp <= z.sEnd then return true end
    else
      if sp >= z.sStart or sp <= z.sEnd then return true end
    end
  end
  return false
end

function M.copyCfg(src)
  local dst = {}
  for k, v in pairs(M.CFG_DEFAULTS) do
    local sv = src and src[k]
    if sv ~= nil then
      if type(v) == 'number' then
        dst[k] = tonumber(sv) or v
      else
        dst[k] = tostring(sv)
      end
    else
      dst[k] = v
    end
  end
  return M.sanitizeCfg(dst)
end

local function normChoice(val, allowed, fallback)
  local s = tostring(val or ''):lower()
  for _, item in ipairs(allowed) do
    if s == item then return item end
  end
  return fallback
end

local JUMP_PEN_CHOICES = { 'off', 'warn', 'slow_cut', 'drive_through', 'stop_and_go', 'teleport_pits', 'time_penalty' }
local CUT_PEN_CHOICES = { 'warn', 'slow_cut', 'drive_through', 'stop_and_go', 'teleport_pits', 'time_penalty' }
local ESC_PEN_CHOICES = { 'none', 'drive_through', 'stop_and_go', 'teleport_pits', 'black_flag', 'time_penalty' }
local SC_FALLBACK_CHOICES = { 'admin', 'p1', 'off' }

function M.sanitizeCfg(cfg)
  cfg.enabled = (tonumber(cfg.enabled) or 1) ~= 0 and 1 or 0
  cfg.everySession = (tonumber(cfg.everySession) or 0) ~= 0 and 1 or 0
  cfg.formationMode = normChoice(cfg.formationMode, { '1x1', '2x2' }, '2x2')
  cfg.poleSide = normChoice(cfg.poleSide, { 'left', 'right' }, 'left')
  cfg.startLength = normChoice(cfg.startLength, { 'full', 'short' }, 'full')
  cfg.formationLaps = math.floor(M.clamp(tonumber(cfg.formationLaps) or 1, 1, 5) + 0.5)
  cfg.shortMode = normChoice(cfg.shortMode, { 'distance', 'spline', 'timer' }, 'distance')
  cfg.shortDistanceM = math.floor(M.clamp(tonumber(cfg.shortDistanceM) or 450, 80, 5000) + 0.5)
  cfg.shortGreenSpline = M.clamp(tonumber(cfg.shortGreenSpline) or 0.18, 0.01, 0.98)
  cfg.shortSec = math.floor(M.clamp(tonumber(cfg.shortSec) or 25, 5, 300) + 0.5)
  cfg.greenTrigger = normChoice(cfg.greenTrigger, { 'both', 'auto', 'manual' }, 'both')
  cfg.autoGreenAt = normChoice(cfg.autoGreenAt, { 'line', 'zone' }, 'line')
  cfg.allowP1Green = (tonumber(cfg.allowP1Green) or 0) ~= 0 and 1 or 0
  cfg.limiterMode = normChoice(cfg.limiterMode, { 'limiter', 'hard', 'off' }, 'limiter')
  cfg.paceKmh = math.floor(M.clamp(tonumber(cfg.paceKmh) or 90, 40, 180) + 0.5)
  cfg.catchupKmh = math.floor(M.clamp(tonumber(cfg.catchupKmh) or 35, 0, 100) + 0.5)
  cfg.fastKmh = math.floor(M.clamp(tonumber(cfg.fastKmh) or 160, 40, 200) + 0.5)
  cfg.fastPct = math.floor(M.clamp(tonumber(cfg.fastPct) or 75, 25, 100) + 0.5)
  cfg.slowKmh = math.floor(M.clamp(tonumber(cfg.slowKmh) or 80, 30, 150) + 0.5)
  cfg.bunchM = math.floor(M.clamp(tonumber(cfg.bunchM) or 80, 20, 300) + 0.5)
  cfg.speedTolKmh = math.floor(M.clamp(tonumber(cfg.speedTolKmh) or 6, 1, 30) + 0.5)
  cfg.targetGapM = math.floor(M.clamp(tonumber(cfg.targetGapM) or 16, 6, 60) + 0.5)
  cfg.rowAlignTolM = math.floor(M.clamp(tonumber(cfg.rowAlignTolM) or 8, 2, 25) + 0.5)
  cfg.laneTolNorm = M.clamp(tonumber(cfg.laneTolNorm) or 0.18, 0.05, 0.50)
  cfg.oneToGoSpline = M.clamp(tonumber(cfg.oneToGoSpline) or 0.72, 0.10, 0.96)
  cfg.accelZoneStart = M.clamp(tonumber(cfg.accelZoneStart) or 0.88, 0.20, 0.995)
  cfg.greenLineSpline = M.frac(tonumber(cfg.greenLineSpline) or 0.000)
  cfg.penaltyMode = normChoice(cfg.penaltyMode, { 'off', 'warn', 'slow', 'drive' }, 'warn')
  cfg.slowSec = math.floor(M.clamp(tonumber(cfg.slowSec) or 4, 1, 15) + 0.5)
  cfg.driveLaps = math.floor(M.clamp(tonumber(cfg.driveLaps) or 3, 1, 10) + 0.5)
  cfg.launchGraceSec = math.floor(M.clamp(tonumber(cfg.launchGraceSec) or 5, 0, 20) + 0.5)
  cfg.maxFormationSec = math.floor(M.clamp(tonumber(cfg.maxFormationSec) or 240, 0, 600) + 0.5)
  cfg.hideHudWhenAppOpen = (tonumber(cfg.hideHudWhenAppOpen) or 1) ~= 0 and 1 or 0
  cfg.debug = (tonumber(cfg.debug) or 0) ~= 0 and 1 or 0

  -- Jump-start
  cfg.jumpEnabled = (tonumber(cfg.jumpEnabled) or 1) ~= 0 and 1 or 0
  cfg.jumpStandingTolM = math.floor(M.clamp(tonumber(cfg.jumpStandingTolM) or 0.8, 0.2, 3.0) * 10 + 0.5) / 10
  cfg.jumpStandingMaxKmh = math.floor(M.clamp(tonumber(cfg.jumpStandingMaxKmh) or 5, 2, 15) + 0.5)
  cfg.jumpRollingCatch = (tonumber(cfg.jumpRollingCatch) or 1) ~= 0 and 1 or 0
  cfg.jumpPenaltyType = normChoice(cfg.jumpPenaltyType, JUMP_PEN_CHOICES, 'drive_through')
  cfg.jumpStopGoSec = math.floor(M.clamp(tonumber(cfg.jumpStopGoSec) or 10, 3, 60) + 0.5)
  cfg.jumpServeLaps = math.floor(M.clamp(tonumber(cfg.jumpServeLaps) or 3, 1, 10) + 0.5)
  cfg.jumpEscPenalty = normChoice(cfg.jumpEscPenalty, ESC_PEN_CHOICES, 'stop_and_go')
  cfg.jumpEscStopGoSec = math.floor(M.clamp(tonumber(cfg.jumpEscStopGoSec) or 10, 3, 60) + 0.5)
  cfg.jumpTimePenaltySec = math.floor(M.clamp(tonumber(cfg.jumpTimePenaltySec) or 15, 5, 180) + 0.5)

  -- Track cuts
  cfg.cutEnabled = (tonumber(cfg.cutEnabled) or 1) ~= 0 and 1 or 0
  cfg.cutEverySession = (tonumber(cfg.cutEverySession) or 0) ~= 0 and 1 or 0
  cfg.cutWheelsMin = math.floor(M.clamp(tonumber(cfg.cutWheelsMin) or 4, 2, 4) + 0.5)
  cfg.cutUseKunosInvalid = (tonumber(cfg.cutUseKunosInvalid) or 0) ~= 0 and 1 or 0
  cfg.cutMinDurationSec = math.floor(M.clamp(tonumber(cfg.cutMinDurationSec) or 0.35, 0.1, 2.0) * 100 + 0.5) / 100
  cfg.cutMinSpeedKmh = math.floor(M.clamp(tonumber(cfg.cutMinSpeedKmh) or 45, 10, 120) + 0.5)
  cfg.cutCooldownSec = math.floor(M.clamp(tonumber(cfg.cutCooldownSec) or 4, 1, 15) + 0.5)
  cfg.cutMaxBeforePenalty = math.floor(M.clamp(tonumber(cfg.cutMaxBeforePenalty) or 3, 0, 15) + 0.5)
  cfg.cutRepeatEvery = math.floor(M.clamp(tonumber(cfg.cutRepeatEvery) or 0, 0, 10) + 0.5)
  cfg.cutPenaltyType = normChoice(cfg.cutPenaltyType, CUT_PEN_CHOICES, 'drive_through')
  cfg.cutStopGoSec = math.floor(M.clamp(tonumber(cfg.cutStopGoSec) or 10, 3, 60) + 0.5)
  cfg.cutSlowSec = math.floor(M.clamp(tonumber(cfg.cutSlowSec) or 5, 1, 15) + 0.5)
  cfg.cutServeLaps = math.floor(M.clamp(tonumber(cfg.cutServeLaps) or 3, 1, 10) + 0.5)
  cfg.cutEscPenalty = normChoice(cfg.cutEscPenalty, ESC_PEN_CHOICES, 'stop_and_go')
  cfg.cutEscStopGoSec = math.floor(M.clamp(tonumber(cfg.cutEscStopGoSec) or 10, 3, 60) + 0.5)
  cfg.cutFinishTimeSec = math.floor(M.clamp(tonumber(cfg.cutFinishTimeSec) or 20, 5, 180) + 0.5)
  cfg.cutTimePenaltySec = math.floor(M.clamp(tonumber(cfg.cutTimePenaltySec) or 10, 2, 120) + 0.5)
  cfg.cutDisabledZones = M.sanitizeCutZones(tostring(cfg.cutDisabledZones or ''))
  cfg.scFallback = normChoice(cfg.scFallback, SC_FALLBACK_CHOICES, 'admin')
  local sck = tostring(cfg.safetyCarKey or 'safety'):gsub('[%c"`]', ''):gsub('^%s+', ''):gsub('%s+$', '')
  if #sck > 23 then sck = sck:sub(1, 23) end
  cfg.safetyCarKey = (sck ~= '' and sck) or 'safety'

  return cfg
end

local function idxOf(list, val, defIdx)
  for i = 1, #list do
    if list[i] == val then return i - 1 end
  end
  return defIdx or 0
end

function M.escPenaltyToCode(val) return idxOf(ESC_PEN_CHOICES, val, 2) end
function M.codeToEscPenalty(code) return ESC_PEN_CHOICES[(tonumber(code) or 2) + 1] or 'stop_and_go' end
function M.scFallbackToCode(val) return idxOf(SC_FALLBACK_CHOICES, val, 0) end
function M.codeToScFallback(code) return SC_FALLBACK_CHOICES[(tonumber(code) or 0) + 1] or 'admin' end

function M.packCutEscAndFallback(cfg)
  return M.escPenaltyToCode(cfg.cutEscPenalty) + M.scFallbackToCode(cfg.scFallback) * 8
end

function M.unpackCutEscAndFallback(byteVal, cfg)
  local v = tonumber(byteVal) or 2
  cfg.cutEscPenalty = M.codeToEscPenalty(v % 8)
  cfg.scFallback = M.codeToScFallback(math.floor(v / 8) % 4)
end

function M.isSafetyCarMatch(carId, driverName, keyStr)
  local cid = tostring(carId or ''):lower()
  local dname = tostring(driverName or ''):lower()
  local merged = tostring(keyStr or 'safety'):lower() .. ',pace_car,pace car,[sc],race_control,steward'
  for tok in merged:gmatch('[^,;]+') do
    local t = tok:gsub('^%s+', ''):gsub('%s+$', '')
    if t ~= '' then
      if cid:find(t, 1, true) or dname:find(t, 1, true) then
        return true
      end
    end
  end
  return false
end

function M.resolvePelotonAccess(cfg, mySid, isAdmin, isOnlineRace, designatedSid, p1Sid, carsList)
  local meIsSC = false
  local anySC = false
  if carsList then
    for i = 1, #carsList do
      local item = carsList[i]
      if M.isSafetyCarMatch(item.carId, item.driverName, cfg.safetyCarKey) then
        anySC = true
        if item.sessionID == mySid then
          meIsSC = true
        end
      end
    end
  end
  if meIsSC then return true, 'SAFETY CAR', anySC end
  if designatedSid ~= nil and designatedSid == mySid then return true, 'COMMISSAIRE', anySC end
  if not isOnlineRace then return true, 'SOLO / ADMIN', anySC end
  if anySC then
    return false, nil, true
  end
  local fb = cfg.scFallback or 'admin'
  if fb == 'off' then
    return false, nil, false
  elseif fb == 'p1' then
    if isAdmin then return true, 'RACE CONTROL', false end
    if p1Sid ~= nil and mySid == p1Sid then return true, 'RELAIS P1', false end
  elseif fb == 'admin' and isAdmin then
    return true, 'RACE CONTROL', false
  end
  return false, nil, false
end

-- Pack Rolling Start flags into uint16 (pure arithmetic, Lua 5.1+ safe)
function M.packCfgFlags(cfg)
  local f = 0
  if cfg.enabled == 1 then f = f + 1 end
  if cfg.formationMode == '2x2' then f = f + 2 end
  if cfg.poleSide == 'right' then f = f + 4 end
  if cfg.startLength == 'short' then f = f + 8 end
  local sm = cfg.shortMode == 'spline' and 1 or (cfg.shortMode == 'timer' and 2 or 0)
  f = f + sm * 16
  local gt = cfg.greenTrigger == 'auto' and 1 or (cfg.greenTrigger == 'manual' and 2 or 0)
  f = f + gt * 64
  if cfg.autoGreenAt == 'zone' then f = f + 256 end
  local lm = cfg.limiterMode == 'hard' and 1 or (cfg.limiterMode == 'off' and 2 or 0)
  f = f + lm * 512
  local pm = cfg.penaltyMode == 'warn' and 1 or (cfg.penaltyMode == 'slow' and 2 or (cfg.penaltyMode == 'drive' and 3 or 0))
  f = f + pm * 2048
  if cfg.allowP1Green == 1 then f = f + 8192 end
  if cfg.everySession == 1 then f = f + 16384 end
  return f
end

function M.unpackCfgFlags(f, base)
  local cfg = M.copyCfg(base)
  local function bitOn(v, p) return math.floor(v / p) % 2 == 1 end
  local function twoBits(v, p) return math.floor(v / p) % 4 end
  cfg.enabled = bitOn(f, 1) and 1 or 0
  cfg.formationMode = bitOn(f, 2) and '2x2' or '1x1'
  cfg.poleSide = bitOn(f, 4) and 'right' or 'left'
  cfg.startLength = bitOn(f, 8) and 'short' or 'full'
  local sm = twoBits(f, 16)
  cfg.shortMode = sm == 1 and 'spline' or (sm == 2 and 'timer' or 'distance')
  local gt = twoBits(f, 64)
  cfg.greenTrigger = gt == 1 and 'auto' or (gt == 2 and 'manual' or 'both')
  cfg.autoGreenAt = bitOn(f, 256) and 'zone' or 'line'
  local lm = twoBits(f, 512)
  cfg.limiterMode = lm == 1 and 'hard' or (lm == 2 and 'off' or 'limiter')
  local pm = twoBits(f, 2048)
  cfg.penaltyMode = pm == 1 and 'warn' or (pm == 2 and 'slow' or (pm == 3 and 'drive' or 'off'))
  cfg.allowP1Green = bitOn(f, 8192) and 1 or 0
  cfg.everySession = bitOn(f, 16384) and 1 or 0
  return M.sanitizeCfg(cfg)
end

-- Pack Jump-Start + Track-Cut enums/flags into uint16
function M.packCfgFlags2(cfg)
  local f = 0
  if cfg.jumpEnabled == 1 then f = f + 1 end
  if cfg.jumpRollingCatch == 1 then f = f + 2 end
  f = f + idxOf(JUMP_PEN_CHOICES, cfg.jumpPenaltyType, 3) * 4       -- bits 2..4 (0..6)
  f = f + idxOf(ESC_PEN_CHOICES, cfg.jumpEscPenalty, 2) * 32       -- bits 5..7 (0..5)
  if cfg.cutEnabled == 1 then f = f + 256 end                      -- bit 8
  if cfg.cutEverySession == 1 then f = f + 512 end                 -- bit 9
  if cfg.cutUseKunosInvalid == 1 then f = f + 1024 end             -- bit 10
  local wm = M.clamp((tonumber(cfg.cutWheelsMin) or 4) - 2, 0, 2)  -- 0=2w,1=3w,2=4w
  f = f + wm * 2048                                                -- bits 11..12
  f = f + idxOf(CUT_PEN_CHOICES, cfg.cutPenaltyType, 2) * 8192     -- bits 13..15 (0..5)
  return f
end

function M.unpackCfgFlags2(f, base)
  local cfg = M.copyCfg(base)
  local function bitOn(v, p) return math.floor(v / p) % 2 == 1 end
  local function bits(v, p, m) return math.floor(v / p) % m end
  cfg.jumpEnabled = bitOn(f, 1) and 1 or 0
  cfg.jumpRollingCatch = bitOn(f, 2) and 1 or 0
  cfg.jumpPenaltyType = JUMP_PEN_CHOICES[bits(f, 4, 8) + 1] or 'drive_through'
  cfg.jumpEscPenalty = ESC_PEN_CHOICES[bits(f, 32, 8) + 1] or 'stop_and_go'
  cfg.cutEnabled = bitOn(f, 256) and 1 or 0
  cfg.cutEverySession = bitOn(f, 512) and 1 or 0
  cfg.cutUseKunosInvalid = bitOn(f, 1024) and 1 or 0
  cfg.cutWheelsMin = bits(f, 2048, 4) + 2
  cfg.cutPenaltyType = CUT_PEN_CHOICES[bits(f, 8192, 8) + 1] or 'drive_through'
  return M.sanitizeCfg(cfg)
end

-- Encode order array (sessionIDs 0..254) as comma-separated string for bridge IPC
function M.encodeOrder(order)
  if not order or #order == 0 then return '' end
  local t = {}
  for i = 1, math.min(#order, M.ORDER_MAX) do
    t[i] = tostring(order[i])
  end
  return table.concat(t, ',')
end

function M.decodeOrder(str)
  local order = {}
  if type(str) ~= 'string' or str == '' then return order end
  for tok in str:gmatch('%d+') do
    order[#order + 1] = tonumber(tok)
    if #order >= M.ORDER_MAX then break end
  end
  return order
end

-- Decode steward CSV: "sid:cuts:penKind:penReason:lapsLeft:holdLeft:timeAddedSec:dq:raceTimeMs;..."
function M.decodeStewardCsv(str)
  local map = {}
  if type(str) ~= 'string' or str == '' then return map end
  for row in str:gmatch('[^;]+') do
    local parts = {}
    for p in row:gmatch('[^:]+') do parts[#parts + 1] = tonumber(p) or 0 end
    if #parts >= 8 then
      local sid = parts[1]
      map[sid] = {
        sessionId = sid,
        cuts = parts[2],
        penKind = parts[3],
        penReason = parts[4],
        lapsLeft = parts[5],
        holdLeft = parts[6],
        timeAddedSec = parts[7],
        dq = parts[8] == 1,
        raceTimeMs = parts[9] or 0,
      }
    end
  end
  return map
end

-- Formation target calculation: given 1-based grid slot index and configuration,
-- returns row (1..), lane ('center' | 'left' | 'right'), targetNormX, slotOffsetM.
function M.slotAssignment(slotIdx, cfg)
  if cfg.formationMode == '1x1' then
    return slotIdx, 'center', 0, (slotIdx - 1) * cfg.targetGapM
  end
  local row = math.floor((slotIdx - 1) / 2) + 1
  local isOdd = (slotIdx % 2 == 1)
  local poleLeft = (cfg.poleSide ~= 'right')
  local onLeft = (isOdd and poleLeft) or ((not isOdd) and (not poleLeft))
  local lane = onLeft and 'left' or 'right'
  local normX = onLeft and -0.42 or 0.42
  local offsetM = (row - 1) * cfg.targetGapM
  return row, lane, normX, offsetM
end

function M.computeTargetDistanceM(s0, cfg, trackLenM)
  local L = (trackLenM and trackLenM > 50) and trackLenM or 1000
  if cfg.startLength == 'short' then
    if cfg.shortMode == 'distance' then
      return cfg.shortDistanceM
    elseif cfg.shortMode == 'spline' then
      local arc = M.forwardArc(s0, cfg.shortGreenSpline)
      if arc < 0.02 then arc = arc + 1 end
      return arc * L
    else
      return (cfg.paceKmh / 3.6) * cfg.shortSec
    end
  end
  local rawArc = M.forwardArc(s0, cfg.greenLineSpline)
  if rawArc < 0.15 then
    return (rawArc + cfg.formationLaps) * L
  end
  return (rawArc + (cfg.formationLaps - 1)) * L
end

function M.createBridgeLayout()
  return {
    ac.StructItem.key('gdsp.rs.bridge.v1'),
    scriptHeartbeat = ac.StructItem.double(),
    appHeartbeat = ac.StructItem.double(),
    appVisible = ac.StructItem.uint8(),
    hideBanner = ac.StructItem.uint8(),

    -- Authoritative state (Online Script -> App)
    seq = ac.StructItem.int32(),
    cfgSeq = ac.StructItem.int32(),
    phase = ac.StructItem.uint8(),
    reason = ac.StructItem.uint8(),
    tStart = ac.StructItem.int32(),
    s0 = ac.StructItem.float(),
    stateFlags = ac.StructItem.uint8(),
    orderCount = ac.StructItem.uint8(),
    orderCsv = ac.StructItem.string(192),

    -- Local car live telemetry (Online Script -> App)
    mySlot = ac.StructItem.uint8(),
    myRow = ac.StructItem.uint8(),
    myLane = ac.StructItem.uint8(),
    targetSessionId = ac.StructItem.int16(),
    partnerSessionId = ac.StructItem.int16(),
    slotDeltaM = ac.StructItem.float(),
    aheadGapM = ac.StructItem.float(),
    partnerDeltaM = ac.StructItem.float(),
    lateralNorm = ac.StructItem.float(),
    allowedKmh = ac.StructItem.float(),
    limiterCapKmh = ac.StructItem.float(),
    limiterActive = ac.StructItem.uint8(),
    inAccelZone = ac.StructItem.uint8(),
    distRemainingM = ac.StructItem.float(),
    strikes = ac.StructItem.uint8(),
    penOwed = ac.StructItem.uint8(),
    penDriving = ac.StructItem.uint8(),
    warnFlags = ac.StructItem.uint8(),
    onlineCount = ac.StructItem.uint8(),
    netSent = ac.StructItem.uint16(),
    netGot = ac.StructItem.uint16(),

    -- Live Jump-Start + Track-Cut + Penalty telemetry (Online Script -> App)
    cutsCount = ac.StructItem.uint16(),
    cutsQuota = ac.StructItem.uint8(),
    activePenKind = ac.StructItem.uint8(),
    activePenReason = ac.StructItem.uint8(),
    activePenLapsLeft = ac.StructItem.uint8(),
    activePenHoldLeft = ac.StructItem.float(),
    activePenEscalated = ac.StructItem.uint8(),
    totalTimePenaltySec = ac.StructItem.uint16(),
    jumpWarnFlag = ac.StructItem.uint8(),
    cutNoticeSeq = ac.StructItem.uint16(),
    disqualified = ac.StructItem.uint8(),
    canViewPeloton = ac.StructItem.uint8(),
    pelotonRole = ac.StructItem.string(20),
    stewardCsv = ac.StructItem.string(1200),

    -- Synced configuration (Online Script <-> App)
    cfgFlags = ac.StructItem.uint16(),
    cfgFlags2 = ac.StructItem.uint16(),
    cutEscCode = ac.StructItem.uint8(),
    paceKmh = ac.StructItem.uint8(),
    catchupKmh = ac.StructItem.uint8(),
    speedTolKmh = ac.StructItem.uint8(),
    targetGapM = ac.StructItem.uint8(),
    rowAlignTolM = ac.StructItem.uint8(),
    formationLaps = ac.StructItem.uint8(),
    shortDistanceM = ac.StructItem.uint16(),
    shortSec = ac.StructItem.uint16(),
    accelZoneStart = ac.StructItem.float(),
    greenLineSpline = ac.StructItem.float(),
    oneToGoSpline = ac.StructItem.float(),
    shortGreenSpline = ac.StructItem.float(),
    laneTolNorm = ac.StructItem.float(),
    slowSec = ac.StructItem.uint8(),
    driveLaps = ac.StructItem.uint8(),
    launchGraceSec = ac.StructItem.uint8(),
    maxFormationSec = ac.StructItem.uint16(),
    jumpStandingTolDm = ac.StructItem.uint8(),
    jumpStandingMaxKmh = ac.StructItem.uint8(),
    jumpStopGoSec = ac.StructItem.uint8(),
    jumpServeLaps = ac.StructItem.uint8(),
    jumpEscStopGoSec = ac.StructItem.uint8(),
    jumpTimePenaltySec = ac.StructItem.uint8(),
    cutMinDurationDs = ac.StructItem.uint8(),
    cutMinSpeedKmh = ac.StructItem.uint8(),
    cutCooldownSec = ac.StructItem.uint8(),
    cutMaxBeforePenalty = ac.StructItem.uint8(),
    cutRepeatEvery = ac.StructItem.uint8(),
    cutStopGoSec = ac.StructItem.uint8(),
    cutSlowSec = ac.StructItem.uint8(),
    cutServeLaps = ac.StructItem.uint8(),
    cutEscStopGoSec = ac.StructItem.uint8(),
    cutFinishTimeSec = ac.StructItem.uint16(),
    cutTimePenaltySec = ac.StructItem.uint8(),
    cutDisabledZones = ac.StructItem.string(80),
    safetyCarKey = ac.StructItem.string(24),
    fastKmh = ac.StructItem.uint8(),
    fastPct = ac.StructItem.uint8(),
    slowKmh = ac.StructItem.uint8(),
    bunchM = ac.StructItem.uint8(),

    -- Command channel (App -> Online Script)
    cmdSeq = ac.StructItem.int32(),
    cmdType = ac.StructItem.uint8(),
    cmdAction = ac.StructItem.uint8(),
    cmdTargetSid = ac.StructItem.uint8(),
    cmdParam = ac.StructItem.uint16(),
    cmdCfgFlags = ac.StructItem.uint16(),
    cmdCfgFlags2 = ac.StructItem.uint16(),
    cmdCutEscCode = ac.StructItem.uint8(),
    cmdPaceKmh = ac.StructItem.uint8(),
    cmdCatchupKmh = ac.StructItem.uint8(),
    cmdSpeedTolKmh = ac.StructItem.uint8(),
    cmdTargetGapM = ac.StructItem.uint8(),
    cmdRowAlignTolM = ac.StructItem.uint8(),
    cmdFormationLaps = ac.StructItem.uint8(),
    cmdShortDistanceM = ac.StructItem.uint16(),
    cmdShortSec = ac.StructItem.uint16(),
    cmdAccelZoneStart = ac.StructItem.float(),
    cmdGreenLineSpline = ac.StructItem.float(),
    cmdOneToGoSpline = ac.StructItem.float(),
    cmdShortGreenSpline = ac.StructItem.float(),
    cmdLaneTolNorm = ac.StructItem.float(),
    cmdSlowSec = ac.StructItem.uint8(),
    cmdDriveLaps = ac.StructItem.uint8(),
    cmdLaunchGraceSec = ac.StructItem.uint8(),
    cmdMaxFormationSec = ac.StructItem.uint16(),
    cmdJumpStandingTolDm = ac.StructItem.uint8(),
    cmdJumpStandingMaxKmh = ac.StructItem.uint8(),
    cmdJumpStopGoSec = ac.StructItem.uint8(),
    cmdJumpServeLaps = ac.StructItem.uint8(),
    cmdJumpEscStopGoSec = ac.StructItem.uint8(),
    cmdJumpTimePenaltySec = ac.StructItem.uint8(),
    cmdCutMinDurationDs = ac.StructItem.uint8(),
    cmdCutMinSpeedKmh = ac.StructItem.uint8(),
    cmdCutCooldownSec = ac.StructItem.uint8(),
    cmdCutMaxBeforePenalty = ac.StructItem.uint8(),
    cmdCutRepeatEvery = ac.StructItem.uint8(),
    cmdCutStopGoSec = ac.StructItem.uint8(),
    cmdCutSlowSec = ac.StructItem.uint8(),
    cmdCutServeLaps = ac.StructItem.uint8(),
    cmdCutEscStopGoSec = ac.StructItem.uint8(),
    cmdCutFinishTimeSec = ac.StructItem.uint16(),
    cmdCutTimePenaltySec = ac.StructItem.uint8(),
    cmdCutDisabledZones = ac.StructItem.string(80),
    cmdSafetyCarKey = ac.StructItem.string(24),
    cmdFastKmh = ac.StructItem.uint8(),
    cmdFastPct = ac.StructItem.uint8(),
    cmdSlowKmh = ac.StructItem.uint8(),
    cmdBunchM = ac.StructItem.uint8(),
  }
end

function M.writeCfgToBridge(b, cfg, asCmd)
  local flags = M.packCfgFlags(cfg)
  local flags2 = M.packCfgFlags2(cfg)
  local escCode = M.packCutEscAndFallback(cfg)
  if asCmd then
    b.cmdCfgFlags = flags
    b.cmdCfgFlags2 = flags2
    b.cmdCutEscCode = escCode
    b.cmdPaceKmh = cfg.paceKmh
    b.cmdCatchupKmh = cfg.catchupKmh
    b.cmdFastKmh = cfg.fastKmh
    b.cmdFastPct = cfg.fastPct
    b.cmdSlowKmh = cfg.slowKmh
    b.cmdBunchM = cfg.bunchM
    b.cmdSpeedTolKmh = cfg.speedTolKmh
    b.cmdTargetGapM = cfg.targetGapM
    b.cmdRowAlignTolM = cfg.rowAlignTolM
    b.cmdFormationLaps = cfg.formationLaps
    b.cmdShortDistanceM = cfg.shortDistanceM
    b.cmdShortSec = cfg.shortSec
    b.cmdAccelZoneStart = cfg.accelZoneStart
    b.cmdGreenLineSpline = cfg.greenLineSpline
    b.cmdOneToGoSpline = cfg.oneToGoSpline
    b.cmdShortGreenSpline = cfg.shortGreenSpline
    b.cmdLaneTolNorm = cfg.laneTolNorm
    b.cmdSlowSec = cfg.slowSec
    b.cmdDriveLaps = cfg.driveLaps
    b.cmdLaunchGraceSec = cfg.launchGraceSec
    b.cmdMaxFormationSec = cfg.maxFormationSec
    b.cmdJumpStandingTolDm = math.floor(cfg.jumpStandingTolM * 10 + 0.5)
    b.cmdJumpStandingMaxKmh = cfg.jumpStandingMaxKmh
    b.cmdJumpStopGoSec = cfg.jumpStopGoSec
    b.cmdJumpServeLaps = cfg.jumpServeLaps
    b.cmdJumpEscStopGoSec = cfg.jumpEscStopGoSec
    b.cmdJumpTimePenaltySec = cfg.jumpTimePenaltySec
    b.cmdCutMinDurationDs = math.floor(cfg.cutMinDurationSec * 100 + 0.5)
    b.cmdCutMinSpeedKmh = cfg.cutMinSpeedKmh
    b.cmdCutCooldownSec = cfg.cutCooldownSec
    b.cmdCutMaxBeforePenalty = cfg.cutMaxBeforePenalty
    b.cmdCutRepeatEvery = cfg.cutRepeatEvery
    b.cmdCutStopGoSec = cfg.cutStopGoSec
    b.cmdCutSlowSec = cfg.cutSlowSec
    b.cmdCutServeLaps = cfg.cutServeLaps
    b.cmdCutEscStopGoSec = cfg.cutEscStopGoSec
    b.cmdCutFinishTimeSec = cfg.cutFinishTimeSec
    b.cmdCutTimePenaltySec = cfg.cutTimePenaltySec
    b.cmdCutDisabledZones = cfg.cutDisabledZones or ''
    b.cmdSafetyCarKey = cfg.safetyCarKey or 'safety'
  else
    b.cfgFlags = flags
    b.cfgFlags2 = flags2
    b.cutEscCode = escCode
    b.paceKmh = cfg.paceKmh
    b.catchupKmh = cfg.catchupKmh
    b.fastKmh = cfg.fastKmh
    b.fastPct = cfg.fastPct
    b.slowKmh = cfg.slowKmh
    b.bunchM = cfg.bunchM
    b.speedTolKmh = cfg.speedTolKmh
    b.targetGapM = cfg.targetGapM
    b.rowAlignTolM = cfg.rowAlignTolM
    b.formationLaps = cfg.formationLaps
    b.shortDistanceM = cfg.shortDistanceM
    b.shortSec = cfg.shortSec
    b.accelZoneStart = cfg.accelZoneStart
    b.greenLineSpline = cfg.greenLineSpline
    b.oneToGoSpline = cfg.oneToGoSpline
    b.shortGreenSpline = cfg.shortGreenSpline
    b.laneTolNorm = cfg.laneTolNorm
    b.slowSec = cfg.slowSec
    b.driveLaps = cfg.driveLaps
    b.launchGraceSec = cfg.launchGraceSec
    b.maxFormationSec = cfg.maxFormationSec
    b.jumpStandingTolDm = math.floor(cfg.jumpStandingTolM * 10 + 0.5)
    b.jumpStandingMaxKmh = cfg.jumpStandingMaxKmh
    b.jumpStopGoSec = cfg.jumpStopGoSec
    b.jumpServeLaps = cfg.jumpServeLaps
    b.jumpEscStopGoSec = cfg.jumpEscStopGoSec
    b.jumpTimePenaltySec = cfg.jumpTimePenaltySec
    b.cutMinDurationDs = math.floor(cfg.cutMinDurationSec * 100 + 0.5)
    b.cutMinSpeedKmh = cfg.cutMinSpeedKmh
    b.cutCooldownSec = cfg.cutCooldownSec
    b.cutMaxBeforePenalty = cfg.cutMaxBeforePenalty
    b.cutRepeatEvery = cfg.cutRepeatEvery
    b.cutStopGoSec = cfg.cutStopGoSec
    b.cutSlowSec = cfg.cutSlowSec
    b.cutServeLaps = cfg.cutServeLaps
    b.cutEscStopGoSec = cfg.cutEscStopGoSec
    b.cutFinishTimeSec = cfg.cutFinishTimeSec
    b.cutTimePenaltySec = cfg.cutTimePenaltySec
    b.cutDisabledZones = cfg.cutDisabledZones or ''
    b.safetyCarKey = cfg.safetyCarKey or 'safety'
  end
end

function M.readCfgFromBridge(b, fromCmd, base)
  local cfg = M.unpackCfgFlags(fromCmd and b.cmdCfgFlags or b.cfgFlags, base)
  cfg = M.unpackCfgFlags2(fromCmd and b.cmdCfgFlags2 or b.cfgFlags2, cfg)
  M.unpackCutEscAndFallback(fromCmd and b.cmdCutEscCode or b.cutEscCode, cfg)
  if fromCmd then
    cfg.paceKmh = b.cmdPaceKmh
    cfg.catchupKmh = b.cmdCatchupKmh
    cfg.fastKmh = b.cmdFastKmh
    cfg.fastPct = b.cmdFastPct
    cfg.slowKmh = b.cmdSlowKmh
    cfg.bunchM = b.cmdBunchM
    cfg.speedTolKmh = b.cmdSpeedTolKmh
    cfg.targetGapM = b.cmdTargetGapM
    cfg.rowAlignTolM = b.cmdRowAlignTolM
    cfg.formationLaps = b.cmdFormationLaps
    cfg.shortDistanceM = b.cmdShortDistanceM
    cfg.shortSec = b.cmdShortSec
    cfg.accelZoneStart = b.cmdAccelZoneStart
    cfg.greenLineSpline = b.cmdGreenLineSpline
    cfg.oneToGoSpline = b.cmdOneToGoSpline
    cfg.shortGreenSpline = b.cmdShortGreenSpline
    cfg.laneTolNorm = b.cmdLaneTolNorm
    cfg.slowSec = b.cmdSlowSec
    cfg.driveLaps = b.cmdDriveLaps
    cfg.launchGraceSec = b.cmdLaunchGraceSec
    cfg.maxFormationSec = b.cmdMaxFormationSec
    cfg.jumpStandingTolM = (b.cmdJumpStandingTolDm or 8) / 10
    cfg.jumpStandingMaxKmh = b.cmdJumpStandingMaxKmh
    cfg.jumpStopGoSec = b.cmdJumpStopGoSec
    cfg.jumpServeLaps = b.cmdJumpServeLaps
    cfg.jumpEscStopGoSec = b.cmdJumpEscStopGoSec
    cfg.jumpTimePenaltySec = b.cmdJumpTimePenaltySec
    cfg.cutMinDurationSec = (b.cmdCutMinDurationDs or 35) / 100
    cfg.cutMinSpeedKmh = b.cmdCutMinSpeedKmh
    cfg.cutCooldownSec = b.cmdCutCooldownSec
    cfg.cutMaxBeforePenalty = b.cmdCutMaxBeforePenalty
    cfg.cutRepeatEvery = b.cmdCutRepeatEvery
    cfg.cutStopGoSec = b.cmdCutStopGoSec
    cfg.cutSlowSec = b.cmdCutSlowSec
    cfg.cutServeLaps = b.cmdCutServeLaps
    cfg.cutEscStopGoSec = b.cmdCutEscStopGoSec
    cfg.cutFinishTimeSec = b.cmdCutFinishTimeSec
    cfg.cutTimePenaltySec = b.cmdCutTimePenaltySec
    cfg.cutDisabledZones = b.cmdCutDisabledZones or ''
    cfg.safetyCarKey = b.cmdSafetyCarKey or 'safety'
  else
    cfg.paceKmh = b.paceKmh
    cfg.catchupKmh = b.catchupKmh
    cfg.fastKmh = b.fastKmh
    cfg.fastPct = b.fastPct
    cfg.slowKmh = b.slowKmh
    cfg.bunchM = b.bunchM
    cfg.speedTolKmh = b.speedTolKmh
    cfg.targetGapM = b.targetGapM
    cfg.rowAlignTolM = b.rowAlignTolM
    cfg.formationLaps = b.formationLaps
    cfg.shortDistanceM = b.shortDistanceM
    cfg.shortSec = b.shortSec
    cfg.accelZoneStart = b.accelZoneStart
    cfg.greenLineSpline = b.greenLineSpline
    cfg.oneToGoSpline = b.oneToGoSpline
    cfg.shortGreenSpline = b.shortGreenSpline
    cfg.laneTolNorm = b.laneTolNorm
    cfg.slowSec = b.slowSec
    cfg.driveLaps = b.driveLaps
    cfg.launchGraceSec = b.launchGraceSec
    cfg.maxFormationSec = b.maxFormationSec
    cfg.jumpStandingTolM = (b.jumpStandingTolDm or 8) / 10
    cfg.jumpStandingMaxKmh = b.jumpStandingMaxKmh
    cfg.jumpStopGoSec = b.jumpStopGoSec
    cfg.jumpServeLaps = b.jumpServeLaps
    cfg.jumpEscStopGoSec = b.jumpEscStopGoSec
    cfg.jumpTimePenaltySec = b.jumpTimePenaltySec
    cfg.cutMinDurationSec = (b.cutMinDurationDs or 35) / 100
    cfg.cutMinSpeedKmh = b.cutMinSpeedKmh
    cfg.cutCooldownSec = b.cutCooldownSec
    cfg.cutMaxBeforePenalty = b.cutMaxBeforePenalty
    cfg.cutRepeatEvery = b.cutRepeatEvery
    cfg.cutStopGoSec = b.cutStopGoSec
    cfg.cutSlowSec = b.cutSlowSec
    cfg.cutServeLaps = b.cutServeLaps
    cfg.cutEscStopGoSec = b.cutEscStopGoSec
    cfg.cutFinishTimeSec = b.cutFinishTimeSec
    cfg.cutTimePenaltySec = b.cutTimePenaltySec
    cfg.cutDisabledZones = b.cutDisabledZones or ''
    cfg.safetyCarKey = b.safetyCarKey or 'safety'
  end
  return M.sanitizeCfg(cfg)
end

function M.formatIniSnippet(cfg, scriptUrl)
  local url = (scriptUrl and scriptUrl ~= '') and scriptUrl or 'https://YOUR_HOST/rolling-start/csp/rolling_start.lua'
  local lines = {
    '[SCRIPT_1]',
    "SCRIPT = '" .. url .. "'",
    'REQUIRED = 1',
    'enabled = ' .. tostring(cfg.enabled),
    'everySession = ' .. tostring(cfg.everySession),
    'formationMode = ' .. tostring(cfg.formationMode),
    'poleSide = ' .. tostring(cfg.poleSide),
    'startLength = ' .. tostring(cfg.startLength),
    'formationLaps = ' .. tostring(cfg.formationLaps),
    'shortMode = ' .. tostring(cfg.shortMode),
    'shortDistanceM = ' .. tostring(cfg.shortDistanceM),
    string.format('shortGreenSpline = %.3f', cfg.shortGreenSpline),
    'shortSec = ' .. tostring(cfg.shortSec),
    'greenTrigger = ' .. tostring(cfg.greenTrigger),
    'autoGreenAt = ' .. tostring(cfg.autoGreenAt),
    'allowP1Green = ' .. tostring(cfg.allowP1Green),
    'limiterMode = ' .. tostring(cfg.limiterMode),
    'paceKmh = ' .. tostring(cfg.paceKmh),
    'catchupKmh = ' .. tostring(cfg.catchupKmh),
    'speedTolKmh = ' .. tostring(cfg.speedTolKmh),
    'targetGapM = ' .. tostring(cfg.targetGapM),
    'rowAlignTolM = ' .. tostring(cfg.rowAlignTolM),
    string.format('laneTolNorm = %.2f', cfg.laneTolNorm),
    string.format('oneToGoSpline = %.2f', cfg.oneToGoSpline),
    string.format('accelZoneStart = %.2f', cfg.accelZoneStart),
    string.format('greenLineSpline = %.3f', cfg.greenLineSpline),
    'penaltyMode = ' .. tostring(cfg.penaltyMode),
    'slowSec = ' .. tostring(cfg.slowSec),
    'driveLaps = ' .. tostring(cfg.driveLaps),
    'launchGraceSec = ' .. tostring(cfg.launchGraceSec),
    'maxFormationSec = ' .. tostring(cfg.maxFormationSec),
    'jumpEnabled = ' .. tostring(cfg.jumpEnabled),
    string.format('jumpStandingTolM = %.1f', cfg.jumpStandingTolM),
    'jumpStandingMaxKmh = ' .. tostring(cfg.jumpStandingMaxKmh),
    'jumpRollingCatch = ' .. tostring(cfg.jumpRollingCatch),
    'jumpPenaltyType = ' .. tostring(cfg.jumpPenaltyType),
    'jumpStopGoSec = ' .. tostring(cfg.jumpStopGoSec),
    'jumpServeLaps = ' .. tostring(cfg.jumpServeLaps),
    'jumpEscPenalty = ' .. tostring(cfg.jumpEscPenalty),
    'jumpEscStopGoSec = ' .. tostring(cfg.jumpEscStopGoSec),
    'jumpTimePenaltySec = ' .. tostring(cfg.jumpTimePenaltySec),
    'cutEnabled = ' .. tostring(cfg.cutEnabled),
    'cutEverySession = ' .. tostring(cfg.cutEverySession),
    'cutWheelsMin = ' .. tostring(cfg.cutWheelsMin),
    'cutUseKunosInvalid = ' .. tostring(cfg.cutUseKunosInvalid),
    string.format('cutMinDurationSec = %.2f', cfg.cutMinDurationSec),
    'cutMinSpeedKmh = ' .. tostring(cfg.cutMinSpeedKmh),
    'cutCooldownSec = ' .. tostring(cfg.cutCooldownSec),
    'cutMaxBeforePenalty = ' .. tostring(cfg.cutMaxBeforePenalty),
    'cutRepeatEvery = ' .. tostring(cfg.cutRepeatEvery),
    'cutPenaltyType = ' .. tostring(cfg.cutPenaltyType),
    'cutStopGoSec = ' .. tostring(cfg.cutStopGoSec),
    'cutSlowSec = ' .. tostring(cfg.cutSlowSec),
    'cutServeLaps = ' .. tostring(cfg.cutServeLaps),
    'cutEscPenalty = ' .. tostring(cfg.cutEscPenalty),
    'cutEscStopGoSec = ' .. tostring(cfg.cutEscStopGoSec),
    'cutFinishTimeSec = ' .. tostring(cfg.cutFinishTimeSec),
    'cutTimePenaltySec = ' .. tostring(cfg.cutTimePenaltySec),
    'cutDisabledZones = ' .. tostring(cfg.cutDisabledZones or ''),
    'scFallback = ' .. tostring(cfg.scFallback or 'admin'),
    'safetyCarKey = ' .. tostring(cfg.safetyCarKey or 'safety'),
  }
  return table.concat(lines, '\n')
end

return M

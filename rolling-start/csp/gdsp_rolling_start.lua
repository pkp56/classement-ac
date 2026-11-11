-- GDSP Rolling Start & Race Control — CSP Online Script ([SCRIPT_1])
-- Self-contained single file for AssettoHosting / ACSM / AssettoServer / acServer.
-- Features:
--   * Toggleable Rolling Start (1x1 / 2x2, full or short, mechanical limiter, dual Green triggers)
--   * Standing Start support (enabled=0) while keeping Stewards active
--   * Jump-Start detection & configurable penalties (both Standing & Rolling starts)
--   * Track-Cut penalty engine: configurable cuts before penalty, per-corner enable/disable zones,
--     Drive-Through or Stop & Go (real stationary hold), X-lap serve window -> 2nd penalty,
--     and automatic Last-Lap / Finish time added to total race time
--   * Network sync via ac.OnlineEvent (<=175B packets) + IPC bridge to GDSP_RollingStart CM App

local VERSION = 'GDSP-RS 1.1.0'
local ORDER_MAX = 48
local NONE = 255
local SEND_INTERVAL = 0.25

local PHASE_IDLE = 0
local PHASE_FORMATION = 1
local PHASE_READY = 2
local PHASE_GREEN = 3
local PHASE_CAUTION = 4

local REASON_NONE = 0
local REASON_LIGHTS = 1
local REASON_ADMIN = 2
local REASON_CAUTION = 3
local REASON_AUTO = 4

local CMD_NONE = 0
local CMD_START = 1
local CMD_READY = 2
local CMD_GREEN = 3
local CMD_CAUTION = 4
local CMD_RESET = 5
local CMD_APPLY_CFG = 6
local CMD_CLEAR_PENALTY = 7
local CMD_ADMIN_ACTION = 8

local ACT_CLEAR_ONE = 1
local ACT_CLEAR_ALL = 2
local ACT_RESET_CUTS = 3
local ACT_GIVE_DT = 4
local ACT_GIVE_SG = 5
local ACT_ADD_TIME = 6
local ACT_SET_STEWARD = 7

local ROLE_NONE = 0
local ROLE_SAFETY_CAR = 1
local ROLE_ADMIN = 2
local ROLE_P1 = 3
local ROLE_STEWARD = 4

local PEN_NONE = 0
local PEN_DRIVE_THROUGH = 1
local PEN_STOP_AND_GO = 2
local PEN_TELEPORT_PITS = 3
local PEN_BLACK_FLAG = 4
local PEN_SLOW_CUT = 5
local PEN_TIME_ONLY = 6

local PEN_REASON_NONE = 0
local PEN_REASON_CUT = 1
local PEN_REASON_JUMP = 2
local PEN_REASON_FORMATION = 3
local PEN_REASON_ESCALATED = 4
local PEN_REASON_ADMIN = 5

local CFG_DEFAULTS = {
  enabled = 1,
  autoFormation = 0,
  everySession = 0,
  formationMode = '2x2',
  poleSide = 'left',
  startLength = 'full',
  formationLaps = 1,
  shortMode = 'distance',
  shortDistanceM = 450,
  shortGreenSpline = 0.18,
  shortSec = 25,
  greenTrigger = 'both',
  autoGreenAt = 'line',
  allowP1Green = 0,
  limiterMode = 'limiter',
  paceKmh = 90,
  catchupKmh = 35,
  fastKmh = 160,      -- phase 1 : vitesse max (km/h)
  fastPct = 75,       -- phase 1 : longueur en % du tour
  slowKmh = 80,       -- phase 2 : vitesse de regroupement (km/h)
  bunchM = 80,        -- ecart max leader -> dernier pour considerer le groupe regroupe (m)
  speedTolKmh = 6,
  targetGapM = 16,
  rowAlignTolM = 8,
  laneTolNorm = 0.18,
  oneToGoSpline = 0.72,
  accelZoneStart = 0.88,
  greenLineSpline = 0.000,
  penaltyMode = 'warn',
  slowSec = 4,
  driveLaps = 3,
  launchGraceSec = 5,
  maxFormationSec = 240,
  hideHudWhenAppOpen = 1,
  debug = 0,

  jumpEnabled = 1,
  jumpStandingTolM = 0.8,
  jumpStandingMaxKmh = 5,
  jumpRollingCatch = 1,
  jumpPenaltyType = 'drive_through',
  jumpStopGoSec = 10,
  jumpServeLaps = 3,
  jumpEscPenalty = 'stop_and_go',
  jumpEscStopGoSec = 10,
  jumpTimePenaltySec = 15,

  cutEnabled = 1,
  cutEverySession = 0,
  cutWheelsMin = 4,
  cutUseKunosInvalid = 0,
  cutMinDurationSec = 0.35,
  cutMinSpeedKmh = 45,
  cutCooldownSec = 4,
  cutMaxBeforePenalty = 3,
  cutRepeatEvery = 0,
  cutPenaltyType = 'drive_through',
  cutStopGoSec = 10,
  cutSlowSec = 5,
  cutServeLaps = 3,
  cutEscPenalty = 'stop_and_go',
  cutEscStopGoSec = 10,
  cutFinishTimeSec = 20,
  cutTimePenaltySec = 10,
  cutDisabledZones = '',
  scFallback = 'admin',
  safetyCarKey = 'safety',
}

-- Placeholder replaced optionally by HTTP script server if query params are used
local QUERY_OVERRIDES = nil -- __GDSP_QUERY_OVERRIDES__

local function frac(x) return x - math.floor(x) end
local function clamp(x, a, b)
  if x < a then return a end
  if x > b then return b end
  return x
end
local function wrapSigned(d) return d - math.floor(d + 0.5) end
local function forwardArc(fromS, toS) return frac(toS - fromS) end

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

local function sanitizeSafetyCarKey(raw)
  local s = tostring(raw or 'safety'):gsub('^%s+', ''):gsub('%s+$', '')
  if s == '' then s = 'safety' end
  if #s > 23 then s = s:sub(1, 23) end
  return s
end

local function sanitizeCutZones(raw)
  if type(raw) ~= 'string' or raw == '' then return '' end
  local out = {}
  for tok in raw:gmatch('[^,;]+') do
    local sStr, eStr = tok:match('^%s*(%d+%.?%d*)%s*%-%s*(%d+%.?%d*)%s*$')
    if sStr and eStr then
      local s = clamp(tonumber(sStr) or 0, 0, 0.999)
      local e = clamp(tonumber(eStr) or 0, 0, 0.999)
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

local function parseCutZones(raw)
  local list = {}
  if type(raw) ~= 'string' or raw == '' then return list end
  for tok in raw:gmatch('[^,;]+') do
    local sStr, eStr = tok:match('^%s*(%d+%.?%d*)%s*%-%s*(%d+%.?%d*)%s*$')
    if sStr and eStr then
      list[#list + 1] = {
        sStart = clamp(tonumber(sStr) or 0, 0, 0.999),
        sEnd = clamp(tonumber(eStr) or 0, 0, 0.999),
      }
    end
  end
  return list
end

local function isSplineInZones(s, zones)
  if not zones or #zones == 0 then return false end
  local sp = frac(tonumber(s) or 0)
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

local function sanitizeCfg(cfg)
  cfg.enabled = (tonumber(cfg.enabled) or 1) ~= 0 and 1 or 0
  cfg.autoFormation = (tonumber(cfg.autoFormation) or 0) ~= 0 and 1 or 0
  cfg.everySession = (tonumber(cfg.everySession) or 0) ~= 0 and 1 or 0
  cfg.formationMode = normChoice(cfg.formationMode, { '1x1', '2x2' }, '2x2')
  cfg.poleSide = normChoice(cfg.poleSide, { 'left', 'right' }, 'left')
  cfg.startLength = normChoice(cfg.startLength, { 'full', 'short' }, 'full')
  cfg.formationLaps = math.floor(clamp(tonumber(cfg.formationLaps) or 1, 1, 5) + 0.5)
  cfg.shortMode = normChoice(cfg.shortMode, { 'distance', 'spline', 'timer' }, 'distance')
  cfg.shortDistanceM = math.floor(clamp(tonumber(cfg.shortDistanceM) or 450, 80, 5000) + 0.5)
  cfg.shortGreenSpline = clamp(tonumber(cfg.shortGreenSpline) or 0.18, 0.01, 0.98)
  cfg.shortSec = math.floor(clamp(tonumber(cfg.shortSec) or 25, 5, 300) + 0.5)
  cfg.greenTrigger = normChoice(cfg.greenTrigger, { 'both', 'auto', 'manual' }, 'both')
  cfg.autoGreenAt = normChoice(cfg.autoGreenAt, { 'line', 'zone' }, 'line')
  cfg.allowP1Green = (tonumber(cfg.allowP1Green) or 0) ~= 0 and 1 or 0
  cfg.limiterMode = normChoice(cfg.limiterMode, { 'limiter', 'hard', 'off' }, 'limiter')
  cfg.paceKmh = math.floor(clamp(tonumber(cfg.paceKmh) or 90, 40, 180) + 0.5)
  cfg.catchupKmh = math.floor(clamp(tonumber(cfg.catchupKmh) or 35, 0, 100) + 0.5)
  cfg.fastKmh = math.floor(clamp(tonumber(cfg.fastKmh) or 160, 40, 200) + 0.5)
  cfg.fastPct = math.floor(clamp(tonumber(cfg.fastPct) or 75, 25, 100) + 0.5)
  cfg.slowKmh = math.floor(clamp(tonumber(cfg.slowKmh) or 80, 30, 150) + 0.5)
  cfg.bunchM = math.floor(clamp(tonumber(cfg.bunchM) or 80, 20, 300) + 0.5)
  cfg.speedTolKmh = math.floor(clamp(tonumber(cfg.speedTolKmh) or 6, 1, 30) + 0.5)
  cfg.targetGapM = math.floor(clamp(tonumber(cfg.targetGapM) or 16, 6, 60) + 0.5)
  cfg.rowAlignTolM = math.floor(clamp(tonumber(cfg.rowAlignTolM) or 8, 2, 25) + 0.5)
  cfg.laneTolNorm = clamp(tonumber(cfg.laneTolNorm) or 0.18, 0.05, 0.50)
  cfg.oneToGoSpline = clamp(tonumber(cfg.oneToGoSpline) or 0.72, 0.10, 0.96)
  cfg.accelZoneStart = clamp(tonumber(cfg.accelZoneStart) or 0.88, 0.20, 0.995)
  cfg.greenLineSpline = frac(tonumber(cfg.greenLineSpline) or 0.000)
  cfg.penaltyMode = normChoice(cfg.penaltyMode, { 'off', 'warn', 'slow', 'drive' }, 'warn')
  cfg.slowSec = math.floor(clamp(tonumber(cfg.slowSec) or 4, 1, 15) + 0.5)
  cfg.driveLaps = math.floor(clamp(tonumber(cfg.driveLaps) or 3, 1, 10) + 0.5)
  cfg.launchGraceSec = math.floor(clamp(tonumber(cfg.launchGraceSec) or 5, 0, 20) + 0.5)
  cfg.maxFormationSec = math.floor(clamp(tonumber(cfg.maxFormationSec) or 240, 0, 600) + 0.5)
  cfg.hideHudWhenAppOpen = (tonumber(cfg.hideHudWhenAppOpen) or 1) ~= 0 and 1 or 0
  cfg.debug = (tonumber(cfg.debug) or 0) ~= 0 and 1 or 0

  cfg.jumpEnabled = (tonumber(cfg.jumpEnabled) or 1) ~= 0 and 1 or 0
  cfg.jumpStandingTolM = math.floor(clamp(tonumber(cfg.jumpStandingTolM) or 0.8, 0.2, 3.0) * 10 + 0.5) / 10
  cfg.jumpStandingMaxKmh = math.floor(clamp(tonumber(cfg.jumpStandingMaxKmh) or 5, 2, 15) + 0.5)
  cfg.jumpRollingCatch = (tonumber(cfg.jumpRollingCatch) or 1) ~= 0 and 1 or 0
  cfg.jumpPenaltyType = normChoice(cfg.jumpPenaltyType, JUMP_PEN_CHOICES, 'drive_through')
  cfg.jumpStopGoSec = math.floor(clamp(tonumber(cfg.jumpStopGoSec) or 10, 3, 60) + 0.5)
  cfg.jumpServeLaps = math.floor(clamp(tonumber(cfg.jumpServeLaps) or 3, 1, 10) + 0.5)
  cfg.jumpEscPenalty = normChoice(cfg.jumpEscPenalty, ESC_PEN_CHOICES, 'stop_and_go')
  cfg.jumpEscStopGoSec = math.floor(clamp(tonumber(cfg.jumpEscStopGoSec) or 10, 3, 60) + 0.5)
  cfg.jumpTimePenaltySec = math.floor(clamp(tonumber(cfg.jumpTimePenaltySec) or 15, 5, 180) + 0.5)

  cfg.cutEnabled = (tonumber(cfg.cutEnabled) or 1) ~= 0 and 1 or 0
  cfg.cutEverySession = (tonumber(cfg.cutEverySession) or 0) ~= 0 and 1 or 0
  cfg.cutWheelsMin = math.floor(clamp(tonumber(cfg.cutWheelsMin) or 4, 2, 4) + 0.5)
  cfg.cutUseKunosInvalid = (tonumber(cfg.cutUseKunosInvalid) or 0) ~= 0 and 1 or 0
  cfg.cutMinDurationSec = math.floor(clamp(tonumber(cfg.cutMinDurationSec) or 0.35, 0.1, 2.0) * 100 + 0.5) / 100
  cfg.cutMinSpeedKmh = math.floor(clamp(tonumber(cfg.cutMinSpeedKmh) or 45, 10, 120) + 0.5)
  cfg.cutCooldownSec = math.floor(clamp(tonumber(cfg.cutCooldownSec) or 4, 1, 15) + 0.5)
  cfg.cutMaxBeforePenalty = math.floor(clamp(tonumber(cfg.cutMaxBeforePenalty) or 3, 0, 15) + 0.5)
  cfg.cutRepeatEvery = math.floor(clamp(tonumber(cfg.cutRepeatEvery) or 0, 0, 10) + 0.5)
  cfg.cutPenaltyType = normChoice(cfg.cutPenaltyType, CUT_PEN_CHOICES, 'drive_through')
  cfg.cutStopGoSec = math.floor(clamp(tonumber(cfg.cutStopGoSec) or 10, 3, 60) + 0.5)
  cfg.cutSlowSec = math.floor(clamp(tonumber(cfg.cutSlowSec) or 5, 1, 15) + 0.5)
  cfg.cutServeLaps = math.floor(clamp(tonumber(cfg.cutServeLaps) or 3, 1, 10) + 0.5)
  cfg.cutEscPenalty = normChoice(cfg.cutEscPenalty, ESC_PEN_CHOICES, 'stop_and_go')
  cfg.cutEscStopGoSec = math.floor(clamp(tonumber(cfg.cutEscStopGoSec) or 10, 3, 60) + 0.5)
  cfg.cutFinishTimeSec = math.floor(clamp(tonumber(cfg.cutFinishTimeSec) or 20, 5, 180) + 0.5)
  cfg.cutTimePenaltySec = math.floor(clamp(tonumber(cfg.cutTimePenaltySec) or 10, 2, 120) + 0.5)
  cfg.cutDisabledZones = sanitizeCutZones(tostring(cfg.cutDisabledZones or ''))
  cfg.scFallback = normChoice(cfg.scFallback, SC_FALLBACK_CHOICES, 'admin')
  cfg.safetyCarKey = sanitizeSafetyCarKey(cfg.safetyCarKey)

  return cfg
end

local function copyCfg(src)
  local dst = {}
  for k, v in pairs(CFG_DEFAULTS) do
    local sv = src and src[k]
    if sv ~= nil then
      dst[k] = type(v) == 'number' and (tonumber(sv) or v) or tostring(sv)
    else
      dst[k] = v
    end
  end
  return sanitizeCfg(dst)
end

local function idxOf(list, val, defIdx)
  for i = 1, #list do
    if list[i] == val then return i - 1 end
  end
  return defIdx or 0
end

local function escPenaltyToCode(val) return idxOf(ESC_PEN_CHOICES, val, 2) end
local function codeToEscPenalty(code) return ESC_PEN_CHOICES[(tonumber(code) or 2) + 1] or 'stop_and_go' end

local function packCutEscAndFallback(c)
  local esc = escPenaltyToCode(c.cutEscPenalty)
  local fb = idxOf(SC_FALLBACK_CHOICES, c.scFallback, 0)
  return esc + fb * 8
end

local function unpackCutEscAndFallback(code)
  local v = tonumber(code) or 2
  local esc = codeToEscPenalty(v % 8)
  local fb = SC_FALLBACK_CHOICES[(math.floor(v / 8) % 4) + 1] or 'admin'
  return esc, fb
end

local function isSafetyCarMatch(carId, driverName, customKey)
  local cid = tostring(carId or ''):lower()
  local dname = tostring(driverName or ''):lower()
  local key = sanitizeSafetyCarKey(customKey):lower()
  local merged = key .. ',safety,pace_car,pace car,[sc],race_control,steward'
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

local function packCfgFlags(c)
  local f = 0
  if c.enabled == 1 then f = f + 1 end
  if c.formationMode == '2x2' then f = f + 2 end
  if c.poleSide == 'right' then f = f + 4 end
  if c.startLength == 'short' then f = f + 8 end
  local sm = c.shortMode == 'spline' and 1 or (c.shortMode == 'timer' and 2 or 0)
  f = f + sm * 16
  local gt = c.greenTrigger == 'auto' and 1 or (c.greenTrigger == 'manual' and 2 or 0)
  f = f + gt * 64
  if c.autoGreenAt == 'zone' then f = f + 256 end
  local lm = c.limiterMode == 'hard' and 1 or (c.limiterMode == 'off' and 2 or 0)
  f = f + lm * 512
  local pm = c.penaltyMode == 'warn' and 1 or (c.penaltyMode == 'slow' and 2 or (c.penaltyMode == 'drive' and 3 or 0))
  f = f + pm * 2048
  if c.allowP1Green == 1 then f = f + 8192 end
  if c.everySession == 1 then f = f + 16384 end
  return f
end

local function unpackCfgFlags(f, base)
  local c = copyCfg(base)
  local function bitOn(v, p) return math.floor(v / p) % 2 == 1 end
  local function twoBits(v, p) return math.floor(v / p) % 4 end
  c.enabled = bitOn(f, 1) and 1 or 0
  c.formationMode = bitOn(f, 2) and '2x2' or '1x1'
  c.poleSide = bitOn(f, 4) and 'right' or 'left'
  c.startLength = bitOn(f, 8) and 'short' or 'full'
  local sm = twoBits(f, 16)
  c.shortMode = sm == 1 and 'spline' or (sm == 2 and 'timer' or 'distance')
  local gt = twoBits(f, 64)
  c.greenTrigger = gt == 1 and 'auto' or (gt == 2 and 'manual' or 'both')
  c.autoGreenAt = bitOn(f, 256) and 'zone' or 'line'
  local lm = twoBits(f, 512)
  c.limiterMode = lm == 1 and 'hard' or (lm == 2 and 'off' or 'limiter')
  local pm = twoBits(f, 2048)
  c.penaltyMode = pm == 1 and 'warn' or (pm == 2 and 'slow' or (pm == 3 and 'drive' or 'off'))
  c.allowP1Green = bitOn(f, 8192) and 1 or 0
  c.everySession = bitOn(f, 16384) and 1 or 0
  return sanitizeCfg(c)
end

local function packCfgFlags2(c)
  local f = 0
  if c.jumpEnabled == 1 then f = f + 1 end
  if c.jumpRollingCatch == 1 then f = f + 2 end
  f = f + idxOf(JUMP_PEN_CHOICES, c.jumpPenaltyType, 3) * 4
  f = f + idxOf(ESC_PEN_CHOICES, c.jumpEscPenalty, 2) * 32
  if c.cutEnabled == 1 then f = f + 256 end
  if c.cutEverySession == 1 then f = f + 512 end
  if c.cutUseKunosInvalid == 1 then f = f + 1024 end
  local wm = clamp((tonumber(c.cutWheelsMin) or 4) - 2, 0, 2)
  f = f + wm * 2048
  f = f + idxOf(CUT_PEN_CHOICES, c.cutPenaltyType, 2) * 8192
  return f
end

local function unpackCfgFlags2(f, base)
  local c = copyCfg(base)
  local function bitOn(v, p) return math.floor(v / p) % 2 == 1 end
  local function bits(v, p, m) return math.floor(v / p) % m end
  c.jumpEnabled = bitOn(f, 1) and 1 or 0
  c.jumpRollingCatch = bitOn(f, 2) and 1 or 0
  c.jumpPenaltyType = JUMP_PEN_CHOICES[bits(f, 4, 8) + 1] or 'drive_through'
  c.jumpEscPenalty = ESC_PEN_CHOICES[bits(f, 32, 8) + 1] or 'stop_and_go'
  c.cutEnabled = bitOn(f, 256) and 1 or 0
  c.cutEverySession = bitOn(f, 512) and 1 or 0
  c.cutUseKunosInvalid = bitOn(f, 1024) and 1 or 0
  c.cutWheelsMin = bits(f, 2048, 4) + 2
  c.cutPenaltyType = CUT_PEN_CHOICES[bits(f, 8192, 8) + 1] or 'drive_through'
  return sanitizeCfg(c)
end

local function encodeOrder(order)
  if not order or #order == 0 then return '' end
  local t = {}
  for i = 1, math.min(#order, ORDER_MAX) do t[i] = tostring(order[i]) end
  return table.concat(t, ',')
end

local function slotAssignment(slotIdx, c)
  if c.formationMode == '1x1' then
    return slotIdx, 'center', 0, (slotIdx - 1) * c.targetGapM
  end
  local row = math.floor((slotIdx - 1) / 2) + 1
  local isOdd = (slotIdx % 2 == 1)
  local poleLeft = (c.poleSide ~= 'right')
  local onLeft = (isOdd and poleLeft) or ((not isOdd) and (not poleLeft))
  local lane = onLeft and 'left' or 'right'
  local normX = onLeft and -0.42 or 0.42
  return row, lane, normX, (row - 1) * c.targetGapM
end

local function computeTargetDistanceM(s0, c, trackLenM)
  local L = (trackLenM and trackLenM > 50) and trackLenM or 1000
  if c.startLength == 'short' then
    if c.shortMode == 'distance' then
      return c.shortDistanceM
    elseif c.shortMode == 'spline' then
      local arc = forwardArc(s0, c.shortGreenSpline)
      if arc < 0.02 then arc = arc + 1 end
      return arc * L
    else
      return (c.paceKmh / 3.6) * c.shortSec
    end
  end
  local rawArc = forwardArc(s0, c.greenLineSpline)
  if rawArc < 0.15 then
    return (rawArc + c.formationLaps) * L
  end
  return (rawArc + (c.formationLaps - 1)) * L
end

local function penKindToCode(kind)
  if kind == 'drive_through' then return PEN_DRIVE_THROUGH
  elseif kind == 'stop_and_go' then return PEN_STOP_AND_GO
  elseif kind == 'teleport_pits' then return PEN_TELEPORT_PITS
  elseif kind == 'black_flag' then return PEN_BLACK_FLAG
  elseif kind == 'slow_cut' then return PEN_SLOW_CUT
  elseif kind == 'time_penalty' then return PEN_TIME_ONLY
  end
  return PEN_NONE
end

-- ── Initialization ───────────────────────────────────────────────────────────
local sim = ac.getSim()
local okCfg, readCfg = pcall(ac.configValues, CFG_DEFAULTS)
local cfg = copyCfg(okCfg and readCfg or CFG_DEFAULTS)
if type(QUERY_OVERRIDES) == 'table' then
  for k, v in pairs(QUERY_OVERRIDES) do
    if CFG_DEFAULTS[k] ~= nil then cfg[k] = v end
  end
  cfg = sanitizeCfg(cfg)
end
local cutZones = parseCutZones(cfg.cutDisabledZones)

local RACE = ac.SessionType and ac.SessionType.Race or 3
local okBuild, build = pcall(ac.getPatchVersionCode)
build = okBuild and build or '?'

local function safeLog(msg)
  pcall(ac.log, '[GDSP-RS] ' .. tostring(msg))
end

local function trackLen()
  local l = sim and sim.trackLengthM
  return (l and l > 50) and l or 1000
end

local function clock()
  return (sim and sim.currentSessionTime) or 0
end

-- Safe sim field read: some CSP builds raise a hard error on unknown struct members
-- (e.g. 'state_sim' has no member named 'raceLaps'), which must never abort the script.
local function simField(name)
  local ok, v = pcall(function() return sim[name] end)
  if ok then return v end
  return nil
end

local function sessionType()
  local t = simField('raceSessionType')
  if t ~= nil then return t end
  local good, sess = pcall(ac.getSession, sim.currentSessionIndex)
  return good and sess and sess.type or nil
end

local function sessionTotalLaps()
  local rl = simField('raceLaps')
  if rl and rl > 0 then return rl end
  local good, sess = pcall(ac.getSession, sim and sim.currentSessionIndex or 0)
  if good and sess and sess.laps and sess.laps > 0 then return sess.laps end
  return 0
end

local function isRaceOrTestSession()
  return cfg.everySession == 1 or sessionType() == RACE
end

local function isRollingSessionActive()
  return cfg.enabled == 1 and isRaceOrTestSession()
end

local function isJumpSessionActive()
  return cfg.jumpEnabled == 1 and isRaceOrTestSession()
end

local function isCutSessionActive()
  return cfg.cutEnabled == 1 and (cfg.cutEverySession == 1 or isRaceOrTestSession())
end

local function isAnySystemActive()
  return isRollingSessionActive() or isJumpSessionActive() or isCutSessionActive()
end

local function canControl()
  if not sim.isOnlineRace then return true end
  return sim.isAdmin == true
end

local function activeCars()
  local m = {}
  local count = sim and sim.carsCount or 0
  for i = 0, count - 1 do
    local c = ac.getCar(i)
    if c and c.isConnected and c.isActive ~= false then
      m[c.sessionID] = c
    end
  end
  return m
end

-- ── Runtime State ────────────────────────────────────────────────────────────
local function freshState()
  return { seq = 0, from = NONE, phase = PHASE_IDLE, reason = REASON_NONE, tStart = 0, s0 = 0, flags = 0, order = {} }
end

local S = freshState()
local cfgSeq = 0
local adminActionSeq = 0
local lastSeenActionSeq = {}
local designatedStewardSid = nil

local function safeCarId(car)
  if not car then return '' end
  local okCid, cid = pcall(function() return ac.getCarID and ac.getCarID(car.index) or '' end)
  return okCid and tostring(cid or '') or ''
end

local function canViewPelotonCuts()
  local me = ac.getCar(0)
  local mySid = me and me.sessionID or -1
  local anySC, meIsSC = false, false
  local p1Sid = S.order and S.order[1] or nil
  local count = sim and sim.carsCount or 0
  for i = 0, count - 1 do
    local c = ac.getCar(i)
    if c and c.isConnected then
      if (p1Sid == nil) and (c.racePosition == 1) and not c.isRetired then
        p1Sid = c.sessionID
      end
      local dname = ac.getDriverName(c.index)
      if isSafetyCarMatch(safeCarId(c), dname, cfg.safetyCarKey) then
        anySC = true
        if c.sessionID == mySid then
          meIsSC = true
        end
      end
    end
  end

  if meIsSC then return true, ROLE_SAFETY_CAR, 'SAFETY CAR', anySC end
  if designatedStewardSid ~= nil and designatedStewardSid == mySid then return true, ROLE_STEWARD, 'COMMISSAIRE', anySC end
  if not (sim and sim.isOnlineRace) then return true, ROLE_ADMIN, 'SOLO / ADMIN', anySC end
  if anySC then
    return false, ROLE_NONE, nil, true
  end
  local fb = cfg.scFallback or 'admin'
  if fb == 'off' then
    return false, ROLE_NONE, nil, false
  elseif fb == 'p1' then
    if canControl() then return true, ROLE_ADMIN, 'RACE CONTROL', false end
    if p1Sid ~= nil and mySid == p1Sid then return true, ROLE_P1, 'RELAIS P1', false end
  elseif fb == 'admin' and canControl() then
    return true, ROLE_ADMIN, 'RACE CONTROL', false
  end
  return false, ROLE_NONE, nil, false
end
local uiTime = 0
local lastClock = 0
local lastSessionIdx = sim and sim.currentSessionIndex or -1
local lastError = nil
local debugOn = cfg.debug == 1
local greeted = false

local startWatch = {}
local standingWatch = {
  armed = false,
  anchorPos = nil,
  anchorSpline = 0,
  triggered = false,
  pendingApply = false,
  lightsOutAt = nil,
  rollingJumpT = 0,
  raceStarted = false,
}
local carTrackDist = {}
local localState = {
  mySlot = 0, myRow = 0, myLane = 0, targetId = -1, partnerId = -1,
  slotDeltaM = 0, aheadGapM = 999, partnerDeltaM = 0, lateralNorm = 0,
  allowedKmh = cfg.paceKmh, limiterCapKmh = cfg.paceKmh, limiterActive = false,
  inAccelZone = false, distRemainingM = 0, warnFlags = 0,
  speedT = 0, passT = 0, speedWarn = false, passWarn = false, lagWarn = false, laneWarn = false,
  targetName = nil, partnerName = nil,
  relBuf = nil, prevSlotSpline = nil,
}

local pen = {
  strikes = 0, last = {}, owed = false, driving = false, pitSeen = false, slowAt = -100, note = nil,
  -- Steward system (cuts + jump-start + pit penalties + finish time)
  cuts = 0,
  cutsSincePenalty = 0,
  hadCutPenalty = false,
  cutNoticeSeq = 0,
  queue = {},            -- penalites pit en attente (FIFO), aucune n'ecrase la penalite en cours
  active = nil,          -- { kind, reasonCode, issuedLap, deadlineLap, serveLaps, holdSec, holdElapsed, pitSeen, pitDistM, escKind, escHoldSec, finishTimeSec, escalated, lapsLeft }
  totalTimePenaltySec = 0,
  disqualified = false,
  jumpWarn = false,
  jumpQueuedRolling = false,
  servedFlashUntil = -10,
  cutWarnUntil = -10,
  raceElapsedMs = 0,
  raceStartClock = nil,
  finishedSynced = false,
}
local cutTrack = { offTime = 0, lastCutAt = -100, countedThisOff = false }
local lastOverrideFlag = -1
local stewardRecords = {}
local lastLapSeen = -1
local lastPenBroadcastAt = -10

local lastContact = -100
local pend = { key = nil, seq = -1, at = 0, last = 0 }
local presence = {}
local stats = { sent = 0, got = 0, stale = 0 }
local lastCmdSeqProcessed = 0
local outboxStateDirty = false
local outboxCfgDirty = false
local outboxPenDirty = false
local outboxAdminDirty = false
local pendingAdminPacket = nil
local lastSendAt = -10
local autoFormationIdleSince = nil

-- ── Shared Memory Bridge (Online Script <-> CM App) ──────────────────────────
local bridge = nil
do
  local ns = ac.SharedNamespace and ac.SharedNamespace.Shared or 'shared'
  local okB, b = pcall(ac.connect, {
    ac.StructItem.key('gdsp.rs.bridge.v1'),
    scriptHeartbeat = ac.StructItem.double(),
    appHeartbeat = ac.StructItem.double(),
    appVisible = ac.StructItem.uint8(),
    hideBanner = ac.StructItem.uint8(),

    seq = ac.StructItem.int32(),
    cfgSeq = ac.StructItem.int32(),
    phase = ac.StructItem.uint8(),
    reason = ac.StructItem.uint8(),
    tStart = ac.StructItem.int32(),
    s0 = ac.StructItem.float(),
    stateFlags = ac.StructItem.uint8(),
    orderCount = ac.StructItem.uint8(),
    orderCsv = ac.StructItem.string(192),

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
  }, true, ns)
  if okB and b then
    bridge = b
    lastCmdSeqProcessed = b.cmdSeq or 0
  end
end

local function writeCfgToBridge(c)
  if not bridge then return end
  bridge.cfgFlags = packCfgFlags(c)
  bridge.cfgFlags2 = packCfgFlags2(c)
  bridge.cutEscCode = packCutEscAndFallback(c)
  bridge.paceKmh = c.paceKmh
  bridge.catchupKmh = c.catchupKmh
  bridge.fastKmh = c.fastKmh
  bridge.fastPct = c.fastPct
  bridge.slowKmh = c.slowKmh
  bridge.bunchM = c.bunchM
  bridge.speedTolKmh = c.speedTolKmh
  bridge.targetGapM = c.targetGapM
  bridge.rowAlignTolM = c.rowAlignTolM
  bridge.formationLaps = c.formationLaps
  bridge.shortDistanceM = c.shortDistanceM
  bridge.shortSec = c.shortSec
  bridge.accelZoneStart = c.accelZoneStart
  bridge.greenLineSpline = c.greenLineSpline
  bridge.oneToGoSpline = c.oneToGoSpline
  bridge.shortGreenSpline = c.shortGreenSpline
  bridge.laneTolNorm = c.laneTolNorm
  bridge.slowSec = c.slowSec
  bridge.driveLaps = c.driveLaps
  bridge.launchGraceSec = c.launchGraceSec
  bridge.maxFormationSec = c.maxFormationSec
  bridge.jumpStandingTolDm = math.floor(c.jumpStandingTolM * 10 + 0.5)
  bridge.jumpStandingMaxKmh = c.jumpStandingMaxKmh
  bridge.jumpStopGoSec = c.jumpStopGoSec
  bridge.jumpServeLaps = c.jumpServeLaps
  bridge.jumpEscStopGoSec = c.jumpEscStopGoSec
  bridge.jumpTimePenaltySec = c.jumpTimePenaltySec
  bridge.cutMinDurationDs = math.floor(c.cutMinDurationSec * 100 + 0.5)
  bridge.cutMinSpeedKmh = c.cutMinSpeedKmh
  bridge.cutCooldownSec = c.cutCooldownSec
  bridge.cutMaxBeforePenalty = c.cutMaxBeforePenalty
  bridge.cutRepeatEvery = c.cutRepeatEvery
  bridge.cutStopGoSec = c.cutStopGoSec
  bridge.cutSlowSec = c.cutSlowSec
  bridge.cutServeLaps = c.cutServeLaps
  bridge.cutEscStopGoSec = c.cutEscStopGoSec
  bridge.cutFinishTimeSec = c.cutFinishTimeSec
  bridge.cutTimePenaltySec = c.cutTimePenaltySec
  bridge.cutDisabledZones = c.cutDisabledZones or ''
  bridge.safetyCarKey = c.safetyCarKey or 'safety'
end

local function readCfgFromBridgeCmd()
  if not bridge then return nil end
  local c = unpackCfgFlags(bridge.cmdCfgFlags, cfg)
  c = unpackCfgFlags2(bridge.cmdCfgFlags2, c)
  c.cutEscPenalty, c.scFallback = unpackCutEscAndFallback(bridge.cmdCutEscCode)
  c.paceKmh = bridge.cmdPaceKmh
  c.catchupKmh = bridge.cmdCatchupKmh
  c.fastKmh = bridge.cmdFastKmh
  c.fastPct = bridge.cmdFastPct
  c.slowKmh = bridge.cmdSlowKmh
  c.bunchM = bridge.cmdBunchM
  c.speedTolKmh = bridge.cmdSpeedTolKmh
  c.targetGapM = bridge.cmdTargetGapM
  c.rowAlignTolM = bridge.cmdRowAlignTolM
  c.formationLaps = bridge.cmdFormationLaps
  c.shortDistanceM = bridge.cmdShortDistanceM
  c.shortSec = bridge.cmdShortSec
  c.accelZoneStart = bridge.cmdAccelZoneStart
  c.greenLineSpline = bridge.cmdGreenLineSpline
  c.oneToGoSpline = bridge.cmdOneToGoSpline
  c.shortGreenSpline = bridge.cmdShortGreenSpline
  c.laneTolNorm = bridge.cmdLaneTolNorm
  c.slowSec = bridge.cmdSlowSec
  c.driveLaps = bridge.cmdDriveLaps
  c.launchGraceSec = bridge.cmdLaunchGraceSec
  c.maxFormationSec = bridge.cmdMaxFormationSec
  c.jumpStandingTolM = (bridge.cmdJumpStandingTolDm or 8) / 10
  c.jumpStandingMaxKmh = bridge.cmdJumpStandingMaxKmh
  c.jumpStopGoSec = bridge.cmdJumpStopGoSec
  c.jumpServeLaps = bridge.cmdJumpServeLaps
  c.jumpEscStopGoSec = bridge.cmdJumpEscStopGoSec
  c.jumpTimePenaltySec = bridge.cmdJumpTimePenaltySec
  c.cutMinDurationSec = (bridge.cmdCutMinDurationDs or 35) / 100
  c.cutMinSpeedKmh = bridge.cmdCutMinSpeedKmh
  c.cutCooldownSec = bridge.cmdCutCooldownSec
  c.cutMaxBeforePenalty = bridge.cmdCutMaxBeforePenalty
  c.cutRepeatEvery = bridge.cmdCutRepeatEvery
  c.cutStopGoSec = bridge.cmdCutStopGoSec
  c.cutSlowSec = bridge.cmdCutSlowSec
  c.cutServeLaps = bridge.cmdCutServeLaps
  c.cutEscStopGoSec = bridge.cmdCutEscStopGoSec
  c.cutFinishTimeSec = bridge.cmdCutFinishTimeSec
  c.cutTimePenaltySec = bridge.cmdCutTimePenaltySec
  c.cutDisabledZones = bridge.cmdCutDisabledZones or ''
  c.safetyCarKey = bridge.cmdSafetyCarKey or 'safety'
  return sanitizeCfg(c)
end

-- ── Penalty Helpers & Steward Sync ───────────────────────────────────────────
local function setGamePenalty(kind, param)
  local good, err = pcall(function() physics.setCarPenalty(ac.PenaltyType[kind], param) end)
  if not good then safeLog('penalty ' .. kind .. ' unavailable: ' .. tostring(err)) end
  return good
end

local function clearNativeGamePenalty()
  pcall(function() physics.setCarPenalty(ac.PenaltyType.MandatoryPits, 0) end)
  pcall(function() physics.setCarPenalty(ac.PenaltyType.ReleaseBlackFlag, 0) end)
  pcall(function() physics.setCarPenalty(ac.PenaltyType.None, 0) end)
end

local function syncLocalStewardRecord(broadcastNow)
  local me = ac.getCar(0)
  if not me then return end
  local sid = me.sessionID
  local activeKind = pen.active and penKindToCode(pen.active.kind) or (pen.disqualified and PEN_BLACK_FLAG or PEN_NONE)
  local activeReason = pen.active and pen.active.reasonCode or PEN_REASON_NONE
  local lapsLeft = pen.active and math.max(0, pen.active.deadlineLap - (me.lapCount or 0)) or 0
  local holdLeft = (pen.active and pen.active.kind == 'stop_and_go')
    and math.max(0, math.ceil(pen.active.holdSec - pen.active.holdElapsed))
    or 0
  local elapsedMs = pen.raceElapsedMs > 0 and pen.raceElapsedMs or (pen.raceStartClock and math.max(0, math.floor(clock() - pen.raceStartClock)) or 0)

  stewardRecords[sid] = {
    sessionId = sid,
    cuts = pen.cuts,
    penKind = activeKind,
    penReason = activeReason,
    lapsLeft = lapsLeft,
    holdLeft = holdLeft,
    timeAddedSec = pen.totalTimePenaltySec,
    dq = pen.disqualified,
    raceFinished = me.isRaceFinished == true,
    raceTimeMs = elapsedMs,
    updatedAt = uiTime,
  }
  if broadcastNow then
    outboxPenDirty = true
  end
end

local function buildStewardCsv()
  local rows = {}
  local keys = {}
  for sid in pairs(stewardRecords) do keys[#keys + 1] = sid end
  table.sort(keys)
  for i = 1, math.min(#keys, ORDER_MAX) do
    local r = stewardRecords[keys[i]]
    rows[#rows + 1] = string.format('%d:%d:%d:%d:%d:%d:%d:%d:%d',
      r.sessionId, r.cuts, r.penKind, r.penReason, r.lapsLeft, r.holdLeft,
      r.timeAddedSec, r.dq and 1 or 0, r.raceTimeMs or 0)
  end
  return table.concat(rows, ';')
end

local function isOnLastLap(me)
  if me and me.isRaceFinished then return true end
  local totalLaps = sessionTotalLaps()
  if totalLaps > 0 and (me and me.lapCount or 0) >= (totalLaps - 1) then return true end
  if simField('isTimedRace') and (simField('sessionTimeLeft') or 1) <= 0 then return true end
  return false
end

local function addTimePenalty(sec, why)
  local add = math.max(1, math.floor(tonumber(sec) or 0))
  pen.totalTimePenaltySec = pen.totalTimePenaltySec + add
  local title = string.format('PENALITE +%ds TEMPS DE COURSE', add)
  pen.note = { title = title, why = why, untilT = uiTime + 7 }
  pcall(ac.setMessage, title, why, 'illegal', 7)
  if sim and sim.isOnlineRace then
    local me = ac.getCar(0)
    local name = me and ac.getDriverName(me.index) or 'Pilote'
    pcall(ac.sendChatMessage, string.format('[Steward] %s : +%ds ajoutes au temps total (%s | Total pena: +%ds)',
      tostring(name), add, tostring(why), pen.totalTimePenaltySec))
  end
  safeLog(string.format('%s — %s (totalAdded=%ds)', title, tostring(why), pen.totalTimePenaltySec))
  syncLocalStewardRecord(true)
end

-- Active une penalite pit (DT / Stop&Go) comme penalite en cours
local function activatePitPenalty(kind, reasonCode, serveLaps, holdSec, escKind, escHoldSec, finishTimeSec, why)
  local me = ac.getCar(0)
  if not me then return end
  local curLap = me.lapCount or 0
  local lapsParam = (escKind == 'black_flag') and (serveLaps + 1) or (serveLaps + 2)
  setGamePenalty('MandatoryPits', lapsParam)

  pen.active = {
    kind = kind,
    reasonCode = reasonCode,
    issuedLap = curLap,
    deadlineLap = curLap + serveLaps,
    serveLaps = serveLaps,
    holdSec = (kind == 'stop_and_go') and holdSec or 0,
    holdElapsed = 0,
    pitSeen = false,
    pitDistM = 0,
    escKind = escKind,
    escHoldSec = escHoldSec,
    finishTimeSec = finishTimeSec,
    escalated = false,
    lapsLeft = serveLaps,
  }

  local title = (kind == 'stop_and_go')
    and string.format('STOP & GO %ds (DANS LES %d TOURS)', holdSec, serveLaps)
    or string.format('DRIVE-THROUGH (DANS LES %d TOURS)', serveLaps)
  pen.note = { title = title, why = why, untilT = uiTime + 7 }
  pcall(ac.setMessage, title, why, 'illegal', 7)
  safeLog(string.format('issued %s deadlineLap=%d (%s)', kind, pen.active.deadlineLap, why))
  syncLocalStewardRecord(true)
end

-- Penalites en attente non purgees (dernier tour / arrivee) : converties en temps
local function flushQueuedToTime(why)
  if not pen.queue or #pen.queue == 0 then return end
  local list = pen.queue
  pen.queue = {}
  for _, q in ipairs(list) do
    addTimePenalty(q.finishTimeSec, why)
  end
end

local function assignStewardPenalty(kind, reasonCode, serveLaps, holdSec, escKind, escHoldSec, finishTimeSec, directTimeSec, why)
  local me = ac.getCar(0)
  if not me or kind == 'off' then return end
  if kind == 'warn' then
    pen.note = { title = 'AVERTISSEMENT STEWARD', why = why, untilT = uiTime + 5 }
    pcall(ac.setMessage, 'AVERTISSEMENT STEWARD', why, 'illegal', 5)
    syncLocalStewardRecord(true)
    return
  end
  if kind == 'slow_cut' then
    local s = (reasonCode == PEN_REASON_CUT) and cfg.cutSlowSec or cfg.slowSec
    pcall(function() physics.forceUserThrottleFor(s, 0) end)
    local title = string.format('COUPURE GAZ %ds', s)
    pen.note = { title = title, why = why, untilT = uiTime + s + 1 }
    pcall(ac.setMessage, title, why, 'illegal', s + 1)
    syncLocalStewardRecord(true)
    return
  end
  if kind == 'time_penalty' then
    addTimePenalty(directTimeSec, why)
    return
  end
  if kind == 'teleport_pits' then
    setGamePenalty('TeleportToPits', holdSec)
    local title = string.format('RETOUR AUX STANDS (%ds)', holdSec)
    pen.note = { title = title, why = why, untilT = uiTime + 6 }
    pcall(ac.setMessage, title, why, 'illegal', 6)
    syncLocalStewardRecord(true)
    return
  end
  if kind == 'black_flag' then
    setGamePenalty('BlackFlag', 0)
    pen.disqualified = true
    pen.active = nil
    pen.queue = {}
    pen.note = { title = 'DRAPEAU NOIR — DISQUALIFIE', why = why, untilT = uiTime + 8 }
    pcall(ac.setMessage, 'DRAPEAU NOIR', why, 'illegal', 8)
    syncLocalStewardRecord(true)
    return
  end

  -- Drive-Through or Stop & Go
  if isOnLastLap(me) then
    addTimePenalty(finishTimeSec, why .. ' (dernier tour)')
    return
  end

  if pen.active then
    -- Une penalite est deja en cours : la nouvelle attend son tour (rien n'est ecrase)
    pen.queue = pen.queue or {}
    table.insert(pen.queue, {
      kind = kind, reasonCode = reasonCode, serveLaps = serveLaps, holdSec = holdSec,
      escKind = escKind, escHoldSec = escHoldSec, finishTimeSec = finishTimeSec, why = why,
    })
    if (tonumber(directTimeSec) or 0) > 0 then addTimePenalty(directTimeSec, why .. ' (en attente)') end
    pen.note = { title = 'PENALITE EN ATTENTE (' .. #pen.queue .. ')', why = why, untilT = uiTime + 6 }
    pcall(ac.setMessage, 'PENALITE EN ATTENTE', why, 'illegal', 6)
    safeLog(string.format('queued %s (%s) — %d en attente', kind, why, #pen.queue))
    syncLocalStewardRecord(true)
    return
  end

  activatePitPenalty(kind, reasonCode, serveLaps, holdSec, escKind, escHoldSec, finishTimeSec, why)
end

local function clearAllLocalPenalties(resetCuts)
  pen.strikes = 0
  pen.owed = false
  pen.driving = false
  pen.pitSeen = false
  pen.active = nil
  pen.queue = {}
  pen.disqualified = false
  pen.jumpWarn = false
  pen.jumpQueuedRolling = false
  pen.note = nil
  if resetCuts then
    pen.cuts = 0
    pen.cutsSincePenalty = 0
    pen.hadCutPenalty = false
    pen.totalTimePenaltySec = 0
  end
  clearNativeGamePenalty()
  local me = ac.getCar(0)
  if me then pcall(physics.forceUserThrottleFor, 0.001, me.gas) end
  syncLocalStewardRecord(true)
end

-- ── Online Events ────────────────────────────────────────────────────────────
local function adoptState(new)
  local phaseChanged = new.phase ~= S.phase or new.tStart ~= S.tStart
  if phaseChanged then
    local wasLimiting = (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION)
    if new.phase == PHASE_GREEN and wasLimiting then
      local me = ac.getCar(0)
      if me then pcall(physics.forceUserThrottleFor, 0.001, me.gas) end
      localState.limiterActive = false
    end
    if new.phase == PHASE_FORMATION or new.phase == PHASE_CAUTION then
      carTrackDist = {}
      localState.relBuf = nil
      localState.prevSlotSpline = nil
      localState.speedT, localState.passT = 0, 0
    end
    if new.phase == PHASE_FORMATION and S.phase ~= PHASE_FORMATION then
      pen.strikes = 0
      pen.last = {}
    end
  end
  if new.seq ~= S.seq or new.from ~= S.from then
    safeLog(string.format('state seq=%d from=%d phase=%d reason=%d cars=%d clock=%d',
      new.seq, new.from, new.phase, new.reason, #new.order, math.floor(clock())))
  end
  S = new
end

local function onStateEvent(sender, d)
  if not sender then return end
  local from = sender.sessionID
  stats.got = stats.got + 1
  if not presence[from] then
    presence[from] = true
    safeLog(string.format('online script active on car %d', from))
  end
  if d.seq == 0 then return end
  if d.seq < S.seq or (d.seq == S.seq and from >= S.from) then return end
  if d.tStart > clock() + 4000 then
    stats.stale = stats.stale + 1
    return
  end
  local order = {}
  local n = math.min(d.n or 0, ORDER_MAX)
  for i = 0, n - 1 do
    order[#order + 1] = d.order[i]
  end
  adoptState({
    seq = d.seq,
    from = from,
    phase = d.phase,
    reason = d.reason,
    tStart = d.tStart,
    s0 = d.s0,
    flags = d.flags,
    order = order,
  })
end

local function onCfgEvent(sender, d)
  if not sender then return end
  stats.got = stats.got + 1
  if d.cfgSeq <= cfgSeq then return end
  cfgSeq = d.cfgSeq
  local nc = unpackCfgFlags(d.flags, cfg)
  nc = unpackCfgFlags2(d.flags2 or 0, nc)
  nc.cutEscPenalty, nc.scFallback = unpackCutEscAndFallback(d.cutEscCode)
  nc.paceKmh = d.paceKmh
  nc.catchupKmh = d.catchupKmh
  nc.fastKmh = d.fastKmh
  nc.fastPct = d.fastPct
  nc.slowKmh = d.slowKmh
  nc.bunchM = d.bunchM
  nc.speedTolKmh = d.speedTolKmh
  nc.targetGapM = d.targetGapM
  nc.rowAlignTolM = d.rowAlignTolM
  nc.formationLaps = d.formationLaps
  nc.shortDistanceM = d.shortDistanceM
  nc.shortSec = d.shortSec
  nc.accelZoneStart = d.accelZoneStart
  nc.greenLineSpline = d.greenLineSpline
  nc.oneToGoSpline = d.oneToGoSpline
  nc.shortGreenSpline = d.shortGreenSpline
  nc.laneTolNorm = d.laneTolNorm
  nc.slowSec = d.slowSec
  nc.jumpStandingTolM = (d.jumpStandingTolDm or 8) / 10
  nc.jumpStandingMaxKmh = d.jumpStandingMaxKmh
  nc.jumpStopGoSec = d.jumpStopGoSec
  nc.jumpServeLaps = d.jumpServeLaps
  nc.jumpEscStopGoSec = d.jumpEscStopGoSec
  nc.jumpTimePenaltySec = d.jumpTimePenaltySec
  nc.cutMinDurationSec = (d.cutMinDurationDs or 35) / 100
  nc.cutMinSpeedKmh = d.cutMinSpeedKmh
  nc.cutCooldownSec = d.cutCooldownSec
  nc.cutMaxBeforePenalty = d.cutMaxBeforePenalty
  nc.cutRepeatEvery = d.cutRepeatEvery
  nc.cutStopGoSec = d.cutStopGoSec
  nc.cutSlowSec = d.cutSlowSec
  nc.cutServeLaps = d.cutServeLaps
  nc.cutEscStopGoSec = d.cutEscStopGoSec
  nc.cutFinishTimeSec = d.cutFinishTimeSec
  nc.cutTimePenaltySec = d.cutTimePenaltySec
  nc.cutDisabledZones = d.cutDisabledZones or ''
  nc.safetyCarKey = d.safetyCarKey or 'safety'

  cfg = sanitizeCfg(nc)
  cutZones = parseCutZones(cfg.cutDisabledZones)
  safeLog(string.format('config updated seq=%d start=%s cut=%d jump=%d zones=%s',
    cfgSeq, cfg.enabled == 1 and cfg.formationMode or 'standing', cfg.cutEnabled, cfg.jumpEnabled, cfg.cutDisabledZones))
end

local function onPenaltyEvent(sender, d)
  if not sender then return end
  stats.got = stats.got + 1
  local sid = d.sessionId
  if sid == nil or sid == NONE then return end
  stewardRecords[sid] = {
    sessionId = sid,
    cuts = d.cuts or 0,
    penKind = d.penKind or 0,
    penReason = d.penReason or 0,
    lapsLeft = d.lapsLeft or 0,
    holdLeft = d.holdSec or 0,
    timeAddedSec = d.timeAddedSec or 0,
    dq = ((d.flags or 0) % 2) == 1,
    raceFinished = (math.floor((d.flags or 0) / 4) % 2) == 1,
    raceTimeMs = d.raceTimeMs or 0,
    updatedAt = uiTime,
  }
end

local function executeAdminAction(action, targetSid, param)
  local me = ac.getCar(0)
  if not me then return end
  if action == ACT_SET_STEWARD then
    if targetSid == NONE or tonumber(param) == 0 then
      if designatedStewardSid == me.sessionID then
        pcall(ac.setMessage, 'COMMISSAIRE RETIRE', 'Acces Peloton Cuts ferme', 'info', 4)
      end
      designatedStewardSid = nil
    else
      designatedStewardSid = targetSid
      if me.sessionID == designatedStewardSid then
        pcall(ac.setMessage, 'COMMISSAIRE DESIGNE', 'Acces Peloton Cuts active sur votre HUD', 'info', 5)
      end
    end
    return
  end
  if targetSid ~= NONE and targetSid ~= me.sessionID then return end
  if action == ACT_CLEAR_ONE or action == ACT_CLEAR_ALL then
    clearAllLocalPenalties(false)
    pcall(ac.setMessage, 'PENALITE ANNULEE', 'Decision Direction de Course', 'info', 4)
  elseif action == ACT_RESET_CUTS then
    clearAllLocalPenalties(true)
    pcall(ac.setMessage, 'COMPTEUR CUTS REINITIALISE', 'Decision Direction de Course', 'info', 4)
  elseif action == ACT_GIVE_DT then
    local laps = math.max(1, tonumber(param) or cfg.cutServeLaps)
    assignStewardPenalty('drive_through', PEN_REASON_ADMIN, laps, 0, cfg.cutEscPenalty, cfg.cutEscStopGoSec, cfg.cutFinishTimeSec, cfg.cutTimePenaltySec, 'Sanction Direction de Course')
  elseif action == ACT_GIVE_SG then
    local sec = math.max(3, tonumber(param) or cfg.cutStopGoSec)
    assignStewardPenalty('stop_and_go', PEN_REASON_ADMIN, cfg.cutServeLaps, sec, cfg.cutEscPenalty, cfg.cutEscStopGoSec, cfg.cutFinishTimeSec, cfg.cutTimePenaltySec, 'Sanction Direction de Course')
  elseif action == ACT_ADD_TIME then
    local sec = math.max(1, tonumber(param) or cfg.cutTimePenaltySec)
    addTimePenalty(sec, 'Sanction Direction de Course')
  end
end

local function onAdminEvent(sender, d)
  if not sender then return end
  stats.got = stats.got + 1
  local from = sender.sessionID
  if (d.actionSeq or 0) <= (lastSeenActionSeq[from] or 0) then return end
  lastSeenActionSeq[from] = d.actionSeq
  executeAdminAction(d.action, d.targetSid, d.param)
end

local sendStateEvt, accessStateEvt
local sendCfgEvt, accessCfgEvt
local sendPenEvt, accessPenEvt
local sendAdminEvt, accessAdminEvt

do
  local ok1, s1, a1 = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('gdspRsS2'),
      seq = ac.StructItem.uint16(),
      tStart = ac.StructItem.int32(),
      s0 = ac.StructItem.float(),
      phase = ac.StructItem.uint8(),
      reason = ac.StructItem.uint8(),
      flags = ac.StructItem.uint8(),
      n = ac.StructItem.uint8(),
      order = ac.StructItem.array(ac.StructItem.uint8(), ORDER_MAX),
    }, onStateEvent)
  end)
  if ok1 then sendStateEvt, accessStateEvt = s1, a1 end

  local ok2, s2, a2 = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('gdspRsC2'),
      cfgSeq = ac.StructItem.uint16(),
      flags = ac.StructItem.uint16(),
      flags2 = ac.StructItem.uint16(),
      cutEscCode = ac.StructItem.uint8(),
      paceKmh = ac.StructItem.uint8(),
      catchupKmh = ac.StructItem.uint8(),
      speedTolKmh = ac.StructItem.uint8(),
      targetGapM = ac.StructItem.uint8(),
      rowAlignTolM = ac.StructItem.uint8(),
      formationLaps = ac.StructItem.uint8(),
      shortDistanceM = ac.StructItem.uint16(),
      shortSec = ac.StructItem.uint16(),
      accelZoneStart = ac.StructItem.unorm16(),
      greenLineSpline = ac.StructItem.unorm16(),
      oneToGoSpline = ac.StructItem.unorm16(),
      shortGreenSpline = ac.StructItem.unorm16(),
      laneTolNorm = ac.StructItem.unorm8(),
      slowSec = ac.StructItem.uint8(),
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
    }, onCfgEvent)
  end)
  if ok2 then sendCfgEvt, accessCfgEvt = s2, a2 end

  local ok3, s3, a3 = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('gdspRsP2'),
      sessionId = ac.StructItem.uint8(),
      cuts = ac.StructItem.uint16(),
      penKind = ac.StructItem.uint8(),
      penReason = ac.StructItem.uint8(),
      lapsLeft = ac.StructItem.uint8(),
      holdSec = ac.StructItem.uint8(),
      timeAddedSec = ac.StructItem.uint16(),
      flags = ac.StructItem.uint8(),
      raceTimeMs = ac.StructItem.int32(),
    }, onPenaltyEvent)
  end)
  if ok3 then sendPenEvt, accessPenEvt = s3, a3 end

  local ok4, s4, a4 = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('gdspRsA2'),
      actionSeq = ac.StructItem.uint16(),
      targetSid = ac.StructItem.uint8(),
      action = ac.StructItem.uint8(),
      param = ac.StructItem.uint16(),
    }, onAdminEvent)
  end)
  if ok4 then sendAdminEvt, accessAdminEvt = s4, a4 end
end

local function flushOutbox()
  if uiTime - lastSendAt < SEND_INTERVAL then return end
  if outboxCfgDirty and sendCfgEvt and accessCfgEvt then
    local p = accessCfgEvt()
    p.cfgSeq = cfgSeq
    p.flags = packCfgFlags(cfg)
    p.flags2 = packCfgFlags2(cfg)
    p.cutEscCode = packCutEscAndFallback(cfg)
    p.paceKmh = cfg.paceKmh
    p.catchupKmh = cfg.catchupKmh
    p.fastKmh = cfg.fastKmh
    p.fastPct = cfg.fastPct
    p.slowKmh = cfg.slowKmh
    p.bunchM = cfg.bunchM
    p.speedTolKmh = cfg.speedTolKmh
    p.targetGapM = cfg.targetGapM
    p.rowAlignTolM = cfg.rowAlignTolM
    p.formationLaps = cfg.formationLaps
    p.shortDistanceM = cfg.shortDistanceM
    p.shortSec = cfg.shortSec
    p.accelZoneStart = cfg.accelZoneStart
    p.greenLineSpline = cfg.greenLineSpline
    p.oneToGoSpline = cfg.oneToGoSpline
    p.shortGreenSpline = cfg.shortGreenSpline
    p.laneTolNorm = cfg.laneTolNorm
    p.slowSec = cfg.slowSec
    p.jumpStandingTolDm = math.floor(cfg.jumpStandingTolM * 10 + 0.5)
    p.jumpStandingMaxKmh = cfg.jumpStandingMaxKmh
    p.jumpStopGoSec = cfg.jumpStopGoSec
    p.jumpServeLaps = cfg.jumpServeLaps
    p.jumpEscStopGoSec = cfg.jumpEscStopGoSec
    p.jumpTimePenaltySec = cfg.jumpTimePenaltySec
    p.cutMinDurationDs = math.floor(cfg.cutMinDurationSec * 100 + 0.5)
    p.cutMinSpeedKmh = cfg.cutMinSpeedKmh
    p.cutCooldownSec = cfg.cutCooldownSec
    p.cutMaxBeforePenalty = cfg.cutMaxBeforePenalty
    p.cutRepeatEvery = cfg.cutRepeatEvery
    p.cutStopGoSec = cfg.cutStopGoSec
    p.cutSlowSec = cfg.cutSlowSec
    p.cutServeLaps = cfg.cutServeLaps
    p.cutEscStopGoSec = cfg.cutEscStopGoSec
    p.cutFinishTimeSec = cfg.cutFinishTimeSec
    p.cutTimePenaltySec = cfg.cutTimePenaltySec
    p.cutDisabledZones = cfg.cutDisabledZones or ''
    p.safetyCarKey = cfg.safetyCarKey or 'safety'
    if sendCfgEvt(nil, true) then
      outboxCfgDirty = false
      lastSendAt = uiTime
      stats.sent = stats.sent + 1
      return
    end
  end
  if outboxAdminDirty and pendingAdminPacket and sendAdminEvt and accessAdminEvt then
    local p = accessAdminEvt()
    p.actionSeq = pendingAdminPacket.actionSeq
    p.targetSid = pendingAdminPacket.targetSid
    p.action = pendingAdminPacket.action
    p.param = pendingAdminPacket.param
    if sendAdminEvt(nil, false) then
      outboxAdminDirty = false
      lastSendAt = uiTime
      stats.sent = stats.sent + 1
      return
    end
  end
  if outboxStateDirty and sendStateEvt and accessStateEvt then
    local p = accessStateEvt()
    p.seq = S.seq
    p.tStart = S.tStart
    p.s0 = S.s0
    p.phase = S.phase
    p.reason = S.reason
    p.flags = S.flags
    p.n = #S.order
    for i = 0, ORDER_MAX - 1 do
      p.order[i] = S.order[i + 1] or NONE
    end
    if sendStateEvt(nil, true) then
      outboxStateDirty = false
      lastSendAt = uiTime
      stats.sent = stats.sent + 1
      return
    end
  end
  if outboxPenDirty and sendPenEvt and accessPenEvt then
    local me = ac.getCar(0)
    local sid = me and me.sessionID or 0
    local r = stewardRecords[sid]
    if r then
      local p = accessPenEvt()
      p.sessionId = sid
      p.cuts = r.cuts
      p.penKind = r.penKind
      p.penReason = r.penReason
      p.lapsLeft = r.lapsLeft
      p.holdSec = r.holdLeft
      p.timeAddedSec = r.timeAddedSec
      p.flags = (r.dq and 1 or 0) + (r.raceFinished and 4 or 0)
      p.raceTimeMs = r.raceTimeMs
      if sendPenEvt(nil, false) then
        outboxPenDirty = false
        lastSendAt = uiTime
        lastPenBroadcastAt = uiTime
        stats.sent = stats.sent + 1
      end
    end
  end
end

local function commitState(phase, reason, tStart, s0, flags, order)
  local me = ac.getCar(0)
  local mySid = me and me.sessionID or 0
  adoptState({
    seq = S.seq + 1,
    from = mySid,
    phase = phase,
    reason = reason,
    tStart = math.floor(tStart),
    s0 = s0,
    flags = flags or 0,
    order = order or {},
  })
  outboxStateDirty = true
end

local function broadcastCfg(newCfg)
  cfg = sanitizeCfg(newCfg)
  cutZones = parseCutZones(cfg.cutDisabledZones)
  cfgSeq = cfgSeq + 1
  outboxCfgDirty = true
  writeCfgToBridge(cfg)
end

local function sendAdminAction(action, targetSid, param)
  adminActionSeq = adminActionSeq + 1
  local tgt = tonumber(targetSid) or NONE
  local prm = math.floor(tonumber(param) or 0)
  pendingAdminPacket = { actionSeq = adminActionSeq, targetSid = tgt, action = action, param = prm }
  outboxAdminDirty = true
  -- Also apply locally immediately if it targets us or all
  executeAdminAction(action, tgt, prm)
end

-- ── Grid / Formation Actions ─────────────────────────────────────────────────
local function sortGridOrder(cars)
  local list = {}
  for _, c in pairs(cars) do
    if not c.isInPitlane and not c.isRetired then
      list[#list + 1] = c
    end
  end
  table.sort(list, function(a, b)
    local pa, pb = a.racePosition or 0, b.racePosition or 0
    if pa > 0 and pb > 0 and pa ~= pb then return pa < pb end
    return frac(0.5 - a.splinePosition) < frac(0.5 - b.splinePosition)
  end)
  local order, s0 = {}, 0
  for i = 1, math.min(#list, ORDER_MAX) do
    order[i] = list[i].sessionID
  end
  if list[1] then s0 = list[1].splinePosition end
  return order, s0
end

local function startFormation(reason)
  local cars = activeCars()
  local order, s0 = sortGridOrder(cars)
  if #order == 0 then return false end
  commitState(PHASE_FORMATION, reason or REASON_ADMIN, clock(), s0, 0, order)
  return true
end

local function callReady()
  if S.phase == PHASE_FORMATION or S.phase == PHASE_CAUTION then
    commitState(PHASE_READY, S.reason, S.tStart, S.s0, S.flags, S.order)
  end
end

local function triggerGreen(reason)
  if S.phase == PHASE_IDLE then return end
  commitState(PHASE_GREEN, reason or REASON_NONE, clock(), S.s0, 0, S.order)
end

local function resetAll()
  S = freshState()
  startWatch = {}
  standingWatch = {
    armed = false, anchorPos = nil, anchorSpline = 0,
    triggered = false, pendingApply = false, lightsOutAt = nil,
    rollingJumpT = 0, raceStarted = false,
  }
  carTrackDist = {}
  pen = {
    strikes = 0, last = {}, owed = false, driving = false, pitSeen = false, slowAt = -100, note = nil,
    cuts = 0, cutsSincePenalty = 0, hadCutPenalty = false, cutNoticeSeq = 0,
    active = nil, totalTimePenaltySec = 0, disqualified = false,
    jumpWarn = false, jumpQueuedRolling = false, servedFlashUntil = -10, cutWarnUntil = -10,
    raceElapsedMs = 0, raceStartClock = nil, finishedSynced = false,
  }
  cutTrack = { offTime = 0, lastCutAt = -100, countedThisOff = false }
  stewardRecords = {}
  designatedStewardSid = nil
  lastLapSeen = -1
  if lastOverrideFlag ~= 0 then
    lastOverrideFlag = 0
    pcall(function() physics.overrideRacingFlag(ac.FlagType.None) end)
  end
  local me = ac.getCar(0)
  if me then pcall(physics.forceUserThrottleFor, 0.001, me.gas) end
  localState.limiterActive = false
  localState.inAccelZone = false
  greeted = false
  autoFormationIdleSince = nil
end

local function onSessionReset()
  resetAll()
  if isAnySystemActive() then
    safeLog('session reset')
  end
end
pcall(ac.onSessionStart, onSessionReset)

-- ── Continuous Distance & Pace Tracking ──────────────────────────────────────
local function paceDistM()
  return math.max(0, (clock() - S.tStart) / 1000) * (cfg.paceKmh / 3.6)
end

local function paceSpline()
  return frac(S.s0 + paceDistM() / trackLen())
end

-- Depart lance (startLength = full) :
--   1) 3/4 de tour a cfg.fastKmh, 2) cfg.slowKmh jusqu'au regroupement du groupe,
--   3) drapeau vert au passage de la ligne par le leader apres formationLaps passages.
-- (table unique : limite Lua de 200 variables locales au niveau principal)
local RS = {
  BUNCH_TIMEOUT_MS = 90000,  -- repli : passe en attente si le regroupement tarde
  stage = { tStart = nil, stage = 'fast', slowT = nil },
}

local function updateCarDistances(cars)
  local len = trackLen()
  for id, c in pairs(cars) do
    local tr = carTrackDist[id]
    if not tr then
      local initD = wrapSigned(c.splinePosition - S.s0) * len
      carTrackDist[id] = { lastS = c.splinePosition, distM = initD, cross = 0, crossT = S.tStart, crossedNow = false }
    else
      if tr.crossT ~= S.tStart then tr.crossT = S.tStart; tr.cross = 0 end
      tr.crossedNow = false
      local prevS = tr.lastS
      local ds = wrapSigned(c.splinePosition - tr.lastS) * len
      tr.distM = tr.distM + ds
      -- passage de ligne vers l'avant : la position repasse de ~1 a ~0
      if prevS > 0.75 and c.splinePosition < 0.25 then
        tr.cross = tr.cross + 1
        tr.crossedNow = true
      end
      tr.lastS = c.splinePosition
    end
  end
end

local function activeLeader(cars)
  for _, id in ipairs(S.order) do
    local c = cars[id]
    if c and not c.isInPitlane and not c.isRetired then
      return c, id
    end
  end
  return nil, nil
end

-- Palier courant du depart lance : 'fast' -> 'slow' -> 'wait'
local function fullFormationStage(cars)
  if RS.stage.tStart ~= S.tStart then
    RS.stage.tStart = S.tStart; RS.stage.stage = 'grid'; RS.stage.slowT = nil
  end
  -- grille : aucune limite tant que les feux ne sont pas eteints (ou que les voitures ne partent pas)
  if RS.stage.stage == 'grid' then
    local tts = sim.timeToSessionStart
    local moving = false
    for _, c in pairs(cars) do
      if c.speedKmh > 15 then moving = true; break end
    end
    if (tts and tts <= 0) or moving then
      RS.stage.stage = 'fast'
    end
  end
  if RS.stage.stage == 'fast' then
    local _, leadId = activeLeader(cars)
    local lt = leadId and carTrackDist[leadId]
    if lt and lt.distM >= (cfg.fastPct / 100) * trackLen() then
      RS.stage.stage = 'slow'; RS.stage.slowT = clock()
    end
  end
  if RS.stage.stage == 'slow' then
    local minD, maxD, n = nil, nil, 0
    for id, c in pairs(cars) do
      local tr = carTrackDist[id]
      if tr and not c.isInPitlane and not c.isRetired then
        n = n + 1
        if not minD or tr.distM < minD then minD = tr.distM end
        if not maxD or tr.distM > maxD then maxD = tr.distM end
      end
    end
    local bunched = n >= 1 and (maxD - minD) <= cfg.bunchM
    local timedOut = RS.stage.slowT and (clock() - RS.stage.slowT) >= RS.BUNCH_TIMEOUT_MS
    if bunched or timedOut then RS.stage.stage = 'wait' end
  end
  return RS.stage.stage
end


local function due(key, rank)
  if pend.key ~= key or pend.seq ~= S.seq or uiTime - pend.last > 0.5 then
    pend = { key = key, seq = S.seq, at = uiTime }
  end
  pend.last = uiTime
  return uiTime - pend.at >= rank * 0.35
end

-- ── Lateral Offset Helper ────────────────────────────────────────────────────
local function computeLateralNorm(c)
  local ok, val = pcall(function()
    local s = c.splinePosition
    local center = ac.trackCoordinateToWorld(vec3(0, 0, s))
    local rightEdge = ac.trackCoordinateToWorld(vec3(1, 0, s))
    local leftEdge = ac.trackCoordinateToWorld(vec3(-1, 0, s))
    local span = rightEdge - leftEdge
    local halfW = span:length() * 0.5
    if halfW < 1 then return 0 end
    local rightDir = span:normalize()
    local rel = c.position - center
    return clamp(rel:dot(rightDir) / halfW, -1.5, 1.5)
  end)
  return ok and val or 0
end

-- ── Formation Penalties (Rolling Start Infraction Ladder) ──────────────────────
local function applyPenaltyStrike(why, weight)
  if cfg.penaltyMode == 'off' then return end
  if uiTime - (pen.last[why] or -100) < 8 then return end
  pen.last[why] = uiTime
  pen.strikes = pen.strikes + weight

  local title = 'AVERTISSEMENT / WARNING'
  if cfg.penaltyMode == 'slow' or (cfg.penaltyMode == 'drive' and pen.strikes == 2) then
    if pen.strikes >= 2 then
      if uiTime - (pen.slowAt or -100) < cfg.slowSec + 2 then
        title = 'GAS CUT ACTIVE'
      else
        local applied = pcall(function() physics.forceUserThrottleFor(cfg.slowSec, 0) end)
        title = applied and ('COUPURE GAZ ' .. cfg.slowSec .. 's') or 'GAS CUT (SIMULATED)'
        pen.slowAt = uiTime
      end
    end
  elseif cfg.penaltyMode == 'drive' and pen.strikes >= 3 and not pen.owed and not pen.driving and not pen.active then
    pen.owed = true
    title = 'DRIVE-THROUGH APRES GREEN'
  end

  pen.note = { title = title, why = why, untilT = uiTime + 5 }
  pcall(ac.setMessage, title, why, 'illegal', 5)
  safeLog(string.format('%s - %s (strikes=%d)', title, why, pen.strikes))
end

local function issueJumpStartPenalty(why)
  assignStewardPenalty(
    cfg.jumpPenaltyType,
    PEN_REASON_JUMP,
    cfg.jumpServeLaps,
    cfg.jumpStopGoSec,
    cfg.jumpEscPenalty,
    cfg.jumpEscStopGoSec,
    cfg.jumpTimePenaltySec,
    cfg.jumpTimePenaltySec,
    why
  )
end

-- ── Active Pit Penalty Serving + Escalation + Finish Conversion ──────────────
local function updateActiveStewardPenalty(me, dt)
  -- Track race clock once lights go out or green flag drops
  if isRaceOrTestSession() then
    local tts = sim and sim.timeToSessionStart
    if not pen.raceStartClock and ((cfg.enabled == 1 and S.phase == PHASE_GREEN) or (cfg.enabled == 0 and ((tts or -1) <= 0))) then
      pen.raceStartClock = clock()
    end
    if pen.raceStartClock and not me.isRaceFinished then
      pen.raceElapsedMs = math.max(0, math.floor(clock() - pen.raceStartClock))
    end
  end

  -- Apply deferred rolling-start formation drive-through after Green
  if pen.owed and S.phase == PHASE_GREEN and clock() - S.tStart >= 1500 then
    pen.owed = false
    assignStewardPenalty('drive_through', PEN_REASON_FORMATION, cfg.driveLaps, 0, cfg.cutEscPenalty, cfg.cutEscStopGoSec, cfg.cutFinishTimeSec, cfg.cutTimePenaltySec, 'Infractions pendant la formation')
  end

  -- Apply deferred rolling jump-start penalty after Green
  if pen.jumpQueuedRolling and S.phase == PHASE_GREEN and clock() - S.tStart >= 800 then
    pen.jumpQueuedRolling = false
    issueJumpStartPenalty('Depart anticipe avant Green Flag')
  end

  -- Apply deferred standing jump-start penalty once lights are out
  if standingWatch.pendingApply and standingWatch.lightsOutAt and (uiTime - standingWatch.lightsOutAt) >= 0.35 then
    standingWatch.pendingApply = false
    issueJumpStartPenalty('Depart anticipe sur grille (feux allumes)')
  end

  -- Periodic / finish steward broadcast
  if me.isRaceFinished and not pen.finishedSynced then
    pen.finishedSynced = true
    flushQueuedToTime('Penalite non effectuee avant la ligne d\'arrivee')
    if pen.active then
      local addSec = pen.active.finishTimeSec
      clearNativeGamePenalty()
      pen.active = nil
      addTimePenalty(addSec, 'Penalite non effectuee avant la ligne d\'arrivee')
    else
      syncLocalStewardRecord(true)
    end
    return
  end

  local curLap = me.lapCount or 0
  if curLap ~= lastLapSeen then
    lastLapSeen = curLap
    if pen.raceStartClock then
      syncLocalStewardRecord(true)
    end
  elseif pen.raceStartClock and (uiTime - lastPenBroadcastAt >= 6.0) then
    syncLocalStewardRecord(true)
  end

  -- Promotion de la penalite suivante en file d'attente
  if not pen.active and pen.queue and #pen.queue > 0 then
    if isOnLastLap(me) then
      flushQueuedToTime('Penalite non effectuee avant l\'arrivee')
    else
      local q = table.remove(pen.queue, 1)
      activatePitPenalty(q.kind, q.reasonCode, q.serveLaps, q.holdSec, q.escKind, q.escHoldSec, q.finishTimeSec, q.why)
    end
  end

  if not pen.active then return end

  pen.active.lapsLeft = math.max(0, pen.active.deadlineLap - curLap)
  local totalLaps = sessionTotalLaps()
  if totalLaps > 0 and curLap >= totalLaps then
    local addSec = pen.active.finishTimeSec
    clearNativeGamePenalty()
    pen.active = nil
    addTimePenalty(addSec, 'Penalite non effectuee avant l\'arrivee')
    return
  end

  local inPits = (me.isInPitlane == true) or (me.isInPit == true)
  if inPits then
    pen.active.pitSeen = true
    pen.active.pitDistM = pen.active.pitDistM + (me.speedKmh / 3.6) * dt
    if pen.active.kind == 'stop_and_go' then
      if me.speedKmh <= 2.5 then
        pcall(physics.forceUserThrottleFor, 0.2, 0)
        pen.active.holdElapsed = pen.active.holdElapsed + dt
        if pen.active.holdElapsed >= pen.active.holdSec then
          pcall(physics.forceUserThrottleFor, 0.001, me.gas)
          clearNativeGamePenalty()
          pen.active = nil
          pen.servedFlashUntil = uiTime + 5
          pen.note = { title = 'STOP & GO EFFECTUE', why = 'Vous pouvez repartir !', untilT = uiTime + 4 }
          pcall(ac.setMessage, 'STOP & GO EFFECTUE', 'Penalite purgee — Vous pouvez repartir !', 'info', 4)
          safeLog('stop_and_go served')
          syncLocalStewardRecord(true)
          return
        end
      end
    end
  elseif pen.active.pitSeen then
    if pen.active.kind == 'drive_through' then
      if pen.active.pitDistM >= 25 then
        clearNativeGamePenalty()
        pen.active = nil
        pen.servedFlashUntil = uiTime + 5
        pen.note = { title = 'DRIVE-THROUGH EFFECTUE', why = 'Penalite purgee — Bonne course !', untilT = uiTime + 4 }
        pcall(ac.setMessage, 'DRIVE-THROUGH EFFECTUE', 'Penalite purgee — Bonne course !', 'info', 4)
        safeLog('drive_through served')
        syncLocalStewardRecord(true)
        return
      else
        pen.active.pitSeen = false
        pen.active.pitDistM = 0
      end
    else
      -- Left pits during Stop & Go without holding stationary
      pen.active.pitSeen = false
      pen.active.pitDistM = 0
      pen.active.holdElapsed = 0
      local lapsParam = (pen.active.escKind == 'black_flag') and (pen.active.lapsLeft + 1) or (pen.active.lapsLeft + 2)
      setGamePenalty('MandatoryPits', lapsParam)
      pen.note = { title = 'STOP & GO NON VALIDE', why = 'Arret complet requis dans les stands (' .. pen.active.holdSec .. 's)', untilT = uiTime + 5 }
      pcall(ac.setMessage, 'STOP & GO NON VALIDE', 'Arret complet requis dans les stands', 'illegal', 5)
    end
  end

  -- Check deadline expiration -> 2nd penalty escalation
  if curLap > pen.active.deadlineLap and not inPits then
    local esc = pen.active.escalated and 'time_penalty' or pen.active.escKind
    local escHold = pen.active.escHoldSec
    local serveL = pen.active.serveLaps
    local finSec = pen.active.finishTimeSec
    clearNativeGamePenalty()
    pen.active = nil

    if esc == 'none' then
      pen.note = { title = 'PENALITE EXPIREE', why = 'Delai depasse (aucune 2e penalite configuree)', untilT = uiTime + 4 }
      syncLocalStewardRecord(true)
    elseif esc == 'time_penalty' then
      addTimePenalty(cfg.cutTimePenaltySec > 0 and cfg.cutTimePenaltySec or finSec, '2e penalite : delai stand depasse')
    elseif esc == 'black_flag' then
      setGamePenalty('BlackFlag', 0)
      pen.disqualified = true
      pen.note = { title = 'DRAPEAU NOIR (2e PENALITE)', why = 'Penalite non effectuee dans les ' .. serveL .. ' tours', untilT = uiTime + 8 }
      pcall(ac.setMessage, 'DRAPEAU NOIR (2e PENALITE)', 'Penalite non effectuee a temps', 'illegal', 8)
      syncLocalStewardRecord(true)
    elseif esc == 'teleport_pits' then
      setGamePenalty('TeleportToPits', escHold)
      pen.note = { title = '2e PENALITE : STANDS (' .. escHold .. 's)', why = 'Penalite non effectuee dans les ' .. serveL .. ' tours', untilT = uiTime + 6 }
      pcall(ac.setMessage, '2e PENALITE : STANDS', 'Delai depasse — ' .. escHold .. 's aux stands', 'illegal', 6)
      syncLocalStewardRecord(true)
    elseif esc == 'stop_and_go' or esc == 'drive_through' then
      local lapsParam = serveL + 2
      setGamePenalty('MandatoryPits', lapsParam)
      pen.active = {
        kind = esc,
        reasonCode = PEN_REASON_ESCALATED,
        issuedLap = curLap,
        deadlineLap = curLap + serveL,
        serveLaps = serveL,
        holdSec = (esc == 'stop_and_go') and escHold or 0,
        holdElapsed = 0,
        pitSeen = false,
        pitDistM = 0,
        escKind = 'black_flag',
        escHoldSec = escHold,
        finishTimeSec = finSec,
        escalated = true,
        lapsLeft = serveL,
      }
      local title = esc == 'stop_and_go'
        and string.format('2e PENALITE : STOP & GO %ds', escHold)
        or '2e PENALITE : DRIVE-THROUGH'
      pen.note = { title = title, why = '1re penalite non effectuee dans les ' .. serveL .. ' tours', untilT = uiTime + 7 }
      pcall(ac.setMessage, title, '1re penalite non effectuee a temps', 'illegal', 7)
      safeLog('escalated to ' .. esc)
      syncLocalStewardRecord(true)
    end
  end
end

-- ── Standing Start Jump-Start Monitor ────────────────────────────────────────
local function updateStandingJumpStart(me)
  if cfg.enabled == 1 then return end -- Rolling start uses rolling jump detector
  if not isJumpSessionActive() or cfg.jumpPenaltyType == 'off' then return end
  local tts = sim and sim.timeToSessionStart
  if not tts then return end

  if tts > 500 and tts <= 20000 and not me.isInPitlane then
    standingWatch.armed = true
    if me.speedKmh < 1.5 and not standingWatch.anchorPos then
      pcall(function()
        standingWatch.anchorPos = me.position:clone()
        standingWatch.anchorSpline = me.splinePosition
      end)
    end
  end

  if tts <= 0 and standingWatch.armed and not standingWatch.lightsOutAt then
    standingWatch.lightsOutAt = uiTime
    standingWatch.raceStarted = true
  end

  if standingWatch.armed and tts > 80 and not standingWatch.triggered and not me.isInPitlane then
    local moved = 0
    if standingWatch.anchorPos then
      local okD, dist = pcall(function() return me.position:distance(standingWatch.anchorPos) end)
      if okD and dist then
        moved = dist
      else
        moved = math.abs(wrapSigned(me.splinePosition - standingWatch.anchorSpline)) * trackLen()
      end
    end
    if (moved > cfg.jumpStandingTolM and me.speedKmh > cfg.jumpStandingMaxKmh) or (me.speedKmh > cfg.jumpStandingMaxKmh + 4) then
      standingWatch.triggered = true
      standingWatch.pendingApply = true
      pen.jumpWarn = true
      pen.note = { title = 'DEPART ANTICIPE !', why = 'Mouvement avant l\'extinction des feux', untilT = uiTime + 6 }
      pcall(ac.setMessage, 'DEPART ANTICIPE !', 'Mouvement avant extinction des feux', 'illegal', 6)
      safeLog(string.format('standing jump-start detected (moved=%.2fm speed=%.1f tts=%.0f)', moved, me.speedKmh, tts))
    end
  end
end

-- ── Track-Cut Detector ───────────────────────────────────────────────────────
local function onCutDetected()
  pen.cuts = pen.cuts + 1
  pen.cutsSincePenalty = pen.cutsSincePenalty + 1
  pen.cutNoticeSeq = pen.cutNoticeSeq + 1

  local quota = (pen.hadCutPenalty and cfg.cutRepeatEvery > 0)
    and cfg.cutRepeatEvery
    or (cfg.cutMaxBeforePenalty + 1)

  if pen.cutsSincePenalty >= quota then
    pen.hadCutPenalty = true
    pen.cutsSincePenalty = 0
    assignStewardPenalty(
      cfg.cutPenaltyType,
      PEN_REASON_CUT,
      cfg.cutServeLaps,
      cfg.cutStopGoSec,
      cfg.cutEscPenalty,
      cfg.cutEscStopGoSec,
      cfg.cutFinishTimeSec,
      cfg.cutTimePenaltySec,
      string.format('Limite cuts depassee (%d cuts)', pen.cuts)
    )
  else
    local rem = quota - pen.cutsSincePenalty
    local title = string.format('TRACK CUT (%d / %d)', pen.cutsSincePenalty, quota - 1)
    local why = rem == 1
      and 'DERNIER AVERTISSEMENT — Prochain cut = penalite !'
      or string.format('Encore %d cut(s) tolere(s) avant penalite', rem - 1)
    pen.cutWarnUntil = uiTime + 3.5
    pen.note = { title = title, why = why, untilT = uiTime + 4 }
    pcall(ac.setMessage, title, why, 'illegal', 4)
    safeLog(string.format('track cut #%d (%s)', pen.cuts, why))
    syncLocalStewardRecord(true)
  end
end

local function updateTrackCuts(me, dt)
  if not isCutSessionActive() then
    cutTrack.offTime = 0
    cutTrack.countedThisOff = false
    return
  end
  if me.isInPitlane or me.isInPit or me.isRetired or me.isRaceFinished then
    cutTrack.offTime = 0
    cutTrack.countedThisOff = false
    return
  end

  local tts = sim and sim.timeToSessionStart
  if tts and tts > 0 then
    cutTrack.offTime = 0
    return
  end
  -- Do not count cuts during rolling start formation laps before Green Flag
  if cfg.enabled == 1 and S.phase ~= PHASE_GREEN then
    cutTrack.offTime = 0
    cutTrack.countedThisOff = false
    return
  end

  if isSplineInZones(me.splinePosition, cutZones) then
    cutTrack.offTime = 0
    cutTrack.countedThisOff = false
    return
  end

  if me.speedKmh < cfg.cutMinSpeedKmh then
    cutTrack.offTime = 0
    return
  end

  local offTrack = false
  if cfg.cutUseKunosInvalid == 1 then
    offTrack = (me.isLapValid == false)
  else
    offTrack = ((me.wheelsOutside or 0) >= cfg.cutWheelsMin)
  end

  if offTrack then
    cutTrack.offTime = cutTrack.offTime + dt
    if not cutTrack.countedThisOff and cutTrack.offTime >= cfg.cutMinDurationSec and (uiTime - cutTrack.lastCutAt) >= cfg.cutCooldownSec then
      cutTrack.countedThisOff = true
      cutTrack.lastCutAt = uiTime
      onCutDetected()
    end
  else
    cutTrack.offTime = 0
    cutTrack.countedThisOff = false
  end
end

-- ── Limiter & Local Formation Rules ──────────────────────────────────────────
local function updateLocalFormation(cars, dt)
  local me = ac.getCar(0)
  if not me then return end
  local limitingPhase = (cfg.enabled == 1) and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION)
  -- depart lance : pas de limite sur la grille (palier 'grid') tant que les feux ne sont pas eteints
  if limitingPhase and cfg.startLength == 'full' and S.phase ~= PHASE_CAUTION and RS.stage.stage == 'grid' then
    limitingPhase = false
  end
  if not limitingPhase or me.isInPitlane or me.isRetired then
    if localState.limiterActive then
      pcall(physics.forceUserThrottleFor, 0.001, me.gas)
    end
    localState.limiterActive = false
    localState.warnFlags = 0
    localState.speedWarn, localState.passWarn, localState.lagWarn, localState.laneWarn = false, false, false, false
    return
  end

  local idx = 0
  for i, id in ipairs(S.order) do
    if id == me.sessionID then idx = i; break end
  end
  if idx == 0 then idx = #S.order + 1 end

  local row, laneName, targetNormX, slotOffsetM = slotAssignment(idx, cfg)
  localState.mySlot = idx
  localState.myRow = row
  localState.myLane = laneName == 'left' and 1 or (laneName == 'right' and 2 or 0)
  localState.lateralNorm = computeLateralNorm(me)

  local len = trackLen()
  local pSpline = paceSpline()
  local slotSpline = frac(pSpline - slotOffsetM / len)

  local rawSlotDiff = slotSpline - me.splinePosition
  if localState.relBuf == nil or localState.prevSlotSpline == nil then
    localState.relBuf = wrapSigned(rawSlotDiff) * len
  else
    local d = rawSlotDiff - localState.prevRawDiff
    localState.relBuf = localState.relBuf + wrapSigned(d) * len
  end
  localState.prevRawDiff = rawSlotDiff
  localState.prevSlotSpline = slotSpline
  localState.slotDeltaM = localState.relBuf

  local aheadCar, aheadId = nil, -1
  if cfg.formationMode == '2x2' then
    for j = idx - 2, 1, -2 do
      local c = cars[S.order[j]]
      if c and not c.isInPitlane and not c.isRetired then
        aheadCar, aheadId = c, S.order[j]
        break
      end
    end
    if not aheadCar and idx > 2 then
      local fallbackIdx = (idx % 2 == 1) and (idx - 1) or (idx - 3)
      if fallbackIdx >= 1 then
        local c = cars[S.order[fallbackIdx]]
        if c and not c.isInPitlane and not c.isRetired then
          aheadCar, aheadId = c, S.order[fallbackIdx]
        end
      end
    end
  else
    for j = idx - 1, 1, -1 do
      local c = cars[S.order[j]]
      if c and not c.isInPitlane and not c.isRetired then
        aheadCar, aheadId = c, S.order[j]
        break
      end
    end
  end

  local partnerCar, partnerId = nil, -1
  if cfg.formationMode == '2x2' then
    local pIdx = (idx % 2 == 1) and (idx + 1) or (idx - 1)
    if pIdx >= 1 and pIdx <= #S.order then
      local c = cars[S.order[pIdx]]
      if c and not c.isInPitlane and not c.isRetired then
        partnerCar, partnerId = c, S.order[pIdx]
      end
    end
  end

  localState.targetId = aheadId
  localState.partnerId = partnerId
  localState.targetName = aheadCar and ac.getDriverName(aheadCar.index) or nil
  localState.partnerName = partnerCar and ac.getDriverName(partnerCar.index) or nil

  local aheadGapM = 999
  if aheadCar then
    local myD = carTrackDist[me.sessionID] and carTrackDist[me.sessionID].distM
    local ahD = carTrackDist[aheadId] and carTrackDist[aheadId].distM
    if myD and ahD then aheadGapM = ahD - myD
    else aheadGapM = wrapSigned(aheadCar.splinePosition - me.splinePosition) * len end
  end
  localState.aheadGapM = aheadGapM

  local partnerDeltaM = 0
  if partnerCar then
    local myD = carTrackDist[me.sessionID] and carTrackDist[me.sessionID].distM
    local ptD = carTrackDist[partnerId] and carTrackDist[partnerId].distM
    if myD and ptD then partnerDeltaM = ptD - myD
    else partnerDeltaM = wrapSigned(partnerCar.splinePosition - me.splinePosition) * len end
  end
  localState.partnerDeltaM = partnerDeltaM

  local elapsedSec = math.max(0, (clock() - S.tStart) / 1000)
  local allowed = cfg.paceKmh
  if cfg.startLength == 'full' and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY) then
    allowed = (RS.stage.stage == 'fast') and cfg.fastKmh or cfg.slowKmh
  elseif cfg.limiterMode ~= 'hard' then
    if localState.slotDeltaM > 3 then
      allowed = cfg.paceKmh + clamp((localState.slotDeltaM - 3) / 35, 0, 1) * cfg.catchupKmh
    elseif localState.slotDeltaM < -3 then
      allowed = math.max(35, cfg.paceKmh - clamp((-localState.slotDeltaM - 3) * 1.4, 0, 18))
    end
  end
  if aheadCar and aheadGapM < cfg.targetGapM * 0.72 then
    allowed = math.min(allowed, math.max(30, aheadCar.speedKmh - 8))
  end
  localState.allowedKmh = allowed

  if cfg.limiterMode ~= 'off' then
    if not localState.limiterActive then
      localState.limiterCapKmh = math.max(allowed, me.speedKmh)
    end
    local cap = localState.limiterCapKmh
    if allowed > cap then
      cap = math.min(allowed, cap + 40 * dt)
    else
      cap = math.max(allowed, math.min(cap - 18 * dt, me.speedKmh + 4))
    end
    localState.limiterCapKmh = cap
    localState.limiterActive = true

    local over = me.speedKmh - cap
    if over > -4.5 then
      local maxGas = clamp(-over / 4.5, 0, 1)
      if me.gas > maxGas then pcall(physics.forceUserThrottleFor, 0.08, maxGas) end
    end
    if over > 10 then
      local brk = clamp((over - 10) / 35, 0, 0.30)
      pcall(physics.forceUserBrakesFor, 0.08, math.max(me.brake, brk))
    end
  else
    localState.limiterActive = false
    localState.limiterCapKmh = allowed
  end

  local graceActive = elapsedSec < cfg.launchGraceSec or (uiTime - lastContact < 3)
  local speeding = me.speedKmh > allowed + cfg.speedTolKmh
  local passingAhead = aheadCar and aheadGapM < -2.5
  local passingPole = (cfg.formationMode == '2x2' and idx == 2 and partnerCar and partnerDeltaM < -math.min(4, cfg.rowAlignTolM))
  local passing = passingAhead or passingPole
  local lagging = (aheadCar and aheadGapM > cfg.targetGapM * 2.4 and me.speedKmh < cfg.paceKmh - 15) or (localState.slotDeltaM > 45 and me.speedKmh < cfg.paceKmh - 12)
  local wrongLane = (cfg.formationMode == '2x2') and (math.abs(localState.lateralNorm - targetNormX) > (0.34 + cfg.laneTolNorm))

  localState.speedWarn = speeding
  localState.passWarn = passing
  localState.lagWarn = lagging
  localState.laneWarn = wrongLane
  localState.warnFlags = (speeding and 1 or 0) + (passing and 2 or 0) + (lagging and 4 or 0) + (wrongLane and 8 or 0)

  localState.speedT = (speeding and not graceActive) and (localState.speedT + dt) or 0
  localState.passT = (passing and not graceActive) and (localState.passT + dt) or 0

  -- Rolling Start Jump-Start detection (jumping line or breaking formation in READY / accel zone)
  if isJumpSessionActive() and cfg.jumpRollingCatch == 1 and not graceActive and not standingWatch.triggered and cfg.jumpPenaltyType ~= 'off' then
    local myDist = carTrackDist[me.sessionID] and carTrackDist[me.sessionID].distM or 0
    local targetDist = computeTargetDistanceM(S.s0, cfg, len)
    local jumpedLine = (S.phase == PHASE_READY or S.phase == PHASE_FORMATION) and (myDist > targetDist + 8)
    local jumpingPack = (S.phase == PHASE_READY or localState.inAccelZone) and (passing or (cfg.limiterMode == 'off' and me.speedKmh > allowed + cfg.speedTolKmh + 10))
    if jumpedLine or jumpingPack then
      standingWatch.rollingJumpT = standingWatch.rollingJumpT + dt
    else
      standingWatch.rollingJumpT = 0
    end
    if jumpedLine or standingWatch.rollingJumpT >= 1.2 then
      standingWatch.triggered = true
      pen.jumpWarn = true
      pen.jumpQueuedRolling = true
      pen.note = { title = 'DEPART ANTICIPE !', why = 'Anticipation avant Green Flag', untilT = uiTime + 6 }
      pcall(ac.setMessage, 'DEPART ANTICIPE !', 'Anticipation avant Green Flag', 'illegal', 6)
      safeLog('rolling jump-start detected')
      syncLocalStewardRecord(true)
    end
  end

  if localState.speedT >= 3.5 then
    localState.speedT = 0
    applyPenaltyStrike('Vitesse excessive sous regime de depart lance / Overspeed', 1)
  end
  if localState.passT >= 1.2 then
    localState.passT = 0
    local w = (S.phase == PHASE_READY or localState.inAccelZone) and 2 or 1
    applyPenaltyStrike(passingPole and 'Depassement poleman avant drapeau vert' or 'Depassement en formation / Passed out of order', w)
  end
end

-- ── Formation Phase & Dual Green Triggers Controller ─────────────────────────
local function controlFormation(cars, rank)
  if cfg.enabled ~= 1 or S.phase == PHASE_IDLE or S.phase == PHASE_GREEN then
    localState.inAccelZone = false
    localState.distRemainingM = 0
    return
  end

  if not cars[S.from] and S.from ~= NONE then
    if due('reannounce', rank) then
      commitState(S.phase, S.reason, S.tStart, S.s0, S.flags, S.order)
    end
    return
  end

  local len = trackLen()
  local _, leadId = activeLeader(cars)
  local pDist = paceDistM()
  local leadDist = (leadId and carTrackDist[leadId] and carTrackDist[leadId].distM) or pDist
  -- Progression réelle : distance parcourue par le leader. Le terme "pace" (temps x vitesse)
  -- ne sert qu'en secours si aucune donnée de voiture n'existe ; sinon une voiture plus lente
  -- que le pace faisait passer le vert trop tôt, avant d'avoir roulé les tours de formation.
  local leaderHasData = leadId and carTrackDist[leadId] ~= nil
  local progressDist = leaderHasData and leadDist or (pDist * 0.85)
  local targetDist = computeTargetDistanceM(S.s0, cfg, len)
  local remM = math.max(0, targetDist - progressDist)
  localState.distRemainingM = remM

  local inZone = false
  if cfg.startLength == 'short' then
    local readyThresh = (cfg.shortMode == 'timer') and ((cfg.paceKmh / 3.6) * math.max(0, cfg.shortSec - 5)) or (targetDist * 0.70)
    local zoneThresh = targetDist * 0.85
    inZone = progressDist >= zoneThresh
    localState.inAccelZone = inZone
    if S.phase == PHASE_FORMATION and progressDist >= readyThresh and due('short_ready', rank) then
      commitState(PHASE_READY, S.reason, S.tStart, S.s0, 1, S.order)
      return
    end
    if cfg.greenTrigger ~= 'manual' then
      local triggerAt = (cfg.autoGreenAt == 'zone') and zoneThresh or targetDist
      if progressDist >= triggerAt and due('short_green', rank) then
        triggerGreen(REASON_NONE)
        return
      end
    end
  else
    local stage = fullFormationStage(cars)
    localState.inAccelZone = (stage == 'wait')
    localState.distRemainingM = 0
    if cfg.greenTrigger ~= 'manual' and stage == 'wait' then
      local _, leadId = activeLeader(cars)
      local lt = leadId and carTrackDist[leadId]
      if lt and lt.crossedNow and lt.cross >= cfg.formationLaps and due('full_green', rank) then
        triggerGreen(REASON_NONE)
        return
      end
    end
  end

  if cfg.maxFormationSec > 0 and cfg.greenTrigger ~= 'manual' then
    if (clock() - S.tStart) / 1000 >= cfg.maxFormationSec and due('timeout_green', rank) then
      triggerGreen(REASON_NONE)
    end
  end
end

-- ── Lights Out Detection ─────────────────────────────────────────────────────
local function checkLightsOut(cars, now)
  if cfg.enabled ~= 1 then return end
  if S.phase ~= PHASE_IDLE or S.seq > 0 then return end
  if sessionType() ~= RACE then return end
  local tts = sim.timeToSessionStart
  local fastest = 0
  for _, c in pairs(cars) do
    if c.speedKmh > fastest then fastest = c.speedKmh end
  end
  if tts and tts > 500 then startWatch.armed = true end
  if fastest < 12 and now < 120000 then startWatch.seenGrid = true end
  if not startWatch.seenGrid then return end
  local lightsGone = (startWatch.armed and (tts or -1) <= 0)
  local packRolled = (not startWatch.armed and now > 2500 and fastest > 12)
  if lightsGone or packRolled then
    startWatch.triggered = true
    local order, s0 = sortGridOrder(cars)
    if #order > 0 then
      commitState(PHASE_FORMATION, REASON_LIGHTS, now, s0, 0, order)
      safeLog(string.format('lights out detected (tts=%s clock=%d cars=%d mode=%s)',
        tostring(tts), math.floor(now), #order, cfg.formationMode))
    end
  end
end

-- ── Bridge Command Consumer ──────────────────────────────────────────────────
local function processBridgeCommands()
  if not bridge then return end
  bridge.scriptHeartbeat = uiTime
  if (bridge.cmdSeq or 0) > lastCmdSeqProcessed then
    lastCmdSeqProcessed = bridge.cmdSeq
    local cmd = bridge.cmdType
    if cmd == CMD_CLEAR_PENALTY then
      clearAllLocalPenalties(false)
    elseif canControl() or (cmd == CMD_GREEN and cfg.allowP1Green == 1 and localState.mySlot == 1 and localState.inAccelZone) then
      if cmd == CMD_START then
        startFormation(REASON_ADMIN)
      elseif cmd == CMD_READY then
        callReady()
      elseif cmd == CMD_GREEN then
        triggerGreen(REASON_ADMIN)
      elseif cmd == CMD_CAUTION then
        local cars = activeCars()
        local order, s0 = sortGridOrder(cars)
        if #order > 0 then commitState(PHASE_CAUTION, REASON_CAUTION, clock(), s0, 0, order) end
      elseif cmd == CMD_RESET then
        commitState(PHASE_IDLE, REASON_ADMIN, clock(), 0, 0, {})
      elseif cmd == CMD_APPLY_CFG then
        local nc = readCfgFromBridgeCmd()
        if nc then broadcastCfg(nc) end
      elseif cmd == CMD_ADMIN_ACTION then
        sendAdminAction(bridge.cmdAction, bridge.cmdTargetSid, bridge.cmdParam)
      end
    end
  end

  local me = ac.getCar(0)
  bridge.seq = S.seq
  bridge.cfgSeq = cfgSeq
  bridge.phase = S.phase
  bridge.reason = S.reason
  bridge.tStart = S.tStart
  bridge.s0 = S.s0
  bridge.stateFlags = S.flags
  bridge.orderCount = #S.order
  bridge.orderCsv = encodeOrder(S.order)

  bridge.mySlot = localState.mySlot
  bridge.myRow = localState.myRow
  bridge.myLane = localState.myLane
  bridge.targetSessionId = localState.targetId
  bridge.partnerSessionId = localState.partnerId
  bridge.slotDeltaM = localState.slotDeltaM
  bridge.aheadGapM = localState.aheadGapM
  bridge.partnerDeltaM = localState.partnerDeltaM
  bridge.lateralNorm = localState.lateralNorm
  bridge.allowedKmh = localState.allowedKmh
  bridge.limiterCapKmh = localState.limiterCapKmh
  bridge.limiterActive = localState.limiterActive and 1 or 0
  bridge.inAccelZone = localState.inAccelZone and 1 or 0
  bridge.distRemainingM = localState.distRemainingM
  bridge.strikes = pen.strikes
  bridge.penOwed = (pen.owed or (pen.active ~= nil)) and 1 or 0
  bridge.penDriving = (pen.active ~= nil) and 1 or 0
  bridge.warnFlags = localState.warnFlags
  local pc = 0
  for _ in pairs(presence) do pc = pc + 1 end
  bridge.onlineCount = pc
  bridge.netSent = stats.sent
  bridge.netGot = stats.got

  bridge.cutsCount = pen.cutsSincePenalty
  bridge.cutsQuota = (pen.hadCutPenalty and cfg.cutRepeatEvery > 0) and math.max(0, cfg.cutRepeatEvery - 1) or cfg.cutMaxBeforePenalty
  bridge.activePenKind = pen.active and penKindToCode(pen.active.kind) or (pen.disqualified and PEN_BLACK_FLAG or PEN_NONE)
  bridge.activePenReason = pen.active and pen.active.reasonCode or PEN_REASON_NONE
  bridge.activePenLapsLeft = pen.active and math.max(0, pen.active.deadlineLap - (me and me.lapCount or 0)) or 0
  bridge.activePenHoldLeft = (pen.active and pen.active.kind == 'stop_and_go') and math.max(0, pen.active.holdSec - pen.active.holdElapsed) or 0
  bridge.activePenEscalated = (pen.active and pen.active.escalated) and 1 or 0
  bridge.totalTimePenaltySec = pen.totalTimePenaltySec
  bridge.jumpWarnFlag = pen.jumpWarn and 1 or 0
  bridge.cutNoticeSeq = pen.cutNoticeSeq
  bridge.disqualified = pen.disqualified and 1 or 0
  local canViewPeloton, pelotonRoleCode, pelotonRoleLabel = canViewPelotonCuts()
  bridge.canViewPeloton = canViewPeloton and 1 or 0
  bridge.pelotonRole = pelotonRoleLabel or ''
  bridge.stewardCsv = buildStewardCsv()

  writeCfgToBridge(cfg)
end

-- ── Movable & Resizable Built-in HUD Layout (single table to preserve LuaJIT 200-local limit) ──
local hudUi = {
  DEFAULTS = {
    bannerX = -1, bannerY = 0.04, bannerScale = 1.0,
    cutsX = 0.012, cutsY = 0.945, cutsScale = 1.0,
    pelotonX = 0.012, pelotonY = 0.72, pelotonScale = 1.0,
    locked = false,
  },
  store = nil,
  mem = {
    bannerX = -1, bannerY = 0.04, bannerScale = 1.0,
    cutsX = 0.012, cutsY = 0.945, cutsScale = 1.0,
    pelotonX = 0.012, pelotonY = 0.72, pelotonScale = 1.0,
    locked = false,
  },
  drag = { activeId = nil, mode = nil, offX = 0, offY = 0, startMx = 0, startMy = 0, startScale = 1.0, prevDown = false },
  COL_GREEN = rgbm(0.12, 0.78, 0.35, 0.94),
  COL_AMBER = rgbm(0.95, 0.76, 0.12, 0.94),
  COL_RED = rgbm(0.88, 0.16, 0.16, 0.94),
  COL_TEAL = rgbm(0.06, 0.16, 0.20, 0.90),
  COL_WHITE = rgbm(0.97, 0.95, 0.90, 1),
  COL_DARK = rgbm(0.05, 0.08, 0.10, 1),
  COL_GOLD = rgbm(0.86, 0.66, 0.26, 0.96),
}
pcall(function()
  if ac.storage then
    hudUi.store = ac.storage({
      bannerX = hudUi.DEFAULTS.bannerX,
      bannerY = hudUi.DEFAULTS.bannerY,
      bannerScale = hudUi.DEFAULTS.bannerScale,
      cutsX = hudUi.DEFAULTS.cutsX,
      cutsY = hudUi.DEFAULTS.cutsY,
      cutsScale = hudUi.DEFAULTS.cutsScale,
      pelotonX = hudUi.DEFAULTS.pelotonX,
      pelotonY = hudUi.DEFAULTS.pelotonY,
      pelotonScale = hudUi.DEFAULTS.pelotonScale,
      locked = hudUi.DEFAULTS.locked,
    }, 'gdsp_rs_hud_')
  end
end)

function hudUi.get(k)
  if hudUi.store ~= nil and hudUi.store[k] ~= nil then
    return hudUi.store[k]
  end
  return hudUi.mem[k]
end

function hudUi.set(k, v)
  hudUi.mem[k] = v
  if hudUi.store ~= nil then
    pcall(function() hudUi.store[k] = v end)
  end
end

function hudUi.reset(onlyId)
  local keys = onlyId
    and { onlyId .. 'X', onlyId .. 'Y', onlyId .. 'Scale' }
    or { 'bannerX', 'bannerY', 'bannerScale', 'cutsX', 'cutsY', 'cutsScale', 'pelotonX', 'pelotonY', 'pelotonScale', 'locked' }
  for _, k in ipairs(keys) do
    hudUi.set(k, hudUi.DEFAULTS[k])
  end
end

function hudUi.readMouse()
  local mpos, mdown, mwheel = nil, false, 0
  if ui and ui.mousePos then
    local ok, p = pcall(ui.mousePos)
    if ok and p then mpos = p end
  end
  if not mpos and ac and ac.getUI then
    local ok, u = pcall(ac.getUI)
    if ok and u and u.mousePos then mpos = u.mousePos end
  end
  if ui and ui.mouseDown then
    local ok, d = pcall(ui.mouseDown, 0)
    if ok and d then mdown = true end
  elseif ac and ac.getUI then
    local ok, u = pcall(ac.getUI)
    if ok and u and u.isMouseLeftKeyDown then mdown = true end
  end
  if ui and ui.mouseWheel then
    local ok, w = pcall(ui.mouseWheel)
    if ok and type(w) == 'number' then mwheel = w end
  elseif ac and ac.getUI then
    local ok, u = pcall(ac.getUI)
    if ok and u and type(u.mouseWheel) == 'number' then mwheel = u.mouseWheel end
  end
  return mpos, mdown, mwheel
end

-- ── Chat Commands ────────────────────────────────────────────────────────────
local function handleChatCommand(msg)
  if type(msg) ~= 'string' then return false end
  local trimmed = msg:lower():match('^%s*(.-)%s*$')
  if trimmed == '!rsdebug' then
    debugOn = not debugOn
    return true
  end
  if trimmed:match('^!rshud') then
    local hcmd = trimmed:match('^!rshud%s+(.+)$') or 'reset'
    if hcmd == 'reset' then
      hudUi.reset(nil)
    elseif hcmd == 'lock' then
      hudUi.set('locked', true)
    elseif hcmd == 'unlock' then
      hudUi.set('locked', false)
    else
      local scVal = tonumber(hcmd:match('^scale%s+([%d%.]+)$'))
      if scVal then
        scVal = clamp(scVal, 0.55, 2.50)
        hudUi.set('bannerScale', scVal)
        hudUi.set('cutsScale', scVal)
        hudUi.set('pelotonScale', scVal)
      end
    end
    return true
  end
  if not trimmed:match('^!green$') and not trimmed:match('^!yellow$') and not trimmed:match('^!rs') then
    return false
  end
  local cmd = trimmed:match('^!rs%s+(.+)$') or (trimmed == '!green' and 'green') or (trimmed == '!yellow' and 'start') or ''
  if cmd == 'green' then
    if canControl() or (cfg.allowP1Green == 1 and localState.mySlot == 1 and localState.inAccelZone) then
      triggerGreen(REASON_ADMIN)
      return true
    end
    return false
  end
  if not canControl() then return false end
  if cmd == 'start' then
    startFormation(REASON_ADMIN)
  elseif cmd == 'ready' then
    callReady()
  elseif cmd == 'reset' then
    commitState(PHASE_IDLE, REASON_ADMIN, clock(), 0, 0, {})
  elseif cmd == 'on' or cmd == 'rolling' then
    local nc = copyCfg(cfg); nc.enabled = 1; broadcastCfg(nc)
  elseif cmd == 'off' or cmd == 'standing' then
    local nc = copyCfg(cfg); nc.enabled = 0; broadcastCfg(nc)
    commitState(PHASE_IDLE, REASON_ADMIN, clock(), 0, 0, {})
  elseif cmd == '1x1' or cmd == '2x2' then
    local nc = copyCfg(cfg); nc.formationMode = cmd; broadcastCfg(nc)
  elseif cmd == 'full' or cmd == 'short' then
    local nc = copyCfg(cfg); nc.startLength = cmd; broadcastCfg(nc)
  elseif cmd == 'test' then
    local nc = copyCfg(cfg); nc.everySession = nc.everySession == 1 and 0 or 1; broadcastCfg(nc)
  elseif cmd == 'clear' then
    clearAllLocalPenalties(false)
  elseif cmd == 'clearall' then
    sendAdminAction(ACT_CLEAR_ALL, NONE, 0)
  elseif cmd == 'resetcuts' then
    sendAdminAction(ACT_RESET_CUTS, NONE, 0)
  elseif cmd == 'cut on' or cmd == 'cut off' then
    local nc = copyCfg(cfg); nc.cutEnabled = (cmd == 'cut on') and 1 or 0; broadcastCfg(nc)
  elseif cmd == 'jump on' or cmd == 'jump off' then
    local nc = copyCfg(cfg); nc.jumpEnabled = (cmd == 'jump on') and 1 or 0; broadcastCfg(nc)
  else
    local paceVal = cmd:match('^pace%s+(%d+)$')
    if paceVal then
      local nc = copyCfg(cfg); nc.paceKmh = tonumber(paceVal); broadcastCfg(nc)
    end
    local cutLim = cmd:match('^cutlimit%s+(%d+)$')
    if cutLim then
      local nc = copyCfg(cfg); nc.cutMaxBeforePenalty = tonumber(cutLim); broadcastCfg(nc)
    end
    local trigVal = cmd:match('^trigger%s+(%a+)$')
    if trigVal == 'auto' or trigVal == 'manual' or trigVal == 'both' then
      local nc = copyCfg(cfg); nc.greenTrigger = trigVal; broadcastCfg(nc)
    end
    local afVal = cmd:match('^autoformation%s+(%a+)$')
    if afVal == 'on' or afVal == '1' or afVal == 'yes' then
      local nc = copyCfg(cfg); nc.autoFormation = 1; broadcastCfg(nc)
    elseif afVal == 'off' or afVal == '0' or afVal == 'no' then
      local nc = copyCfg(cfg); nc.autoFormation = 0; broadcastCfg(nc)
    end
    local limVal = cmd:match('^limiter%s+(%a+)$')
    if limVal == 'limiter' or limVal == 'hard' or limVal == 'off' then
      local nc = copyCfg(cfg); nc.limiterMode = limVal; broadcastCfg(nc)
    end
    local stewTarget = cmd:match('^steward%s+(.+)$')
    if stewTarget then
      local q = stewTarget:lower():gsub('^%s+', ''):gsub('%s+$', '')
      if q == 'off' or q == 'none' or q == 'clear' then
        sendAdminAction(ACT_SET_STEWARD, NONE, 0)
      else
        local count = sim and sim.carsCount or 0
        for i = 0, count - 1 do
          local c = ac.getCar(i)
          if c and c.isConnected then
            local dn = tostring(ac.getDriverName(c.index) or ''):lower()
            local cid = safeCarId(c):lower()
            if dn:find(q, 1, true) or cid:find(q, 1, true) then
              sendAdminAction(ACT_SET_STEWARD, c.sessionID, 1)
              break
            end
          end
        end
      end
    end
  end
  return true
end

if not pcall(ac.onOutgoingChatMessage, handleChatCommand) then
  pcall(ac.onChatMessage, function(msg, sender)
    if sender == 0 then handleChatCommand(msg) end
  end)
end

pcall(ac.onCarCollision, 0, function()
  lastContact = uiTime
end)

-- ── Main Loop ────────────────────────────────────────────────────────────────
local function guard(fn)
  return function(...)
    local ok, err = pcall(fn, ...)
    if not ok and err ~= lastError then
      lastError = tostring(err)
      safeLog('error: ' .. lastError)
    end
  end
end

local function getDesiredHudFlag(now)
  if not ac.FlagType then return 0 end
  if pen.disqualified then return ac.FlagType.Stop or 5 end
  if pen.active then return ac.FlagType.ReturnToPits or 8 end
  if cfg.enabled == 1 and S.phase == PHASE_GREEN and (now - S.tStart) < 4500 then
    return ac.FlagType.Start or 1
  end
  if cfg.enabled == 1 and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION) then
    if localState.inAccelZone and (math.floor(uiTime * 4) % 2 == 0) then
      return ac.FlagType.Start or 1
    end
    return ac.FlagType.Caution or 2
  end
  if uiTime < pen.cutWarnUntil then
    return ac.FlagType.Unsportsmanlike or 10
  end
  return ac.FlagType.None or 0
end

local function updateRaceFlagOverride(now)
  if not ac.FlagType then return end
  local target = ac.FlagType.None or 0
  if pen.disqualified then
    target = ac.FlagType.Stop or 5
  elseif pen.active then
    target = ac.FlagType.ReturnToPits or 8
  elseif cfg.enabled == 1 and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION) then
    target = ac.FlagType.Caution or 2
  elseif cfg.enabled == 1 and S.phase == PHASE_GREEN and (now - S.tStart) < 4500 then
    target = ac.FlagType.Start or 1
  end
  if target ~= lastOverrideFlag then
    lastOverrideFlag = target
    pcall(function()
      if physics.overrideRacingFlag then physics.overrideRacingFlag(target) end
    end)
  end
end

function script.update(dt)
  guard(function()
    uiTime = uiTime + dt
    local now = clock()
    local curSess = sim and sim.currentSessionIndex or -1
    if now < lastClock - 3000 or curSess ~= lastSessionIdx then
      onSessionReset()
    end
    lastClock = now
    lastSessionIdx = curSess

    if not greeted and sendStateEvt and accessStateEvt and uiTime > 0.8 then
      greeted = true
      local p = accessStateEvt()
      p.seq, p.tStart, p.s0, p.phase, p.reason, p.flags, p.n = 0, 0, 0, PHASE_IDLE, 0, 0, 0
      for i = 0, ORDER_MAX - 1 do p.order[i] = NONE end
      sendStateEvt(nil, false)
    end

    flushOutbox()
    processBridgeCommands()

    if not isAnySystemActive() then
      if S.seq > 0 and S.phase ~= PHASE_IDLE then
        resetAll()
      end
      return
    end

    local cars = activeCars()
    local me = ac.getCar(0)
    if not me then return end

    if cfg.enabled == 1 and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION) then
      updateCarDistances(cars)
    end

    local rank = 0
    for id in pairs(cars) do
      if id < me.sessionID then rank = rank + 1 end
    end

    -- Auto-formation : lance le tour de formation tout seul après un délai
    if S.phase == PHASE_IDLE and cfg.autoFormation == 1 and cfg.enabled == 1 then
      local nCars = 0
      for _ in pairs(cars) do nCars = nCars + 1 end
      if nCars > 0 then
        if not autoFormationIdleSince then autoFormationIdleSince = now end
        if now - autoFormationIdleSince >= 5000 then
          startFormation(REASON_AUTO)
          autoFormationIdleSince = nil
        end
      else
        autoFormationIdleSince = nil
      end
    end

    if isRollingSessionActive() then
      if S.phase == PHASE_IDLE then
        checkLightsOut(cars, now)
      end
      controlFormation(cars, rank)
      updateLocalFormation(cars, dt)
    else
      if localState.limiterActive then
        pcall(physics.forceUserThrottleFor, 0.001, me.gas)
        localState.limiterActive = false
      end
    end

    updateStandingJumpStart(me)
    updateTrackCuts(me, dt)
    updateActiveStewardPenalty(me, dt)
    updateRaceFlagOverride(now)
    flushOutbox()
  end)()
end

-- ── Built-In Fallback HUD (for drivers without the CM Lua App) ────────────────
function hudUi.drawCentered(txt, sz, cx, y, col)
  local w = ui.measureDWriteText and ui.measureDWriteText(txt, sz).x or (#txt * sz * 0.52)
  ui.dwriteDrawText(txt, sz, vec2(cx - w / 2, y), col)
end

function hudUi.computeWidgetBox(id, baseW, baseH, win, mpos, mdown, mwheel, justPressed)
  local sc = clamp(tonumber(hudUi.get(id .. 'Scale')) or 1.0, 0.55, 2.50)
  local w = math.min(baseW * sc, math.max(60, win.x - 16))
  local h = math.min(baseH * sc, math.max(24, win.y - 16))
  local nx = tonumber(hudUi.get(id .. 'X'))
  local ny = tonumber(hudUi.get(id .. 'Y'))
  local x = (not nx or nx < 0) and ((win.x - w) * 0.5) or (nx * win.x)
  local y = (ny or 0.04) * win.y
  local maxX = math.max(4, win.x - w - 4)
  local maxY = math.max(4, win.y - h - 4)
  x = clamp(x, 4, maxX)
  y = clamp(y, 4, maxY)

  local hovered = false
  local locked = hudUi.get('locked') == true
  if mpos and not locked then
    local mx, my = mpos.x, mpos.y
    local btnSz = clamp(16 * (win.y / 1080), 13, 22)
    local btnY = (y >= btnSz + 6) and (y - btnSz - 3) or (y + 2)
    local plusX = x + w - btnSz - 2
    local minusX = plusX - btnSz - 2
    local resetX = minusX - btnSz - 2
    local gripSz = clamp(16 * (win.y / 1080), 12, 22)

    local inBody = mx >= x and mx <= x + w and my >= y and my <= y + h
    local inBar = (my >= btnY and my <= btnY + btnSz and mx >= resetX and mx <= plusX + btnSz)
    hovered = inBody or inBar

    if justPressed and hovered and not hudUi.drag.activeId then
      if my >= btnY and my <= btnY + btnSz then
        if mx >= plusX and mx <= plusX + btnSz then
          sc = clamp(sc + 0.12, 0.55, 2.50)
          hudUi.set(id .. 'Scale', sc)
          return x, y, math.min(baseW * sc, win.x - 16), math.min(baseH * sc, win.y - 16), sc, true
        elseif mx >= minusX and mx <= minusX + btnSz then
          sc = clamp(sc - 0.12, 0.55, 2.50)
          hudUi.set(id .. 'Scale', sc)
          return x, y, math.min(baseW * sc, win.x - 16), math.min(baseH * sc, win.y - 16), sc, true
        elseif mx >= resetX and mx <= resetX + btnSz then
          hudUi.reset(id)
          sc = clamp(tonumber(hudUi.get(id .. 'Scale')) or 1.0, 0.55, 2.50)
          local rnx = tonumber(hudUi.get(id .. 'X'))
          local rny = tonumber(hudUi.get(id .. 'Y'))
          local rw = math.min(baseW * sc, math.max(60, win.x - 16))
          local rh = math.min(baseH * sc, math.max(24, win.y - 16))
          local rx = (not rnx or rnx < 0) and ((win.x - rw) * 0.5) or (rnx * win.x)
          local ry = (rny or 0.04) * win.y
          return clamp(rx, 4, math.max(4, win.x - rw - 4)), clamp(ry, 4, math.max(4, win.y - rh - 4)), rw, rh, sc, true
        end
      end

      if inBody then
        if mx >= x + w - gripSz and my >= y + h - gripSz then
          hudUi.drag.activeId = id
          hudUi.drag.mode = 'resize'
          hudUi.drag.startMx = mx
          hudUi.drag.startMy = my
          hudUi.drag.startScale = sc
        else
          hudUi.drag.activeId = id
          hudUi.drag.mode = 'move'
          hudUi.drag.offX = mx - x
          hudUi.drag.offY = my - y
        end
      end
    elseif hudUi.drag.activeId == id and mdown then
      if hudUi.drag.mode == 'move' then
        x = clamp(mx - hudUi.drag.offX, 4, maxX)
        y = clamp(my - hudUi.drag.offY, 4, maxY)
        hudUi.set(id .. 'X', x / math.max(1, win.x))
        hudUi.set(id .. 'Y', y / math.max(1, win.y))
      elseif hudUi.drag.mode == 'resize' then
        local dw = (mx - hudUi.drag.startMx) / math.max(40, baseW)
        local dh = (my - hudUi.drag.startMy) / math.max(24, baseH)
        -- droite/bas = grandit, gauche/haut = rapetisse (les deux sens)
        sc = clamp(hudUi.drag.startScale + dw + dh, 0.55, 2.50)
        hudUi.set(id .. 'Scale', sc)
        w = math.min(baseW * sc, math.max(60, win.x - 16))
        h = math.min(baseH * sc, math.max(24, win.y - 16))
        x = clamp(x, 4, math.max(4, win.x - w - 4))
        y = clamp(y, 4, math.max(4, win.y - h - 4))
      end
    elseif hovered and mwheel ~= 0 and not hudUi.drag.activeId then
      sc = clamp(sc + (mwheel > 0 and 0.08 or -0.08), 0.55, 2.50)
      hudUi.set(id .. 'Scale', sc)
      w = math.min(baseW * sc, math.max(60, win.x - 16))
      h = math.min(baseH * sc, math.max(24, win.y - 16))
    end
  end

  return x, y, w, h, sc, hovered
end

function hudUi.drawControls(id, x, y, w, h, win, hovered)
  if hudUi.get('locked') == true then return end
  if not hovered and hudUi.drag.activeId ~= id then return end
  local goldCol = rgbm(0.85, 0.64, 0.28, 0.92)
  local bgCol = rgbm(0.05, 0.14, 0.18, 0.92)
  if ui.drawRect then
    ui.drawRect(vec2(x, y), vec2(x + w, y + h), goldCol, 6, 1.5)
  end
  if ui.drawLine then
    ui.drawLine(vec2(x + w - 12, y + h - 3), vec2(x + w - 3, y + h - 12), goldCol, 1.8)
    ui.drawLine(vec2(x + w - 7, y + h - 3), vec2(x + w - 3, y + h - 7), goldCol, 1.8)
  end
  local btnSz = clamp(16 * (win.y / 1080), 13, 22)
  local btnY = (y >= btnSz + 6) and (y - btnSz - 3) or (y + 2)
  local plusX = x + w - btnSz - 2
  local minusX = plusX - btnSz - 2
  local resetX = minusX - btnSz - 2
  local labels = { { resetX, 'R' }, { minusX, '-' }, { plusX, '+' } }
  for _, b in ipairs(labels) do
    ui.drawRectFilled(vec2(b[1], btnY), vec2(b[1] + btnSz, btnY + btnSz), bgCol, 3)
    if ui.drawRect then ui.drawRect(vec2(b[1], btnY), vec2(b[1] + btnSz, btnY + btnSz), goldCol, 3, 1) end
    ui.dwriteDrawText(b[2], math.max(9, btnSz * 0.68), vec2(b[1] + btnSz * 0.28, btnY + btnSz * 0.12), goldCol)
  end
end

function script.drawUI()
  guard(function()
    local win = ui.windowSize()
    if uiTime < 14 then
      ui.dwriteDrawText(string.format('%s active (CSP %s)', VERSION, tostring(build)), 13, vec2(12, 10), rgbm(1, 1, 1, 0.7))
    end
    if debugOn then
      ui.dwriteDrawText(string.format('RS start=%d phase=%d cuts=%d/%d pen=%s timeAdd=%ds',
        cfg.enabled, S.phase, pen.cuts, cfg.cutMaxBeforePenalty, pen.active and pen.active.kind or 'none', pen.totalTimePenaltySec),
        13, vec2(12, 28), hudUi.COL_AMBER)
    end

    if not isAnySystemActive() then return end

    local hudFlag = getDesiredHudFlag(clock())
    if hudFlag and hudFlag > 0 and ui.drawRaceFlag then
      pcall(ui.drawRaceFlag, hudFlag)
    end

    if cfg.hideHudWhenAppOpen == 1 and bridge and bridge.appVisible == 1 and (uiTime - (bridge.appHeartbeat or -99)) < 1.5 then
      return
    end

    local mpos, mdown, mwheel = hudUi.readMouse()
    if not mdown then
      hudUi.drag.activeId = nil
      hudUi.drag.mode = nil
    end
    local justPressed = mdown and not hudUi.drag.prevDown

    local k = win.y / 1080
    local showGreen = cfg.enabled == 1 and S.phase == PHASE_GREEN and (clock() - S.tStart) < 4500
    local showFormation = cfg.enabled == 1 and (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION)
    local inFormation = (S.phase == PHASE_FORMATION or S.phase == PHASE_READY or S.phase == PHASE_CAUTION)
    local hasPenaltyCard = (pen.active ~= nil) or (pen.note ~= nil and uiTime < pen.note.untilT)

    if showGreen or showFormation or hasPenaltyCard then
      local me = ac.getCar(0)
      local warn = nil
      if showFormation then
        warn = localState.passWarn and 'NE DEPASSEZ PAS / DROP BACK!'
          or localState.speedWarn and 'RALENTIR / TOO FAST!'
          or localState.laneWarn and ('RESTEZ EN ' .. (localState.myLane == 1 and 'FILE GAUCHE' or (localState.myLane == 2 and 'FILE DROITE' or 'FILE INDIENNE')))
          or localState.lagWarn and 'RESSERREZ L\'ECART / CLOSE GAP'
          or nil
      end
      local formH = (showFormation and warn) and 100 or 70
      local mainH = showGreen and 56 or (showFormation and formH or 0)
      local penH = pen.active and 80 or ((pen.note and uiTime < pen.note.untilT) and 42 or 0)
      local gapH = (mainH > 0 and penH > 0) and 6 or 0
      local baseBW, baseBH = 380 * k, (mainH + gapH + penH) * k
      local bx, by, bw, bh, bSc, bHov = hudUi.computeWidgetBox('banner', baseBW, math.max(30 * k, baseBH), win, mpos, mdown, mwheel, justPressed)
      -- le contenu suit la largeur réelle du cadre : rien ne dépasse, rien n'est rogné
      local kb = bw / 380 -- echelle commune largeur/hauteur : contenu = cadre (k * sc)
      local cx = bx + bw * 0.5
      local cy = by
      if ui.pushClipRect then pcall(ui.pushClipRect, vec2(bx, by), vec2(bx + bw, by + bh)) end

      if showGreen then
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 56 * kb), rgbm(0.04, 0.22, 0.10, 0.95), 8 * kb)
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 17 * kb), hudUi.COL_GREEN, 8 * kb)
        hudUi.drawCentered('GREEN FLAG — EN COURSE', 11 * kb, cx, cy + 2.5 * kb, hudUi.COL_DARK)
        hudUi.drawCentered('DRAPEAU VERT — EN COURSE', 16 * kb, cx, cy + 20 * kb, hudUi.COL_WHITE)
        hudUi.drawCentered('Limiteur coupé · Compteur personnel actif', 9 * kb, cx, cy + 41 * kb, hudUi.COL_GREEN)
        cy = cy + 60 * kb
      elseif showFormation then
        local title = (S.phase == PHASE_READY or localState.inAccelZone)
          and (localState.inAccelZone and 'ACCELERATION ZONE — PREPARE' or 'ONE TO GO — FORM UP')
          or ('ROLLING START ' .. cfg.formationMode:upper())
        if cfg.startLength == 'full' then
          title = ({ fast = 'DEPART LANCE — 3/4 TOUR A 160 km/h',
                     slow = 'REGROUPEMENT — 80 km/h',
                     wait = 'VERT AU PASSAGE DE LA LIGNE DU LEADER' })[RS.stage.stage] or title
        end
        local bgHeader = localState.inAccelZone and hudUi.COL_GREEN or hudUi.COL_GOLD
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + formH * kb), hudUi.COL_TEAL, 8 * kb)
        ui.drawRect(vec2(bx, cy), vec2(bx + bw, cy + formH * kb), hudUi.COL_GOLD, 8 * kb, 1.5)
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 24 * kb), bgHeader, 8 * kb)
        hudUi.drawCentered(title, 14 * kb, cx, cy + 5 * kb, hudUi.COL_DARK)

        local laneLabel = localState.myLane == 1 and 'FILE GAUCHE' or (localState.myLane == 2 and 'FILE DROITE' or 'FILE INDIENNE')
        local followTxt = localState.targetName and ('SUIVRE: ' .. localState.targetName) or 'VOUS MENEZ'
        hudUi.drawCentered(string.format('P%d  |  %s  |  %s', localState.mySlot, laneLabel, followTxt), 11 * kb, cx, cy + 30 * kb, hudUi.COL_WHITE)

        local speedTxt = string.format('%d / %d km/h%s  |  Green: %d m',
          math.floor((me and me.speedKmh or 0) + 0.5),
          math.floor(localState.allowedKmh + 0.5),
          localState.limiterActive and ' [LIM]' or '',
          math.floor(localState.distRemainingM + 0.5))
        hudUi.drawCentered(speedTxt, 12 * kb, cx, cy + 46 * kb, (localState.speedWarn or localState.passWarn) and hudUi.COL_RED or hudUi.COL_AMBER)

        if warn then
          ui.drawRectFilled(vec2(bx + 6 * kb, cy + 70 * kb), vec2(bx + bw - 6 * kb, cy + 96 * kb), hudUi.COL_RED, 6 * kb)
          hudUi.drawCentered(warn, 12 * kb, cx, cy + 76 * kb, hudUi.COL_WHITE)
        end
        cy = cy + formH * kb
      end
      if mainH > 0 and penH > 0 then cy = cy + gapH * kb end

      if pen.active then
        local me2 = ac.getCar(0)
        local lapsLeft = math.max(0, pen.active.deadlineLap - (me2 and me2.lapCount or 0))
        local isSG = pen.active.kind == 'stop_and_go'
        local nQ = pen.queue and #pen.queue or 0
        local hdrTxt = isSG and 'STOP & GO OBLIGATOIRE' or 'DRIVE-THROUGH OBLIGATOIRE'
        if nQ > 0 then hdrTxt = hdrTxt .. '  (+' .. nQ .. ' EN ATTENTE)' end
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 80 * kb), rgbm(0.30, 0.05, 0.05, 0.95), 8 * kb)
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 17 * kb), hudUi.COL_RED, 8 * kb)
        hudUi.drawCentered(hdrTxt, 11 * kb, cx, cy + 2.5 * kb, hudUi.COL_WHITE)
        if isSG then
          local left = math.max(0, pen.active.holdSec - pen.active.holdElapsed)
          hudUi.drawCentered(string.format('STOP & GO (%ds)', pen.active.holdSec), 15 * kb, cx, cy + 20 * kb, hudUi.COL_WHITE)
          hudUi.drawCentered(string.format('ARRET EN COURS : %.1fs RESTANT — RESTEZ IMMOBILE', left), 9 * kb, cx, cy + 37 * kb, hudUi.COL_WHITE)
          local frac = clamp(pen.active.holdElapsed / math.max(0.1, pen.active.holdSec), 0, 1)
          ui.drawRectFilled(vec2(bx + 10 * kb, cy + 48 * kb), vec2(bx + bw - 10 * kb, cy + 53 * kb), rgbm(0.2, 0.2, 0.2, 0.8), 3 * kb)
          ui.drawRectFilled(vec2(bx + 10 * kb, cy + 48 * kb), vec2(bx + 10 * kb + (bw - 20 * kb) * frac, cy + 53 * kb), hudUi.COL_GREEN, 3 * kb)
        else
          hudUi.drawCentered(string.format('DRIVE-THROUGH — %d TOUR(S) RESTANT(S)', lapsLeft), 14 * kb, cx, cy + 22 * kb, hudUi.COL_WHITE)
        end
        local ESC_LBL = { stop_and_go = 'Stop & Go', drive_through = 'Drive-through', teleport_pits = 'Retour aux stands', black_flag = 'Drapeau noir', time_penalty = '+temps' }
        local escTxt = 'Sinon : ' .. (ESC_LBL[pen.active.escKind] or 'pénalité') .. ' — délai : ' .. lapsLeft .. ' tour(s)'
        ui.drawRectFilled(vec2(bx + 6 * kb, cy + 60 * kb), vec2(bx + bw - 6 * kb, cy + 75 * kb), hudUi.COL_RED, 5 * kb)
        hudUi.drawCentered(escTxt, 9 * kb, cx, cy + 64 * kb, hudUi.COL_WHITE)
        cy = cy + 84 * kb
      elseif pen.note and uiTime < pen.note.untilT then
        ui.drawRectFilled(vec2(bx, cy), vec2(bx + bw, cy + 42 * kb), hudUi.COL_AMBER, 8 * kb)
        hudUi.drawCentered(pen.note.title .. ' — ' .. pen.note.why, 15 * kb, cx, cy + 11 * kb, hudUi.COL_DARK)
      end

      if ui.popClipRect then pcall(ui.popClipRect) end
      -- boutons R - + et cadre : dessines hors du clip, sinon ils sont coupes en haut
      hudUi.drawControls('banner', bx, by, bw, bh, win, bHov)
    end

    local showCutsWidget = (isCutSessionActive() or pen.totalTimePenaltySec > 0 or pen.active ~= nil)
    if showCutsWidget then
      local canViewPeloton, _, pelotonRoleLabel = canViewPelotonCuts()
      if canViewPeloton and not inFormation then
        local gridRows = {}
        local count = sim and sim.carsCount or 0
        for i = 0, count - 1 do
          local c = ac.getCar(i)
          if c and c.isConnected then
            local rec = stewardRecords[c.sessionID]
            if rec and (rec.cuts > 0 or rec.penKind > 0 or rec.timeAddedSec > 0 or rec.dq) then
              local pTag = rec.dq and 'DQ'
                or (rec.penKind == PEN_STOP_AND_GO and string.format('S&G(%dt)', rec.lapsLeft))
                or (rec.penKind == PEN_DRIVE_THROUGH and string.format('DT(%dt)', rec.lapsLeft))
                or 'OK'
              local addTag = rec.timeAddedSec > 0 and string.format(' +%ds', rec.timeAddedSec) or ''
              gridRows[#gridRows + 1] = {
                pos = c.racePosition or (i + 1),
                txt = string.format('P%d %s : %d cuts | %s%s', c.racePosition or (i + 1), ac.getDriverName(c.index), rec.cuts, pTag, addTag),
                alert = rec.dq or rec.penKind > 0 or rec.timeAddedSec > 0,
              }
            end
          end
        end
        table.sort(gridRows, function(a, b) return a.pos < b.pos end)

        local maxShown = math.min(#gridRows, 6)
        if maxShown > 0 then
          local basePW, basePH = 360 * k, (24 + maxShown * 18) * k
          local px, py, pw, ph, pSc, pHov = hudUi.computeWidgetBox('peloton', basePW, basePH, win, mpos, mdown, mwheel, justPressed)
          local kp = k * pSc
          ui.drawRectFilled(vec2(px, py), vec2(px + pw, py + ph), rgbm(0.06, 0.16, 0.20, 0.88), 6 * kp)
          ui.drawRectFilled(vec2(px, py), vec2(px + pw, py + 20 * kp), hudUi.COL_GOLD, 6 * kp)
          ui.dwriteDrawText('CUTS & PENALITES PELOTON — ' .. tostring(pelotonRoleLabel or 'SAFETY CAR'), 11 * kp, vec2(px + 8 * kp, py + 4 * kp), hudUi.COL_DARK)
          for j = 1, maxShown do
            ui.dwriteDrawText(gridRows[j].txt, 12 * kp, vec2(px + 8 * kp, py + (20 + (j - 1) * 18) * kp),
              gridRows[j].alert and hudUi.COL_RED or hudUi.COL_WHITE)
          end
          hudUi.drawControls('peloton', px, py, pw, ph, win, pHov)
        end
      end

      -- Compteur personnel de cuts (déplaçable, redimensionnable) + pénalité en cours
      local meC = ac.getCar(0)
      local quota = math.max(0, (pen.hadCutPenalty and cfg.cutRepeatEvery > 0) and cfg.cutRepeatEvery or cfg.cutMaxBeforePenalty or 3)
      local showCount = (not inFormation) and isCutSessionActive()
      local dotCount = showCount and math.min(quota, 5) or 0
      local baseTxt = string.format('Cuts : %d/%d', pen.cutsSincePenalty, quota)
      local timeTxt = pen.totalTimePenaltySec > 0 and string.format('+%ds', pen.totalTimePenaltySec) or ''
      local penTxt = nil
      if pen.active then
        local lapsLeft = math.max(0, pen.active.deadlineLap - (meC and meC.lapCount or 0))
        local srcTxt = (pen.active.reasonCode == PEN_REASON_JUMP and 'DEPART ANTICIPE')
          or (pen.active.reasonCode == PEN_REASON_FORMATION and 'FORMATION')
          or (pen.active.reasonCode == PEN_REASON_CUT and 'CUT')
          or 'PENALITE'
        if pen.active.kind == 'stop_and_go' then
          local rest = math.max(0, (pen.active.holdSec or 0) - (pen.active.holdElapsed or 0))
          penTxt = string.format('%s : STOP & GO %.0fs (reste %.0fs) — %d tour(s)', srcTxt, pen.active.holdSec or 0, rest, lapsLeft)
        else
          penTxt = string.format('%s : DRIVE-THROUGH — %d tour(s)', srcTxt, lapsLeft)
        end
      end
      local rawBaseW = ui.measureDWriteText and ui.measureDWriteText(baseTxt, 12 * k).x or 74 * k
      local rawTimeW = timeTxt ~= '' and (ui.measureDWriteText and ui.measureDWriteText(timeTxt, 12 * k).x + 12 * k or 44 * k) or 0
      local rawDotsW = dotCount > 0 and (10 + dotCount * 10) * k or 0
      local rawPenW = penTxt and ((ui.measureDWriteText and ui.measureDWriteText(penTxt, 11 * k).x or #penTxt * 6 * k) + 16 * k) or 0
      if showCount or penTxt then
        local rowH = showCount and 26 * k or 0
        local penRowH = penTxt and 20 * k or 0
        local baseCW = math.max(124 * k, 18 * k + (showCount and (rawBaseW + rawDotsW + rawTimeW) or 0), rawPenW)
        local baseCH = rowH + penRowH

        local cx0, cy0, cw, ch, cSc, cHov = hudUi.computeWidgetBox('cuts', baseCW, baseCH, win, mpos, mdown, mwheel, justPressed)
        local kc = cw / math.max(1, baseCW)
        ui.drawRectFilled(vec2(cx0, cy0), vec2(cx0 + cw, cy0 + ch), rgbm(0.06, 0.16, 0.20, 0.78), 6 * kc)
        if ui.pushClipRect then pcall(ui.pushClipRect, vec2(cx0, cy0), vec2(cx0 + cw, cy0 + ch)) end

        if showCount then
          local fzC = 12 * kc
          local rowMid = cy0 + rowH * kc * 0.5
          local cutColor = (pen.active or pen.disqualified) and hudUi.COL_RED
            or ((quota > 0 and pen.cutsSincePenalty >= quota) and hudUi.COL_AMBER or rgbm(0.96, 0.93, 0.85, 0.90))
          ui.dwriteDrawText(baseTxt, fzC, vec2(cx0 + 8 * kc, rowMid - fzC * 0.6), cutColor)
          if dotCount > 0 and ui.drawCircleFilled then
            local filledN = math.min(pen.cutsSincePenalty, dotCount)
            local textW = rawBaseW * kc
            local startX = cx0 + 8 * kc + textW + 10 * kc
            for d = 1, dotCount do
              local dCol = (d <= filledN)
                and ((filledN >= dotCount) and hudUi.COL_RED or hudUi.COL_AMBER)
                or rgbm(0.96, 0.93, 0.85, 0.22)
              ui.drawCircleFilled(vec2(startX + (d - 1) * 10 * kc, rowMid), 3 * kc, dCol)
            end
          end
          if timeTxt ~= '' then
            local tw = rawTimeW * kc
            ui.dwriteDrawText(timeTxt, fzC, vec2(cx0 + cw - tw + 4 * kc, rowMid - fzC * 0.6), hudUi.COL_AMBER)
          end
        end

        if penTxt then
          local py0 = cy0 + rowH * kc
          ui.drawRectFilled(vec2(cx0 + 4 * kc, py0 + 2 * kc), vec2(cx0 + cw - 4 * kc, py0 + penRowH * kc - 2 * kc), hudUi.COL_RED, 4 * kc)
          local fzP = 11 * kc
          ui.dwriteDrawText(penTxt, fzP, vec2(cx0 + 8 * kc, py0 + (penRowH * kc - fzP) * 0.5), hudUi.COL_WHITE)
        end

        if ui.popClipRect then pcall(ui.popClipRect) end
        hudUi.drawControls('cuts', cx0, cy0, cw, ch, win, cHov)
      end
    end

    hudUi.drag.prevDown = mdown
  end)()
end

function script.draw3D()
  guard(function()
    if not isRollingSessionActive() then return end
    if S.phase ~= PHASE_FORMATION and S.phase ~= PHASE_READY and S.phase ~= PHASE_CAUTION then return end
    if cfg.hideHudWhenAppOpen == 1 and bridge and bridge.appVisible == 1 and (uiTime - (bridge.appHeartbeat or -99)) < 1.5 then
      return
    end
    local p = ac.trackCoordinateToWorld(vec3(0, 0, paceSpline()))
    render.debugArrow(p + vec3(0, 10, 0), p + vec3(0, 1.6, 0), 1.2, hudUi.COL_AMBER)
    render.debugText(p + vec3(0, 11.5, 0), string.format('PACE %d KM/H', cfg.paceKmh), hudUi.COL_AMBER, 1.4)
  end)()
end

safeLog(string.format('loaded %s (CSP %s) start=%s cut=%d jump=%d',
  VERSION, tostring(build), cfg.enabled == 1 and cfg.formationMode or 'standing', cfg.cutEnabled, cfg.jumpEnabled))

if GDSP_RS_TEST then
  return {
    state = function() return S end,
    cfg = function() return cfg end,
    localState = function() return localState end,
    pen = function() return pen end,
    standingWatch = function() return standingWatch end,
    stewardRecords = function() return stewardRecords end,
    cutZones = function() return cutZones end,
    bridge = function() return bridge end,
    stats = function() return stats end,
    lastError = function() return lastError end,
    paceSpline = paceSpline,
    desiredHudFlag = function() return getDesiredHudFlag(clock()) end,
    canViewPelotonCuts = canViewPelotonCuts,
    designatedStewardSid = function() return designatedStewardSid end,
    hudLayout = function() return hudUi.mem end,
    handleChatCommand = handleChatCommand,
    startFormation = startFormation,
    triggerGreen = triggerGreen,
    broadcastCfg = broadcastCfg,
    sendAdminAction = sendAdminAction,
    syncLocalStewardRecord = syncLocalStewardRecord,
    buildStewardCsv = buildStewardCsv,
    flushOutbox = flushOutbox,
  }
end

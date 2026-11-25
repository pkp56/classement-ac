-- GDSP Rolling Start — départ lancé progressif ([SCRIPT_1])
--
-- Script CSP Lua en ligne poussé par le serveur via `csp_extra_options.ini` :
--   [SCRIPT_1]
--   SCRIPT = 'https://gdsp.duckdns.org/csp/rollingstart.lua'
--   REQUIRED = 0
--
-- Note : GDSP dispose également du script complet Race Control + formation +
-- commissaires à `/csp/rolling_start.lua` (configurateur `/race-control.html`).
-- Ce script `rollingstart.lua` fournit le départ lancé léger et autonome :
--   1. À l'extinction des feux d'une session Course, mise en mouvement
--      progressive vers la vitesse cible configurable (`launchSpeedKmh`,
--      60 km/h par défaut dans la plage 40–80 km/h).
--   2. Même consigne de vitesse appliquée à toutes les voitures pour ne créer
--      aucun avantage et sans toucher aux compteurs de tours ni aux chronos.
--   3. Désactivation propre après la rampe (`rampDurationSec`) ou sur tout
--      redémarrage / changement de session, avec relâchement systématique des
--      contrôles et capture de toute erreur via `pcall` (retour immédiat au
--      comportement normal du jeu).
--   4. Annonce chat au signal de départ (« Départ lancé — rolling start »).

local VERSION = 'GDSP-ROLLINGSTART 1.0.0'

local CFG_DEFAULTS = {
  enabled = 1,
  launchSpeedKmh = 60,     -- vitesse cible au lancement (40–80 km/h par défaut, bornée 30–140)
  minSpeedKmh = 40,        -- borne basse recommandée de la plage de croisière
  maxSpeedKmh = 80,        -- borne haute recommandée de la plage de croisière
  rampDurationSec = 6.0,   -- durée de la rampe progressive à partir du signal (s)
  speedToleranceKmh = 2.5, -- tolérance autour de la consigne avant régulation douce
  everySession = 0,        -- 0 = uniquement en session Course ; 1 = toutes sessions (essais)
  announceChat = 1,        -- 1 = message chat au départ
  debug = 0,
}

-------------------------------------------------------------------------------
-- Utilitaires défensifs : toute lecture / action physique passe par `pcall`.
-------------------------------------------------------------------------------
local function clamp(x, lo, hi)
  if x < lo then return lo end
  if x > hi then return hi end
  return x
end

local function safeField(obj, key)
  if obj == nil then return nil end
  local ok, v = pcall(function() return obj[key] end)
  if ok then return v end
  return nil
end

local function safeNum(obj, key, fallback)
  local v = safeField(obj, key)
  local n = tonumber(v)
  if n ~= nil and n == n then return n end
  return fallback
end

local function safeBool(obj, key)
  return safeField(obj, key) == true
end

local function safeLog(msg)
  if type(ac) == 'table' and type(ac.log) == 'function' then
    pcall(ac.log, '[GDSP-ROLLING] ' .. tostring(msg))
  end
end

local function sanitizeCfg(raw)
  local c = {}
  for k, def in pairs(CFG_DEFAULTS) do
    local v = raw and raw[k]
    if v == nil or v == '' then
      c[k] = def
    else
      c[k] = tonumber(v) or def
    end
  end
  c.enabled = c.enabled ~= 0 and 1 or 0
  c.minSpeedKmh = clamp(c.minSpeedKmh, 20, 160)
  c.maxSpeedKmh = clamp(math.max(c.minSpeedKmh, c.maxSpeedKmh), 20, 180)
  c.launchSpeedKmh = clamp(c.launchSpeedKmh, 30, 160)
  c.rampDurationSec = clamp(c.rampDurationSec, 1.5, 25.0)
  c.speedToleranceKmh = clamp(c.speedToleranceKmh, 0.5, 15.0)
  c.everySession = c.everySession ~= 0 and 1 or 0
  c.announceChat = c.announceChat ~= 0 and 1 or 0
  c.debug = c.debug ~= 0 and 1 or 0
  return c
end

local sim = (type(ac) == 'table' and type(ac.getSim) == 'function') and ac.getSim() or nil
local okCfg, readCfg = false, nil
if type(ac) == 'table' and type(ac.configValues) == 'function' then
  okCfg, readCfg = pcall(ac.configValues, CFG_DEFAULTS)
end
local cfg = sanitizeCfg(okCfg and readCfg or CFG_DEFAULTS)

local RACE_TYPE = (type(ac) == 'table' and type(ac.SessionType) == 'table' and ac.SessionType.Race) or 3

-------------------------------------------------------------------------------
-- État d'exécution et synchronisation réseau de l'instant exact de départ.
-------------------------------------------------------------------------------
local PHASE_WAIT_START = 0
local PHASE_RAMPING = 1
local PHASE_RELEASED = 2

local state = {
  now = 0,
  phase = PHASE_WAIT_START,
  rampStartedAt = nil,
  targetKmh = cfg.launchSpeedKmh,
  currentCapKmh = 0,
  announced = false,
  controlsTouched = false,
  lastSessionIdx = -1,
  lastSessionTimeMs = 0,
  hadError = false,
}

local function getCar(idx)
  if type(ac) ~= 'table' or type(ac.getCar) ~= 'function' then return nil end
  local ok, c = pcall(ac.getCar, idx)
  if ok then return c end
  return nil
end

-- Relâche immédiatement toute consigne de pédale pour ne jamais laisser une
-- voiture bloquée après la rampe, un redémarrage ou une exception.
local function releaseControls()
  if not state.controlsTouched then return end
  state.controlsTouched = false
  if type(physics) ~= 'table' then return end
  local me = getCar(0)
  local userGas = clamp(safeNum(me, 'gas', 0), 0, 1)
  local userBrake = clamp(safeNum(me, 'brake', 0), 0, 1)
  if type(physics.forceUserThrottleFor) == 'function' then
    pcall(physics.forceUserThrottleFor, 0.001, userGas)
  end
  if type(physics.forceUserBrakesFor) == 'function' then
    pcall(physics.forceUserBrakesFor, 0.001, userBrake)
  end
end

local function resetState()
  pcall(releaseControls)
  state.phase = PHASE_WAIT_START
  state.rampStartedAt = nil
  state.targetKmh = cfg.launchSpeedKmh
  state.currentCapKmh = 0
  state.announced = false
  state.hadError = false
end

if type(ac) == 'table' and type(ac.onSessionStart) == 'function' then
  pcall(ac.onSessionStart, resetState)
end

-- Synchronisation optionnelle via `ac.OnlineEvent` pour que tous les clients
-- partagent la même vitesse cible et le même instant de déclenchement.
local sendStartEvt, accessStartEvt = nil, nil

local function onStartSync(_sender, message)
  if not message then return end
  local tgt = tonumber(message.targetKmh)
  if tgt and tgt >= 20 and tgt <= 180 then
    state.targetKmh = tgt
  end
  if tonumber(message.phase) == PHASE_RAMPING and state.phase == PHASE_WAIT_START then
    state.phase = PHASE_RAMPING
    state.rampStartedAt = state.now
  elseif tonumber(message.phase) == PHASE_WAIT_START and state.phase ~= PHASE_WAIT_START then
    resetState()
  end
end

if type(ac) == 'table' and type(ac.OnlineEvent) == 'function' and type(ac.StructItem) == 'table' then
  local okE, sE, aE = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('gdspRollingStartSync'),
      phase = ac.StructItem.uint8(),
      targetKmh = ac.StructItem.uint8(),
      rampDs = ac.StructItem.uint8(),
    }, onStartSync)
  end)
  if okE then sendStartEvt, accessStartEvt = sE, aE end
end

local function isAuthority()
  if not sim or not safeBool(sim, 'isOnlineRace') then return true end
  if safeBool(sim, 'isAdmin') then return true end
  local me = getCar(0)
  if me and safeNum(me, 'racePosition', 99) == 1 then return true end
  return safeNum(me, 'index', -1) == 0 and not safeBool(sim, 'isOnlineRace')
end

local function isRaceSession()
  if cfg.everySession == 1 then return true end
  local t = safeField(sim, 'raceSessionType')
  if t == nil and type(ac) == 'table' and type(ac.getSession) == 'function' then
    local idx = safeNum(sim, 'currentSessionIndex', 0)
    local ok, sess = pcall(ac.getSession, idx)
    if ok and sess then t = safeField(sess, 'type') end
  end
  return t == RACE_TYPE
end

local function hasStartSignalFired()
  if not sim then return false end
  -- En AC / CSP : `timeToSessionStart <= 0` et `isSessionStarted == true`
  -- marquent l'extinction des feux au départ de la course.
  local started = safeField(sim, 'isSessionStarted')
  if started == false then return false end
  local tts = safeNum(sim, 'timeToSessionStart', nil)
  if tts ~= nil and tts > 0 then return false end
  local sessTime = safeNum(sim, 'currentSessionTime', nil)
  if started == true then return true end
  return sessTime ~= nil and sessTime > 0 and (tts == nil or tts <= 0)
end

-------------------------------------------------------------------------------
-- Application progressive et uniforme de la consigne sur la voiture locale
-- (chaque client exécute le même script poussé par le serveur avec les mêmes
-- paramètres -> même vitesse cible pour tout le peloton, sans téléportation ni
-- altération de `lapCount` / `splinePosition`).
-------------------------------------------------------------------------------
local function computeTargetEnvelopeKmh(elapsedSec)
  local dur = math.max(0.5, cfg.rampDurationSec)
  local progress = clamp(elapsedSec / dur, 0, 1)
  -- Courbe lisse (smoothstep) de 0 jusqu'à `state.targetKmh` pour éviter tout
  -- patinage brutal à l'extinction des feux.
  local smooth = progress * progress * (3 - 2 * progress)
  local baseFloor = math.min(18, state.targetKmh * 0.35)
  return baseFloor + (state.targetKmh - baseFloor) * smooth, progress
end

local function applyProgressiveLaunch(elapsedSec)
  local capKmh, progress = computeTargetEnvelopeKmh(elapsedSec)
  state.currentCapKmh = capKmh

  local me = getCar(0)
  if not me then return progress >= 1 end
  if safeBool(me, 'isInPit') or safeBool(me, 'isInPitlane') then
    releaseControls()
    return progress >= 1
  end

  local speed = safeNum(me, 'speedKmh', 0)
  local tol = cfg.speedToleranceKmh
  if type(physics) == 'table' and type(physics.forceUserThrottleFor) == 'function' then
    if speed < capKmh - tol then
      -- Accompagnement progressif à l'accélération jusqu'à la vitesse de lancement.
      local deficit = clamp((capKmh - speed) / math.max(15, state.targetKmh), 0.15, 0.85)
      local userGas = clamp(safeNum(me, 'gas', 0), 0, 1)
      local appliedGas = math.max(userGas, deficit)
      state.controlsTouched = true
      pcall(physics.forceUserThrottleFor, 0.08, appliedGas)
    elseif speed > state.targetKmh + tol then
      -- Écrêtage doux au-dessus de la vitesse cible pour que personne ne prenne
      -- d'élan supérieur au reste de la grille avant la fin de la rampe.
      local over = speed - (state.targetKmh + tol)
      local maxGas = clamp(1 - over / 12, 0, 0.35)
      state.controlsTouched = true
      pcall(physics.forceUserThrottleFor, 0.08, math.min(clamp(safeNum(me, 'gas', 0), 0, 1), maxGas))
      if over > 6 and type(physics.forceUserBrakesFor) == 'function' then
        local brk = clamp((over - 6) / 30, 0, 0.35)
        pcall(physics.forceUserBrakesFor, 0.08, math.max(clamp(safeNum(me, 'brake', 0), 0, 1), brk))
      end
    end
  end

  return progress >= 1
end

local function triggerRollingStart()
  state.phase = PHASE_RAMPING
  state.rampStartedAt = state.now
  state.targetKmh = cfg.launchSpeedKmh
  if isAuthority() then
    if sendStartEvt and accessStartEvt then
      pcall(function()
        local p = accessStartEvt()
        p.phase = PHASE_RAMPING
        p.targetKmh = math.floor(clamp(state.targetKmh, 20, 180) + 0.5)
        p.rampDs = math.floor(clamp(cfg.rampDurationSec * 10, 10, 250) + 0.5)
        sendStartEvt()
      end)
    end
    if not state.announced and cfg.announceChat == 1 then
      state.announced = true
      if type(ac) == 'table' and type(ac.sendChatMessage) == 'function' then
        pcall(ac.sendChatMessage, string.format(
          'Départ lancé — rolling start (%d km/h)',
          math.floor(state.targetKmh + 0.5)
        ))
      end
    else
      state.announced = true
    end
  end
end

-------------------------------------------------------------------------------
-- Boucle principale protégée : toute exception relâche immédiatement les
-- contrôles et bascule en `PHASE_RELEASED` pour rendre la main aux pilotes.
-------------------------------------------------------------------------------
script = script or {}

function script.update(dt)
  local ok, err = pcall(function()
    dt = tonumber(dt) or 0
    if dt < 0 then dt = 0 end
    state.now = state.now + dt

    -- Détection de changement ou de redémarrage de session (horloge qui recule).
    local sessIdx = safeNum(sim, 'currentSessionIndex', -1)
    local sessTimeMs = safeNum(sim, 'currentSessionTime', 0)
    local started = safeField(sim, 'isSessionStarted')
    if (state.lastSessionIdx ~= -1 and sessIdx ~= state.lastSessionIdx)
      or (sessTimeMs + 2500 < state.lastSessionTimeMs)
      or (started == false and state.phase ~= PHASE_WAIT_START) then
      resetState()
    end
    state.lastSessionIdx = sessIdx
    state.lastSessionTimeMs = sessTimeMs

    if cfg.enabled ~= 1 or state.hadError or not isRaceSession() then
      releaseControls()
      return
    end

    if state.phase == PHASE_WAIT_START then
      if hasStartSignalFired() then
        triggerRollingStart()
      end
    end

    if state.phase == PHASE_RAMPING then
      local elapsed = state.now - (state.rampStartedAt or state.now)
      local finished = applyProgressiveLaunch(elapsed)
      if finished then
        releaseControls()
        state.phase = PHASE_RELEASED
      end
    elseif state.phase == PHASE_RELEASED then
      releaseControls()
    end
  end)

  if not ok then
    state.hadError = true
    state.phase = PHASE_RELEASED
    pcall(releaseControls)
    if cfg.debug == 1 then safeLog('fallback to normal after error: ' .. tostring(err)) end
  end
end

-- Export interne non intrusif pour vérification unitaire hors jeu (fengari).
__GDSP_ROLLINGSTART__ = {
  version = VERSION,
  cfg = cfg,
  state = state,
  resetState = resetState,
  computeTargetEnvelopeKmh = computeTargetEnvelopeKmh,
}

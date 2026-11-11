-- GDSP Rolling Start & Race Control — Content Manager Lua App Entry Point
-- Works in Hybrid mode (connected to server CSP Online Script via shared memory IPC)
-- AND falls back gracefully to standalone/chat-command mode if the online script is absent.

local proto = require('rs_protocol')
local hud = require('rs_hud')
local admin = require('rs_admin')

local sim = ac.getSim()
local uiTime = 0
-- heartbeat = compteur incremente par le script (processus different : pas d'horloge commune)
local appBeatCount = 0
local seenScriptVal, seenScriptAt = nil, -99
local lastClock = 0
local lastSessionIdx = sim and sim.currentSessionIndex or -1
local hudVisible = false
local adminVisible = false
local bridge = nil
local storage = nil

pcall(function()
  storage = ac.storage({
    hideOnlineBanner = true,
    trackZonesJson = '{}',
    hudScale = 1.0,
    cutsScale = 1.0,
  })
end)

local localPrefs = {
  hideOnlineBanner = not (storage and storage.hideOnlineBanner == false),
  showCutsInSim = not (storage and storage.showCutsInSim == false),
  hudScale = (storage and tonumber(storage.hudScale)) or 1.0,
  cutsScale = (storage and tonumber(storage.cutsScale)) or 1.0,
}

local cfg = proto.copyCfg(proto.CFG_DEFAULTS)

local function readServerIniDefaults()
  pcall(function()
    local ini = ac.INIConfig.onlineExtras()
    if not ini then return end
    for name, _ in pairs(ini.sections) do
      if type(name) == 'string' and name:find('^SCRIPT') then
        local scr = tostring(ini:get(name, 'SCRIPT', '') or '')
        if scr:find('rolling_start', 1, true) or ini:get(name, 'formationMode', '') ~= '' or ini:get(name, 'cutEnabled', '') ~= '' then
          for k, def in pairs(proto.CFG_DEFAULTS) do
            local val = ini:get(name, k, def)
            if val ~= nil then cfg[k] = val end
          end
          cfg = proto.sanitizeCfg(cfg)
          break
        end
      end
    end
  end)
end
readServerIniDefaults()

do
  local ns = ac.SharedNamespace and ac.SharedNamespace.Shared or 'shared'
  local okB, b = pcall(ac.connect, proto.createBridgeLayout(), true, ns)
  if okB and b then bridge = b end
end

local state = {
  seq = 0,
  cfgSeq = 0,
  phase = proto.PHASE_IDLE,
  reason = proto.REASON_NONE,
  tStart = 0,
  s0 = 0,
  order = {},
  mySlot = 0,
  myRow = 0,
  myLane = 0,
  targetId = -1,
  partnerId = -1,
  targetName = nil,
  partnerName = nil,
  slotDeltaM = 0,
  aheadGapM = 0,
  partnerDeltaM = 0,
  lateralNorm = 0,
  allowedKmh = cfg.paceKmh,
  limiterCapKmh = cfg.paceKmh,
  limiterActive = false,
  inAccelZone = false,
  distRemainingM = 0,
  strikes = 0,
  penOwed = 0,
  penDriving = 0,
  speedWarn = false,
  passWarn = false,
  lagWarn = false,
  laneWarn = false,
  onlineCount = 0,
  netSent = 0,
  netGot = 0,

  -- Steward & Cut telemetry
  cutsCount = 0,
  cutsQuota = cfg.cutMaxBeforePenalty,
  activePenKind = proto.PEN_NONE,
  activePenReason = proto.PEN_REASON_NONE,
  activePenLapsLeft = 0,
  activePenHoldLeft = 0,
  activePenEscalated = false,
  totalTimePenaltySec = 0,
  jumpWarn = false,
  disqualified = false,
  canViewPeloton = false,
  pelotonRole = '',
  designatedStewardSid = nil,
  stewardMap = {},
}

local standalone = {
  startWatch = {},
  cutOffTime = 0,
  lastCutAt = -100,
  countedOff = false,
  activePen = nil,
  cutsSince = 0,
}

local function isBridgeActive()
  if not bridge then return false end
  local v = bridge.scriptHeartbeat
  if v ~= seenScriptVal then seenScriptVal = v; seenScriptAt = uiTime end
  return v > 0 and (uiTime - seenScriptAt) < 1.5
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

local function findDriverNameBySession(cars, sid)
  if not sid or sid < 0 then return nil end
  local c = cars[sid]
  return c and ac.getDriverName(c.index) or nil
end

local function computeLocalPelotonAccess()
  local me = ac.getCar(0)
  local mySid = me and me.sessionID or -1
  local isAdmin = sim and sim.isAdmin == true or false
  local isOnline = sim and sim.isOnlineRace == true or false
  local p1Sid = state.order and state.order[1] or nil
  local list = {}
  local count = sim and sim.carsCount or 0
  for i = 0, count - 1 do
    local c = ac.getCar(i)
    if c and c.isConnected then
      if (p1Sid == nil) and (c.racePosition == 1) and not c.isRetired then
        p1Sid = c.sessionID
      end
      local okCid, cid = pcall(function() return ac.getCarID and ac.getCarID(c.index) or '' end)
      list[#list + 1] = {
        sessionID = c.sessionID,
        carId = okCid and cid or '',
        driverName = ac.getDriverName(c.index),
      }
    end
  end
  local allowed, role = proto.resolvePelotonAccess(cfg, mySid, isAdmin, isOnline, state.designatedStewardSid, p1Sid, list)
  return allowed == true, role or ''
end

local lastChatSendAt = -99
local function sendCommand(cmdType, maybeCfg, action, targetSid, param)
  if isBridgeActive() and bridge then
    if maybeCfg then
      proto.writeCfgToBridge(bridge, maybeCfg, true)
    end
    bridge.cmdAction = action or 0
    bridge.cmdTargetSid = targetSid or proto.NONE
    bridge.cmdParam = param or 0
    bridge.cmdType = cmdType
    bridge.cmdSeq = (bridge.cmdSeq or 0) + 1
    return
  end

  if sim and sim.isOnlineRace then
    -- anti-spam : au plus un message de commande par 4 s (le chat est partage avec tous les pilotes)
    if uiTime - lastChatSendAt < 4 then return end
    lastChatSendAt = uiTime
    if cmdType == proto.CMD_START then pcall(ac.sendChatMessage, '!rs start')
    elseif cmdType == proto.CMD_READY then pcall(ac.sendChatMessage, '!rs ready')
    elseif cmdType == proto.CMD_GREEN then pcall(ac.sendChatMessage, '!green')
    elseif cmdType == proto.CMD_RESET then pcall(ac.sendChatMessage, '!rs reset')
    elseif cmdType == proto.CMD_CLEAR_PENALTY then pcall(ac.sendChatMessage, '!rs clear')
    elseif cmdType == proto.CMD_ADMIN_ACTION then
      if action == proto.ACT_CLEAR_ALL then pcall(ac.sendChatMessage, '!rs clearall')
      elseif action == proto.ACT_RESET_CUTS then pcall(ac.sendChatMessage, '!rs resetcuts')
      elseif action == proto.ACT_SET_STEWARD then
        if targetSid == proto.NONE or param == 0 then
          pcall(ac.sendChatMessage, '!rs steward off')
        else
          local cars = activeCars()
          local dname = findDriverNameBySession(cars, targetSid)
          if dname and dname ~= '' then pcall(ac.sendChatMessage, '!rs steward ' .. dname) end
        end
      end
    elseif cmdType == proto.CMD_APPLY_CFG and maybeCfg then
      -- pas de spam de chat : les reglages ne passent que par le bridge (sinon non appliques)
      cfg = proto.copyCfg(maybeCfg)
    end
    return
  end

  -- Offline / Singleplayer standalone simulation mode
  local now = (sim and sim.currentSessionTime) or 0
  if cmdType == proto.CMD_APPLY_CFG and maybeCfg then
    cfg = proto.copyCfg(maybeCfg)
  elseif cmdType == proto.CMD_CLEAR_PENALTY then
    state.activePenKind = proto.PEN_NONE
    state.disqualified = false
    standalone.activePen = nil
  elseif cmdType == proto.CMD_ADMIN_ACTION then
    if action == proto.ACT_CLEAR_ALL or action == proto.ACT_CLEAR_ONE then
      state.activePenKind = proto.PEN_NONE
      state.disqualified = false
      standalone.activePen = nil
    elseif action == proto.ACT_RESET_CUTS then
      state.cutsCount = 0
      state.totalTimePenaltySec = 0
      state.activePenKind = proto.PEN_NONE
      standalone.cutsSince = 0
      standalone.activePen = nil
    elseif action == proto.ACT_ADD_TIME then
      state.totalTimePenaltySec = state.totalTimePenaltySec + (param or 10)
    elseif action == proto.ACT_SET_STEWARD then
      state.designatedStewardSid = (targetSid ~= proto.NONE and param ~= 0) and targetSid or nil
    end
  elseif cmdType == proto.CMD_START then
    local cars = activeCars()
    local list = {}
    for _, c in pairs(cars) do
      if not c.isInPitlane then list[#list + 1] = c end
    end
    table.sort(list, function(a, b)
      local pa, pb = a.racePosition or 0, b.racePosition or 0
      if pa > 0 and pb > 0 and pa ~= pb then return pa < pb end
      return proto.frac(0.5 - a.splinePosition) < proto.frac(0.5 - b.splinePosition)
    end)
    state.order = {}
    for i = 1, #list do state.order[i] = list[i].sessionID end
    state.s0 = list[1] and list[1].splinePosition or 0
    state.tStart = math.floor(now)
    state.phase = proto.PHASE_FORMATION
    state.seq = state.seq + 1
  elseif cmdType == proto.CMD_READY then
    if state.phase == proto.PHASE_FORMATION then state.phase = proto.PHASE_READY end
  elseif cmdType == proto.CMD_GREEN then
    state.phase = proto.PHASE_GREEN
    state.tStart = math.floor(now)
  elseif cmdType == proto.CMD_CAUTION then
    state.phase = proto.PHASE_CAUTION
  elseif cmdType == proto.CMD_RESET then
    state.phase = proto.PHASE_IDLE
    state.seq = 0
  end
end

local function updateStandalone(dt)
  local cars = activeCars()
  local me = ac.getCar(0)
  if not me then return end
  local len = (sim.trackLengthM and sim.trackLengthM > 50) and sim.trackLengthM or 1000
  local now = sim.currentSessionTime or 0
  local raceType = ac.SessionType and ac.SessionType.Race or 3

  if cfg.enabled == 1 and state.phase == proto.PHASE_IDLE then
    if sim.raceSessionType == raceType then
      local tts = sim.timeToSessionStart
      if tts and tts > 500 then standalone.startWatch.armed = true end
      if me.speedKmh < 12 and now < 120000 then standalone.startWatch.seen = true end
      if standalone.startWatch.seen and ((standalone.startWatch.armed and (tts or -1) <= 0) or (not standalone.startWatch.armed and now > 2500 and me.speedKmh > 12)) then
        if not sim.isOnlineRace then sendCommand(proto.CMD_START) end
      end
    end
  end

  -- Standalone cut tracking preview (for solo offline testing)
  local cutActive = cfg.cutEnabled == 1 and (cfg.cutEverySession == 1 or cfg.everySession == 1 or sim.raceSessionType == raceType)
  local formationActive = cfg.enabled == 1 and state.phase ~= proto.PHASE_GREEN
  if cutActive and not formationActive and not me.isInPitlane and me.speedKmh >= cfg.cutMinSpeedKmh then
    local zones = proto.parseCutZones(cfg.cutDisabledZones)
    if not proto.isSplineInZones(me.splinePosition, zones) then
      local off = cfg.cutUseKunosInvalid == 1 and (me.isLapValid == false) or ((me.wheelsOutside or 0) >= cfg.cutWheelsMin)
      if off then
        standalone.cutOffTime = standalone.cutOffTime + dt
        if not standalone.countedOff and standalone.cutOffTime >= cfg.cutMinDurationSec and (uiTime - standalone.lastCutAt) >= cfg.cutCooldownSec then
          standalone.countedOff = true
          standalone.lastCutAt = uiTime
          state.cutsCount = state.cutsCount + 1
          standalone.cutsSince = standalone.cutsSince + 1
          if standalone.cutsSince >= (cfg.cutMaxBeforePenalty + 1) then
            standalone.cutsSince = 0
            state.cutsCount = 0
            if cfg.cutPenaltyType == 'stop_and_go' then
              state.activePenKind = proto.PEN_STOP_AND_GO
              state.activePenHoldLeft = cfg.cutStopGoSec
              state.activePenLapsLeft = cfg.cutServeLaps
            elseif cfg.cutPenaltyType == 'drive_through' then
              state.activePenKind = proto.PEN_DRIVE_THROUGH
              state.activePenLapsLeft = cfg.cutServeLaps
            elseif cfg.cutPenaltyType == 'time_penalty' then
              state.totalTimePenaltySec = state.totalTimePenaltySec + cfg.cutTimePenaltySec
            end
          end
        end
      else
        standalone.cutOffTime = 0
        standalone.countedOff = false
      end
    end
  end

  if cfg.enabled ~= 1 or (state.phase ~= proto.PHASE_FORMATION and state.phase ~= proto.PHASE_READY and state.phase ~= proto.PHASE_CAUTION) then
    state.limiterActive = false
    state.inAccelZone = false
    return
  end

  local idx = 1
  for i, id in ipairs(state.order) do
    if id == me.sessionID then idx = i; break end
  end
  local row, laneName, _, slotOffsetM = proto.slotAssignment(idx, cfg)
  state.mySlot = idx
  state.myRow = row
  state.myLane = laneName == 'left' and 1 or (laneName == 'right' and 2 or 0)
  state.allowedKmh = cfg.paceKmh

  local pDist = math.max(0, (now - state.tStart) / 1000) * (cfg.paceKmh / 3.6)
  local targetDist = proto.computeTargetDistanceM(state.s0, cfg, len)
  state.distRemainingM = math.max(0, targetDist - pDist)
  local paceS = proto.frac(state.s0 + pDist / len)
  local slotS = proto.frac(paceS - slotOffsetM / len)
  state.slotDeltaM = proto.wrapSigned(slotS - me.splinePosition) * len

  if cfg.startLength == 'short' then
    local readyT = targetDist * 0.70
    local zoneT = targetDist * 0.85
    state.inAccelZone = pDist >= zoneT
    if state.phase == proto.PHASE_FORMATION and pDist >= readyT then state.phase = proto.PHASE_READY end
    if cfg.greenTrigger ~= 'manual' then
      local trig = cfg.autoGreenAt == 'zone' and zoneT or targetDist
      if pDist >= trig and not sim.isOnlineRace then sendCommand(proto.CMD_GREEN) end
    end
  else
    local readyW = proto.forwardArc(cfg.oneToGoSpline, cfg.greenLineSpline) * len
    local accelW = proto.forwardArc(cfg.accelZoneStart, cfg.greenLineSpline) * len
    if readyW < 100 then readyW = len * 0.25 end
    if accelW < 40 then accelW = len * 0.12 end
    state.inAccelZone = state.distRemainingM <= accelW
    if state.phase == proto.PHASE_FORMATION and state.distRemainingM <= readyW then state.phase = proto.PHASE_READY end
    if cfg.greenTrigger ~= 'manual' and not sim.isOnlineRace and ((cfg.autoGreenAt == 'zone' and state.inAccelZone) or state.distRemainingM <= 2.5) then
      sendCommand(proto.CMD_GREEN)
    end
  end

  if cfg.limiterMode ~= 'off' and not sim.isOnlineRace and not me.isInPitlane then
    local over = me.speedKmh - cfg.paceKmh
    if over > -4.5 then
      local maxGas = proto.clamp(-over / 4.5, 0, 1)
      if me.gas > maxGas then pcall(physics.forceUserThrottleFor, 0.08, maxGas) end
      state.limiterActive = true
    else
      state.limiterActive = false
    end
  else
    state.limiterActive = false
  end
  state.speedWarn = me.speedKmh > cfg.paceKmh + cfg.speedTolKmh
end

local btnStart, btnGreen
pcall(function()
  btnStart = ac.ControlButton('GDSP_RollingStart/Start Formation')
  btnGreen = ac.ControlButton('GDSP_RollingStart/Green Flag')
end)

local function applyAppWindowSize(title, w, h, x, y)
  if not ac.accessAppWindow then return false end
  local ok = false
  pcall(function()
    local win = ac.accessAppWindow(title)
    if win and win:valid() then
      if w and h and win.resize then win:resize(vec2(w, h)) end
      if x and y and win.move then win:move(vec2(x, y)) end
      ok = true
    end
  end)
  return ok
end

local ctx = {
  state = state,
  cfg = cfg,
  storage = storage,
  bridgeActive = false,
  adminVisible = false,
  localPrefs = localPrefs,
  btnStart = btnStart,
  btnGreen = btnGreen,
  applyAppWindowSize = applyAppWindowSize,
  sendCommand = function(cmd) sendCommand(cmd) end,
  applyConfig = function(newCfg) sendCommand(proto.CMD_APPLY_CFG, newCfg) end,
  sendAdminAction = function(action, targetSid, param) sendCommand(proto.CMD_ADMIN_ACTION, nil, action, targetSid, param) end,
}

function script.update(dt)
  uiTime = uiTime + dt
  local now = sim and sim.currentSessionTime or 0
  local curSess = sim and sim.currentSessionIndex or -1
  if now < lastClock - 3000 or curSess ~= lastSessionIdx then
    standalone.startWatch = {}
    standalone.cutOffTime = 0
    standalone.countedOff = false
    standalone.activePen = nil
    standalone.cutsSince = 0
    if not isBridgeActive() then
      state.phase = proto.PHASE_IDLE
      state.seq = 0
      state.cutsCount = 0
      state.activePenKind = proto.PEN_NONE
      state.totalTimePenaltySec = 0
      state.jumpWarn = false
      state.disqualified = false
      state.designatedStewardSid = nil
    end
    readServerIniDefaults()
  end
  lastClock = now
  lastSessionIdx = curSess

  if storage then
    storage.hideOnlineBanner = localPrefs.hideOnlineBanner
    storage.showCutsInSim = localPrefs.showCutsInSim
    storage.hudScale = localPrefs.hudScale
    storage.cutsScale = localPrefs.cutsScale
  end

  if bridge then
    appBeatCount = appBeatCount + 1
    bridge.appHeartbeat = appBeatCount
    bridge.appVisible = (hudVisible and localPrefs.hideOnlineBanner) and 1 or 0
    -- hideBanner (champ existant du bridge) = 1 : masquer le compteur cuts en jeu
    bridge.hideBanner = (localPrefs.showCutsInSim == false) and 1 or 0
  end

  local bActive = isBridgeActive()
  ctx.bridgeActive = bActive
  ctx.adminVisible = adminVisible

  if bActive and bridge then
    state.seq = bridge.seq
    state.cfgSeq = bridge.cfgSeq
    state.phase = bridge.phase
    state.reason = bridge.reason
    state.tStart = bridge.tStart
    state.s0 = bridge.s0
    state.order = proto.decodeOrder(bridge.orderCsv)
    state.mySlot = bridge.mySlot
    state.myRow = bridge.myRow
    state.myLane = bridge.myLane
    state.targetId = bridge.targetSessionId
    state.partnerId = bridge.partnerSessionId
    state.slotDeltaM = bridge.slotDeltaM
    state.aheadGapM = bridge.aheadGapM
    state.partnerDeltaM = bridge.partnerDeltaM
    state.lateralNorm = bridge.lateralNorm
    state.allowedKmh = bridge.allowedKmh
    state.limiterCapKmh = bridge.limiterCapKmh
    state.limiterActive = bridge.limiterActive == 1
    state.inAccelZone = bridge.inAccelZone == 1
    state.distRemainingM = bridge.distRemainingM
    state.strikes = bridge.strikes
    state.penOwed = bridge.penOwed
    state.penDriving = bridge.penDriving
    local wf = bridge.warnFlags or 0
    state.speedWarn = (wf % 2) == 1
    state.passWarn = (math.floor(wf / 2) % 2) == 1
    state.lagWarn = (math.floor(wf / 4) % 2) == 1
    state.laneWarn = (math.floor(wf / 8) % 2) == 1
    state.onlineCount = bridge.onlineCount
    state.netSent = bridge.netSent
    state.netGot = bridge.netGot

    state.cutsCount = bridge.cutsCount or 0
    state.cutsQuota = bridge.cutsQuota or cfg.cutMaxBeforePenalty
    state.activePenKind = bridge.activePenKind or proto.PEN_NONE
    state.activePenReason = bridge.activePenReason or proto.PEN_REASON_NONE
    state.activePenLapsLeft = bridge.activePenLapsLeft or 0
    state.activePenHoldLeft = bridge.activePenHoldLeft or 0
    state.activePenEscalated = (bridge.activePenEscalated or 0) == 1
    state.totalTimePenaltySec = bridge.totalTimePenaltySec or 0
    state.jumpWarn = (bridge.jumpWarnFlag or 0) == 1
    state.disqualified = (bridge.disqualified or 0) == 1
    state.canViewPeloton = (bridge.canViewPeloton or 0) == 1
    state.pelotonRole = tostring(bridge.pelotonRole or '')
    state.stewardMap = proto.decodeStewardCsv(bridge.stewardCsv or '')

    local cars = activeCars()
    state.targetName = findDriverNameBySession(cars, state.targetId)
    state.partnerName = findDriverNameBySession(cars, state.partnerId)

    local syncedCfg = proto.readCfgFromBridge(bridge, false, cfg)
    for k, v in pairs(syncedCfg) do cfg[k] = v end
  else
    updateStandalone(dt)
    local okPel, rolePel = computeLocalPelotonAccess()
    state.canViewPeloton = okPel
    state.pelotonRole = rolePel
  end

  if btnStart and btnStart:pressed() then sendCommand(proto.CMD_START) end
  if btnGreen and btnGreen:pressed() then sendCommand(proto.CMD_GREEN) end
end

function script.onHudShow() hudVisible = true end
function script.onHudHide() hudVisible = false end
function script.windowHud(dt) hudVisible = true; hud.drawHud(ctx, dt) end
function script.windowCuts(dt) hud.drawCutsWidget(ctx, dt) end
function script.windowAdmin(dt) adminVisible = true; admin.drawAdmin(ctx, dt) end
function script.windowSettings(dt) admin.drawSettings(ctx) end
function script.draw3D() hud.draw3D(ctx) end

if GDSP_APP_TEST then
  return {
    ctx = ctx,
    state = state,
    cfg = cfg,
    bridge = bridge,
    updateStandalone = updateStandalone,
    sendCommand = sendCommand,
  }
end

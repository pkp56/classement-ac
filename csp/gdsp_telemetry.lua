-- GDSP Télémétrie — script CSP poussé par le serveur ([SCRIPT_2])
--
-- Rôle : lire, sur CHAQUE PC de pilote, ce que le serveur dédié ne transmet pas
-- (carburant restant et usure des pneus), et l'envoyer au site GDSP une fois
-- par tour. Rien à installer : c'est le serveur qui pousse ce fichier aux
-- clients via csp_extra_options.ini. Voir tools/telemetry/README.md,
-- § « 3. En ligne : le script CSP poussé aux pilotes ».
--
-- Ce script est volontairement DÉFENSIF :
--   * il ne parie sur aucun nom de champ (les noms internes de CSP changent
--     d'une version à l'autre) : il essaie plusieurs accesseurs et retient le
--     premier qui renvoie un nombre plausible ;
--   * une valeur qu'il n'arrive pas à lire reste ABSENTE du paquet — jamais 0,
--     jamais une estimation. Le site affiche alors « — », et le tour compte
--     pour le chrono mais pas pour le BoP ;
--   * au lancement, il affiche en jeu ce qu'il a réussi à lire :
--         « Télémétrie GDSP · carburant lu · pneus lus · envoi actif »
--     Si tu lis « carburant NON LU » ou « pneus NON LUS », c'est cette ligne
--     qu'il faut transmettre : elle dit exactement quoi corriger.
--
-- Contrat d'envoi (POST <url>) :
--   { v, script, campaign, serverName, track, trackConfig, sessionType,
--     fuelRate, tyreWearRate, airTempC, roadTempC, grip,
--     driver:{guid,name}, car,
--     laps:[ { lapNumber, lapMs, fuelUsedL, fuelLoadedL,
--              tyreWearPct:[fl,fr,rl,rr], speedMaxKmh } ] }
--   `tyreWearPct` est l'usure CONSOMMÉE pendant le tour, par roue, en %. Le
--   site fait la moyenne des quatre roues (c'est cette moyenne qui entre dans
--   le calcul d'autonomie gomme).
-- Les champs absents sont simplement omis : le serveur enregistre `null`.
--
-- Dépendance : CSP 0.1.79+ (online scripts).

local VERSION = 'GDSP-TELEMETRY 1.0'
local WHEELS = 4
local MAX_BUFFER = 120      -- tours en attente avant de jeter les plus anciens

-------------------------------------------------------------------------------
-- 1. État local (déclaré tôt : les fonctions ci-dessous le capturent).
-------------------------------------------------------------------------------
local state = {
  now = 0,                  -- horloge du script, en secondes
  driverGuid = nil,
  driverName = nil,
  carId = nil,
  fuelSeen = false,
  wearSeen = false,
  lapStartFuel = nil,
  lapStartWear = nil,
  lastLapCount = nil,
  lastSpline = nil,
  splineWraps = 0,
  currentLapSpeedMax = 0,
  pending = {},
  pendingCount = 0,
  lastSendAt = -1e9,
  sentLaps = 0,
  sendErrors = 0,
  hasWeb = false,
}

-------------------------------------------------------------------------------
-- 2. Configuration : lue dans la section [SCRIPT_x] du csp_extra_options.ini.
-------------------------------------------------------------------------------
local cfg = {
  url = '',
  token = '',
  campaign = 'campagne',
  intervalSec = 5,
  debug = 0,
}

local function log(msg)
  pcall(ac.log, '[' .. VERSION .. '] ' .. tostring(msg))
  if tonumber(cfg.debug) == 1 then
    pcall(ac.console, '[' .. VERSION .. '] ' .. tostring(msg))
  end
end

local function message(title, body)
  pcall(ac.setMessage, tostring(title), tostring(body or ''), 'info', 5)
end

-- Valeurs par défaut éventuellement injectées par le site qui sert ce fichier
-- (route /csp/telemetry.lua) : il n'y a alors qu'une seule URL à déclarer dans
-- csp_extra_options.ini. La copie du dépôt n'en contient aucune.
do
  local injected = rawget(_G, '__GDSP_TELEMETRY__')
  if type(injected) == 'table' then
    for k, v in pairs(injected) do cfg[k] = v end
  end
end

do
  local ok, values = pcall(ac.configValues, {
    url = '',
    token = '',
    campaign = 'campagne',
    intervalSec = 5,
    debug = 0,
  })
  if ok and type(values) == 'table' then
    for k, v in pairs(values) do cfg[k] = v end
  end
  cfg.url = tostring(cfg.url or '')
  cfg.token = tostring(cfg.token or '')
  cfg.campaign = tostring(cfg.campaign or 'campagne')
  cfg.intervalSec = math.max(2, tonumber(cfg.intervalSec) or 5)
end

-------------------------------------------------------------------------------
-- 3. Accès tolérant à l'état de la voiture.
--    `car` est fourni par le script en ligne (ac.getCar(0)).
-------------------------------------------------------------------------------
local function firstNumber(candidates)
  for i = 1, #candidates do
    local ok, v = pcall(candidates[i])
    if ok and type(v) == 'number' and v == v and v > -1e9 and v < 1e9 then
      return v
    end
  end
  return nil
end

local function readFuelLiters()
  return firstNumber({
    function() return car and car.fuel end,
    function() return car and car.fuelLiters end,
    function() return car and car.fuelAmount end,
    function()
      local p = ac.getCarPhysics and ac.getCarPhysics(0)
      return p and p.fuel
    end,
    function()
      local p = ac.accessCarPhysics and ac.accessCarPhysics()
      return p and p.fuel
    end,
  })
end

--- Usure des 4 pneus, en fraction 0–1 (1 = neuf), ordre FL, FR, RL, RR.
--- `nil` si les quatre roues ne sont pas lisibles : on ne complète pas les trous.
local function readTyreWear()
  for _, base in ipairs({ 0, 1 }) do
    local vals = {}
    local okAll = true
    for i = 0, WHEELS - 1 do
      local ok, v = pcall(function()
        local c = car
        if not c or not c.wheels then return nil end
        local w = c.wheels[base + i]
        if not w then return nil end
        local wear = w.tyreWear
        if wear == nil then wear = w.wear end
        return wear
      end)
      if ok and type(v) == 'number' and v >= 0 and v <= 1.5 then
        vals[i + 1] = v
      else
        okAll = false
        break
      end
    end
    if okAll and #vals == WHEELS then return vals end
  end
  return nil
end

local function readSpeedKmh()
  return firstNumber({
    function() return car and car.speedKmh end,
    function() return sim and sim.speedKmh end,
  })
end

local function readLapCount()
  return firstNumber({
    function() return car and car.lapCount end,
    function() return car and car.lapsCount end,
  })
end

local function readSpline()
  return firstNumber({
    function() return car and car.splinePosition end,
  })
end

local function readLastLapMs()
  local ms = firstNumber({
    function() return car and car.lastLapTimeMs end,
    function() return car and car.lastLapMs end,
  })
  return ms and ms > 1000 and ms or nil
end

-------------------------------------------------------------------------------
-- 4. Encodage JSON minimal — aucune dépendance, JSON strict.
-------------------------------------------------------------------------------
local function jsonEscape(s)
  s = tostring(s)
  s = s:gsub('[\\"]', function(c) return '\\' .. c end)
  s = s:gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
  s = s:gsub('[\1-\31]', function(c) return string.format('\\u%04x', string.byte(c)) end)
  return s
end

local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= 'number' then return false end
    n = n + 1
  end
  return n == #t
end

local function toJson(v)
  local t = type(v)
  if v == nil then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    if v == math.floor(v) and math.abs(v) < 1e12 then return string.format('%d', v) end
    return string.format('%.3f', v)
  end
  if t == 'string' then return '"' .. jsonEscape(v) .. '"' end
  if t == 'table' then
    if isArray(v) then
      local parts = {}
      for i = 1, #v do parts[i] = toJson(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    local parts = {}
    for i = 1, #keys do
      local k = keys[i]
      if v[k] ~= nil then
        parts[#parts + 1] = '"' .. jsonEscape(k) .. '":' .. toJson(v[k])
      end
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end

-------------------------------------------------------------------------------
-- 5. Transport HTTP.
--    `web.post` est le seul moyen propre d'envoyer des données depuis un script
--    en ligne. On vérifie sa présence une fois : sans transport, inutile de
--    collecter des tours qu'on ne pourrait pas transmettre.
-------------------------------------------------------------------------------
do
  local ok, fn = pcall(function() return web.post end)
  state.hasWeb = ok and type(fn) == 'function'
end

local function post(body, callback)
  if not state.hasWeb then
    callback('Transport HTTP indisponible dans ce type de script CSP', nil)
    return
  end
  local headers = {
    ['Content-Type'] = 'application/json',
    ['User-Agent'] = VERSION,
  }
  if cfg.token ~= '' then headers['X-Telemetry-Token'] = cfg.token end
  local ok, err = pcall(web.post, cfg.url, headers, body, callback)
  if not ok then callback(tostring(err), nil) end
end

-------------------------------------------------------------------------------
-- 6. Identité : circuit, voiture, pilote.
--    Le guid du pilote est ce qui permet de distinguer deux pilotes sur la même
--    voiture — sans lui, un BoP mesurerait le talent et pas la voiture.
-------------------------------------------------------------------------------
local function ensureIdentity()
  if not state.driverGuid and car then
    local candidates = { car.driverGuid, car.driverSteamID, car.guid }
    for i = 1, #candidates do
      local v = candidates[i]
      if v ~= nil and tostring(v) ~= '' then state.driverGuid = tostring(v) break end
    end
    if not state.driverGuid and ac.getDriverSteamID then
      local ok, v = pcall(ac.getDriverSteamID, 0)
      if ok and v ~= nil and tostring(v) ~= '' then state.driverGuid = tostring(v) end
    end
  end
  if not state.driverName and car then
    local v = car.driverName
    if v == nil and ac.getDriverName then
      local ok, name = pcall(ac.getDriverName, 0)
      if ok then v = name end
    end
    if v ~= nil then state.driverName = tostring(v) end
  end
  if not state.carId and car then
    local v = car.id
    if v == nil and ac.getCarID then
      local ok, id = pcall(ac.getCarID, 0)
      if ok then v = id end
    end
    if v ~= nil then state.carId = tostring(v) end
  end
end

local function identityKnown()
  return state.driverGuid ~= nil and state.carId ~= nil
end

-------------------------------------------------------------------------------
-- 7. Envoi groupé.
-------------------------------------------------------------------------------
local function buildPayload()
  return {
    v = 1,
    script = VERSION,
    campaign = cfg.campaign,
    serverName = tostring((sim and sim.serverName) or ''),
    track = tostring((sim and sim.trackID) or ''),
    trackConfig = tostring((sim and sim.trackLayout) or ''),
    sessionType = tostring((sim and sim.currentSessionType) or ''),
    fuelRate = tonumber(sim and sim.fuelRate),
    tyreWearRate = tonumber(sim and sim.tyreWearRate),
    airTempC = tonumber(sim and sim.ambientTemperature),
    roadTempC = tonumber(sim and sim.roadTemperature),
    grip = tonumber(sim and sim.trackGrip),
    driver = {
      guid = state.driverGuid or '',
      name = state.driverName or '',
    },
    car = state.carId or '',
    laps = state.pending,
  }
end

local function flush(force)
  if state.pendingCount == 0 then return end
  if not force and (state.now - state.lastSendAt) < cfg.intervalSec then return end
  if not identityKnown() then return end

  local body = toJson(buildPayload())
  local batch = state.pending
  local count = state.pendingCount
  state.pending = {}
  state.pendingCount = 0
  state.lastSendAt = state.now

  post(body, function(err)
    if err then
      state.sendErrors = state.sendErrors + 1
      -- On remet les tours en attente : rien ne doit être perdu parce que le
      -- Wi-Fi a hoqueté. Le site déduplique par numéro de tour, donc un renvoi
      -- ne crée jamais de doublon.
      for i = 1, #batch do
        if state.pendingCount < MAX_BUFFER then
          state.pendingCount = state.pendingCount + 1
          state.pending[state.pendingCount] = batch[i]
        end
      end
      if state.sendErrors == 1 or state.sendErrors % 10 == 0 then
        log('envoi impossible (' .. state.sendErrors .. '×) : ' .. tostring(err))
        if state.sendErrors == 1 or state.sendErrors % 50 == 0 then
          message('Télémétrie : envoi impossible', tostring(err):sub(1, 90))
        end
      end
      return
    end
    state.sendErrors = 0
    state.sentLaps = state.sentLaps + count
    log(string.format('%d tour(s) envoyé(s) — total %d', count, state.sentLaps))
  end)
end

-------------------------------------------------------------------------------
-- 8. Fin de tour : c'est ici que la mesure est prise.
-------------------------------------------------------------------------------
local function wearDeltaPct(startWear, endWear)
  if not startWear or not endWear then return nil end
  local out = {}
  local any = false
  for i = 1, WHEELS do
    local a, b = startWear[i], endWear[i]
    if a ~= nil and b ~= nil and b <= a + 0.001 then
      local pct = (a - b) * 100
      out[i] = pct
      if pct > 0 then any = true end
    end
  end
  if not any then return nil end
  return out
end

local function completeLap(lapNumber)
  if not identityKnown() then
    log('tour ignoré : identité pilote ou voiture introuvable')
    return
  end
  local fuelNow = readFuelLiters()
  local wearNow = readTyreWear()
  local lap = { lapNumber = lapNumber }

  local lapMs = readLastLapMs()
  if lapMs then lap.lapMs = math.floor(lapMs + 0.5) end
  if state.currentLapSpeedMax > 1 then
    lap.speedMaxKmh = math.floor(state.currentLapSpeedMax + 0.5)
  end

  -- Carburant : seulement si le niveau a BAISSÉ (un ravitaillement inverse le
  -- signe ; ce n'est alors pas une consommation et on ne publie rien).
  if fuelNow and state.lapStartFuel then
    local used = state.lapStartFuel - fuelNow
    if used > 0 and used < 20 then
      lap.fuelUsedL = used
      lap.fuelLoadedL = state.lapStartFuel
    end
  end

  local delta = wearDeltaPct(state.lapStartWear, wearNow)
  if delta then lap.tyreWearPct = delta end

  state.lapStartFuel = fuelNow
  state.lapStartWear = wearNow
  state.currentLapSpeedMax = 0

  if state.pendingCount >= MAX_BUFFER then
    table.remove(state.pending, 1)
    state.pendingCount = state.pendingCount - 1
  end
  state.pendingCount = state.pendingCount + 1
  state.pending[state.pendingCount] = lap

  log(string.format('tour %s : %s ms%s%s',
    tostring(lap.lapNumber), tostring(lap.lapMs or '—'),
    lap.fuelUsedL and string.format(' · %.3f L', lap.fuelUsedL) or ' · conso ?',
    lap.tyreWearPct and ' · usure' or ' · usure ?'))
end

-------------------------------------------------------------------------------
-- 9. Boucle principale.
-------------------------------------------------------------------------------
function script.update(dt)
  state.now = state.now + (tonumber(dt) or 0)
  if not car then return end
  ensureIdentity()
  if not identityKnown() then return end

  local speed = readSpeedKmh()
  if speed and speed > state.currentLapSpeedMax then state.currentLapSpeedMax = speed end

  -- Détection de tour : le compteur de la voiture est la source fiable ; à
  -- défaut, le passage de 0,99 → 0,01 sur la ligne d'arrivée.
  local lapCount = readLapCount()
  local spline = readSpline()
  local lapDone = false
  if lapCount then
    if state.lastLapCount and lapCount > state.lastLapCount then
      lapDone = true
    end
    state.lastLapCount = lapCount
  elseif spline and state.lastSpline and state.lastSpline > 0.9 and spline < 0.1 then
    state.splineWraps = state.splineWraps + 1
    lapDone = true
  end
  if spline then state.lastSpline = spline end

  -- Premier relevé : on mémorise le niveau de départ sans compter de tour.
  if not state.fuelSeen then
    local fuelNow = readFuelLiters()
    if fuelNow then
      state.fuelSeen = true
      state.lapStartFuel = fuelNow
    end
  end
  if not state.wearSeen then
    local wearNow = readTyreWear()
    if wearNow then
      state.wearSeen = true
      state.lapStartWear = wearNow
    end
  end

  if lapDone then
    completeLap(lapCount or (state.splineWraps + 1))
  end

  if state.pendingCount > 0 then flush(false) end
end

function script.__init__()
  ensureIdentity()
  local fuelOk = readFuelLiters() ~= nil
  local wearOk = readTyreWear() ~= nil
  local transport = state.hasWeb and (cfg.url ~= '' and 'actif' or 'sans URL') or 'impossible'
  local status = string.format('Télémétrie GDSP · carburant %s · pneus %s · envoi %s',
    fuelOk and 'lu' or 'NON LU',
    wearOk and 'lus' or 'NON LUS',
    transport)
  message(VERSION, status)
  log(status .. ' · url=' .. cfg.url .. ' · guid=' .. tostring(state.driverGuid) ..
    ' · voiture=' .. tostring(state.carId))
end

function script.onCarReset()
  -- Sortie des stands ou remise en piste : les niveaux repartent de zéro, et
  -- le tour en cours ne doit pas être compté comme une consommation.
  state.lapStartFuel = readFuelLiters()
  state.lapStartWear = readTyreWear()
  state.currentLapSpeedMax = 0
end

function script.onSessionEnd()
  flush(true)
end

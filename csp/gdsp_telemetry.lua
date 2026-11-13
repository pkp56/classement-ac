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
  pinged = false,           -- le ping de démarrage n'est envoyé qu'une fois
  started = false,          -- init déjà exécuté (les deux noms d'init existent)
  inflight = false,         -- une requête est en cours
  inflightSince = -1e9,     -- quand elle est partie (détection du callback perdu)
  lastError = '',           -- dernière erreur d'envoi, affichée en jeu
  lastResponse = '',        -- dernière réponse reçue (code HTTP)
  probed = false,           -- sonde GET déjà lancée
  probe = 'sonde en attente', -- résultat de la sonde GET
  pingAttempts = 0,         -- tentatives de ping (le réseau peut être en retard)
  lastAttemptAt = -1e9,     -- cadence des tentatives
  why = '',                 -- dernière raison d'un envoi impossible
  updates = 0,              -- nombre d'appels à script.update
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
  -- `print` part dans log.txt (le journal du jeu), `ac.log` dans le journal CSP :
  -- les deux sont nécessaires, aucun n'est garanti selon la version.
  pcall(print, '[' .. VERSION .. '] ' .. tostring(msg))
  if tonumber(cfg.debug) == 1 then
    pcall(ac.console, '[' .. VERSION .. '] ' .. tostring(msg))
  end
end

local function message(title, body)
  pcall(ac.setMessage, tostring(title), tostring(body or ''), 'info', 5)
end

-- Résolution de la configuration. ATTENTION À L'ORDRE D'EXÉCUTION : le site
-- ajoute la table `__GDSP_TELEMETRY__` À LA FIN du fichier servi, une fois le
-- reste déjà chargé. La lire ici, au chargement, donnait donc toujours `nil` —
-- le script tournait avec une URL vide. C'est pour cela que tout ce bloc est
-- dans une fonction, appelée depuis `script.init()`, quand le fichier entier a
-- fini de s'exécuter.
local cfgSource = 'défaut'
local configured = false

local function resolveConfig()
  if configured then return end
  configured = true

  -- 1. Valeurs injectées par le site qui sert ce fichier (priorité haute).
  local injected = rawget(_G, '__GDSP_TELEMETRY__')
  if type(injected) == 'table' then
    for k, v in pairs(injected) do cfg[k] = v end
    cfgSource = 'injectée'
  end

  -- 2. Section `csp_extra_options.ini` : elle ne sert que de REPLI. CSP renvoie
  --    le layout fourni en entier, valeurs par défaut comprises ; l'appliquer
  --    telle quelle écraserait les valeurs injectées par des vides.
  local ok, values = pcall(ac.configValues, {
    url = '', token = '', campaign = '', intervalSec = 0, debug = 0,
  })
  if ok and type(values) == 'table' then
    for _, key in ipairs({ 'url', 'token', 'campaign', 'intervalSec', 'debug' }) do
      local v = values[key]
      local vide = (v == nil or v == '' or v == 0)
      if not vide and (cfg[key] == nil or cfg[key] == '' or cfg[key] == 0) then
        cfg[key] = v
        if cfgSource ~= 'injectée' then cfgSource = 'config' end
      end
    end
  end

  -- Délais courts : par défaut WinHTTP attend 30 s en réception. En cas de
  -- blocage TLS, cela se traduisait par un silence de 30 s sans aucun message.
  if type(web) == 'table' and type(web.timeouts) == 'function' then
    pcall(web.timeouts, 3000, 5000, 5000, 6000, 2)
  end
  cfg.url = tostring(cfg.url or '')
  cfg.token = tostring(cfg.token or '')
  cfg.campaign = tostring(cfg.campaign or 'campagne')
  cfg.intervalSec = math.max(2, tonumber(cfg.intervalSec) or 5)
  if cfg.url == '' then cfgSource = 'aucune' end
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
    -- `previousLapTimeMs` est le nom RÉEL dans ac.StateCar (SDK,
    -- common/ac_state.lua). `lastLapTimeMs` existe dans le harnais de test mais
    -- pas forcément en jeu : vérifié, le SDK n'expose que previousLapTimeMs.
    function() return car and car.previousLapTimeMs end,
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

--- Valeurs lues au démarrage, pour le diagnostic : `nil` signifie « pas lisible
--- sur cette version de CSP », et c'est une information (jamais remplacé par 0).
function script.readable()
  return {
    fuel = readFuelLiters(),
    wear = readTyreWear(),
    bestLapMs = firstNumber({
      function() return car and car.bestLapTimeMs end,
    }),
    speedKmh = readSpeedKmh(),
    lapCount = readLapCount(),
  }
end

-------------------------------------------------------------------------------
-- 5. Transport HTTP.
--    `web.post` est le seul moyen propre d'envoyer des données depuis un script
--    en ligne. On vérifie sa présence une fois : sans transport, inutile de
--    collecter des tours qu'on ne pourrait pas transmettre.
-------------------------------------------------------------------------------
--- Détection du transport, répétable : dans un script en ligne, l'objet `web`
--- n'est pas forcément complet au moment du chargement. Une vérification faite
--- une seule fois dans un `do ... end` initial fige un `false` définitif —
--- et le script reste muet pour toute la session, sans le moindre message.
local function detectWeb()
  local ok, fn = pcall(function() return web.post end)
  state.hasWeb = ok and type(fn) == 'function'
  return state.hasWeb
end
detectWeb()

local function post(body, callback)
  if not state.hasWeb then
    callback('Transport HTTP indisponible dans ce type de script CSP', nil)
    return
  end
  -- Un callback qui ne vient JAMAIS laissait le ping « en attente » pour
  -- toujours, sans un mot. On arme un délai : au-delà, on considère l'envoi
  -- perdu et on réessaiera.
  local done = false
  local function finish(err, res)
    if done then return end
    done = true
    state.inflight = false
    callback(err, res)
  end
  state.inflight = true
  state.inflightSince = state.now
  state.lastResponse = ''
  local headers = {
    ['Content-Type'] = 'application/json',
    ['User-Agent'] = VERSION,
  }
  if cfg.token ~= '' then headers['X-Telemetry-Token'] = cfg.token end
  state.lastError = ''
  local ok, err = pcall(web.post, cfg.url, headers, body, finish)
  if not ok then
    -- Certaines versions n'acceptent que (url, data, callback) : on retente
    -- sans les en-têtes avant d'abandonner.
    state.lastError = 'entêtes refusées: ' .. tostring(err)
    local ok2, err2 = pcall(web.post, cfg.url, body, finish)
    if not ok2 then
      state.lastError = 'web.post: ' .. tostring(err2)
      finish(tostring(err), nil)
    end
  end
end

-------------------------------------------------------------------------------
-- 6. Identité : circuit, voiture, pilote.
--    Le guid du pilote est ce qui permet de distinguer deux pilotes sur la même
--    voiture — sans lui, un BoP mesurerait le talent et pas la voiture.
-------------------------------------------------------------------------------
local function ensureIdentity()
  if not state.driverGuid and car then
    -- `ac.StateCar` (SDK, common/ac_state.lua) n'expose AUCUN identifiant
    -- Steam : ni driverGuid, ni driverSteamID. Lire ces champs renvoyait nil
    -- en silence, d'où un guid éternellement vide. Les identifiants réels
    -- passent par csp_extra_options.ini, qui sait substituer {SteamID} dans
    -- l'URL du script (documentation CSP, section [SCRIPT_...]).
    local candidates = { car.driverGuid, car.driverSteamID, car.guid, car.steamID }
    for i = 1, #candidates do
      local v = candidates[i]
      if v ~= nil and tostring(v) ~= '' then state.driverGuid = tostring(v) break end
    end
    if not state.driverGuid and ac.getDriverSteamID then
      local ok, v = pcall(ac.getDriverSteamID, 0)
      if ok and v ~= nil and tostring(v) ~= '' then state.driverGuid = tostring(v) end
    end
    -- Repli : la section [SCRIPT_x] peut fournir `steamID`, à poser dans
    -- csp_extra_options.ini avec SCRIPT = '…/telemetry.lua?s={SteamID}'.
    if not state.driverGuid then
      for _, key in ipairs({ 'steamID', 'steamId', 'driverGuid', 'guid' }) do
        local v = rawget(_G, '__GDSP_IDENT__')
        if type(v) == 'table' and v[key] ~= nil and tostring(v[key]) ~= '' then
          state.driverGuid = tostring(v[key])
          break
        end
      end
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

-- Sert uniquement au diagnostic : l'absence d'identifiant ne doit plus
-- interrompre la boucle.
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
  -- Même raison que dans completeLap : l'absence de guid ne doit pas retenir
  -- les tours indéfiniment. Seule la voiture est indispensable.
  if not state.carId then return end

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
  -- NE JETTE PLUS le tour quand l'identité manque. C'était le verrou le plus
  -- coûteux : sans guid, CHAQUE tour partait à la poubelle, en silence (le
  -- message partait dans un log inaccessible aux scripts en ligne). Le guid ne
  -- sert qu'au regroupement par pilote ; la voiture, le circuit et les mesures
  -- suffisent à une mesure de BoP. Le site ignore les paquets sans guid s'il
  -- en a besoin — mais nous, on ne perd plus la donnée.
  if not state.carId then
    state.lapsDropped = (state.lapsDropped or 0) + 1
    return
  end
  if not state.driverGuid then
    state.lapsWithoutGuid = (state.lapsWithoutGuid or 0) + 1
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
  state.updates = state.updates + 1

  -- Preuve de vie : une seule ligne, à la première image. Si elle n'apparaît
  -- nulle part, le script ne tourne pas du tout — et aucun autre diagnostic
  -- n'aurait de sens.
  if state.updates == 1 then
    log('boucle démarrée · url=' .. (cfg.url ~= '' and cfg.url or 'AUCUNE') ..
      ' · transport=' .. tostring(state.hasWeb))
  end

  -- Le ping est retenté à chaque image tant qu'il n'a pas abouti : au
  -- chargement, la session réseau n'est pas encore établie, et une tentative
  -- unique à cet instant échoue silencieusement une fois pour toutes.
  -- Délai dépassé alors qu'une requête est en vol : le callback n'est jamais
  -- venu. On le dit, puis on considère la tentative comme terminée.
  if state.inflight and (state.now - state.inflightSince) > 10 then
    state.inflight = false
    state.lastError = 'aucune réponse après 10 s'
    if state.pingAttempts <= 2 then
      log('PING sans réponse après 10 s (tentative ' .. state.pingAttempts .. ')')
      message('Télémétrie GDSP : pas de réponse', tostring(cfg.url) .. ' — rien reçu en 10 s.')
    end
  end

  if not state.pinged and not state.inflight and (state.now - state.lastAttemptAt) > 2 then
    script.ping()
  end

  -- On NE sort PAS si l'identité manque : le guid Steam n'est pas exposé par
  -- l'API (voir ensureIdentity), l'exiger condamnait le script au silence sur
  -- toutes les voitures. L'identité sert au regroupement, pas au fonctionne-
  -- ment : un tour sans guid reste utile, un tour jamais lu ne l'est pas.
  if not car then return end
  ensureIdentity()
  if not state.driverGuid then state.guidMissing = (state.guidMissing or 0) + 1 end

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

--- Envoie un premier paquet dès le chargement, sans attendre un tour : il
--- n'apporte aucune mesure, mais il prouve que la chaîne complète fonctionne
--- (script exécuté → réseau → jeton accepté → base joignable). Sans lui, un
--- échec silencieux ne se voit qu'au premier tour terminé, voire jamais.
function script.ping()
  if state.pinged then return end
  if cfg.url == '' then
    -- Sans URL, inutile de réessayer : mais le dire une fois, clairement.
    if state.why ~= 'sans URL' then
      state.why = 'sans URL'
      log('aucune URL de télémétrie : le script n\'a pas reçu sa configuration')
      message('Télémétrie GDSP : pas d\'URL', 'Le script n\'a pas reçu sa configuration (csp_extra_options.ini).')
    end
    return
  end
  if not detectWeb() then
    -- `web.post` absent : on retentera (voir script.update), le transport peut
    -- apparaître une fois la session réseau réellement établie.
    if state.why ~= 'web.post absent' then
      state.why = 'web.post absent'
      log('web.post indisponible : nouvelle tentative à chaque image')
      message('Télémétrie GDSP : transport indisponible', 'web.post absent — CSP trop ancien ou script hors ligne.')
    end
    return
  end
  state.why = ''
  state.pingAttempts = state.pingAttempts + 1
  state.lastAttemptAt = state.now
  -- Sonde une seule fois : un GET tout simple sur la même origine. Si lui
  -- répond et pas le POST, le problème est côté site ; si aucun ne répond, il
  -- est dans le transport (TLS, pare-feu, proxy).
  if not state.probed then
    state.probed = true
    local base = cfg.url:gsub('/api/telemetry/push$', '')
    if base ~= cfg.url and type(web) == 'table' and type(web.get) == 'function' then
      local done = false
      pcall(web.get, base .. '/healthz', function(err, res)
        if done then return end
        done = true
        state.probe = err and ('GET err=' .. tostring(err))
          or ('GET HTTP ' .. tostring(res and res.status))
        message('Télémétrie GDSP : réseau', state.probe)
      end)
    end
  end
  if state.pingAttempts > 60 then return end   -- on abandonne après ~1 min d'images
  local body = toJson({
    v = 1,
    script = VERSION,
    campaign = cfg.campaign,
    kind = 'ping',                     -- pas un tour : le site ne stocke rien
    serverName = tostring((sim and sim.serverName) or ''),
    track = tostring((sim and sim.trackID) or ''),
    driver = { guid = state.driverGuid or '', name = state.driverName or '' },
    car = state.carId or '',
  })
  post(body, function(err, res)
    local status = res and tonumber(res.status) or nil
    -- Toute réponse, même mauvaise, est une preuve que le réseau fonctionne :
    -- on la garde pour le diagnostic affiché à l'écran.
    state.lastResponse = err and ('err=' .. tostring(err)) or ('HTTP ' .. tostring(status))
    if res and res.certificate ~= nil then
      state.lastResponse = state.lastResponse .. ' cert=oui'
    end
    if err then
      -- Échec réseau : on réessaiera. On ne parle qu'aux première et dixième
      -- tentatives, pour ne pas noyer le joueur de messages.
      state.lastError = tostring(err)
      if state.pingAttempts == 1 or state.pingAttempts % 10 == 0 then
        log('PING échoué (' .. state.pingAttempts .. '×) : ' .. tostring(err))
        message('Télémétrie GDSP : envoi impossible', tostring(err):sub(1, 90))
      end
      return
    end
    if status and status >= 200 and status < 300 then
      state.pinged = true
      log('PING accepté (HTTP ' .. tostring(status) .. ') · base joignable côté serveur')
      message('Télémétrie GDSP', 'Connexion au site établie (' .. tostring(status) .. ').')
    else
      log('PING refusé (HTTP ' .. tostring(status) .. ') : ' .. tostring(res and res.body or ''))
      message('Télémétrie GDSP : le site refuse', 'HTTP ' .. tostring(status) ..
        ' · vérifier TELEMETRY_TOKEN / TELEMETRY_ENABLED sur Render')
    end
  end)
end

function script.init()
  if state.started then return end
  state.started = true
  -- À ce stade seulement, la table injectée en fin de fichier existe.
  resolveConfig()
  ensureIdentity()
  local fuelOk = readFuelLiters() ~= nil
  local wearOk = readTyreWear() ~= nil
  local transport = state.hasWeb and (cfg.url ~= '' and 'actif' or 'sans URL') or 'impossible'
  local status = string.format('Télémétrie GDSP · carburant %s · pneus %s · envoi %s',
    fuelOk and 'lu' or 'NON LU',
    wearOk and 'lus' or 'NON LUS',
    transport)
  -- Message plus long : 5 s suffisaient à le manquer pendant le chargement.
  pcall(ac.setMessage, VERSION, status, 'info', 12)
  print('[' .. VERSION .. '] ' .. status .. ' · url=' .. cfg.url ..
    ' · guid=' .. tostring(state.driverGuid) .. ' · voiture=' .. tostring(state.carId))
  script.ping()
end

-- `__init__` est conservé en plus de `init` : selon que CSP résout le hook de
-- la lib (`__script.__init__`, appelé automatiquement) ou la clé `script.init`,
-- un seul des deux noms pourrait être appelé. Les deux pointent sur la même
-- fonction, et le garde-fou `state.started` rend l'appel idempotent.
script.__init__ = function() script.init() end

--- Battement visible à l'écran, pendant les 20 premières secondes.
--- Les online scripts n'ont ni IO ni journal garanti : `ui.text` dans `drawUI`
--- est le seul canal dont on soit sûr. Si lui aussi reste muet, c'est que le
--- script ne s'exécute pas du tout.
function script.drawUI()
  -- Affichée 20 s au démarrage, PUIS tant que le ping n'a pas abouti : un
  -- premier tour prend souvent plus de 20 s, et c'est justement le moment où
  -- le diagnostic est le plus utile.
  if state.now > 20 and state.pinged then return end
  -- init n'a peut-être jamais été appelé : le diagnostic doit rester lisible.
  pcall(resolveConfig)
  local lines = {
    'GDSP-TELEMETRY ' .. (state.pinged and 'OK' or 'attente'),
    'url(' .. cfgSource .. '): ' .. (cfg.url ~= '' and cfg.url or 'MANQUANTE'),
    'web=' .. tostring(state.hasWeb) ..
      ' guid=' .. tostring(state.driverGuid or 'ABSENT (API)') ..
      ' tours=' .. tostring(state.sentLaps) ..
      ((state.lapsWithoutGuid or 0) > 0 and (' sansguid=' .. state.lapsWithoutGuid) or ''),
    'essais=' .. tostring(state.pingAttempts) ..
      (state.inflight and (' · en vol ' .. string.format('%.0f', state.now - state.inflightSince) .. 's') or ''),
    -- La ligne qui compte : ce que le transport a RÉPONDU, mot pour mot.
    'réponse: ' .. (state.lastResponse ~= '' and state.lastResponse
      or (state.lastError ~= '' and state.lastError or 'aucune')),
    'sonde: ' .. tostring(state.probe),
  }
  for i = 1, #lines do
    -- pcall autour de l'appel ET de l'accès à `ui` : si l'objet n'existe pas,
    -- `ui.text` lèverait avant même d'entrer dans pcall.
    pcall(function() ui.text(lines[i]) end)
  end
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

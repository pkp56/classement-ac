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
--   { v, script, campaign, serverName, track, sessionKey, trackConfig,
--     sessionType, fuelRate, tyreWearRate, airTempC, roadTempC,
--     driver:{guid,name}, car,
--     laps:[ { lapNumber, lapMs, fuelUsedL, fuelLoadedL,
--              tyreWearPct:[fl,fr,rl,rr], speedMaxKmh, pitLaneMs } ] }
--   `tyreWearPct` est l'usure CONSOMMÉE pendant le tour, par roue, en %. Le
--   site fait la moyenne des quatre roues (c'est cette moyenne qui entre dans
--   le calcul d'autonomie gomme).
-- Les champs absents sont simplement omis : le serveur enregistre `null`.
--
-- Dépendance : CSP 0.1.79+ (online scripts).

local VERSION = 'GDSP-TELEMETRY 1.2'
local WHEELS = 4
local COMMAND_POLL_SEC = 5
local FUEL_CHANGE_EPSILON_L = 0.002
local MAX_BUFFER = 120      -- tours en attente avant de jeter les plus anciens
-- Sans indicateur pit-lane CSP fiable, on reconnaît le plateau du limiteur
-- 80 km/h, puis sa libération. Un bref passage à cette vitesse sur piste ne
-- suffit pas : il faut un plateau continu, une sortie au-dessus de 84 km/h,
-- et au moins 4 s de roulage mesuré.
local PIT_LIMIT_MIN_KMH = 78
local PIT_LIMIT_MAX_KMH = 82
local PIT_LIMIT_CONFIRM_MS = 2500
local PIT_EXIT_KMH = 84
local PIT_EXIT_CONFIRM_MS = 400
local PIT_MIN_LANE_MS = 4000
local PIT_STOP_KMH = 5

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
  pitCandidateMs = 0,
  pitLaneActive = false,
  pitLaneMs = 0,
  pitExitMs = 0,
  pitStopAt = nil,
  pendingPitLaneMs = {},
  measurement = nil,
  nextMeasurementPollAt = 0,
  measurementPollErrors = 0,
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
  transport = nil,          -- mode d'envoi verrouillé après la première réponse
  mode = '',                -- mode de la tentative en cours (affiché)
  transportLocked = false,  -- un mode a-t-il déjà livré une réponse
  lastAttemptAt = -1e9,     -- cadence des tentatives
  why = '',                 -- dernière raison d'un envoi impossible
  updateError = '',         -- erreur attrapée dans update/init (affichée)
  guidSource = nil,         -- d'où vient le guid : 'config' ou 'API'
  sendBlocked = '',         -- pourquoi les tours attendent (affiché)
  lapConfirmed = false,     -- la première confirmation d'enregistrement est passée
  lastLapAt = -1e9,         -- dernier tour DÉTECTÉ (la bannière réapparaît)
  sessionKey = nil,         -- identité de cette exécution, côté site
  clientSecret = nil,       -- capacité temporaire délivrée par le serveur CSP
  trackSource = nil,        -- d'où vient le circuit : « jeu » (ac.getTrackID) ou « config »
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
  guid = '',           -- SteamID injecté par le site (?guid={SteamID}) ou la config
  track = '',          -- circuit, si aucun champ sim n'est lisible
  trackLayout = '',
  serverName = '',
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
    guid = '', track = '', trackLayout = '', serverName = '',
  })
  if ok and type(values) == 'table' then
    for _, key in ipairs({ 'url', 'token', 'campaign', 'intervalSec', 'debug',
      'guid', 'track', 'trackLayout', 'serverName' }) do
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
    -- 8 requêtes simultanées au lieu de 2 : la limite par défaut est globale
    -- au jeu (météo, apps, autres scripts du serveur…). Deux slots pris
    -- ailleurs laissaient nos POST en file d'attente, sans erreur ni réponse.
    pcall(web.timeouts, 3000, 5000, 5000, 6000, 8)
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
--- Lecture d'un champ de `car` ou `sim`. Ces objets sont des structures C
--- brutes côté CSP (cdata LuaJIT) : lire un champ qui n'existe pas LÈVE une
--- erreur — une table Lua aurait renvoyé nil. C'est ce qui tuait le ping en
--- production : `sim.serverName` levait dans toJson, AVANT l'appel à web.post,
--- et le POST ne partait jamais (compteur d'essais alone, mode vide).
--- Chaque lecture passe donc par pcall, et le nom des champs refusés est
--- conservé pour l'écran : c'est le seul moyen de savoir ce que cette
--- version de CSP n'expose pas.
local function readField(obj, key)
  if obj == nil then return nil end
  local ok, v = pcall(function() return obj[key] end)
  if ok then return v end
  state.fieldErrors = state.fieldErrors or {}
  state.fieldErrors[key] = true
  return nil
end

-- Appel protégé d'une fonction de l'API CSP : renvoie une chaîne non vide,
-- ou nil (fonction absente d'une version plus ancienne, erreur, vide).
local function acCallString(name)
  local fn = type(ac) == 'table' and ac[name] or nil
  if type(fn) ~= 'function' then return nil end
  local ok, r = pcall(fn)
  if ok and type(r) == 'string' and r ~= '' then return r end
  return nil
end

-- Circuit / serveur : l'API DÉDIÉE de CSP d'abord (ac.getTrackID renvoie le
-- nom du dossier dans content/tracks — « oesterreichring1979 », exactement
-- le format du site), puis les champs sim (replis pour les vieux CSP), puis
-- la config (URL ?track=… ou section [SCRIPT_x]). Le circuit est donc lu
-- dans le jeu même si l'URL du script n'est pas à jour.
local function resolveTrack()
  local fromGame = acCallString('getTrackID') or acCallString('getTrackId')
  if fromGame then
    state.trackSource = 'jeu'
    return fromGame
  end
  state.trackSource = 'config'
  return tostring(readField(sim, 'trackID') or readField(sim, 'track')
    or readField(sim, 'trackId') or cfg.track or '')
end

local function resolveTrackLayout()
  return acCallString('getTrackLayout')
    or tostring(readField(sim, 'trackLayout') or cfg.trackLayout or '')
end

local function resolveServerName()
  return acCallString('getServerName')
    or tostring(readField(sim, 'serverName') or cfg.serverName or '')
end

--- Clé de séance, stable pour toute la vie du script. Le site regroupe les
--- tours PAR SÉANCE : sans clé, deux courses sur le même circuit fusionnaient
--- et les tours 1-2-3 de la seconde étaient refusés comme doublons de la
--- première (constaté : « 3 tours » enregistrés puis « rien »).
local function sessionKey()
  if state.sessionKey then return state.sessionKey end
  -- Pas d'identifiant de séance fiable dans ac.StateSim : une clé par
  -- exécution du script (horodatage + aléa) isole chaque course.
  local ok, t = pcall(os.time)
  local entropy = {}
  for i = 1, 4 do
    entropy[i] = string.format('%08x', math.random(0, 2147483647))
  end
  if ok and type(t) == 'number' then
    state.sessionKey = 'r:' .. tostring(t) .. ':' .. table.concat(entropy)
  else
    state.sessionKey = 'r:' .. table.concat(entropy)
  end
  return state.sessionKey
end

-- Certains champs sont des FONCTIONS sur cette version de CSP (constaté en
-- jeu : car.id, enregistré comme « function: 0x… »). On appelle, et on
-- n'accepte qu'une chaîne ou un nombre — jamais un tostring de fonction.
local function readValue(obj, key)
  local v = readField(obj, key)
  if type(v) == 'function' then
    local ok, r = pcall(v, obj)
    if ok and (type(r) == 'string' or type(r) == 'number') then return r end
    ok, r = pcall(v)
    if ok and (type(r) == 'string' or type(r) == 'number') then return r end
    return nil
  end
  if type(v) == 'string' or type(v) == 'number' then return v end
  return nil
end

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

-- Ces lectures passent par readField : un champ qui LÈVE apparaît dans
-- « champs refusés » au lieu de disparaître dans un nil anonyme — c'est ce
-- qui a caché « compteur: — » pendant que la détection tenait sur la spline.
local function readLapCount()
  local v = readField(car, 'lapCount')
  if type(v) ~= 'number' then v = readField(car, 'lapsCount') end
  if type(v) == 'number' then return v end
  return nil
end

local function readSpline()
  local v = readField(car, 'splinePosition')
  if type(v) == 'number' then return v end
  return nil
end

local function readLastLapMs()
  -- `previousLapTimeMs` est le nom RÉEL dans ac.StateCar (SDK,
  -- common/ac_state.lua) ; les autres sont des replis.
  for _, key in ipairs({ 'previousLapTimeMs', 'lastLapTimeMs', 'lastLapMs' }) do
    local v = readField(car, key)
    if type(v) == 'number' and v > 1000 then return v end
  end
  return nil
end

local function readBestLapMs()
  local v = readField(car, 'bestLapTimeMs')
  if type(v) == 'number' and v > 1000 then return v end
  return nil
end

-- CSP expose les secteurs du pilote local dans car.lastSplits / bestSplits,
-- indexés de 0 à N-1. On copie vers une table Lua 1-indexée pour l'envoyer en
-- JSON. Un tableau incomplet reste absent : aucun secteur n'est estimé.
local function readSectorTimes(fieldName)
  local source = readField(car, fieldName)
  if source == nil then return nil end

  local count = nil
  local marks = readField(sim, 'lapSplits')
  if marks ~= nil then
    local ok, n = pcall(function() return #marks end)
    if ok and type(n) == 'number' and n > 0 then count = n end
  end
  if not count then
    local ok, n = pcall(function() return #source end)
    if ok and type(n) == 'number' and n > 0 then count = n end
  end
  if not count or count < 2 or count > 8 then return nil end

  local out = {}
  for i = 0, count - 1 do
    local ok, value = pcall(function() return source[i] end)
    if not ok or type(value) ~= 'number' or value <= 0 or value > 600000 then
      return nil
    end
    out[#out + 1] = math.floor(value + 0.5)
  end
  return #out == count and out or nil
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

-- Jeton sûr pour une URL (les jetons hexadécimaux passent tels quels).
local function encodeQuery(v)
  return (tostring(v):gsub('[^%w%-_%.%~]', function(c)
    return string.format('%%%02X', string.byte(c))
  end))
end

local function telemetryHeaders()
  local headers = {
    ['Content-Type'] = 'application/json',
    ['User-Agent'] = VERSION,
  }
  if cfg.token ~= '' then headers['X-Telemetry-Token'] = cfg.token end
  return headers
end

local function urlWithToken()
  if cfg.token == '' then return cfg.url end
  return cfg.url .. (cfg.url:find('?', 1, true) and '&' or '?')
    .. 'token=' .. encodeQuery(cfg.token)
end

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
  -- Appelé par CSP (et par CSP seul) : si ce point est atteint, le mode de
  -- transport courant traverse la couche web. On le verrouille pour tous
  -- les envois suivants, tours compris.
  local function libFinish(err, res)
    state.transport = state.mode
    state.transportLocked = true
    finish(err, res)
  end
  state.inflight = true
  state.inflightSince = state.now
  state.lastResponse = ''
  -- Deux façons d'appeler web.post, au choix de CSP :
  --   « nu » : (url, corps, callback), aucun en-tête custom, jeton dans
  --            l'URL. Même silhouette que le GET de la sonde, qui passe.
  --   « en-têtes » : (url, en-têtes, corps, callback) avec Content-Type,
  --            User-Agent et jeton d'en-tête.
  -- Constat en jeu : le GET répond, le POST habillé reste muet. Tant qu'aucun
  -- mode n'a obtenu de réponse, on ALTERNE à chaque essai ; le premier qui
  -- répond devient le mode permanent. La ligne « mode: » à l'écran dit lequel.
  local variants = {
    ['nu'] = function() return pcall(web.post, urlWithToken(), body, libFinish) end,
    ['en-têtes'] = function() return pcall(web.post, cfg.url, telemetryHeaders(), body, libFinish) end,
  }
  if not state.transportLocked then
    -- Tant qu'aucune variante n'a livré de réponse, on essaie l'autre à
    -- chaque essai : le mode visible à l'écran alterne jusqu'à ce qu'une
    -- des deux réponde (et se verrouille dans libFinish).
    state.transport = (state.pingAttempts % 2 == 1) and 'nu' or 'en-têtes'
  end
  state.mode = state.transport
  local ok, err = variants[state.transport]()
  if not ok then
    -- La variante est refusée par cette version de CSP : l'autre, tout de
    -- suite, dans le même essai.
    state.mode = (state.transport == 'nu') and 'en-têtes' or 'nu'
    ok, err = variants[state.mode]()
  end
  state.lastError = ''
  if not ok then
    state.lastError = 'web.post(' .. state.mode .. '): ' .. tostring(err)
    finish(tostring(err), nil)
  end
end

-------------------------------------------------------------------------------
-- 6. Identité : circuit, voiture, pilote.
--    Le guid du pilote est ce qui permet de distinguer deux pilotes sur la même
--    voiture — sans lui, un BoP mesurerait le talent et pas la voiture.
-------------------------------------------------------------------------------
local function ensureIdentity()
  -- Le guid par configuration d'abord : ?guid={SteamID} dans l'URL du script
  -- (injecté par le site) ou guid = … dans la section [SCRIPT_x]. C'est la
  -- seule source fiable — aucun champ de `car` ne l'expose (constaté en jeu).
  if not state.driverGuid and cfg.guid ~= '' then
    state.driverGuid = tostring(cfg.guid)
    state.guidSource = 'config'
  end
  if not state.driverGuid and car then
    -- `ac.StateCar` (SDK, common/ac_state.lua) n'expose AUCUN identifiant
    -- Steam : ni driverGuid, ni driverSteamID. Lire ces champs renvoyait nil
    -- en silence, d'où un guid éternellement vide. Les identifiants réels
    -- passent par csp_extra_options.ini, qui sait substituer {SteamID} dans
    -- l'URL du script (documentation CSP, section [SCRIPT_...]).
    for _, key in ipairs({ 'driverGuid', 'driverSteamID', 'guid', 'steamID' }) do
      local v = readValue(car, key)
      if v ~= nil and tostring(v) ~= '' then
        state.driverGuid = tostring(v)
        state.guidSource = 'API'
        break
      end
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
    local v = readValue(car, 'driverName')
    if v == nil and ac.getDriverName then
      local ok, name = pcall(ac.getDriverName, 0)
      if ok then v = name end
    end
    if v ~= nil then state.driverName = tostring(v) end
  end
  if not state.carId and car then
    -- `car.id` est une FONCTION sur la version testée : sans l'appeler, la
    -- « voiture » enregistrée était « function: 0x… » (visible sur /telemetry).
    local v = readValue(car, 'id')
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

--- Type de séance : l'enum StateSim se lit parfois en numérique, ac.SessionType
--- donne le nom documenté (1 = practice…). Rien d'inventé : la table vient de
--- CSP, et sans elle on garde la valeur brute.
local function resolveSessionType()
  local t = readField(sim, 'raceSessionType') or readField(sim, 'currentSessionType')
  if t == nil then return '' end
  local name = tostring(t)
  local n = tonumber(name)
  if n then
    local st = type(ac) == 'table' and ac.SessionType or nil
    if type(st) == 'table' then
      for key, v in pairs(st) do
        if v == n then return string.lower(key) end
      end
    end
  end
  return name
end

-------------------------------------------------------------------------------
-- 7. Envoi groupé.
-------------------------------------------------------------------------------
local function buildPayload()
  return {
    v = 1,
    script = VERSION,
    campaign = cfg.campaign,
    serverName = resolveServerName(),
    track = resolveTrack(),
    sessionKey = sessionKey(),
    trackConfig = resolveTrackLayout(),
    -- Vrais noms de ac.StateSim (SDK) : fuelConsumptionRate/tyreConsumptionRate
    -- (plage 0…1, pas le FUEL_RATE du serveur) et raceSessionType. Les anciens
    -- noms restent en repli ; `trackGrip` n'existe pas dans StateSim — sa
    -- lecture levait à chaque envoi (bruit « champs refusés »), la colonne
    -- reste « — » côté site, jamais inventée.
    sessionType = resolveSessionType(),
    fuelRate = tonumber(readField(sim, 'fuelConsumptionRate') or readField(sim, 'fuelRate')),
    tyreWearRate = tonumber(readField(sim, 'tyreConsumptionRate') or readField(sim, 'tyreWearRate')),
    airTempC = tonumber(readField(sim, 'ambientTemperature')),
    roadTempC = tonumber(readField(sim, 'roadTemperature')),
    driver = {
      guid = state.driverGuid or '',
      name = state.driverName or '',
    },
    car = state.carId or '',
    laps = state.pending,
  }
end

-- Le site refuse un tour sans pilote ni circuit (validatePush) : autant ne
-- pas l'envoyer — mais il faut le DIRE à l'écran, sinon ce sont des tours qui
-- disparaissent sans que personne sache pourquoi.
local function blockSend(reason)
  if state.sendBlocked == reason then return end
  state.sendBlocked = reason
  message('Télémétrie GDSP : envoi suspendu', reason)
end

local function flush(force)
  if state.pendingCount == 0 or state.inflight then return end
  if not force and (state.now - state.lastSendAt) < cfg.intervalSec then return end
  -- Même raison que dans completeLap : l'absence de guid ne doit pas retenir
  -- les tours indéfiniment. Seule la voiture est indispensable.
  if not state.carId then return end
  if not state.driverGuid then
    blockSend('guid absent — ajouter ?guid={SteamID} à l\'URL du script dans csp_extra_options.ini')
    return
  end
  if resolveTrack() == '' then
    blockSend('circuit inconnu — ajouter track = … à la section [SCRIPT_x] de csp_extra_options.ini')
    return
  end
  state.sendBlocked = ''

  local body = toJson(buildPayload())
  local batch = state.pending
  local count = state.pendingCount
  state.pending = {}
  state.pendingCount = 0
  state.lastSendAt = state.now

  post(body, function(err, res)
    -- Même règle que le ping : la réponse du site s'affiche, mot pour mot.
    -- Sinon « réponse: aucune » après un envoi de tours réussi laissait
    -- croire à un silence.
    local status = res and tonumber(res.status) or nil
    state.lastResponse = err and ('err=' .. tostring(err)) or ('HTTP ' .. tostring(status))
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
    -- Le site dit ce qu'il a RÉELLEMENT enregistré : c'est lui qui sait si
    -- un tour sans temps valide a été écarté. Compter les envois ferait
    -- mentir « tours=N » quand le serveur refuse des tours.
    local added = count
    local duplicates = 0
    if res and type(res.body) == 'string' then
      added = tonumber(res.body:match('"added"%s*:%s*(%-?%d+)')) or count
      duplicates = tonumber(res.body:match('"duplicates"%s*:%s*(%-?%d+)')) or 0
    end
    state.sentLaps = state.sentLaps + added
    log(string.format('%d tour(s) enregistré(s) — total %d', added, state.sentLaps))
    -- Confirmation visible une fois, puis à chaque anomalie : un envoi sans
    -- effet doit se voir à l'écran, pas seulement sur le site.
    if not state.lapConfirmed or (count > 0 and added == 0 and duplicates == 0) then
      state.lapConfirmed = true
      if added > 0 then
        message('Télémétrie GDSP',
          string.format('%d tour(s) enregistré(s) — visible sur /telemetry.', added))
      elseif duplicates > 0 then
        message('Télémétrie GDSP', 'Tours déjà enregistrés — doublons ignorés.')
      else
        message('Télémétrie GDSP : rien enregistré',
          string.format('%d tour(s) envoyé(s) mais écarté(s) — temps de tour illisible ? (voir « champs refusés »)', count))
      end
    end
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

--- Mesure le temps roulé entre le plateau du limiteur à 80 km/h et sa sortie.
--- Le CSP ne fournit pas d'indicateur pit-lane exploitable ici : c'est donc une
--- détection heuristique et non une position exacte sur la voie. Les arrêts au
--- stand ne sont pas comptés (le ravitaillement/changement de pneus est saisi
--- séparément dans le profil de circuit).
local function resetPitLaneDetection()
  state.pitCandidateMs = 0
  state.pitLaneActive = false
  state.pitLaneMs = 0
  state.pitExitMs = 0
  state.pitStopAt = nil
end

local function measurementMessage(text)
  message('Télémétrie · mesure stand', text)
  log('mesure stand : ' .. text)
end

local function failPitMeasurement(reason, force)
  local m = state.measurement
  if not m or m.phase == 'failed' or (m.phase == 'complete' and not force) then return end
  m.phase = 'failed'
  m.error = tostring(reason or 'procédure interrompue')
  measurementMessage(m.error)
end

local function beginPitMeasurement(id, kind, requestedLiters)
  local current = state.measurement
  if current and current.id == id then return end -- commande répétée : idempotente
  if current and current.phase ~= 'complete' and current.phase ~= 'failed' then return end
  if kind ~= 'tyre' and kind ~= 'refuel' then return end
  state.measurement = {
    id = tostring(id),
    kind = kind,
    requestedLiters = kind == 'refuel' and tonumber(requestedLiters) or nil,
    phase = 'before_lap',
    preLaps = 0,
    postLaps = 0,
    serviceDurationMs = nil,
    fuelAddedL = nil,
    tyreReset = false,
    error = nil
  }
  -- Une mesure commence sur un passage neuf : aucun plateau antérieur ne doit
  -- être pris pour l'entrée du protocole demandé.
  resetPitLaneDetection()
  measurementMessage(kind == 'refuel'
    and string.format('ravitaillement de %.1f L demandé — effectuez un tour, puis entrez aux stands.', tonumber(requestedLiters) or 0)
    or 'changement de pneus demandé — effectuez un tour, puis entrez aux stands.')
end

local function measurementSnapshot()
  local m = state.measurement
  if not m then return nil end
  return {
    id = m.id,
    phase = m.phase,
    preLaps = m.preLaps or 0,
    postLaps = m.postLaps or 0,
    serviceDurationMs = m.serviceDurationMs,
    fuelAddedL = m.fuelAddedL,
    refuelRateLps = m.refuelRateLps,
    pitLaneDurationMs = m.pitLaneDurationMs,
    tyreReset = m.tyreReset == true,
    error = m.error
  }
end

local function measurementLapCompleted()
  local m = state.measurement
  if not m then return end
  if m.phase == 'before_lap' then
    m.preLaps = (m.preLaps or 0) + 1
    if m.preLaps >= 1 then
      m.phase = 'wait_pit_entry'
      resetPitLaneDetection()
      measurementMessage('tour avant validé — entrez dans la pit-lane au limiteur de 80 km/h.')
    end
  elseif m.phase == 'after_lap' then
    m.postLaps = (m.postLaps or 0) + 1
    if m.postLaps >= 1 then
      m.phase = 'complete'
      measurementMessage('tour après validé — la mesure est prête à être enregistrée.')
    end
  end
end

local function tyreResetDetected(before, after)
  if not before or not after then return false end
  local increased = 0
  for i = 1, WHEELS do
    if before[i] ~= nil and after[i] ~= nil
        and after[i] >= 0.95 and after[i] > before[i] + 0.0005 then
      increased = increased + 1
    end
  end
  -- Un changement complet remet à neuf les quatre roues. Trois roues au moins
  -- tolèrent une valeur momentanément illisible sans accepter une usure normale.
  return increased >= 3
end

local function startMeasuredService()
  local m = state.measurement
  if not m or m.phase ~= 'pit_lane' then return end
  m.phase = 'service'
  m.stopStartAt = state.now
  m.fuelBefore = readFuelLiters()
  m.fuelLastObserved = m.fuelBefore
  m.fuelMax = m.fuelBefore
  m.tyresBefore = readTyreWear()
  measurementMessage(m.kind == 'refuel'
    and 'arrêt au box détecté — effectuez le ravitaillement demandé, puis repartez.'
    or 'arrêt au box détecté — effectuez uniquement le changement de pneus, puis repartez.')
end

local function observeMeasuredService()
  local m = state.measurement
  if not m or m.phase ~= 'service' then return end
  if m.kind == 'tyre' then
    if tyreResetDetected(m.tyresBefore, readTyreWear()) then
      m.tyreReset = true
      m.serviceDurationMs = math.floor(math.max(0, state.now - m.stopStartAt) * 1000 + 0.5)
      m.phase = 'wait_pit_exit'
      measurementMessage(string.format('pneus neufs confirmés · %.2f s — sortez de la pit-lane.', m.serviceDurationMs / 1000))
    end
    return
  end

  local fuel = readFuelLiters()
  if fuel and m.fuelBefore and fuel > m.fuelBefore + FUEL_CHANGE_EPSILON_L then
    if not m.fuelStartAt then
      m.fuelStartAt = state.now
      m.fuelLastChangeAt = state.now
      m.fuelLastObserved = fuel
      m.fuelMax = fuel
    elseif fuel > (m.fuelLastObserved or m.fuelBefore) + FUEL_CHANGE_EPSILON_L then
      m.fuelLastChangeAt = state.now
      m.fuelLastObserved = fuel
      m.fuelMax = math.max(m.fuelMax or fuel, fuel)
    end
  end
end

local function finishMeasuredService()
  local m = state.measurement
  if not m or m.phase ~= 'service' then return end
  if m.kind == 'tyre' then
    failPitMeasurement('Pneus neufs non confirmés par la télémétrie; aucune durée enregistrée.')
    return
  end
  local fuelEnd = readFuelLiters()
  local measuredEnd = math.max(tonumber(fuelEnd) or -1, tonumber(m.fuelMax) or -1)
  local added = m.fuelBefore and measuredEnd >= m.fuelBefore
    and (measuredEnd - m.fuelBefore) or nil
  local durationMs = m.fuelStartAt and m.fuelLastChangeAt
    and math.floor(math.max(0, m.fuelLastChangeAt - m.fuelStartAt) * 1000 + 0.5) or nil
  if not added or added <= 0.05 or not durationMs or durationMs <= 0 or durationMs > 600000 then
    failPitMeasurement('La hausse réelle du carburant n’a pas permis de mesurer le débit; réessayez sans interrompre le remplissage.')
    return
  end
  local requested = tonumber(m.requestedLiters) or 0
  local tolerance = math.max(0.05, requested * 0.1)
  if requested <= 0 or math.abs(added - requested) > tolerance then
    failPitMeasurement(string.format('%.2f L ajoutés au lieu des %.2f L demandés; aucune valeur enregistrée.', added, requested))
    return
  end
  local rate = added / (durationMs / 1000)
  if rate < 0.05 or rate > 50 then
    failPitMeasurement('Le débit calculé est hors plage mesurable; aucune valeur enregistrée.')
    return
  end
  m.fuelAddedL = math.floor(added * 1000 + 0.5) / 1000
  m.serviceDurationMs = durationMs
  m.refuelRateLps = math.floor(rate * 1000 + 0.5) / 1000
  m.phase = 'wait_pit_exit'
  measurementMessage(string.format('%.2f L en %.2f s · %.3f L/s — sortez de la pit-lane.',
    m.fuelAddedL, m.serviceDurationMs / 1000, m.refuelRateLps))
end

local function pitMeasurementEntry()
  local m = state.measurement
  if m and m.phase == 'wait_pit_entry' then
    m.phase = 'pit_lane'
    measurementMessage('entrée pit-lane confirmée par le plateau 80 km/h — rejoignez le box.')
  end
end

local function pitMeasurementExit()
  local m = state.measurement
  if not m then return end
  if m.phase == 'wait_pit_exit' then
    -- Le compteur pitLaneMs ne progresse jamais véhicule à l'arrêt : on fige
    -- ici le roulage du passage, distinct du chronomètre de service au box.
    m.pitLaneDurationMs = math.floor(math.max(0, state.pitLaneMs) + 0.5)
    if m.pitLaneDurationMs <= 0 then
      failPitMeasurement('Temps de roulage pit-lane non mesurable; aucune valeur de service enregistrée.')
      return
    end
    m.phase = 'after_lap'
    m.postLaps = 0
    measurementMessage(string.format('sortie confirmée · roulage pit-lane %.1f s · service %.2f s — effectuez un tour complet après l’arrêt.',
      m.pitLaneDurationMs / 1000, (m.serviceDurationMs or 0) / 1000))
  elseif m.phase == 'pit_lane' then
    failPitMeasurement('Sortie de pit-lane détectée sans arrêt de service; aucune mesure enregistrée.')
  elseif m.phase == 'service' then
    failPitMeasurement('Le service demandé n’a pas été confirmé avant la sortie des stands.')
  end
end

local function updatePitLane(speedKmh, dt)
  local frameMs = math.max(0, tonumber(dt) or 0) * 1000
  if not speedKmh or frameMs <= 0 then return end

  if not state.pitLaneActive then
    if speedKmh >= PIT_LIMIT_MIN_KMH and speedKmh <= PIT_LIMIT_MAX_KMH then
      state.pitCandidateMs = state.pitCandidateMs + frameMs
      if state.pitCandidateMs >= PIT_LIMIT_CONFIRM_MS then
        state.pitLaneActive = true
        state.pitLaneMs = state.pitCandidateMs
        state.pitExitMs = 0
        pitMeasurementEntry()
      end
    else
      state.pitCandidateMs = 0
    end
    return
  end

  -- La durée d'arrêt/service est suivie à part : elle ne s'ajoute jamais au
  -- roulage entre le plateau 80 et la sortie de la pit-lane.
  if speedKmh <= PIT_STOP_KMH then
    state.pitExitMs = 0
    if not state.pitStopAt then
      state.pitStopAt = state.now
      startMeasuredService()
    end
    observeMeasuredService()
    return
  end

  if state.pitStopAt then
    finishMeasuredService()
    state.pitStopAt = nil
  end

  if speedKmh > PIT_EXIT_KMH then
    state.pitExitMs = state.pitExitMs + frameMs
    if state.pitExitMs >= PIT_EXIT_CONFIRM_MS then
      if state.pitLaneMs >= PIT_MIN_LANE_MS then
        local measuredMs = math.floor(state.pitLaneMs + 0.5)
        state.pendingPitLaneMs[#state.pendingPitLaneMs + 1] = measuredMs
        log(string.format('passage pit-lane détecté au limiteur 80 : %.1f s', measuredMs / 1000))
      end
      pitMeasurementExit()
      resetPitLaneDetection()
    end
    return
  end

  state.pitExitMs = 0
  state.pitLaneMs = state.pitLaneMs + frameMs
end

local function completeLap(lapNumber)
  -- La procédure attend un tour avant puis un tour après le service, même si
  -- le chrono d'un tour est illisible (la détection du compteur reste réelle).
  measurementLapCompleted()
  -- La bannière réapparaît à chaque tour bouclé : c'est le seul moment où
  -- le joueur peut lire compteur, tours enregistrés et anomalies — le reste
  -- du temps, elle serait du bruit.
  state.lastLapAt = state.now
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
  local bestLapMs = readBestLapMs()
  local lastSectorsMs = readSectorTimes('lastSplits')
  local bestSectorsMs = readSectorTimes('bestSplits')
  if lapMs then
    lap.lapMs = math.floor(lapMs + 0.5)
    -- Le passage peut s'être terminé avant ou pendant ce tour. On joint une
    -- mesure en attente au prochain tour complet exploitable, sans modifier
    -- son chrono; un tour sans temps ne consomme pas l'échantillon.
    if #state.pendingPitLaneMs > 0 then
      lap.pitLaneMs = table.remove(state.pendingPitLaneMs, 1)
    end
  end
  if bestLapMs then lap.bestLapMs = math.floor(bestLapMs + 0.5) end
  if lastSectorsMs then lap.lastSectorsMs = lastSectorsMs end
  if bestSectorsMs then lap.bestSectorsMs = bestSectorsMs end
  -- Les secteurs du tour record sont connus sans ambiguïté quand le dernier
  -- tour vient d'égaler le meilleur temps CSP. Sinon on garde séparément les
  -- meilleurs secteurs personnels (qui alimentent le potentiel).
  if lapMs and bestLapMs and lastSectorsMs and math.abs(lapMs - bestLapMs) <= 2 then
    lap.bestLapSectorsMs = lastSectorsMs
  end
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

  log(string.format('tour %s : %s ms%s%s%s',
    tostring(lap.lapNumber), tostring(lap.lapMs or '—'),
    lap.fuelUsedL and string.format(' · %.3f L', lap.fuelUsedL) or ' · conso ?',
    lap.tyreWearPct and ' · usure' or ' · usure ?',
    lap.pitLaneMs and string.format(' · pit-lane %.1f s', lap.pitLaneMs / 1000) or ''))
end

-------------------------------------------------------------------------------
-- 9. Boucle principale.
-------------------------------------------------------------------------------
local function updateStep(dt)
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
  updatePitLane(speed, dt)

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
  -- Une seule requête CSP à la fois : un envoi de tours en attente garde la
  -- priorité, puis le canal de commande reprend à intervalle fixe.
  if state.pinged and not state.inflight and state.now >= state.nextMeasurementPollAt then
    script.pollMeasurement()
  end
end

function script.update(dt)
  -- Une erreur dans la boucle ne doit plus jamais tuer le script en silence :
  -- elle est attrapée et affichée (ligne « blocage: »).
  local ok, err = pcall(updateStep, dt)
  if not ok then
    state.updateError = tostring(err)
  else
    state.updateError = ''
  end
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
    serverName = resolveServerName(),
    track = resolveTrack(),
    sessionKey = sessionKey(),
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
      state.nextMeasurementPollAt = state.now + COMMAND_POLL_SEC
      log('PING accepté (HTTP ' .. tostring(status) .. ') · base joignable côté serveur')
      message('Télémétrie GDSP', 'Connexion au site établie (' .. tostring(status) .. ').')
    else
      log('PING refusé (HTTP ' .. tostring(status) .. ') : ' .. tostring(res and res.body or ''))
      message('Télémétrie GDSP : le site refuse', 'HTTP ' .. tostring(status) ..
        ' · vérifier TELEMETRY_TOKEN / TELEMETRY_ENABLED sur Render')
    end
  end)
end

--- Battement du canal de commande CSP. La page admin ne peut pas atteindre la
--- voiture directement : elle arme une procédure côté serveur, et seul le
--- script de la session ciblée reçoit START via cette requête authentifiée.
function script.pollMeasurement()
  if not state.pinged or state.inflight or cfg.url == '' then return end
  state.nextMeasurementPollAt = state.now + COMMAND_POLL_SEC
  local body = toJson({
    v = 1,
    script = VERSION,
    kind = 'measurement-poll',
    campaign = cfg.campaign,
    serverName = resolveServerName(),
    track = resolveTrack(),
    trackConfig = resolveTrackLayout(),
    sessionKey = sessionKey(),
    clientSecret = state.clientSecret,
    driver = { guid = state.driverGuid or '', name = state.driverName or '' },
    car = state.carId or '',
    measurement = measurementSnapshot()
  })
  post(body, function(err, res)
    if err then
      state.measurementPollErrors = state.measurementPollErrors + 1
      if state.measurementPollErrors == 1 or state.measurementPollErrors % 10 == 0 then
        log('poll de mesure impossible (' .. state.measurementPollErrors .. '×) : ' .. tostring(err))
      end
      return
    end
    local status = res and tonumber(res.status) or 0
    if status < 200 or status >= 300 then
      state.measurementPollErrors = state.measurementPollErrors + 1
      return
    end
    state.measurementPollErrors = 0
    local raw = res and res.body ~= nil and tostring(res.body) or ''
    raw = raw:gsub('^%s+', ''):gsub('%s+$', '')
    local registration = raw:match('^REGISTER|([%w%-]+)$')
    if registration then
      state.clientSecret = registration
      return
    end
    local abortedId = raw:match('^ABORT|([%w%-]+)$')
    if abortedId and state.measurement and state.measurement.id == abortedId then
      failPitMeasurement('Le serveur a interrompu la procédure; aucune mesure ne sera enregistrée.', true)
      return
    end
    local id, kind, liters = raw:match('^START|([%w%-]+)|([%a]+)|([%d%.]+)$')
    if id and kind then beginPitMeasurement(id, kind, tonumber(liters) or 0) end
  end)
end

local function initStep()
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

function script.init()
  local ok, err = pcall(initStep)
  if not ok then state.updateError = 'init: ' .. tostring(err) end
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
  -- Affichée 20 s au démarrage, PUIS tant que le ping n'a pas abouti, PUIS
  -- 15 s à chaque tour bouclé. Une procédure de stand reste visible du début
  -- à la fin, même pendant plusieurs tours.
  local m = state.measurement
  local measurementActive = m and m.phase ~= 'complete' and m.phase ~= 'failed'
  if state.now > 20 and state.pinged and (state.now - state.lastLapAt) > 15
      and not measurementActive then return end
  -- init n'a peut-être jamais été appelé : le diagnostic doit rester lisible.
  pcall(resolveConfig)
  local trackNow = resolveTrack()
  local lines = {
    'GDSP-TELEMETRY ' .. (state.pinged and 'OK' or 'attente'),
    'url(' .. cfgSource .. '): ' .. (cfg.url ~= '' and cfg.url or 'MANQUANTE'),
    'circuit: ' .. (trackNow ~= '' and (trackNow .. ' (' .. tostring(state.trackSource or '?') .. ')') or '—'),
    'web=' .. tostring(state.hasWeb) ..
      ' guid=' .. (state.driverGuid
        and (tostring(state.driverGuid) .. ' (' .. tostring(state.guidSource or 'API') .. ')')
        or 'ABSENT (API)') ..
      ' tours=' .. tostring(state.sentLaps) ..
      ((state.lapsWithoutGuid or 0) > 0 and (' sansguid=' .. state.lapsWithoutGuid) or ''),
    'essais=' .. tostring(state.pingAttempts) ..
      (state.inflight and (' · en vol ' .. string.format('%.0f', state.now - state.inflightSince) .. 's') or ''),
    -- Compteur BRUT de la voiture : s'il ne monte pas en franchissant la
    -- ligne, la détection de tour elle-même est en cause — c'est la première
    -- chose à vérifier quand « tours= » reste à 0.
    'compteur: ' .. tostring(readLapCount() or '—') ..
      ' · spline: ' .. tostring(readSpline() and string.format('%.2f', readSpline()) or '—'),
    'pit-lane: ' .. (state.pitLaneActive
      and string.format('plateau 80 confirmé · %.1f s', state.pitLaneMs / 1000)
      or (#state.pendingPitLaneMs > 0 and 'mesure prête pour le prochain tour' or 'en attente du plateau 80')),
    'mode: ' .. (state.mode ~= '' and state.mode or '—') ..
      (state.transportLocked and ' (fixé)' or ' (alternance)'),
    -- La ligne qui compte : ce que le transport a RÉPONDU, mot pour mot.
    'réponse: ' .. (state.lastResponse ~= '' and state.lastResponse
      or (state.lastError ~= '' and state.lastError or 'aucune')),
    'sonde: ' .. tostring(state.probe),
  }
  if m then
    local phases = {
      before_lap = 'tour avant', wait_pit_entry = 'attente limiteur 80',
      pit_lane = 'entrée stands', service = 'service au box',
      wait_pit_exit = 'sortie des stands', after_lap = 'tour après',
      complete = 'terminée', failed = 'interrompue'
    }
    local detail = phases[m.phase] or tostring(m.phase)
    if m.serviceDurationMs then detail = detail .. string.format(' · service %.2f s', m.serviceDurationMs / 1000) end
    if m.pitLaneDurationMs then detail = detail .. string.format(' · roulage pit-lane %.1f s', m.pitLaneDurationMs / 1000) end
    if m.refuelRateLps then detail = detail .. string.format(' · %.3f L/s', m.refuelRateLps) end
    lines[#lines + 1] = 'procédure stand: ' .. detail
    if m.error then lines[#lines + 1] = 'mesure: ' .. tostring(m.error):sub(1, 90) end
  end
  -- Une erreur attrapée dans la boucle s'affiche : sans cela, un crash
  -- répété dans update restait invisible (le harnais ne peut pas le voir,
  -- ses car/sim sont des tables Lua permissives).
  if state.updateError ~= '' then
    lines[#lines + 1] = 'blocage: ' .. state.updateError:sub(1, 90)
  end
  if state.sendBlocked ~= '' then
    lines[#lines + 1] = 'envoi bloqué: ' .. state.sendBlocked:sub(1, 90)
  end
  if state.fieldErrors then
    local keys = {}
    for k in pairs(state.fieldErrors) do keys[#keys + 1] = k end
    if #keys > 0 then
      table.sort(keys)
      lines[#lines + 1] = 'champs refusés: ' .. table.concat(keys, ', ')
    end
  end
  for i = 1, #lines do
    -- pcall autour de l'appel ET de l'accès à `ui` : si l'objet n'existe pas,
    -- `ui.text` lèverait avant même d'entrer dans pcall.
    pcall(function() ui.text(lines[i]) end)
  end
end

function script.onCarReset()
  -- Une remise en piste rendrait ambiguë le protocole guidé : jamais de durée
  -- enregistrée après un reset ou une téléportation.
  failPitMeasurement('Remise en piste détectée; la procédure a été annulée.')
  resetPitLaneDetection()
  -- Sortie des stands ou remise en piste : les niveaux repartent de zéro, et
  -- le tour en cours ne doit pas être compté comme une consommation.
  state.lapStartFuel = readFuelLiters()
  state.lapStartWear = readTyreWear()
  state.currentLapSpeedMax = 0
end

function script.onSessionEnd()
  flush(true)
end

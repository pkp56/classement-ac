-- GDSP Propreté — classement propreté avec attribution agresseur / agressé ([SCRIPT_3])
--
-- Script CSP Lua en ligne poussé par le serveur via `csp_extra_options.ini` :
--   [SCRIPT_3]
--   SCRIPT = 'https://gdsp.duckdns.org/csp/cleanliness.lua'
--   REQUIRED = 0
--
-- Principes :
--   * STRICTEMENT READ-ONLY sur la physique : aucune modification de voiture,
--     aucune pénalité de jeu, aucune interdiction de conduite. Le script est
--     sûr pour un serveur public comme pour une manche officielle.
--   * Détection par `ac.onCarCollision(carIndex, callback)` sur les voitures du
--     serveur + repli dans `script.update` sur `car.collidedWith` / `car.collisionDepth`,
--     avec dédoublonnage temporel par paire de voitures (un même contact entre
--     A et B n'est jugé qu'une seule fois).
--   * Attribution de la faute selon les critères FIA (Driving Standards
--     Guidelines, Appendix L Ch. IV, appliqués par la FFSA) :
--       1. Sévérité minimale : collisions très légères ignorées
--          (`collisionDepth < minDepth` et vitesse relative `< minRelSpeedKmh`).
--       2. Droit au virage (overlap longitudinal dans le repère de la voiture
--          défendue) :
--            - dépassement intérieur : l'essieu avant de l'attaquant doit être
--              au moins à hauteur du rétroviseur / habitacle du défenseur ;
--            - dépassement extérieur : l'essieu avant de l'attaquant doit être
--              devant l'essieu avant du défenseur.
--          Sans cet engagement minimal, l'attaquant (derrière) est l'agresseur.
--       3. Responsabilité du défenseur quand l'engagement est acquis : si le
--          vecteur vitesse du défenseur converge nettement vers l'attaquant ou
--          s'il bouge latéralement sous freinage après le début de sa
--          décélération alors que l'attaquant tient sa ligne, le défenseur est
--          l'agresseur.
--       4. Évitement / freinage : celui qui freine fort pour éviter quand
--          l'autre maintient les gaz / ne freine pas est l'agressé ; si les
--          deux contribuent (convergence mutuelle ou comportements symétriques),
--          l'incident est classé « partagé » (« both contributed ») et personne
--          ne prend de point.
--       5. Sortie forcée : une courte fenêtre d'observation (1,2 s) après le
--          choc permet de repérer un pilote contraint de sortir de piste
--          (`wheelsOutside >= 3`) pour éviter ou sous l'effet direct du choc ;
--          s'il n'était pas déjà fautif, l'autre est désigné agresseur.
--   * Barème :
--       - Agresseur : +1 point d'agressivité au classement propreté ;
--       - Agressé : +`victimBonus` (0 par défaut) ;
--       - Incident partagé (« both ») : 0 pour chacun.
--   * Diffusion : événement réseau `ac.OnlineEvent` (clé `cleanlinessScoreEnd`
--     avec les champs `Score`, `Agresseur`, `Agresse`, `Car`, `Time`) + message
--     chat via `ac.sendChatMessage` (« Agresseur : PiloteA — Agressé : PiloteB »)
--     émis par une seule instance autoritaire pour éviter tout doublon en ligne.
--   * Persistance optionnelle : mémoire + `ac.storage` si disponible + écriture
--     protégée par `pcall` dans `cleanliness-scores.json` lorsque l'hôte Lua
--     expose `io.open` (ignorée proprement dans le bac à sable client CSP).

local VERSION = 'GDSP-CLEANLINESS 1.0.0'

local CFG_DEFAULTS = {
  enabled = 1,
  minDepth = 0.015,            -- profondeur minimale de pénétration (m)
  minRelSpeedKmh = 10,         -- vitesse relative minimale (km/h)
  pairCooldownSec = 4.0,       -- anti-rebond par paire de voitures (s)
  evalWindowSec = 1.2,         -- fenêtre post-impact pour observer une sortie forcée (s)
  carHalfLengthM = 2.25,       -- demi-longueur typique pour estimer essieu avant / rétro
  frontAxleOffsetM = 1.35,     -- distance centre -> essieu avant (m)
  mirrorOffsetM = 0.35,        -- distance centre -> rétroviseur / montant A (m)
  lateralCloseM = 2.6,         -- proximité latérale max pour parler de côte-à-côte (m)
  convergeMps = 1.35,          -- vitesse latérale de rabattement significative (m/s)
  brakeMoveLatMps = 1.10,      -- déport latéral sous freinage (m/s)
  hardBrake = 0.45,            -- seuil de freinage franc (0..1)
  fullGas = 0.55,              -- seuil de maintien d'accélérateur (0..1)
  victimBonus = 0,             -- 0 par défaut (optionnel, conformément au cahier des charges)
  announceChat = 1,            -- message chat sur verdict agresseur / agressé
  announceShared = 0,          -- annoncer aussi les faits de course partagés (0 = silencieux)
  persistFile = 'cleanliness-scores.json',
  debug = 0,
}

-------------------------------------------------------------------------------
-- Utilitaires sûrs (les structs Cdata CSP lèvent sur champ inconnu).
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

local function safeVec(obj, key)
  local v = safeField(obj, key)
  if v == nil then return nil end
  local ok, x, y, z = pcall(function() return tonumber(v.x), tonumber(v.y), tonumber(v.z) end)
  if ok and x and y and z then return { x = x, y = y, z = z } end
  return nil
end

local function safeLog(msg)
  if type(ac) == 'table' and type(ac.log) == 'function' then
    pcall(ac.log, '[GDSP-CLEAN] ' .. tostring(msg))
  end
end

local function vecSub(a, b)
  return { x = a.x - b.x, y = a.y - b.y, z = a.z - b.z }
end

local function vecDot(a, b)
  return a.x * b.x + a.y * b.y + a.z * b.z
end

local function vecLen(a)
  return math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
end

local function vecNorm(a)
  local l = vecLen(a)
  if l < 1e-6 then return { x = 0, y = 0, z = 1 }, 0 end
  return { x = a.x / l, y = a.y / l, z = a.z / l }, l
end

local function sanitizeCfg(raw)
  local c = {}
  for k, def in pairs(CFG_DEFAULTS) do
    local v = raw and raw[k]
    if v == nil or v == '' then
      c[k] = def
    elseif type(def) == 'number' then
      c[k] = tonumber(v) or def
    else
      c[k] = tostring(v)
    end
  end
  c.enabled = c.enabled ~= 0 and 1 or 0
  c.minDepth = clamp(c.minDepth, 0, 1.0)
  c.minRelSpeedKmh = clamp(c.minRelSpeedKmh, 0, 120)
  c.pairCooldownSec = clamp(c.pairCooldownSec, 0.5, 30)
  c.evalWindowSec = clamp(c.evalWindowSec, 0, 5)
  c.announceChat = c.announceChat ~= 0 and 1 or 0
  c.announceShared = c.announceShared ~= 0 and 1 or 0
  c.debug = c.debug ~= 0 and 1 or 0
  return c
end

local sim = (type(ac) == 'table' and type(ac.getSim) == 'function') and ac.getSim() or nil
local okCfg, readCfg = false, nil
if type(ac) == 'table' and type(ac.configValues) == 'function' then
  okCfg, readCfg = pcall(ac.configValues, CFG_DEFAULTS)
end
local cfg = sanitizeCfg(okCfg and readCfg or CFG_DEFAULTS)

-------------------------------------------------------------------------------
-- État du classement propreté et historique court par voiture.
-------------------------------------------------------------------------------
local state = {
  now = 0,
  lastSessionIdx = -1,
  hookedCars = {},         -- [carIndex] = true une fois ac.onCarCollision attaché
  pairCooldown = {},       -- ["min:max"] = timestamp du dernier contact pris en compte
  pending = {},            -- incidents en attente de fin de fenêtre (sortie forcée)
  carHist = {},            -- [carIndex] = { brakingSince, brakeStartLat, prevOffTrack, lastCollidedWith }
  scores = {},             -- [driverKey] = { name, car, points, victimCount, sharedCount, incidents }
  verdicts = {},           -- journal mémoire des verdicts de la session
}

local persistentStore = nil
if type(ac) == 'table' and type(ac.storage) == 'function' then
  local okS, st = pcall(ac.storage, { scoresJson = '{}' })
  if okS and st then persistentStore = st end
end

local function jsonEscape(s)
  s = tostring(s or '')
  return (s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t'))
end

local function serializeScores()
  local parts = {}
  local keys = {}
  for k in pairs(state.scores) do keys[#keys + 1] = k end
  table.sort(keys)
  for i = 1, #keys do
    local k = keys[i]
    local e = state.scores[k]
    parts[#parts + 1] = string.format(
      '{"driver":"%s","car":"%s","score":%d,"victim":%d,"shared":%d,"incidents":%d}',
      jsonEscape(e.name), jsonEscape(e.car),
      tonumber(e.points) or 0, tonumber(e.victimCount) or 0,
      tonumber(e.sharedCount) or 0, tonumber(e.incidents) or 0
    )
  end
  return '{"version":"' .. jsonEscape(VERSION) .. '","drivers":[' .. table.concat(parts, ',') .. ']}'
end

local function persistScores()
  local payload = serializeScores()
  if persistentStore then
    pcall(function() persistentStore.scoresJson = payload end)
  end
  local path = tostring(cfg.persistFile or '')
  if path ~= '' and not path:find('..', 1, true) and not path:find('[/\\]') then
    if type(io) == 'table' and type(io.open) == 'function' then
      pcall(function()
        local f = io.open(path, 'w')
        if f then f:write(payload); f:close() end
      end)
    end
  end
end

-------------------------------------------------------------------------------
-- Lecture d'une voiture et repère local (avant / droite).
-------------------------------------------------------------------------------
local function getCar(idx)
  if type(ac) ~= 'table' or type(ac.getCar) ~= 'function' then return nil end
  local ok, c = pcall(ac.getCar, idx)
  if ok then return c end
  return nil
end

local function carsCount()
  local n = safeNum(sim, 'carsCount', nil)
  if n and n > 0 then return math.floor(n) end
  return 0
end

local function driverName(car, fallbackIdx)
  local idx = safeNum(car, 'index', fallbackIdx or 0)
  if type(ac) == 'table' and type(ac.getDriverName) == 'function' then
    local ok, n = pcall(ac.getDriverName, idx)
    if ok and type(n) == 'string' and n ~= '' then return n end
  end
  local direct = safeField(car, 'driverName')
  if type(direct) == 'string' and direct ~= '' then return direct end
  return 'Voiture #' .. tostring(idx)
end

local function carModel(car, fallbackIdx)
  local idx = safeNum(car, 'index', fallbackIdx or 0)
  if type(ac) == 'table' and type(ac.getCarID) == 'function' then
    local ok, id = pcall(ac.getCarID, idx)
    if ok and type(id) == 'string' and id ~= '' then return id end
  end
  local direct = safeField(car, 'id')
  if type(direct) == 'string' and direct ~= '' then return direct end
  return 'car_' .. tostring(idx)
end

local function snapshotCar(car, idx)
  if not car then return nil end
  local pos = safeVec(car, 'position') or { x = 0, y = 0, z = 0 }
  local vel = safeVec(car, 'velocity')
  local look = safeVec(car, 'look')
  local side = safeVec(car, 'side')
  local speedKmh = safeNum(car, 'speedKmh', nil)
  if not vel then
    local sp = (speedKmh or 0) / 3.6
    local fwd = look and (vecNorm(look)) or { x = 0, y = 0, z = 1 }
    vel = { x = fwd.x * sp, y = fwd.y * sp, z = fwd.z * sp }
  end
  if not speedKmh then speedKmh = vecLen(vel) * 3.6 end
  if not look then
    local n, l = vecNorm(vel)
    look = l > 0.5 and n or { x = 0, y = 0, z = 1 }
  else
    look = (vecNorm(look))
  end
  if not side then
    -- Produit vectoriel up(0,1,0) × look -> vecteur droite sur plan horizontal.
    side = (vecNorm({ x = look.z, y = 0, z = -look.x }))
  else
    side = (vecNorm(side))
  end
  local hist = state.carHist[idx] or {}
  return {
    index = idx,
    sessionID = safeNum(car, 'sessionID', idx),
    name = driverName(car, idx),
    model = carModel(car, idx),
    pos = pos,
    vel = vel,
    look = look,
    side = side,
    speedKmh = speedKmh,
    spline = safeNum(car, 'splinePosition', 0),
    gas = clamp(safeNum(car, 'gas', 0), 0, 1),
    brake = clamp(safeNum(car, 'brake', 0), 0, 1),
    wheelsOutside = safeNum(car, 'wheelsOutside', 0),
    inPit = safeBool(car, 'isInPit') or safeBool(car, 'isInPitlane'),
    brakingSince = hist.brakingSince,
    latDriftUnderBraking = hist.latDrift or 0,
  }
end

-------------------------------------------------------------------------------
-- Événement réseau CSP (`cleanlinessScoreEnd`) + annonce chat sans doublon.
-------------------------------------------------------------------------------
local sendCleanEvt, accessCleanEvt = nil, nil

local function onCleanlinessEvent(sender, message)
  if not message then return end
  local aggr = tostring(message.Agresseur or '')
  local vict = tostring(message.Agresse or '')
  if aggr == '' then return end
  -- Si un pair autoritaire publie un verdict que nous n'avons pas localement,
  -- on met à jour le tableau mémoire pour garder la même vue partout.
  local me = getCar(0)
  if sender and me and safeField(sender, 'index') == safeField(me, 'index') then return end
  local entry = state.scores[aggr]
  if not entry then
    state.scores[aggr] = {
      name = aggr, car = tostring(message.Car or ''),
      points = tonumber(message.Score) or 1,
      victimCount = 0, sharedCount = 0, incidents = 1,
    }
  elseif (tonumber(message.Score) or 0) > entry.points then
    entry.points = tonumber(message.Score) or entry.points
  end
  if vict ~= '' and not state.scores[vict] then
    state.scores[vict] = { name = vict, car = '', points = 0, victimCount = 1, sharedCount = 0, incidents = 1 }
  end
end

if type(ac) == 'table' and type(ac.OnlineEvent) == 'function' and type(ac.StructItem) == 'table' then
  local okE, sE, aE = pcall(function()
    return ac.OnlineEvent({
      ac.StructItem.key('cleanlinessScoreEnd'),
      Score = ac.StructItem.int32(),
      Agresseur = ac.StructItem.string(48),
      Agresse = ac.StructItem.string(48),
      Car = ac.StructItem.string(40),
      Time = ac.StructItem.int32(),
    }, onCleanlinessEvent)
  end)
  if okE then sendCleanEvt, accessCleanEvt = sE, aE end
end

-- Seule une instance publie sur le chat / OnlineEvent par incident pour éviter
-- que 20 clients connectés n'envoient 20 fois la même ligne :
--   - hors ligne ou si l'hôte est admin, cette instance publie ;
--   - sinon, l'instance de la voiture impliquée d'indice le plus bas publie.
local function shouldBroadcastForPair(idxA, idxB)
  if not sim or not safeBool(sim, 'isOnlineRace') then return true end
  local me = getCar(0)
  if not me then return true end
  local myIdx = safeNum(me, 'index', 0)
  if safeBool(sim, 'isAdmin') and (myIdx == idxA or myIdx == idxB) then return true end
  return myIdx == math.min(idxA, idxB)
end

local function emitVerdict(verdict)
  state.verdicts[#state.verdicts + 1] = verdict
  if verdict.status == 'fault' then
    local ag = verdict.aggressor
    local vi = verdict.victim
    local eA = state.scores[ag.name] or { name = ag.name, car = ag.model, points = 0, victimCount = 0, sharedCount = 0, incidents = 0 }
    eA.car = ag.model
    eA.points = eA.points + 1
    eA.incidents = eA.incidents + 1
    state.scores[ag.name] = eA

    local eV = state.scores[vi.name] or { name = vi.name, car = vi.model, points = 0, victimCount = 0, sharedCount = 0, incidents = 0 }
    eV.car = vi.model
    eV.points = eV.points + (tonumber(cfg.victimBonus) or 0)
    eV.victimCount = eV.victimCount + 1
    eV.incidents = eV.incidents + 1
    state.scores[vi.name] = eV

    persistScores()

    if shouldBroadcastForPair(ag.index, vi.index) then
      if sendCleanEvt and accessCleanEvt then
        pcall(function()
          local p = accessCleanEvt()
          p.Score = eA.points
          p.Agresseur = ag.name:sub(1, 47)
          p.Agresse = vi.name:sub(1, 47)
          p.Car = ag.model:sub(1, 39)
          p.Time = math.floor(verdict.sessionTimeMs or 0)
          sendCleanEvt()
        end)
      end
      if cfg.announceChat == 1 and type(ac) == 'table' and type(ac.sendChatMessage) == 'function' then
        pcall(ac.sendChatMessage, string.format(
          '[Propreté] Agresseur : %s — Agressé : %s (%s · score propreté : %d)',
          ag.name, vi.name, verdict.reasonLabel, eA.points
        ))
      end
    end
  elseif verdict.status == 'both' then
    for _, side in ipairs({ verdict.carA, verdict.carB }) do
      local e = state.scores[side.name] or { name = side.name, car = side.model, points = 0, victimCount = 0, sharedCount = 0, incidents = 0 }
      e.car = side.model
      e.sharedCount = e.sharedCount + 1
      e.incidents = e.incidents + 1
      state.scores[side.name] = e
    end
    persistScores()
    if cfg.announceShared == 1 and shouldBroadcastForPair(verdict.carA.index, verdict.carB.index) then
      if type(ac) == 'table' and type(ac.sendChatMessage) == 'function' then
        pcall(ac.sendChatMessage, string.format(
          '[Propreté] Incident partagé : %s / %s (aucun point)',
          verdict.carA.name, verdict.carB.name
        ))
      end
    end
  end
end

-------------------------------------------------------------------------------
-- Règles FIA / FFSA d'attribution agresseur / agressé.
--
-- Fonction pure : peut être appelée directement par les tests unitaires Lua
-- avec deux instantanés `snapA`, `snapB`, la profondeur `depth` et un état
-- post-impact optionnel `after = { aForcedOff = bool, bForcedOff = bool }`.
-------------------------------------------------------------------------------
local function classifyCollision(snapA, snapB, depth, after)
  if not snapA or not snapB then return { status = 'ignored', reason = 'missing_car' } end
  if snapA.inPit or snapB.inPit then return { status = 'ignored', reason = 'pitlane' } end

  local relVel = vecSub(snapA.vel, snapB.vel)
  local relSpeedKmh = vecLen(relVel) * 3.6
  local d = tonumber(depth) or 0
  if d < cfg.minDepth and relSpeedKmh < cfg.minRelSpeedKmh then
    return { status = 'ignored', reason = 'light_contact', relSpeedKmh = relSpeedKmh, depth = d }
  end
  if relSpeedKmh < cfg.minRelSpeedKmh * 0.6 then
    return { status = 'ignored', reason = 'very_low_rel_speed', relSpeedKmh = relSpeedKmh, depth = d }
  end

  -- Qui est le défenseur (devant) et qui est le dépasseur (derrière) ?
  -- Projection du vecteur B->A sur l'axe longitudinal moyen des deux voitures.
  local avgFwd = vecNorm({
    x = snapA.look.x + snapB.look.x,
    y = snapA.look.y + snapB.look.y,
    z = snapA.look.z + snapB.look.z,
  })
  local bToA = vecSub(snapA.pos, snapB.pos)
  local longLeadA = vecDot(bToA, avgFwd) -- > 0 signifie A devant B
  local defender, attacker, forcedDef, forcedAtt
  if longLeadA >= 0 then
    defender, attacker = snapA, snapB
    forcedDef = after and after.aForcedOff == true or false
    forcedAtt = after and after.bForcedOff == true or false
  else
    defender, attacker = snapB, snapA
    forcedDef = after and after.bForcedOff == true or false
    forcedAtt = after and after.aForcedOff == true or false
  end

  -- Coordonnées de l'attaquant dans le repère local du défenseur :
  --   longOffset : position du centre de l'attaquant le long de defender.look (m, <= 0 s'il est derrière)
  --   latOffset  : décalage latéral le long de defender.side (+ = à droite du défenseur, - = à gauche)
  local defToAtt = vecSub(attacker.pos, defender.pos)
  local longOffset = vecDot(defToAtt, defender.look)
  local latOffset = vecDot(defToAtt, defender.side)
  local absLat = math.abs(latOffset)
  local sideSign = latOffset >= 0 and 1 or -1 -- sens défenseur -> attaquant

  -- Essieu avant de l'attaquant exprimé dans le repère longitudinal du défenseur.
  local attFrontInDef = longOffset + cfg.frontAxleOffsetM * vecDot(attacker.look, defender.look)

  -- Intérieur vs extérieur : si la courbure locale ou le braquage n'est pas
  -- connu, on distingue dépassement franc par derrière (pare-chocs contre
  -- pare-chocs, absLat faible) d'un dépassement côte-à-côte. Pour le côte-à-côte :
  --   - si l'attaquant est du côté intérieur présumé (côté vers lequel pointe
  --     légèrement le cap du défenseur par rapport à la corde) -> seuil rétro ;
  --   - s'il est à l'extérieur -> seuil essieu avant du défenseur.
  -- En l'absence de courbure mesurable, le critère FIA intérieur (rétroviseur,
  -- `mirrorOffsetM`) est le minimum absolu d'engagement ; le critère extérieur
  -- exige `attFrontInDef >= frontAxleOffsetM`.
  local isRearEnd = absLat < 1.05 and longOffset < -cfg.carHalfLengthM * 0.65
  local turnSign = vecDot(defender.vel, defender.side) -- dérive/inscription latérale du défenseur
  local isOutsidePass = (math.abs(turnSign) > 0.35) and ((turnSign * sideSign) < 0)
  local requiredFrontPos = isOutsidePass and cfg.frontAxleOffsetM or cfg.mirrorOffsetM
  local hasOverlap = (not isRearEnd) and (absLat <= cfg.lateralCloseM) and (attFrontInDef >= requiredFrontPos)

  -- Vitesses latérales dans le repère du défenseur :
  --   defTowardsAtt > 0 : le défenseur se rabat vers le côté où se trouve l'attaquant
  --   attTowardsDef > 0 : l'attaquant se déporte vers le défenseur
  local defLatVel = vecDot(defender.vel, defender.side) * sideSign
  local attLatVel = -vecDot(attacker.vel, defender.side) * sideSign

  -- Signal de freinage / évitement de chaque pilote.
  local defAvoiding = (defender.brake >= cfg.hardBrake and defender.gas < 0.25)
  local attAvoiding = (attacker.brake >= cfg.hardBrake and attacker.gas < 0.25)
  local defPushing = (defender.gas >= cfg.fullGas and defender.brake < 0.1)
  local attPushing = (attacker.gas >= cfg.fullGas and attacker.brake < 0.1)

  -- 1. Choc arrière caractérisé (pare-chocs arrière du défenseur, aucune superposition) :
  --    l'attaquant qui percute par derrière est l'agresseur, sauf brake-check
  --    manifeste en ligne droite hors zone de freinage non détecté ici.
  if isRearEnd then
    return {
      status = 'fault', aggressor = attacker, victim = defender,
      reason = 'rear_end', reasonLabel = 'choc arrière sans superposition',
    }
  end

  -- 2. Pas le droit au virage (engagement insuffisant à l'apex / au point de choc) :
  --    selon les lignes directrices FIA, l'attaquant n'avait pas acquis la
  --    priorité -> il est l'agresseur (sauf s'il freine déjà fort pour renoncer
  --    pendant que le défenseur change brusquement de ligne sous freinage).
  if not hasOverlap then
    local defMovedUnderBraking = (defender.brake >= 0.25)
      and (math.abs(defender.latDriftUnderBraking or 0) >= cfg.brakeMoveLatMps or defLatVel >= cfg.convergeMps * 1.25)
    if defMovedUnderBraking and attAvoiding then
      return {
        status = 'fault', aggressor = defender, victim = attacker,
        reason = 'moving_under_braking', reasonLabel = 'déport sous freinage',
      }
    end
    return {
      status = 'fault', aggressor = attacker, victim = defender,
      reason = isOutsidePass and 'no_outside_overlap' or 'no_inside_overlap',
      reasonLabel = isOutsidePass and 'extérieur sans essieu avant devant' or 'intérieur sans essieu à hauteur du rétro',
    }
  end

  -- 3. L'attaquant A le droit au virage (superposition acquise).
  --    a) Les deux convergent franchement l'un vers l'autre -> responsabilité partagée.
  if defLatVel >= cfg.convergeMps and attLatVel >= cfg.convergeMps then
    return {
      status = 'both', carA = defender, carB = attacker,
      reason = 'mutual_convergence', reasonLabel = 'convergence mutuelle',
    }
  end

  --    b) Le défenseur se rabat sur l'attaquant ou bouge sous freinage alors que
  --       l'attaquant tient sa ligne -> le défenseur est l'agresseur.
  local defTurnedIn = defLatVel >= cfg.convergeMps
    or (defender.brake >= 0.25 and (defender.latDriftUnderBraking or 0) * sideSign >= cfg.brakeMoveLatMps)
  if defTurnedIn and attLatVel < cfg.convergeMps then
    return {
      status = 'fault', aggressor = defender, victim = attacker,
      reason = 'defender_squeezed', reasonLabel = 'rabattement du défenseur malgré priorité acquise',
    }
  end

  --    c) L'attaquant élargit / glisse dans le défenseur qui lui laissait la place.
  if attLatVel >= cfg.convergeMps and defLatVel < cfg.convergeMps then
    return {
      status = 'fault', aggressor = attacker, victim = defender,
      reason = 'attacker_ran_wide', reasonLabel = 'perte de ligne du dépasseur',
    }
  end

  -- 4. Sortie forcée juste après le contact (un seul des deux part hors piste).
  if forcedAtt and not forcedDef then
    return {
      status = 'fault', aggressor = defender, victim = attacker,
      reason = 'forced_off_track', reasonLabel = 'sortie de piste forcée',
    }
  elseif forcedDef and not forcedAtt then
    return {
      status = 'fault', aggressor = attacker, victim = defender,
      reason = 'forced_off_track', reasonLabel = 'sortie de piste forcée',
    }
  end

  -- 5. Critère d'évitement / freinage : celui qui freine fort pour éviter face
  --    à quelqu'un qui garde les gaz est l'agressé.
  if defAvoiding and attPushing then
    return {
      status = 'fault', aggressor = attacker, victim = defender,
      reason = 'no_avoidance', reasonLabel = 'absence d’évitement du dépasseur',
    }
  elseif attAvoiding and defPushing then
    return {
      status = 'fault', aggressor = defender, victim = attacker,
      reason = 'no_avoidance', reasonLabel = 'absence d’évitement du défenseur',
    }
  end

  -- 6. Sinon : les deux pilotes ont contribué ou l'incident est symétrique ->
  --    aucun point (« both contributed »).
  return {
    status = 'both', carA = defender, carB = attacker,
    reason = 'both_contributed', reasonLabel = 'incident partagé',
  }
end

-------------------------------------------------------------------------------
-- Enregistrement des collisions et fenêtre courte d'observation post-impact.
-------------------------------------------------------------------------------
local function pairKey(a, b)
  if a < b then return tostring(a) .. ':' .. tostring(b) end
  return tostring(b) .. ':' .. tostring(a)
end

local function recordCollision(idxA, idxB, depthHint)
  if cfg.enabled ~= 1 then return end
  if idxA == nil or idxB == nil or idxA < 0 or idxB < 0 or idxA == idxB then return end
  local key = pairKey(idxA, idxB)
  local lastT = state.pairCooldown[key]
  if lastT and (state.now - lastT) < cfg.pairCooldownSec then return end

  local carA = getCar(idxA)
  local carB = getCar(idxB)
  if not carA or not carB then return end
  local snapA = snapshotCar(carA, idxA)
  local snapB = snapshotCar(carB, idxB)
  local depth = math.max(
    tonumber(depthHint) or 0,
    safeNum(carA, 'collisionDepth', 0),
    safeNum(carB, 'collisionDepth', 0)
  )

  -- Filtre immédiat sur micro-touchettes pour ne même pas armer le cooldown si ce
  -- n'était qu'un effleurement insignifiant.
  local relSpeedKmh = vecLen(vecSub(snapA.vel, snapB.vel)) * 3.6
  if depth < cfg.minDepth and relSpeedKmh < cfg.minRelSpeedKmh then return end

  state.pairCooldown[key] = state.now
  local sessionTimeMs = safeNum(sim, 'currentSessionTime', state.now * 1000)

  if cfg.evalWindowSec <= 0 then
    local v = classifyCollision(snapA, snapB, depth, nil)
    v.sessionTimeMs = sessionTimeMs
    emitVerdict(v)
    return
  end

  state.pending[#state.pending + 1] = {
    dueAt = state.now + cfg.evalWindowSec,
    snapA = snapA,
    snapB = snapB,
    depth = depth,
    sessionTimeMs = sessionTimeMs,
    aWasOff = (snapA.wheelsOutside or 0) >= 3,
    bWasOff = (snapB.wheelsOutside or 0) >= 3,
    aForcedOff = false,
    bForcedOff = false,
  }
end

local function ensureCollisionHooks()
  if type(ac) ~= 'table' or type(ac.onCarCollision) ~= 'function' then return end
  local n = carsCount()
  for i = 0, n - 1 do
    if not state.hookedCars[i] then
      state.hookedCars[i] = true
      local carIndex = i
      pcall(ac.onCarCollision, carIndex, function(otherIndex)
        local c = getCar(carIndex)
        local other = tonumber(otherIndex)
        if other == nil or other < 0 then
          other = safeNum(c, 'collidedWith', -1) - 1
          -- Selon la version CSP, `car.collidedWith` vaut 0 quand il n'y a
          -- personne ou l'indice 0-based / 1-based : on vérifie ci-dessous.
          local raw = safeNum(c, 'collidedWith', -1)
          if raw >= 0 and raw < carsCount() and raw ~= carIndex then
            other = raw
          else
            other = -1
          end
        end
        if other and other >= 0 and other ~= carIndex then
          recordCollision(carIndex, other, safeNum(c, 'collisionDepth', 0))
        end
      end)
    end
  end
end

local function updateCarHistories(dt)
  local n = carsCount()
  for i = 0, n - 1 do
    local c = getCar(i)
    if c and safeField(c, 'isConnected') ~= false then
      local h = state.carHist[i]
      if not h then h = { latDrift = 0, prevCollided = -1 }; state.carHist[i] = h end
      local brake = safeNum(c, 'brake', 0)
      local vel = safeVec(c, 'velocity')
      local side = safeVec(c, 'side')
      local latV = (vel and side) and vecDot(vel, (vecNorm(side))) or 0
      if brake >= 0.25 then
        if not h.brakingSince then
          h.brakingSince = state.now
          h.baseLatV = latV
        end
        h.latDrift = latV - (h.baseLatV or 0)
      else
        h.brakingSince = nil
        h.baseLatV = nil
        h.latDrift = 0
      end

      -- Repli polling si une version CSP ne déclenche `ac.onCarCollision` que
      -- pour la voiture locale (indice 0).
      local cw = safeNum(c, 'collidedWith', -1)
      if cw >= 0 and cw < n and cw ~= i and cw ~= h.prevCollided then
        recordCollision(i, cw, safeNum(c, 'collisionDepth', 0))
      end
      h.prevCollided = cw
    end
  end
end

local function flushPending()
  if #state.pending == 0 then return end
  local keep = {}
  for i = 1, #state.pending do
    local p = state.pending[i]
    local cA = getCar(p.snapA.index)
    local cB = getCar(p.snapB.index)
    if cA and not p.aWasOff and safeNum(cA, 'wheelsOutside', 0) >= 3 then p.aForcedOff = true end
    if cB and not p.bWasOff and safeNum(cB, 'wheelsOutside', 0) >= 3 then p.bForcedOff = true end
    if state.now >= p.dueAt then
      local v = classifyCollision(p.snapA, p.snapB, p.depth, {
        aForcedOff = p.aForcedOff,
        bForcedOff = p.bForcedOff,
      })
      v.sessionTimeMs = p.sessionTimeMs
      emitVerdict(v)
    else
      keep[#keep + 1] = p
    end
  end
  state.pending = keep
end

local function resetSession()
  state.pairCooldown = {}
  state.pending = {}
  state.carHist = {}
  state.scores = {}
  state.verdicts = {}
end

if type(ac) == 'table' and type(ac.onSessionStart) == 'function' then
  pcall(ac.onSessionStart, resetSession)
end

-------------------------------------------------------------------------------
-- Boucle principale CSP (protégée par pcall : aucune erreur ne peut remonter).
-------------------------------------------------------------------------------
script = script or {}

function script.update(dt)
  local ok, err = pcall(function()
    dt = tonumber(dt) or 0
    if dt < 0 then dt = 0 end
    state.now = state.now + dt

    local sessIdx = safeNum(sim, 'currentSessionIndex', -1)
    if state.lastSessionIdx ~= -1 and sessIdx ~= state.lastSessionIdx then
      resetSession()
    end
    state.lastSessionIdx = sessIdx

    if cfg.enabled ~= 1 then return end
    ensureCollisionHooks()
    updateCarHistories(dt)
    flushPending()
  end)
  if not ok and cfg.debug == 1 then
    safeLog('update error: ' .. tostring(err))
  end
end

-- Export interne non intrusif pour vérification unitaire hors jeu (fengari).
__GDSP_CLEANLINESS__ = {
  version = VERSION,
  cfg = cfg,
  state = state,
  classifyCollision = classifyCollision,
  recordCollision = recordCollision,
  snapshotCar = snapshotCar,
  resetSession = resetSession,
  serializeScores = serializeScores,
}

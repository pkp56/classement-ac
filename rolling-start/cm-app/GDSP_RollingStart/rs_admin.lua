-- GDSP Rolling Start & Race Control — Admin Panel, Cut Zones, Stewards & INI Export
local proto = require('rs_protocol')

local M = {}

local draft = nil
local activeTab = 1 -- 1=Depart & Presets, 2=Cuts & Faux Depart, 3=Zones Circuit, 4=Stewards, 5=Export INI
local copiedFeedback = 0
local serverScriptUrl = 'https://YOUR_HOST/rolling-start/csp/rolling_start.lua'

-- Per-track cut zone list state
local currentTrackKey = nil
local trackZones = {} -- { name, sStart, sEnd, active }
local markStartSpline = nil
local newZoneName = 'Virage'
local newZoneStart = '0.100'
local newZoneEnd = '0.150'

local function ensureDraft(cfg)
  if not draft then
    draft = proto.copyCfg(cfg)
  end
  return draft
end

local function isControlAllowed()
  local sim = ac.getSim()
  if not sim or not sim.isOnlineRace then return true end
  return sim.isAdmin == true
end

local function getTrackKey()
  local ok, tid = pcall(ac.getTrackID)
  local id = (ok and tid and tid ~= '') and tostring(tid) or 'default'
  local okL, lay = pcall(ac.getTrackLayout)
  if okL and lay and lay ~= '' and not id:find(lay, 1, true) then
    id = id .. '-' .. tostring(lay)
  end
  return id
end

local function loadAllTrackZonesMap(storage)
  local raw = storage and storage.trackZonesJson or ''
  if type(raw) ~= 'string' or raw == '' then return {} end
  local ok, tbl = pcall(function() return JSON.parse(raw) end)
  if ok and type(tbl) == 'table' then return tbl end
  return {}
end

local function syncDisabledStringFromZones(d)
  local offList = {}
  for i = 1, #trackZones do
    local z = trackZones[i]
    if not z.active then
      offList[#offList + 1] = string.format('%.3f-%.3f', z.sStart, z.sEnd)
    end
  end
  d.cutDisabledZones = proto.sanitizeCutZones(table.concat(offList, ','))
end

local function saveZonesForTrack(ctx, d)
  syncDisabledStringFromZones(d)
  if not ctx.storage or not currentTrackKey then return end
  local map = loadAllTrackZonesMap(ctx.storage)
  map[currentTrackKey] = trackZones
  pcall(function()
    ctx.storage.trackZonesJson = JSON.stringify(map)
  end)
end

local function ensureZonesLoaded(d, storage)
  local tk = getTrackKey()
  if currentTrackKey == tk then return end
  currentTrackKey = tk
  trackZones = {}
  local map = loadAllTrackZonesMap(storage)
  if type(map[tk]) == 'table' and #map[tk] > 0 then
    for i = 1, #map[tk] do
      local z = map[tk][i]
      trackZones[#trackZones + 1] = {
        name = tostring(z.name or ('Zone ' .. i)),
        sStart = tonumber(z.sStart) or 0,
        sEnd = tonumber(z.sEnd) or 0,
        active = z.active == true,
      }
    end
  elseif d.cutDisabledZones and d.cutDisabledZones ~= '' then
    local parsed = proto.parseCutZones(d.cutDisabledZones)
    for i = 1, #parsed do
      trackZones[#trackZones + 1] = {
        name = 'Zone Serveur #' .. i,
        sStart = parsed[i].sStart,
        sEnd = parsed[i].sEnd,
        active = false,
      }
    end
  end
end

local function startDisabled(flag)
  if not flag then return end
  if ui.beginDisabled then
    ui.beginDisabled(true)
  elseif ui.pushDisabled then
    ui.pushDisabled(true)
  else
    ui.pushStyleVar(ui.StyleVar.Alpha, 0.45)
  end
end

local function stopDisabled(flag)
  if not flag then return end
  if ui.endDisabled then
    ui.endDisabled()
  elseif ui.popDisabled then
    ui.popDisabled()
  else
    ui.popStyleVar(1)
  end
end

local function sliderInt(label, value, minV, maxV, fmt)
  local v = ui.slider(label, value, minV, maxV, fmt, true)
  return math.floor((tonumber(v) or value) + 0.5)
end

local function formatMs(ms)
  local s = math.max(0, (tonumber(ms) or 0) / 1000)
  local m = math.floor(s / 60)
  local rem = s - m * 60
  return string.format('%d:%05.2f', m, rem)
end

local function choiceRow(label, current, options)
  ui.text(label)
  for i = 1, #options do
    if i > 1 then ui.sameLine(0, 8) end
    local opt = options[i]
    if ui.radioButton(opt[2], current == opt[1]) then
      current = opt[1]
    end
  end
  return current
end

function M.drawAdmin(ctx, dt)
  if copiedFeedback > 0 then copiedFeedback = math.max(0, copiedFeedback - dt) end
  local cfg = ctx.cfg
  local d = ensureDraft(cfg)
  ensureZonesLoaded(d, ctx.storage)
  local st = ctx.state
  local adminOk = isControlAllowed()
  local sim = ac.getSim()

  ui.textColored('GDSP Race Control & Stewards', rgbm(0.85, 0.64, 0.28, 1))
  ui.sameLine(0, 12)
  local statusTxt = ctx.bridgeActive and '[Online Script Hybride OK]' or '[Mode App Autonome]'
  ui.textColored(statusTxt, ctx.bridgeActive and rgbm(0.2, 0.85, 0.4, 1) or rgbm(0.95, 0.75, 0.15, 1))
  ui.separator()

  if not adminOk then
    ui.textColored('Mode lecture seule : connectez-vous /admin password pour piloter.', rgbm(0.95, 0.55, 0.25, 1))
  elseif sim and sim.raceSessionType ~= (ac.SessionType and ac.SessionType.Race or 3) and cfg.everySession ~= 1 and cfg.cutEverySession ~= 1 then
    ui.textColored('Session hors Course : cochez le mode Test pour activer en Essais/Qualifs.', rgbm(0.95, 0.78, 0.22, 1))
  end

  if cfg.enabled == 1 then
    local btnH = 30
    startDisabled(not adminOk)
    if ui.button('DEMARRER FORMATION', vec2(158, btnH)) and adminOk then
      ctx.sendCommand(proto.CMD_START)
    end
    ui.sameLine(0, 8)
    if ui.button('1 TO GO / PRET', vec2(130, btnH)) and adminOk then
      ctx.sendCommand(proto.CMD_READY)
    end
    ui.sameLine(0, 8)
    ui.pushStyleColor(ui.StyleColor.Button, rgbm(0.14, 0.65, 0.30, 1))
    if ui.button('GREEN FLAG NOW', vec2(160, btnH)) and adminOk then
      ctx.sendCommand(proto.CMD_GREEN)
    end
    ui.popStyleColor(1)

    if ui.button('CAUTION / REGROUPER', vec2(158, 25)) and adminOk then
      ctx.sendCommand(proto.CMD_CAUTION)
    end
    ui.sameLine(0, 8)
    if ui.button('RESET / STAND BY', vec2(130, 25)) and adminOk then
      ctx.sendCommand(proto.CMD_RESET)
    end
    ui.sameLine(0, 8)
    if ui.button('EFFACER PENALITE', vec2(160, 25)) and adminOk then
      ctx.sendCommand(proto.CMD_CLEAR_PENALTY)
    end
    stopDisabled(not adminOk)
  else
    startDisabled(not adminOk)
    if ui.button('EFFACER MA PENALITE', vec2(220, 28)) and adminOk then
      ctx.sendCommand(proto.CMD_CLEAR_PENALTY)
    end
    ui.sameLine(0, 10)
    if ui.button('EFFACER TOUTES PENALITES', vec2(230, 28)) and adminOk then
      ctx.sendAdminAction(proto.ACT_CLEAR_ALL, proto.NONE, 0)
    end
    stopDisabled(not adminOk)
  end

  ui.separator()
  local startLabel = cfg.enabled == 1 and ('LANCE (' .. (proto.PHASE_NAMES[st.phase] or '?') .. ')') or 'ARRETE'
  ui.text(string.format('Depart: %s | Cuts: %s (%d/%d) | FauxDep: %s | Clients: %d',
    startLabel,
    cfg.cutEnabled == 1 and 'ON' or 'OFF',
    st.cutsCount or 0, cfg.cutMaxBeforePenalty,
    cfg.jumpEnabled == 1 and 'ON' or 'OFF',
    st.onlineCount or 0))
  ui.separator()

  if not adminOk and not st.canViewPeloton and activeTab == 4 then
    activeTab = 1
  end

  -- Navigation Tabs
  if ui.button(activeTab == 1 and '[ Depart ]' or 'Depart', vec2(92, 24)) then activeTab = 1 end
  ui.sameLine(0, 4)
  if ui.button(activeTab == 2 and '[ Cuts & Pén. ]' or 'Cuts & Pén.', vec2(106, 24)) then activeTab = 2 end
  ui.sameLine(0, 4)
  if ui.button(activeTab == 3 and '[ Zones Cut ]' or 'Zones Cut', vec2(98, 24)) then activeTab = 3 end
  if adminOk or st.canViewPeloton then
    ui.sameLine(0, 4)
    if ui.button(activeTab == 4 and '[ Stewards ]' or 'Stewards', vec2(96, 24)) then activeTab = 4 end
  end
  ui.sameLine(0, 4)
  if ui.button(activeTab == 5 and '[ Export INI ]' or 'Export INI', vec2(100, 24)) then activeTab = 5 end
  ui.separator()

  if activeTab == 1 then
    ui.text('Mode de depart :')
    ui.sameLine(150)
    if ui.radioButton('Depart Lance (Rolling)', d.enabled == 1) then d.enabled = 1 end
    ui.sameLine(0, 12)
    if ui.radioButton('Depart Arrete (Standing)', d.enabled == 0) then d.enabled = 0 end

    local es = (d.everySession == 1)
    if ui.checkbox('Activer aussi en Essais / Qualifs (mode test)', es) then
      d.everySession = es and 0 or 1
    end

    ui.separator()
    ui.text('Preconfigurations rapides :')
    for _, preset in ipairs(proto.PRESETS) do
      if ui.button(preset.label, vec2(490, 22)) then
        for k, v in pairs(preset.values) do d[k] = v end
        proto.sanitizeCfg(d)
      end
    end

    if d.enabled == 1 then
      ui.separator()
      d.formationMode = choiceRow('Format de grille :', d.formationMode, { { '2x2', '2x2 Double File' }, { '1x1', '1x1 File Indienne' } })
      if d.formationMode == '2x2' then
        d.poleSide = choiceRow('Colonne Pole (P1) :', d.poleSide, { { 'left', 'Gauche' }, { 'right', 'Droite' } })
      end
      d.startLength = choiceRow('Longueur formation :', d.startLength, { { 'full', 'Tour Complet' }, { 'short', 'Depart Court' } })
      if d.startLength == 'full' then
        d.formationLaps = sliderInt('Passages de ligne du leader avant le vert', d.formationLaps, 1, 5, '%.0f passage(s)')
      else
        d.shortMode = choiceRow('Mode depart court :', d.shortMode, { { 'distance', 'Distance (m)' }, { 'spline', 'Spline' }, { 'timer', 'Timer (s)' } })
        if d.shortMode == 'distance' then
          d.shortDistanceM = sliderInt('Distance avant Green (m)', d.shortDistanceM, 80, 2500, '%.0f m')
        elseif d.shortMode == 'spline' then
          d.shortGreenSpline = ui.slider('Spline Green (0..1)', d.shortGreenSpline, 0.02, 0.95, '%.2f')
        else
          d.shortSec = sliderInt('Duree formation (s)', d.shortSec, 5, 180, '%.0f s')
        end
      end

      d.limiterMode = choiceRow('Limiteur auto :', d.limiterMode, { { 'limiter', 'Doux' }, { 'hard', 'Strict' }, { 'off', 'Off (pilotes regulent)' } })
      d.paceKmh = sliderInt('Vitesse Pace (km/h)', d.paceKmh, 45, 160, '%.0f km/h')
      d.catchupKmh = sliderInt('Bonus rattrapage (km/h)', d.catchupKmh, 0, 80, '+%.0f km/h')
      d.fastKmh = sliderInt('Phase 1 - vitesse max (km/h)', d.fastKmh, 40, 200, '%.0f km/h')
      d.fastPct = sliderInt('Phase 1 - longueur (% du tour)', d.fastPct, 25, 100, '%.0f %%')
      d.slowKmh = sliderInt('Phase 2 - regroupement (km/h)', d.slowKmh, 30, 150, '%.0f km/h')
      d.bunchM = sliderInt('Seuil de regroupement (m)', d.bunchM, 20, 300, '%.0f m')
      d.targetGapM = sliderInt('Espacement cible (m)', d.targetGapM, 8, 45, '%.0f m')

      d.greenTrigger = choiceRow('Declencheur Green :', d.greenTrigger, { { 'both', 'Auto + Manuel' }, { 'auto', 'Auto seul' }, { 'manual', 'Manuel seul' } })
      if d.greenTrigger ~= 'manual' then
        d.autoGreenAt = choiceRow('Auto-Green declenche :', d.autoGreenAt, { { 'line', 'Ligne S/F' }, { 'zone', 'Zone Accel.' } })
      end
      local p1g = (d.allowP1Green == 1)
      if ui.checkbox('Autoriser P1 a lancer le Green dans la zone', p1g) then d.allowP1Green = p1g and 0 or 1 end
    end

  elseif activeTab == 2 then
    -- Track Cuts section
    local ce = (d.cutEnabled == 1)
    if ui.checkbox('Activer le systeme de penalite CUTS (Track Limits)', ce) then d.cutEnabled = ce and 0 or 1 end
    local ces = (d.cutEverySession == 1)
    if ui.checkbox('Compter les cuts aussi en Essais / Qualifs', ces) then d.cutEverySession = ces and 0 or 1 end

    if d.cutEnabled == 1 then
      d.cutWheelsMin = sliderInt('Roues hors-piste pour cut', d.cutWheelsMin, 2, 4, '%.0f roues')
      local ku = (d.cutUseKunosInvalid == 1)
      if ui.checkbox('Utiliser invalidation Kunos (au lieu de roues hors piste)', ku) then d.cutUseKunosInvalid = ku and 0 or 1 end
      d.cutMinDurationSec = ui.slider('Duree mini hors piste (s)', d.cutMinDurationSec, 0.10, 1.50, '%.2f s')
      d.cutMinSpeedKmh = sliderInt('Vitesse mini (km/h)', d.cutMinSpeedKmh, 15, 100, '%.0f km/h')

      d.cutMaxBeforePenalty = sliderInt(
        string.format('Cuts toleres avant penalite (penalite au %de cut)', d.cutMaxBeforePenalty + 1),
        d.cutMaxBeforePenalty, 0, 15, '%.0f cuts')
      d.cutRepeatEvery = sliderInt('Ensuite penalite tous les N cuts (0 = meme quota)', d.cutRepeatEvery, 0, 10, '%.0f')

      d.cutPenaltyType = choiceRow('1re Penalite Cut :', d.cutPenaltyType, {
        { 'drive_through', 'Drive-Through' },
        { 'stop_and_go', 'Stop & Go' },
        { 'time_penalty', 'Temps (+s)' },
        { 'slow_cut', 'Coupure Gaz' },
      })
      if d.cutPenaltyType == 'stop_and_go' or d.cutPenaltyType == 'teleport_pits' then
        d.cutStopGoSec = sliderInt('Duree arret Stop & Go (s)', d.cutStopGoSec, 3, 60, '%.0f s')
      elseif d.cutPenaltyType == 'slow_cut' then
        d.cutSlowSec = sliderInt('Duree coupure gaz (s)', d.cutSlowSec, 1, 15, '%.0f s')
      elseif d.cutPenaltyType == 'time_penalty' then
        d.cutTimePenaltySec = sliderInt('Temps ajoute direct (s)', d.cutTimePenaltySec, 2, 120, '+%.0f s')
      end

      if d.cutPenaltyType == 'drive_through' or d.cutPenaltyType == 'stop_and_go' then
        d.cutServeLaps = sliderInt('A effectuer dans les X tours', d.cutServeLaps, 1, 10, '%.0f tour(s)')
        d.cutEscPenalty = choiceRow('Si non effectuee -> 2e Penalite :', d.cutEscPenalty, {
          { 'stop_and_go', 'Stop & Go' },
          { 'black_flag', 'Drapeau Noir' },
          { 'teleport_pits', 'Stands Bloques' },
          { 'time_penalty', 'Temps (+s)' },
          { 'none', 'Aucune' },
        })
        if d.cutEscPenalty == 'stop_and_go' or d.cutEscPenalty == 'teleport_pits' then
          d.cutEscStopGoSec = sliderInt('Duree 2e penalite stands (s)', d.cutEscStopGoSec, 3, 60, '%.0f s')
        end
        d.cutFinishTimeSec = sliderInt('Temps ajoute si dernier tour / non effectuee a l\'arrivee', d.cutFinishTimeSec, 5, 180, '+%.0f s')
      end
    end

    ui.separator()
    -- Jump Start section
    local je = (d.jumpEnabled == 1)
    if ui.checkbox('Activer penalite DEPART ANTICIPE (Arrete & Lance)', je) then d.jumpEnabled = je and 0 or 1 end
    if d.jumpEnabled == 1 then
      d.jumpStandingTolM = ui.slider('Tolerance mouvement feux allumes (m)', d.jumpStandingTolM, 0.2, 3.0, '%.1f m')
      local jr = (d.jumpRollingCatch == 1)
      if ui.checkbox('Sanctionner anticipation avant Green en depart lance', jr) then d.jumpRollingCatch = jr and 0 or 1 end
      d.jumpPenaltyType = choiceRow('Penalite Depart Anticipe :', d.jumpPenaltyType, {
        { 'drive_through', 'Drive-Through' },
        { 'stop_and_go', 'Stop & Go' },
        { 'time_penalty', 'Temps (+s)' },
        { 'slow_cut', 'Coupure Gaz' },
      })
      if d.jumpPenaltyType == 'stop_and_go' then
        d.jumpStopGoSec = sliderInt('Arret Stop & Go Faux Depart (s)', d.jumpStopGoSec, 3, 60, '%.0f s')
      end
      d.jumpServeLaps = sliderInt('Delai faux depart (tours)', d.jumpServeLaps, 1, 10, '%.0f tour(s)')
      d.jumpEscPenalty = choiceRow('2e Penalite Faux Depart :', d.jumpEscPenalty, {
        { 'stop_and_go', 'Stop & Go' },
        { 'black_flag', 'Drapeau Noir' },
        { 'time_penalty', 'Temps (+s)' },
        { 'none', 'Aucune' },
      })
      d.jumpTimePenaltySec = sliderInt('Temps faux depart (direct / dernier tour)', d.jumpTimePenaltySec, 5, 180, '+%.0f s')
    end

    ui.separator()
    ui.textColored('Acces Peloton Cuts (Safety Car & Secours)', rgbm(0.85, 0.64, 0.28, 1))
    d.scFallback = choiceRow('Si aucune Safety Car en piste :', d.scFallback or 'admin', {
      { 'admin', 'Admin / Race Control' },
      { 'p1', 'Relais P1 + Admin' },
      { 'off', 'SC / Commissaire seul' },
    })
    d.safetyCarKey = tostring(ui.inputText('Mot-cle Safety Car (car/nom)', d.safetyCarKey or 'safety') or 'safety'):sub(1, 23)

  elseif activeTab == 3 then
    local me = ac.getCar(0)
    local curS = me and me.splinePosition or 0
    local len = (sim and sim.trackLengthM and sim.trackLengthM > 50) and sim.trackLengthM or 4000
    ui.textColored('Circuit : ' .. tostring(currentTrackKey or '?'), rgbm(0.85, 0.64, 0.28, 1))
    ui.text(string.format('Position piste actuelle : spline %.3f  |  Zones desactivees: %s',
      curS, (d.cutDisabledZones ~= '' and d.cutDisabledZones or 'Aucune')))

    if ui.button('Ignorer cut ici (+/- 30m)', vec2(230, 26)) then
      local ds = 30 / len
      trackZones[#trackZones + 1] = {
        name = string.format('Virage @ %.3f', curS),
        sStart = proto.frac(curS - ds),
        sEnd = proto.frac(curS + ds),
        active = false,
      }
      saveZonesForTrack(ctx, d)
    end
    ui.sameLine(0, 8)
    if not markStartSpline then
      if ui.button('Marquer DEBUT zone', vec2(160, 26)) then
        markStartSpline = curS
      end
    else
      if ui.button(string.format('Marquer FIN (depuis %.3f)', markStartSpline), vec2(220, 26)) then
        trackZones[#trackZones + 1] = {
          name = string.format('Zone %.3f-%.3f', markStartSpline, curS),
          sStart = markStartSpline,
          sEnd = curS,
          active = false,
        }
        markStartSpline = nil
        saveZonesForTrack(ctx, d)
      end
    end

    ui.separator()
    newZoneName = ui.inputText('Nom du virage', newZoneName)
    newZoneStart = ui.inputText('Spline debut (0..1)', newZoneStart)
    newZoneEnd = ui.inputText('Spline fin (0..1)', newZoneEnd)
    if ui.button('+ Ajouter cette zone (cut desactive)', vec2(260, 24)) then
      trackZones[#trackZones + 1] = {
        name = (newZoneName ~= '' and newZoneName or 'Virage'),
        sStart = proto.clamp(tonumber(newZoneStart) or 0, 0, 0.999),
        sEnd = proto.clamp(tonumber(newZoneEnd) or 0.05, 0, 0.999),
        active = false,
      }
      saveZonesForTrack(ctx, d)
    end

    ui.separator()
    ui.text('Cochez = Cut ACTIF dans ce virage  |  Decochez = Cut DESACTIVE :')
    local removeIdx = nil
    for i = 1, #trackZones do
      local z = trackZones[i]
      local chkLabel = string.format('%s (%.3f -> %.3f)##z%d', z.name, z.sStart, z.sEnd, i)
      if ui.checkbox(chkLabel, z.active) then
        z.active = not z.active
        saveZonesForTrack(ctx, d)
      end
      ui.sameLine(420)
      if ui.button('Suppr##d' .. i, vec2(65, 20)) then
        removeIdx = i
      end
    end
    if removeIdx then
      table.remove(trackZones, removeIdx)
      saveZonesForTrack(ctx, d)
    end

  elseif activeTab == 4 then
    if not adminOk and not st.canViewPeloton then
      ui.textColored('Acces reserve a la Safety Car (ou Race Control sans Safety Car).', rgbm(0.95, 0.45, 0.25, 1))
    else
      if st.canViewPeloton then
        ui.textColored('Acces Peloton Cuts ACTIF — Role : ' .. tostring(st.pelotonRole ~= '' and st.pelotonRole or 'SAFETY CAR'), rgbm(0.2, 0.85, 0.4, 1))
      else
        ui.textColored('Peloton Cuts masque sur ce client (reserve Safety Car / Commissaire designe).', rgbm(0.95, 0.72, 0.25, 1))
      end

      startDisabled(not adminOk)
      if ui.button('Effacer TOUTES penalites', vec2(170, 24)) and adminOk then
        ctx.sendAdminAction(proto.ACT_CLEAR_ALL, proto.NONE, 0)
      end
      ui.sameLine(0, 8)
      if ui.button('RAZ compteurs Cuts', vec2(145, 24)) and adminOk then
        ctx.sendAdminAction(proto.ACT_RESET_CUTS, proto.NONE, 0)
      end
      ui.sameLine(0, 8)
      if ui.button('Retirer commissaire', vec2(145, 24)) and adminOk then
        ctx.sendAdminAction(proto.ACT_SET_STEWARD, proto.NONE, 0)
      end
      stopDisabled(not adminOk)

      if st.canViewPeloton then
        if ui.button('Copier bilan peloton', vec2(150, 24)) then
          local lines = { 'Pilote | Cuts | Penalite | Temps Ajoute | Temps Corrige' }
          local count = sim and sim.carsCount or 0
          for i = 0, count - 1 do
            local c = ac.getCar(i)
            if c and c.isConnected then
              local rec = st.stewardMap and st.stewardMap[c.sessionID]
              if rec then
                lines[#lines + 1] = string.format('%s | %d | %s | +%ds | %s',
                  ac.getDriverName(c.index), rec.cuts, proto.PEN_LABELS[rec.penKind] or '-', rec.timeAddedSec,
                  formatMs((rec.raceTimeMs or 0) + (rec.timeAddedSec or 0) * 1000))
              end
            end
          end
          pcall(ui.setClipboardText, table.concat(lines, '\n'))
          copiedFeedback = 2.0
        end
        if copiedFeedback > 0 then
          ui.sameLine(0, 6)
          ui.textColored('Copie!', rgbm(0.2, 0.85, 0.4, 1))
        end
      end
      ui.separator()

      local count = sim and sim.carsCount or 0
      for i = 0, count - 1 do
        local c = ac.getCar(i)
        if c and c.isConnected then
          local sid = c.sessionID
          if st.canViewPeloton then
            local rec = (st.stewardMap and st.stewardMap[sid]) or { cuts = 0, penKind = 0, lapsLeft = 0, timeAddedSec = 0, raceTimeMs = 0, dq = false }
            local penName = rec.dq and 'DQ' or (rec.penKind > 0 and (proto.PEN_LABELS[rec.penKind] .. ' (' .. rec.lapsLeft .. 't)') or 'OK')
            local addTxt = rec.timeAddedSec > 0 and string.format('+%ds', rec.timeAddedSec) or '0s'
            ui.text(string.format('P%d %s | Cuts:%d | %s | %s | %s',
              c.racePosition or (i + 1), ac.getDriverName(c.index), rec.cuts, penName, addTxt,
              formatMs((rec.raceTimeMs or 0) + (rec.timeAddedSec or 0) * 1000)))
          else
            ui.text(string.format('P%d %s', c.racePosition or (i + 1), ac.getDriverName(c.index)))
          end
          if adminOk then
            ui.sameLine(300)
            if ui.button('Clr##c' .. sid, vec2(34, 19)) then ctx.sendAdminAction(proto.ACT_CLEAR_ONE, sid, 0) end
            ui.sameLine(0, 3)
            if ui.button('DT##d' .. sid, vec2(30, 19)) then ctx.sendAdminAction(proto.ACT_GIVE_DT, sid, d.cutServeLaps) end
            ui.sameLine(0, 3)
            if ui.button('S&G##s' .. sid, vec2(36, 19)) then ctx.sendAdminAction(proto.ACT_GIVE_SG, sid, d.cutStopGoSec) end
            ui.sameLine(0, 3)
            if ui.button('+10s##t' .. sid, vec2(40, 19)) then ctx.sendAdminAction(proto.ACT_ADD_TIME, sid, 10) end
            ui.sameLine(0, 3)
            if ui.button('Stew##st' .. sid, vec2(42, 19)) then ctx.sendAdminAction(proto.ACT_SET_STEWARD, sid, 1) end
          end
        end
      end
    end

  else
    ui.textWrapped('Copiez ce bloc dans CSP Extra Options (AssettoHosting / Content Manager Server) :')
    serverScriptUrl = ui.inputText('URL du script CSP', serverScriptUrl)
    local snippet = proto.formatIniSnippet(d, serverScriptUrl)
    local roFlags = 0
    if ui.InputTextFlags and bit and bit.bor then
      roFlags = bit.bor(ui.InputTextFlags.ReadOnly or 0, ui.InputTextFlags.Multiline or 0)
    end
    ui.inputText('##ini_export', snippet, roFlags, vec2(500, 240))
    if ui.button('Copier le bloc [SCRIPT_1]', vec2(220, 28)) then
      pcall(ui.setClipboardText, snippet)
      copiedFeedback = 2.5
    end
    if copiedFeedback > 0 then
      ui.sameLine(0, 10)
      ui.textColored('Copie dans le presse-papier !', rgbm(0.2, 0.85, 0.4, 1))
    end
  end

  if activeTab ~= 5 and activeTab ~= 4 then
    ui.separator()
    startDisabled(not adminOk)
    ui.pushStyleColor(ui.StyleColor.Button, rgbm(0.85, 0.64, 0.28, 1))
    ui.pushStyleColor(ui.StyleColor.Text, rgbm(0.05, 0.08, 0.10, 1))
    if ui.button('APPLIQUER & DIFFUSER LA CONFIG', vec2(320, 30)) and adminOk then
      saveZonesForTrack(ctx, d)
      proto.sanitizeCfg(d)
      ctx.applyConfig(d)
    end
    ui.popStyleColor(2)
    stopDisabled(not adminOk)
    ui.sameLine(0, 8)
    if ui.button('Recharger active', vec2(150, 30)) then
      draft = proto.copyCfg(cfg)
    end
  end
end

function M.drawSettings(ctx)
  ui.text('GDSP Race Control v' .. proto.VERSION)
  ui.separator()
  local hideB = (ctx.localPrefs.hideOnlineBanner ~= false)
  if ui.checkbox('Masquer le bandeau basique du script serveur quand ce HUD est ouvert', hideB) then
    ctx.localPrefs.hideOnlineBanner = not hideB
  end

  local showCuts = (ctx.localPrefs.showCutsInSim ~= false)
  if ui.checkbox('Afficher le compteur cuts en jeu (dans le jeu, pas dans le menu CM)', showCuts) then
    ctx.localPrefs.showCutsInSim = not showCuts
  end

  ui.separator()
  ui.textColored('Position & Taille des fenetres HUD', rgbm(0.85, 0.64, 0.28, 1))
  ui.textWrapped('Toutes les fenetres (Rolling Start HUD, Race Control) sont deplacables librement et redimensionnables par le coin bas-droit.')

  local hs = tonumber(ctx.localPrefs.hudScale) or 1.0
  local newHs = ui.slider('Echelle contenu HUD', hs, 0.65, 2.00, '%.2fx')
  ctx.localPrefs.hudScale = newHs
  if ui.button('Compact (300x200)', vec2(130, 22)) and ctx.applyAppWindowSize then
    ctx.applyAppWindowSize('Rolling Start HUD', 300, 200)
  end
  ui.sameLine(0, 6)
  if ui.button('Standard (460x310)', vec2(136, 22)) and ctx.applyAppWindowSize then
    ctx.applyAppWindowSize('Rolling Start HUD', 460, 310)
  end
  ui.sameLine(0, 6)
  if ui.button('Grand (640x430)', vec2(126, 22)) and ctx.applyAppWindowSize then
    ctx.applyAppWindowSize('Rolling Start HUD', 640, 430)
  end

  local cs = tonumber(ctx.localPrefs.cutsScale) or 1.0
  local newCs = ui.slider('Echelle Compteur Cuts', cs, 0.65, 2.20, '%.2fx')
  ctx.localPrefs.cutsScale = newCs
  if ui.button('Reinitialiser tailles & positions', vec2(230, 24)) then
    ctx.localPrefs.hudScale = 1.0
    ctx.localPrefs.cutsScale = 1.0
    if ctx.applyAppWindowSize then
      ctx.applyAppWindowSize('Rolling Start HUD', 460, 310, 40, 40)
    end
  end

  ui.separator()
  ui.text('Raccourcis clavier / volant (Race Control) :')
  if ctx.btnStart then
    ui.text('Demarrer Formation :'); ui.sameLine(180); ctx.btnStart:control(vec2(200, 0))
  end
  if ctx.btnGreen then
    ui.text('Green Flag :'); ui.sameLine(180); ctx.btnGreen:control(vec2(200, 0))
  end
  ui.separator()
  ui.textWrapped('Commandes chat (Admin): !rs on / !rs off, !yellow, !green, !rs 2x2 / 1x1, !rs cut on/off, !rs cutlimit 3, !rs steward <nom|off>, !rs clearall, !rs resetcuts | HUD perso: !rshud reset / lock / scale 1.2')
end

return M

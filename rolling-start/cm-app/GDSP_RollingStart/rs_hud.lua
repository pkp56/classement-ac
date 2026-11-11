-- GDSP Rolling Start & Race Control — Interactive Driver HUD & 3D Track Guidance
local proto = require('rs_protocol')

local M = {}
local showPelotonCuts = false
local hudClock = 0

local COL_BG = rgbm(0.06, 0.16, 0.20, 0.90)
local COL_PANEL = rgbm(0.04, 0.11, 0.14, 0.92)
local COL_BORDER = rgbm(0.85, 0.64, 0.28, 0.65)
local COL_GOLD = rgbm(0.85, 0.64, 0.28, 1)
local COL_CREAM = rgbm(0.96, 0.93, 0.85, 1)
local COL_MUTED = rgbm(0.68, 0.76, 0.78, 0.85)
local COL_GREEN = rgbm(0.14, 0.80, 0.38, 0.96)
local COL_AMBER = rgbm(0.96, 0.74, 0.14, 0.96)
local COL_RED = rgbm(0.90, 0.18, 0.18, 0.96)
local COL_BLUE = rgbm(0.22, 0.68, 0.96, 0.90)
local COL_DARK = rgbm(0.04, 0.08, 0.10, 1)
local COL_ORANGE = rgbm(0.98, 0.48, 0.10, 0.98)

local function drawFlagIcon(pos, st, cfg, sc)
  sc = sc or 1
  local flagCol = nil
  local isMeatball = false
  if st.disqualified then
    flagCol = rgbm(0.06, 0.06, 0.06, 1)
  elseif st.activePenKind ~= proto.PEN_NONE and st.activePenKind ~= proto.PEN_TIME_ONLY then
    flagCol = rgbm(0.08, 0.08, 0.08, 1)
    isMeatball = true
  elseif cfg.enabled == 1 then
    if st.phase == proto.PHASE_GREEN then
      flagCol = COL_GREEN
    elseif st.inAccelZone and (math.floor(hudClock * 4) % 2 == 0) then
      flagCol = COL_GREEN
    elseif st.phase == proto.PHASE_FORMATION or st.phase == proto.PHASE_READY or st.phase == proto.PHASE_CAUTION then
      flagCol = COL_AMBER
    end
  end
  if not flagCol then return end

  local fw, fh = 26 * sc, 15 * sc
  ui.drawLine(pos + vec2(0, 2 * sc), pos + vec2(0, 22 * sc), COL_CREAM, math.max(1.5, 2 * sc))
  ui.drawRectFilled(pos + vec2(2 * sc, 2 * sc), pos + vec2(2 * sc + fw, 2 * sc + fh), flagCol, 2 * sc)
  ui.drawRect(pos + vec2(2 * sc, 2 * sc), pos + vec2(2 * sc + fw, 2 * sc + fh), COL_DARK, 2 * sc, 1)
  if isMeatball then
    ui.drawCircleFilled(pos + vec2(2 * sc + fw * 0.5, 2 * sc + fh * 0.5), 4.5 * sc, COL_ORANGE)
  end
end

local function drawResizeGrip(wpos, wsize)
  local br = wpos + wsize
  local gripCol = rgbm(0.85, 0.64, 0.28, 0.52)
  ui.drawLine(br - vec2(12, 3), br - vec2(3, 12), gripCol, 1.5)
  ui.drawLine(br - vec2(8, 3), br - vec2(3, 8), gripCol, 1.5)
end

local function phaseColor(st, cfg)
  if st.disqualified then return COL_RED end
  if st.activePenKind ~= proto.PEN_NONE then return COL_RED end
  if cfg.enabled ~= 1 then
    return st.jumpWarn and COL_RED or rgbm(0.24, 0.56, 0.66, 0.95)
  end
  if st.phase == proto.PHASE_GREEN then return COL_GREEN end
  if st.inAccelZone then return COL_GREEN end
  if st.phase == proto.PHASE_READY then return COL_AMBER end
  if st.phase == proto.PHASE_CAUTION then return COL_RED end
  if st.phase == proto.PHASE_FORMATION then return COL_GOLD end
  return rgbm(0.35, 0.48, 0.52, 0.9)
end

local function phaseLabel(st, cfg)
  if st.disqualified then return 'DRAPEAU NOIR — DISQUALIFIE' end
  if cfg.enabled ~= 1 then
    if st.jumpWarn then return 'DEPART ANTICIPE — PENALITE' end
    return 'DEPART ARRETE — STEWARDS ACTIFS'
  end
  if st.phase == proto.PHASE_GREEN then return 'GREEN FLAG — GO!' end
  if st.inAccelZone then return 'ZONE D\'ACCELERATION — PRET' end
  if st.phase == proto.PHASE_READY then return '1 TO GO — EN FORMATION ' .. cfg.formationMode:upper() end
  if st.phase == proto.PHASE_CAUTION then return 'CAUTION / MAINTIEN FORMATION' end
  if st.phase == proto.PHASE_FORMATION then
    local modeTxt = cfg.startLength == 'short' and 'DEPART COURT' or 'TOUR DE FORMATION'
    return string.format('%s (%s)', modeTxt, cfg.formationMode:upper())
  end
  return 'ARME — EN ATTENTE DU DEPART LANCE'
end

local function drawCenteredText(pos, width, txt, sz, col)
  local w = ui.measureDWriteText(txt, sz).x
  ui.dwriteDrawText(txt, sz, vec2(pos.x + (width - w) * 0.5, pos.y), col)
end

local greenSince = nil

function M.drawHud(ctx, dt)
  hudClock = hudClock + (dt or 0)
  local st = ctx.state
  local cfg = ctx.cfg
  local me = ac.getCar(0)
  -- Après le départ lancé, le bandeau s'efface (8 s après le vert), sauf si une pénalité est en cours
  if st.phase == proto.PHASE_GREEN then
    greenSince = greenSince or hudClock
  else
    greenSince = nil
  end
  if greenSince and (hudClock - greenSince) > 8 and st.activePenKind == proto.PEN_NONE then
    return
  end
  local wpos = vec2(0, 0) -- origine locale : les dessins d'une fenetre CM sont relatifs a la fenetre (sinon le contenu est decale et rogne quand la fenetre bouge)
  local wsize = ui.windowSize()
  local userScale = (ctx.localPrefs and tonumber(ctx.localPrefs.hudScale)) or 1.0
  local winScale = math.min(wsize.x / 460, wsize.y / 310)
  local sc = proto.clamp(winScale * userScale, 0.55, 2.35)
  local function fz(base) return math.max(9, math.floor(base * sc + 0.5)) end
  local pad = math.max(6, math.floor(10 * sc + 0.5))

  ui.drawRectFilled(wpos, wpos + wsize, COL_BG, 8 * sc)
  ui.drawRect(wpos, wpos + wsize, COL_BORDER, 8 * sc, 1.5)

  local hdrH = math.max(24, math.floor(34 * sc + 0.5))
  local pCol = phaseColor(st, cfg)
  ui.drawRectFilled(wpos + vec2(2, 2), wpos + vec2(wsize.x - 2, hdrH), pCol, 6 * sc)
  local segW = (wsize.x - pad * 2) * 0.25
  local stripeCols = { rgbm(0.61, 0.19, 0.13, 1), COL_GOLD, COL_CREAM, rgbm(0.05, 0.44, 0.43, 1) }
  for sIdx = 1, 4 do
    local sx = wpos.x + pad + (sIdx - 1) * segW
    ui.drawRectFilled(vec2(sx, wpos.y + 2), vec2(sx + segW, wpos.y + math.max(4, 5 * sc)), stripeCols[sIdx])
  end
  drawFlagIcon(wpos + vec2(pad, 7 * sc), st, cfg, sc)
  drawCenteredText(wpos + vec2(0, math.floor(8 * sc)), wsize.x, phaseLabel(st, cfg), fz(16), COL_DARK)

  local y = wpos.y + hdrH + math.floor(8 * sc)
  local leftX = wpos.x + pad
  local innerW = wsize.x - pad * 2

  local syncTag = ctx.bridgeActive and 'HYBRIDE (SERVEUR + LIMITEUR)' or 'AUTONOME (HUD / LOCAL)'
  local syncCol = ctx.bridgeActive and COL_GREEN or COL_AMBER
  ui.dwriteDrawText(syncTag, fz(11), vec2(leftX, y), syncCol)
  local modeBadge = cfg.enabled == 1
    and string.format('%s • %s • Cuts:%s', cfg.formationMode:upper(), cfg.startLength == 'short' and 'COURT' or (cfg.formationLaps .. 'T'), cfg.cutEnabled == 1 and 'ON' or 'OFF')
    or string.format('ARRETE • FauxDep:%s • Cuts:%s', cfg.jumpEnabled == 1 and 'ON' or 'OFF', cfg.cutEnabled == 1 and 'ON' or 'OFF')
  local mbW = ui.measureDWriteText(modeBadge, fz(11)).x
  if mbW + ui.measureDWriteText(syncTag, fz(11)).x + 12 <= innerW then
    ui.dwriteDrawText(modeBadge, fz(11), vec2(wpos.x + wsize.x - pad - mbW, y), COL_MUTED)
  end
  y = y + math.floor(18 * sc)

  if not st.canViewPeloton then
    showPelotonCuts = false
  end

  local footerH = math.floor(32 * sc)
  if showPelotonCuts and st.canViewPeloton then
    local sim = ac.getSim()
    local count = sim and sim.carsCount or 0
    local rows = {}
    for i = 0, count - 1 do
      local c = ac.getCar(i)
      if c and c.isConnected then
        local sid = c.sessionID
        local rec = (st.stewardMap and st.stewardMap[sid]) or {
          cuts = (sid == (me and me.sessionID)) and (st.cutsCount or 0) or 0,
          penKind = (sid == (me and me.sessionID)) and (st.activePenKind or 0) or 0,
          lapsLeft = (sid == (me and me.sessionID)) and (st.activePenLapsLeft or 0) or 0,
          timeAddedSec = (sid == (me and me.sessionID)) and (st.totalTimePenaltySec or 0) or 0,
          dq = (sid == (me and me.sessionID)) and (st.disqualified == true) or false,
        }
        rows[#rows + 1] = {
          pos = c.racePosition or (i + 1),
          name = ac.getDriverName(c.index),
          rec = rec,
          isMe = me and c.sessionID == me.sessionID,
        }
      end
    end
    table.sort(rows, function(a, b) return a.pos < b.pos end)

    local listH = math.max(math.floor(64 * sc), wsize.y - (y - wpos.y) - footerH - pad)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + listH), COL_PANEL, 6 * sc)
    local roleTag = (st.pelotonRole and st.pelotonRole ~= '') and (' (' .. st.pelotonRole .. ')') or ''
    ui.dwriteDrawText('PILOTE' .. roleTag, fz(11), vec2(leftX + 8 * sc, y + 5 * sc), COL_GOLD)
    ui.dwriteDrawText('CUTS', fz(11), vec2(leftX + innerW * 0.50, y + 5 * sc), COL_GOLD)
    ui.dwriteDrawText('PENALITE / TEMPS', fz(11), vec2(leftX + innerW * 0.66, y + 5 * sc), COL_GOLD)

    local rowH = math.max(14, math.floor(18 * sc))
    local maxRows = math.max(1, math.floor((listH - math.floor(24 * sc)) / rowH))
    for rIdx = 1, math.min(#rows, maxRows) do
      local row = rows[rIdx]
      local ry = y + math.floor(22 * sc) + (rIdx - 1) * rowH
      local rec = row.rec
      local pLabel = rec.dq and 'DQ'
        or (rec.penKind == proto.PEN_STOP_AND_GO and string.format('S&G(%dt)', rec.lapsLeft))
        or (rec.penKind == proto.PEN_DRIVE_THROUGH and string.format('DT(%dt)', rec.lapsLeft))
        or 'OK'
      local addTxt = rec.timeAddedSec > 0 and string.format(' +%ds', rec.timeAddedSec) or ''
      local nameCol = row.isMe and COL_GOLD or COL_CREAM
      local penCol = (rec.dq or rec.penKind > 0 or rec.timeAddedSec > 0) and COL_RED or COL_GREEN
      ui.dwriteDrawText(string.format('P%d %s', row.pos, tostring(row.name):sub(1, 18)), fz(12), vec2(leftX + 8 * sc, ry), nameCol)
      ui.dwriteDrawText(string.format('%d/%d', rec.cuts, st.cutsQuota or cfg.cutMaxBeforePenalty), fz(12), vec2(leftX + innerW * 0.50, ry), rec.cuts > 0 and COL_AMBER or COL_MUTED)
      ui.dwriteDrawText(pLabel .. addTxt, fz(12), vec2(leftX + innerW * 0.66, ry), penCol)
    end
  else

  -- Active Pit / Steward Penalty Card (highest priority visibility)
  if st.activePenKind ~= proto.PEN_NONE and st.activePenKind ~= proto.PEN_TIME_ONLY then
    local penH = math.floor(66 * sc)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + penH), rgbm(0.38, 0.06, 0.06, 0.94), 6 * sc)
    ui.drawRect(vec2(leftX, y), vec2(leftX + innerW, y + penH), COL_RED, 6 * sc, 1.5)
    local pName = proto.PEN_LABELS[st.activePenKind] or 'PENALITE'
    local escTag = st.activePenEscalated and ' (2e PENALITE)' or ''
    drawCenteredText(vec2(leftX, y + 6 * sc), innerW, pName .. escTag, fz(18), COL_CREAM)

    if st.activePenKind == proto.PEN_STOP_AND_GO then
      local holdTxt = (me and (me.isInPitlane or me.isInPit))
        and (me.speedKmh <= 2.5
          and string.format('ARRET EN COURS : %.1fs RESTANT — RESTEZ IMMOBILE', st.activePenHoldLeft)
          or string.format('DANS LES STANDS — ARRETEZ-VOUS (%ds)', cfg.cutStopGoSec))
        or string.format('ARRET OBLIGATOIRE %.0fs AUX STANDS • %d TOUR(S) RESTANT(S)', st.activePenHoldLeft, st.activePenLapsLeft)
      drawCenteredText(vec2(leftX, y + 32 * sc), innerW, holdTxt, fz(12), COL_AMBER)
    else
      local dtTxt = string.format('PASSEZ PAR LES STANDS • %d TOUR(S) RESTANT(S)', st.activePenLapsLeft)
      drawCenteredText(vec2(leftX, y + 32 * sc), innerW, dtTxt, fz(13), COL_AMBER)
    end
    y = y + penH + math.floor(8 * sc)
  end

  if cfg.enabled ~= 1 then
    -- Standing Start view
    if st.activePenKind == proto.PEN_NONE then
      local cardH = math.floor(92 * sc)
      ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + cardH), COL_PANEL, 6 * sc)
      local sim = ac.getSim()
      local tts = sim and sim.timeToSessionStart or 0
      if tts and tts > 0 then
        drawCenteredText(vec2(leftX, y + 14 * sc), innerW, string.format('DEPART ARRETE DANS %.1fs', tts / 1000), fz(20), COL_GOLD)
        drawCenteredText(vec2(leftX, y + 46 * sc), innerW, 'Restez immobile jusqu\'a l\'extinction des feux !', fz(13), COL_CREAM)
      else
        drawCenteredText(vec2(leftX, y + 14 * sc), innerW, 'Surveillance Stewards Active', fz(17), COL_CREAM)
        drawCenteredText(vec2(leftX, y + 42 * sc), innerW, string.format('Cuts toleres: %d  |  1re pena: %s (%dt)  |  2e: %s',
          cfg.cutMaxBeforePenalty, cfg.cutPenaltyType, cfg.cutServeLaps, cfg.cutEscPenalty), fz(12), COL_MUTED)
        drawCenteredText(vec2(leftX, y + 64 * sc), innerW, string.format('Penalite dernier tour / non effectuee: +%ds', cfg.cutFinishTimeSec), fz(11), COL_GOLD)
      end
      y = y + cardH + math.floor(8 * sc)
    end
  elseif st.phase == proto.PHASE_IDLE then
    local cardH = math.floor(86 * sc)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + cardH), COL_PANEL, 6 * sc)
    drawCenteredText(vec2(leftX, y + 14 * sc), innerW, 'Pret pour le depart lance (' .. cfg.formationMode:upper() .. ')', fz(16), COL_CREAM)
    local sub = string.format('Vitesse pace: %d km/h   |   Declencheur Green: %s', cfg.paceKmh, cfg.greenTrigger:upper())
    drawCenteredText(vec2(leftX, y + 40 * sc), innerW, sub, fz(12), COL_MUTED)
    local sub2 = (cfg.everySession == 1)
      and 'Mode Test actif : utilisez Race Control ou !rs start'
      or 'Demarrage automatique a l\'extinction des feux en Course'
    drawCenteredText(vec2(leftX, y + 60 * sc), innerW, sub2, fz(11), COL_GOLD)
    y = y + cardH + math.floor(10 * sc)
  elseif st.phase == proto.PHASE_GREEN then
    if st.activePenKind == proto.PEN_NONE then
      local cardH = math.floor(84 * sc)
      ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + cardH), rgbm(0.08, 0.32, 0.16, 0.92), 6 * sc)
      drawCenteredText(vec2(leftX, y + 16 * sc), innerW, 'DRAPEAU VERT — EN COURSE', fz(22), COL_CREAM)
      local cutInfo = cfg.cutEnabled == 1
        and string.format('Surveillance Cuts : %d / %d  |  Pena: %s', st.cutsCount, cfg.cutMaxBeforePenalty, cfg.cutPenaltyType)
        or 'Limiteur coupe — Bonne course !'
      drawCenteredText(vec2(leftX, y + 50 * sc), innerW, cutInfo, fz(12), COL_GREEN)
      y = y + cardH + math.floor(8 * sc)
    end
  else
    -- Active formation panel with classic GDSP cream racing roundel
    local slotH = math.floor(58 * sc)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + slotH), COL_PANEL, 6 * sc)
    local laneTxt = st.myLane == 1 and 'FILE GAUCHE (LEFT)' or (st.myLane == 2 and 'FILE DROITE (RIGHT)' or 'FILE UNIQUE (1x1)')
    local laneCol = st.laneWarn and COL_RED or COL_GOLD
    local rCenter = vec2(leftX + 28 * sc, y + 29 * sc)
    ui.drawCircleFilled(rCenter, 19 * sc, COL_GOLD)
    ui.drawCircleFilled(rCenter, 16.5 * sc, COL_CREAM)
    local posStr = string.format('P%d', st.mySlot)
    local posSz = fz(15)
    local posW = ui.measureDWriteText(posStr, posSz).x
    ui.dwriteDrawText(posStr, posSz, vec2(rCenter.x - posW * 0.5, rCenter.y - posSz * 0.55), COL_DARK)
    ui.dwriteDrawText(string.format('Ligne %d', st.myRow), fz(17), vec2(leftX + 56 * sc, y + 7 * sc), COL_CREAM)
    ui.dwriteDrawText(laneTxt, fz(13), vec2(leftX + 56 * sc, y + 32 * sc), laneCol)

    local targetLabel = st.targetName and ('Suivre: ' .. st.targetName) or 'Leader de file (Pace)'
    local tlW = ui.measureDWriteText(targetLabel, fz(13)).x
    ui.dwriteDrawText(targetLabel, fz(13), vec2(leftX + innerW - 10 * sc - tlW, y + 8 * sc), COL_CREAM)
    local gapTxt = st.targetName and string.format('Ecart devant: %.1f m', st.aheadGapM) or string.format('Box slot: %+.1f m', st.slotDeltaM)
    local gtW = ui.measureDWriteText(gapTxt, fz(12)).x
    ui.dwriteDrawText(gapTxt, fz(12), vec2(leftX + innerW - 10 * sc - gtW, y + 32 * sc), st.passWarn and COL_RED or COL_MUTED)
    y = y + slotH + math.floor(6 * sc)

    local mySpeed = me and me.speedKmh or 0
    local speedRatio = proto.clamp(mySpeed / math.max(1, st.allowedKmh + 15), 0, 1)
    local allowRatio = proto.clamp(st.allowedKmh / math.max(1, st.allowedKmh + 15), 0, 1)
    local spdH = math.floor(40 * sc)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + spdH), COL_PANEL, 6 * sc)
    local barP1 = vec2(leftX + 10 * sc, y + 24 * sc)
    local barW = innerW - 20 * sc
    local barH = math.max(6, 10 * sc)
    ui.drawRectFilled(barP1, barP1 + vec2(barW, barH), rgbm(0.15, 0.22, 0.25, 1), 4 * sc)
    local spdCol = st.speedWarn and COL_RED or (st.limiterActive and COL_AMBER or COL_GREEN)
    ui.drawRectFilled(barP1, barP1 + vec2(barW * speedRatio, barH), spdCol, 4 * sc)
    local tickX = barP1.x + barW * allowRatio
    ui.drawLine(vec2(tickX, barP1.y - 2 * sc), vec2(tickX, barP1.y + barH + 2 * sc), COL_CREAM, math.max(1.5, 2 * sc))

    local spdStr = string.format('%d / %d km/h', math.floor(mySpeed + 0.5), math.floor(st.allowedKmh + 0.5))
    ui.dwriteDrawText(spdStr, fz(14), vec2(leftX + 10 * sc, y + 4 * sc), spdCol)
    local limStr = st.limiterActive and 'LIMITEUR ACTIF' or (cfg.limiterMode == 'off' and 'SANS LIMITEUR' or 'CATCH-UP')
    local lsW = ui.measureDWriteText(limStr, fz(12)).x
    ui.dwriteDrawText(limStr, fz(12), vec2(leftX + innerW - 10 * sc - lsW, y + 5 * sc), st.limiterActive and COL_AMBER or COL_MUTED)
    y = y + spdH + math.floor(6 * sc)

    local laneBoxH = math.floor(42 * sc)
    ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + laneBoxH), COL_PANEL, 6 * sc)
    if cfg.formationMode == '2x2' then
      local laneBoxW = innerW * 0.48
      local lb1 = vec2(leftX + 10 * sc, y + 22 * sc)
      local lbH = math.max(8, 12 * sc)
      ui.dwriteDrawText('Alignement file (G / D)', fz(11), vec2(leftX + 10 * sc, y + 4 * sc), COL_MUTED)
      ui.drawRectFilled(lb1, lb1 + vec2(laneBoxW, lbH), rgbm(0.15, 0.22, 0.25, 1), 4 * sc)
      local targetNorm = st.myLane == 1 and -0.42 or 0.42
      local t0 = proto.clamp((targetNorm - 0.30 + 1) * 0.5, 0, 1)
      local t1 = proto.clamp((targetNorm + 0.30 + 1) * 0.5, 0, 1)
      ui.drawRectFilled(vec2(lb1.x + laneBoxW * t0, lb1.y), vec2(lb1.x + laneBoxW * t1, lb1.y + lbH), rgbm(0.14, 0.78, 0.38, 0.38), 3 * sc)
      local carNorm = proto.clamp((st.lateralNorm + 1) * 0.5, 0, 1)
      local dotX = lb1.x + laneBoxW * carNorm
      ui.drawCircleFilled(vec2(dotX, lb1.y + lbH * 0.5), math.max(3.5, 5 * sc), st.laneWarn and COL_RED or COL_CREAM)

      local remTxt = string.format('Green dans: %d m', math.floor(st.distRemainingM + 0.5))
      local rw = ui.measureDWriteText(remTxt, fz(13)).x
      ui.dwriteDrawText(remTxt, fz(13), vec2(leftX + innerW - 10 * sc - rw, y + 13 * sc), st.inAccelZone and COL_GREEN or COL_CREAM)
    else
      local remTxt = string.format('Distance au Green Flag : %d m   |   Slot delta: %+.1f m',
        math.floor(st.distRemainingM + 0.5), st.slotDeltaM)
      drawCenteredText(vec2(leftX, y + 13 * sc), innerW, remTxt, fz(13), st.inAccelZone and COL_GREEN or COL_CREAM)
    end
    y = y + laneBoxH + math.floor(6 * sc)

    local warnMsg = st.jumpWarn and 'DEPART ANTICIPE DETECTE !'
      or st.passWarn and 'ATTENTION: NE DEPASSEZ PAS — REPRENEZ VOTRE PLACE'
      or st.speedWarn and 'TROP VITE — RALENTISSEZ SOUS LA LIMITE'
      or st.laneWarn and ('MAUVAISE FILE — PLACEZ-VOUS A ' .. (st.myLane == 1 and 'GAUCHE' or 'DROITE'))
      or st.lagWarn and 'ECART IMPORTANT — RESSERREZ LA FORMATION'
      or nil
    if warnMsg then
      local warnH = math.floor(26 * sc)
      ui.drawRectFilled(vec2(leftX, y), vec2(leftX + innerW, y + warnH), COL_RED, 5 * sc)
      drawCenteredText(vec2(leftX, y + 5 * sc), innerW, warnMsg, fz(12), COL_CREAM)
      y = y + warnH + math.floor(4 * sc)
    end
  end
  end -- end not showPelotonCuts

  -- Bottom quick bar: discreet personal Cuts counter (all drivers) + role-gated Peloton Cuts toggle + P1 Green button
  local botH = math.max(18, math.floor(23 * sc))
  local botY = wpos.y + wsize.y - botH - math.max(6, math.floor(7 * sc))
  local cutsNow = st.cutsCount or 0
  local quotaNow = math.max(0, st.cutsQuota or cfg.cutMaxBeforePenalty)
  local timeAdd = st.totalTimePenaltySec or 0
  local penSummary = timeAdd > 0
    and string.format('Cuts : %d/%d   +%ds', cutsNow, quotaNow, timeAdd)
    or string.format('Cuts : %d/%d', cutsNow, quotaNow)
  local penCol = (st.activePenKind ~= proto.PEN_NONE or st.disqualified or timeAdd > 0) and COL_RED
    or (cutsNow > 0 and COL_AMBER or COL_MUTED)
  local pillFz = fz(12)
  local sumW = ui.measureDWriteText(penSummary, pillFz).x
  local dotN = math.min(quotaNow, 5)
  local dotStep = math.max(7, 10 * sc)
  local pillW = sumW + 16 * sc + (dotN > 0 and (dotN * dotStep + 6 * sc) or 0)
  ui.drawRectFilled(vec2(leftX, botY), vec2(leftX + pillW, botY + botH), rgbm(0.04, 0.11, 0.14, 0.78), 5 * sc)
  ui.dwriteDrawText(penSummary, pillFz, vec2(leftX + 8 * sc, botY + (botH - pillFz) * 0.45), penCol)
  if dotN > 0 then
    local filled = math.min(cutsNow, dotN)
    local dx = leftX + 8 * sc + sumW + 10 * sc
    for dIdx = 1, dotN do
      local dc = (dIdx <= filled) and ((filled >= dotN) and COL_RED or COL_AMBER) or rgbm(0.96, 0.93, 0.85, 0.22)
      ui.drawCircleFilled(vec2(dx + (dIdx - 1) * dotStep, botY + botH * 0.5), math.max(2, 3 * sc), dc)
    end
  end

  local btnH = math.max(18, math.floor(24 * sc))
  local btnY = wsize.y - btnH - math.max(6, math.floor(6 * sc))
  local p1BtnW = math.max(104, math.floor(155 * sc))
  local pelBtnW = math.max(78, math.floor(106 * sc))
  local canP1Green = cfg.enabled == 1 and cfg.allowP1Green == 1 and st.mySlot == 1 and st.inAccelZone and (st.phase == proto.PHASE_FORMATION or st.phase == proto.PHASE_READY)
  if st.canViewPeloton then
    local pelBtnX = canP1Green and (wsize.x - pad - p1BtnW - pelBtnW - 6) or (wsize.x - pad - pelBtnW)
    ui.setCursor(vec2(pelBtnX, btnY))
    if ui.button(showPelotonCuts and 'Vue HUD' or 'Peloton Cuts', vec2(pelBtnW, btnH)) then
      showPelotonCuts = not showPelotonCuts
    end
  end

  if canP1Green then
    ui.setCursor(vec2(wsize.x - pad - p1BtnW, btnY))
    ui.pushStyleColor(ui.StyleColor.Button, COL_GREEN)
    ui.pushStyleColor(ui.StyleColor.Text, COL_DARK)
    if ui.button('LANCER GREEN (P1)', vec2(p1BtnW, btnH)) then
      ctx.sendCommand(proto.CMD_GREEN)
    end
    ui.popStyleColor(2)
  end

  drawResizeGrip(wpos, wsize)
end

-- Standalone Movable & Resizable Personal Cut Counter Window (ID = cuts_widget)
function M.drawCutsWidget(ctx, dt)
  hudClock = hudClock + (dt or 0)
  local st = ctx.state
  local cfg = ctx.cfg
  local wpos = vec2(0, 0) -- origine locale : les dessins d'une fenetre CM sont relatifs a la fenetre (sinon le contenu est decale et rogne quand la fenetre bouge)
  local wsize = ui.windowSize()
  local userScale = (ctx.localPrefs and tonumber(ctx.localPrefs.cutsScale)) or 1.0
  local winScale = math.min(wsize.x / 240, wsize.y / 84)
  local sc = proto.clamp(winScale * userScale, 0.52, 3.0)
  local function fz(base) return math.max(10, math.floor(base * sc + 0.5)) end

  ui.drawRectFilled(wpos, wpos + wsize, COL_BG, 7 * sc)
  ui.drawRect(wpos, wpos + wsize, COL_BORDER, 7 * sc, 1.5)

  local padX = math.max(8, 12 * sc)
  local segW = (wsize.x - padX * 2) * 0.25
  local stripeCols = { rgbm(0.61, 0.19, 0.13, 1), COL_GOLD, COL_CREAM, rgbm(0.05, 0.44, 0.43, 1) }
  for sIdx = 1, 4 do
    local sx = wpos.x + padX + (sIdx - 1) * segW
    ui.drawRectFilled(vec2(sx, wpos.y + 2), vec2(sx + segW, wpos.y + math.max(3, 4 * sc)), stripeCols[sIdx])
  end

  -- cutsCount = cuts depuis la dernière pénalité (remis à zéro à chaque pénalité)
  local hasPen = st.activePenKind ~= proto.PEN_NONE and st.activePenKind ~= proto.PEN_TIME_ONLY
  local cutsNow = st.cutsCount or 0
  local quotaNow = math.max(0, st.cutsQuota or cfg.cutMaxBeforePenalty)
  local timeAdd = st.totalTimePenaltySec or 0
  local penSummary = timeAdd > 0
    and string.format('Cuts : %d/%d  +%ds', cutsNow, quotaNow, timeAdd)
    or string.format('Cuts : %d/%d', cutsNow, quotaNow)
  local penCol = (hasPen or st.disqualified or timeAdd > 0) and COL_RED
    or (cutsNow > 0 and COL_AMBER or COL_CREAM)

  local mainFz = fz(16)
  local sumW = ui.measureDWriteText(penSummary, mainFz).x
  local dotN = math.min(quotaNow, 5)
  local dotStep = math.max(8, 12 * sc)
  local cy = wpos.y + wsize.y * (hasPen and 0.30 or 0.54)
  ui.dwriteDrawText(penSummary, mainFz, vec2(wpos.x + padX, cy - mainFz * 0.55), penCol)

  if dotN > 0 then
    local filled = math.min(cutsNow, dotN)
    local dx = wpos.x + padX + sumW + 12 * sc
    if dx + (dotN - 1) * dotStep <= wpos.x + wsize.x - padX then
      for dIdx = 1, dotN do
        local dc = (dIdx <= filled) and ((filled >= dotN) and COL_RED or COL_AMBER) or rgbm(0.96, 0.93, 0.85, 0.24)
        ui.drawCircleFilled(vec2(dx + (dIdx - 1) * dotStep, cy), math.max(2.5, 4 * sc), dc)
      end
    end
  end

  -- pénalité en cours, affichée sous le compteur (disparaît dès qu'elle est purgée)
  if hasPen then
    local src = (st.activePenReason == proto.PEN_REASON_JUMP and 'DEPART ANTICIPE')
      or (st.activePenReason == proto.PEN_REASON_FORMATION and 'FORMATION')
      or (st.activePenReason == proto.PEN_REASON_CUT and 'CUT')
      or 'PENALITE'
    local kind = (st.activePenKind == proto.PEN_STOP_AND_GO)
      and string.format('STOP & GO %ds', st.activePenHoldLeft or 0)
      or 'DRIVE-THROUGH'
    local penTxt = string.format('%s : %s - %d tour(s)', src, kind, st.activePenLapsLeft or 0)
    local pFz = fz(11)
    local barY0 = wpos.y + wsize.y * 0.56
    local barY1 = wpos.y + wsize.y - math.max(4, 6 * sc)
    ui.drawRectFilled(vec2(wpos.x + 4 * sc, barY0), vec2(wpos.x + wsize.x - 4 * sc, barY1), COL_RED, 4 * sc)
    if ui.pushClipRect then pcall(ui.pushClipRect, vec2(wpos.x, barY0), vec2(wpos.x + wsize.x, barY1)) end
    ui.dwriteDrawText(penTxt, pFz, vec2(wpos.x + padX, barY0 + (barY1 - barY0 - pFz) * 0.5), COL_CREAM)
    if ui.popClipRect then pcall(ui.popClipRect) end
  end

  drawResizeGrip(wpos, wsize)
end

function M.draw3D(ctx)
  local st = ctx.state
  local cfg = ctx.cfg

  -- Draw disabled cut zones in 3D when Race Control is visible or debug enabled
  if (ctx.adminVisible or cfg.debug == 1) and cfg.cutDisabledZones and cfg.cutDisabledZones ~= '' then
    pcall(function()
      local zones = proto.parseCutZones(cfg.cutDisabledZones)
      for i = 1, #zones do
        local z = zones[i]
        local p1L = ac.trackCoordinateToWorld(vec3(-1, 0.25, z.sStart))
        local p1R = ac.trackCoordinateToWorld(vec3(1, 0.25, z.sStart))
        local p2L = ac.trackCoordinateToWorld(vec3(-1, 0.25, z.sEnd))
        local p2R = ac.trackCoordinateToWorld(vec3(1, 0.25, z.sEnd))
        render.debugLine(p1L, p1R, COL_BLUE)
        render.debugLine(p2L, p2R, COL_BLUE)
        render.debugText(ac.trackCoordinateToWorld(vec3(0, 2.2, z.sStart)), string.format('CUT OFF #%d', i), COL_BLUE, 1.1)
      end
    end)
  end

  if cfg.enabled ~= 1 then return end
  if st.phase ~= proto.PHASE_FORMATION and st.phase ~= proto.PHASE_READY and st.phase ~= proto.PHASE_CAUTION then
    return
  end

  local sim = ac.getSim()
  local len = (sim and sim.trackLengthM and sim.trackLengthM > 50) and sim.trackLengthM or 1000
  local clockMs = (sim and sim.currentSessionTime) or 0
  local paceDist = math.max(0, (clockMs - st.tStart) / 1000) * (cfg.paceKmh / 3.6)
  local paceS = proto.frac(st.s0 + paceDist / len)

  pcall(function()
    local p = ac.trackCoordinateToWorld(vec3(0, 0, paceS))
    render.debugArrow(p + vec3(0, 9, 0), p + vec3(0, 1.6, 0), 1.1, COL_GOLD)
    render.debugText(p + vec3(0, 10.2, 0), string.format('PACE %d KM/H', cfg.paceKmh), COL_GOLD, 1.3)
  end)

  pcall(function()
    local _, _, targetNormX, slotOffsetM = proto.slotAssignment(math.max(1, st.mySlot), cfg)
    local slotS = proto.frac(paceS - slotOffsetM / len)
    local sBack = proto.frac(slotS - 2.4 / len)
    local sFront = proto.frac(slotS + 2.4 / len)
    local halfBox = cfg.formationMode == '2x2' and 0.24 or 0.35
    local xL = targetNormX - halfBox
    local xR = targetNormX + halfBox
    local boxCol = (st.passWarn or st.laneWarn) and COL_RED or (math.abs(st.slotDeltaM) < 4 and COL_GREEN or COL_AMBER)

    local bl = ac.trackCoordinateToWorld(vec3(xL, 0.15, sBack))
    local br = ac.trackCoordinateToWorld(vec3(xR, 0.15, sBack))
    local fl = ac.trackCoordinateToWorld(vec3(xL, 0.15, sFront))
    local fr = ac.trackCoordinateToWorld(vec3(xR, 0.15, sFront))
    render.debugLine(bl, br, boxCol)
    render.debugLine(br, fr, boxCol)
    render.debugLine(fr, fl, boxCol)
    render.debugLine(fl, bl, boxCol)
  end)

  pcall(function()
    if cfg.startLength == 'full' then
      local azL = ac.trackCoordinateToWorld(vec3(-1, 0.2, cfg.accelZoneStart))
      local azR = ac.trackCoordinateToWorld(vec3(1, 0.2, cfg.accelZoneStart))
      render.debugLine(azL, azR, COL_AMBER)
      local glL = ac.trackCoordinateToWorld(vec3(-1, 0.25, cfg.greenLineSpline))
      local glR = ac.trackCoordinateToWorld(vec3(1, 0.25, cfg.greenLineSpline))
      render.debugLine(glL, glR, COL_GREEN)
    else
      local targetDist = proto.computeTargetDistanceM(st.s0, cfg, len)
      local gs = proto.frac(st.s0 + targetDist / len)
      local glL = ac.trackCoordinateToWorld(vec3(-1, 0.25, gs))
      local glR = ac.trackCoordinateToWorld(vec3(1, 0.25, gs))
      render.debugLine(glL, glR, COL_GREEN)
    end
  end)
end

return M

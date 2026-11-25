'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fengari = require('fengari');

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const root = path.resolve(__dirname, '..');

function runLuaWithPrelude(fileRel, preludeLua, assertLua) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const full = path.join(root, fileRel);
  const src = fs.readFileSync(full, 'utf8');
  const combined = `${preludeLua}\n${src}\n${assertLua}`;
  const loadRc = lauxlib.luaL_loadbuffer(L, to_luastring(combined), combined.length, to_luastring('@' + fileRel));
  if (loadRc !== lua.LUA_OK) {
    throw new Error('Lua syntax error in ' + fileRel + ': ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  const execRc = lua.lua_pcall(L, 0, 0, 0);
  if (execRc !== lua.LUA_OK) {
    throw new Error('Lua runtime error in ' + fileRel + ': ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
}

test('HTTP : /csp/cleanliness.lua, /csp/telemetry.lua et /csp/rollingstart.lua répondent 200 en text/plain', async t => {
  const sock = net.createServer();
  sock.listen(0, '127.0.0.1');
  await once(sock, 'listening');
  const port = sock.address().port;
  await new Promise(r => sock.close(r));

  const child = spawn(process.execPath, ['app.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LIVE_TIMING_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 15000);
    child.stdout.on('data', d => {
      if (String(d).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('serveur arrêté')); });
  });

  const base = `http://127.0.0.1:${port}`;
  for (const [route, marker] of [
    ['/csp/cleanliness.lua', 'GDSP-CLEANLINESS'],
    ['/csp/telemetry.lua', 'GDSP-TELEMETRY'],
    ['/csp/rollingstart.lua', 'GDSP-ROLLINGSTART'],
    ['/csp/rolling_start.lua', 'GDSP Rolling Start & Race Control'],
  ]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route + ' doit répondre 200');
    assert.match(res.headers.get('content-type') || '', /^text\/plain/, route + ' doit être servi en text/plain');
    const body = await res.text();
    assert.ok(!body.trimStart().startsWith('<!DOCTYPE'), route + ' ne doit pas renvoyer une page HTML');
    assert.ok(body.includes(marker), route + ' doit contenir le marqueur ' + marker);
  }
});

test('Lua cleanliness.lua : détection collision, règles FIA agresseur/agressé, OnlineEvent et chat', () => {
  const prelude = `
    CHATS = {}
    EVENTS = {}
    COLLISION_CBS = {}
    SIM = { carsCount = 2, currentSessionIndex = 0, currentSessionTime = 42000, isOnlineRace = false, isAdmin = true }
    CARS = {
      [0] = {
        index = 0, sessionID = 0, isConnected = true, driverName = 'PiloteA', id = 'alfa_gta',
        position = { x = 0, y = 0, z = 10 }, velocity = { x = 0, y = 0, z = 30 },
        look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
        speedKmh = 108, gas = 0.2, brake = 0.2, wheelsOutside = 0, collidedWith = -1, collisionDepth = 0,
      },
      [1] = {
        index = 1, sessionID = 1, isConnected = true, driverName = 'PiloteB', id = 'alfa_gta',
        position = { x = 0.2, y = 0, z = 6.2 }, velocity = { x = 0, y = 0, z = 38 },
        look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
        speedKmh = 136.8, gas = 0.9, brake = 0, wheelsOutside = 0, collidedWith = -1, collisionDepth = 0,
      },
    }
    local pkt = {}
    ac = {
      getSim = function() return SIM end,
      getCar = function(i) return CARS[i] end,
      getDriverName = function(i) return CARS[i] and CARS[i].driverName or '' end,
      getCarID = function(i) return CARS[i] and CARS[i].id or '' end,
      configValues = function(defs)
        local t = {}
        for k, v in pairs(defs) do t[k] = v end
        t.evalWindowSec = 0
        return t
      end,
      onCarCollision = function(idx, cb) COLLISION_CBS[idx] = cb end,
      onSessionStart = function(_) end,
      sendChatMessage = function(m) CHATS[#CHATS + 1] = m end,
      StructItem = {
        key = function(k) return k end,
        int32 = function() return 'int32' end,
        string = function(n) return 'str' .. tostring(n) end,
      },
      OnlineEvent = function(_layout, _cb)
        return function()
          EVENTS[#EVENTS + 1] = {
            Score = pkt.Score, Agresseur = pkt.Agresseur, Agresse = pkt.Agresse, Car = pkt.Car, Time = pkt.Time,
          }
        end, function() return pkt end
      end,
    }
  `;
  const assertions = `
    local C = __GDSP_CLEANLINESS__
    assert(C and C.classifyCollision, 'export absent')

    -- 1) Contact très léger ignoré (< minDepth et vitesse relative < 10 km/h)
    CARS[1].velocity = { x = 0, y = 0, z = 31 }
    local light = C.classifyCollision(C.snapshotCar(CARS[0], 0), C.snapshotCar(CARS[1], 1), 0.002, nil)
    assert(light.status == 'ignored', 'touchette légère doit être ignorée')

    -- 2) Choc arrière franc : PiloteB derrière percute PiloteA -> PiloteB agresseur (+1), PiloteA 0
    CARS[1].velocity = { x = 0, y = 0, z = 40 }
    CARS[1].collisionDepth = 0.08
    script.update(0.05)
    assert(COLLISION_CBS[0] and COLLISION_CBS[1], 'hooks collision enregistrés sur chaque voiture')
    COLLISION_CBS[1](0)
    assert(C.state.scores['PiloteB'].points == 1, 'agresseur +1')
    assert(C.state.scores['PiloteA'].points == 0, 'agressé 0')
    assert(#EVENTS == 1 and EVENTS[1].Agresseur == 'PiloteB' and EVENTS[1].Agresse == 'PiloteA', 'OnlineEvent envoyé')
    assert(#CHATS == 1 and CHATS[1]:find('Agresseur : PiloteB') and CHATS[1]:find('Agressé : PiloteA'), 'chat envoyé')

    -- 3) Dépassement intérieur sans essieu avant à hauteur du rétro -> dépasseur agresseur
    local defSnap = {
      index = 0, name = 'Def', model = 'car', pos = { x = 0, y = 0, z = 10 },
      vel = { x = 0.5, y = 0, z = 30 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 108, gas = 0.3, brake = 0.1, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local attNoOverlap = {
      index = 1, name = 'Att', model = 'car', pos = { x = 1.6, y = 0, z = 8.4 }, -- longOffset = -1.6 -> frontAxle = -0.25 < mirrorOffset(0.35)
      vel = { x = -0.8, y = 0, z = 34 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 122, gas = 0.7, brake = 0, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local vNo = C.classifyCollision(defSnap, attNoOverlap, 0.05, nil)
    assert(vNo.status == 'fault' and vNo.aggressor.name == 'Att', 'sans engagement au rétro, attaquant fautif')

    -- 4) Priorité acquise (essieu avant >= rétro) et défenseur se rabat -> défenseur agresseur
    local defSqueeze = {
      index = 0, name = 'Def', model = 'car', pos = { x = 0, y = 0, z = 10 },
      vel = { x = 2.2, y = 0, z = 30 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 108, gas = 0.6, brake = 0, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local attAlongside = {
      index = 1, name = 'Att', model = 'car', pos = { x = 1.7, y = 0, z = 9.4 }, -- longOffset = -0.6 -> frontAxle = +0.75 >= 0.35
      vel = { x = 0, y = 0, z = 33.5 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 120, gas = 0.5, brake = 0, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local vDef = C.classifyCollision(defSqueeze, attAlongside, 0.05, nil)
    assert(vDef.status == 'fault' and vDef.aggressor.name == 'Def', 'rabattement du défenseur -> défenseur fautif')

    -- 5) Convergence mutuelle (« both contributed ») -> aucun point
    local attConverge = {
      index = 1, name = 'Att', model = 'car', pos = { x = 1.7, y = 0, z = 9.4 },
      vel = { x = -2.0, y = 0, z = 33.5 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 120, gas = 0.5, brake = 0, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local vBoth = C.classifyCollision(defSqueeze, attConverge, 0.05, nil)
    assert(vBoth.status == 'both', 'convergence mutuelle = incident partagé sans sanction')

    -- 6) Sortie forcée post-contact -> l'autre pilote est agresseur
    local defNeutral = {
      index = 0, name = 'Def', model = 'car', pos = { x = 0, y = 0, z = 10 },
      vel = { x = 0, y = 0, z = 30 }, look = { x = 0, y = 0, z = 1 }, side = { x = 1, y = 0, z = 0 },
      speedKmh = 108, gas = 0.5, brake = 0, wheelsOutside = 0, inPit = false, latDriftUnderBraking = 0,
    }
    local vForced = C.classifyCollision(defNeutral, attAlongside, 0.05, { aForcedOff = false, bForcedOff = true })
    assert(vForced.status == 'fault' and vForced.aggressor.name == 'Def' and vForced.reason == 'forced_off_track')
  `;
  runLuaWithPrelude('csp/cleanliness.lua', prelude, assertions);
});

test('Lua rollingstart.lua : rampe progressive en course, annonce chat et relâchement propre au reset', () => {
  const prelude = `
    CHATS = {}
    THROTTLES = {}
    SIM = {
      raceSessionType = 3, currentSessionIndex = 0, currentSessionTime = 0,
      timeToSessionStart = 2000, isSessionStarted = false, isOnlineRace = false, isAdmin = true,
    }
    CAR0 = { index = 0, racePosition = 1, speedKmh = 0, gas = 0, brake = 0, isInPit = false, isInPitlane = false }
    physics = {
      forceUserThrottleFor = function(dur, val) THROTTLES[#THROTTLES + 1] = { dur = dur, val = val } end,
      forceUserBrakesFor = function() end,
    }
    ac = {
      SessionType = { Race = 3 },
      getSim = function() return SIM end,
      getCar = function(i) return i == 0 and CAR0 or nil end,
      configValues = function(defs)
        local t = {}
        for k, v in pairs(defs) do t[k] = v end
        t.launchSpeedKmh = 65
        t.rampDurationSec = 2.0
        return t
      end,
      onSessionStart = function(_) end,
      sendChatMessage = function(m) CHATS[#CHATS + 1] = m end,
    }
  `;
  const assertions = `
    local R = __GDSP_ROLLINGSTART__
    assert(R.cfg.launchSpeedKmh == 65)

    -- Avant le signal de départ : aucune action
    script.update(0.1)
    assert(R.state.phase == 0 and #CHATS == 0 and #THROTTLES == 0)

    -- Signal de départ : rampe progressive + message chat
    SIM.timeToSessionStart = 0
    SIM.isSessionStarted = true
    SIM.currentSessionTime = 100
    script.update(0.1)
    assert(R.state.phase == 1, 'en rampe')
    assert(#CHATS == 1 and CHATS[1]:find('Départ lancé — rolling start'), 'message chat envoyé')
    assert(#THROTTLES >= 1 and THROTTLES[1].val > 0, 'accélération progressive appliquée')

    -- Après la durée de rampe : relâchement complet (voiture libre)
    SIM.currentSessionTime = 2600
    script.update(2.2)
    assert(R.state.phase == 2 and R.state.controlsTouched == false, 'contrôles relâchés en fin de rampe')

    -- Redémarrage de session (horloge qui recule) : réinitialisation propre sans blocage
    SIM.currentSessionTime = 0
    SIM.isSessionStarted = false
    SIM.timeToSessionStart = 3000
    script.update(0.1)
    assert(R.state.phase == 0 and R.state.announced == false and R.state.controlsTouched == false)
  `;
  runLuaWithPrelude('csp/rollingstart.lua', prelude, assertions);
});

test('Administration → Serveur CM : catalogue des 3 scripts et bloc csp_extra_options.ini généré', () => {
  const siteSrc = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
  assert.match(siteSrc, /Ajouter les scripts serveur/);
  // Évalue les fonctions pures du catalogue dans un contexte isolé (origine prod simulée)
  const start = siteSrc.indexOf('const CM_SERVER_SCRIPTS=');
  const end = siteSrc.indexOf('let cmStatusRequest=0;');
  assert.ok(start > 0 && end > start, 'bloc catalogue CM présent dans site.js');
  const snippet = siteSrc.slice(start, end);

  const ctx = {
    location: { origin: 'https://gdsp.duckdns.org' },
    esc: v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: () => null, querySelector: () => null },
    navigator: { clipboard: { writeText: async () => {} } },
    render() {},
  };
  vm.createContext(ctx);
  vm.runInContext(snippet + '\nthis.api={renderServersAdmin,openCmServerScripts,toggleCmServerScript,buildCmServerScriptsIni};', ctx);

  let html = ctx.api.renderServersAdmin();
  assert.match(html, /Ajouter les scripts serveur/);
  assert.match(html, /cleanliness\.lua/);
  assert.match(html, /telemetry\.lua/);
  assert.match(html, /rollingstart\.lua/);
  assert.match(html, /id="cm-scripts-body" hidden/);

  ctx.api.openCmServerScripts();
  html = ctx.api.renderServersAdmin();
  assert.doesNotMatch(html, /id="cm-scripts-body" hidden/);
  assert.match(html, /csp_extra_options\.ini/);
  assert.match(html, /rechargez \/ redémarrez le serveur/);

  const ini = ctx.api.buildCmServerScriptsIni();
  assert.equal(
    ini,
    "[SCRIPT_1]\nSCRIPT = 'https://gdsp.duckdns.org/csp/rollingstart.lua'\nREQUIRED = 0\n\n" +
    "[SCRIPT_2]\nSCRIPT = 'https://gdsp.duckdns.org/csp/telemetry.lua'\nREQUIRED = 0\n\n" +
    "[SCRIPT_3]\nSCRIPT = 'https://gdsp.duckdns.org/csp/cleanliness.lua'\nREQUIRED = 0\n"
  );
});

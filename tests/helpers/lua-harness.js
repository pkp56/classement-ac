'use strict';
/*
 * Exécute un script Lua du dépôt sous un interpréteur Lua 5.3 en JavaScript
 * (fengari), avec un faux environnement CSP et un faux `web.post`.
 *
 * Pourquoi : le script de télémétrie ne tourne qu'en jeu, sur le PC des
 * pilotes. Sans ce harnais, une faute de syntaxe ou un JSON mal encodé ne se
 * verrait qu'en course — c'est-à-dire trop tard. Ici, on vérifie que le script
 * se charge, qu'il lit les valeurs et qu'il produit un JSON valide.
 *
 * Ce harnais ne remplace pas un essai en jeu : il ne prouve pas que CSP expose
 * `car.fuel` sur ta version. Il prouve que ce qui est écrit en Lua est correct.
 */
const path = require('node:path');
const fs = require('node:fs');
const fengari = require('fengari');

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

// `script` est fourni par le SDK CSP (table globale) : on la crée ici, sinon le
// script ne peut pas y attacher ses callbacks.
const PRELUDE = `
  script = {}
  local out = {}
  io.write = function (...) out[#out + 1] = table.concat({...}, ' ') end
`;

/** Environnement simulé : une voiture, une session, un transport HTTP. */
function defaultEnv(overrides = {}) {
  return {
    car: {
      fuel: 30.5, speedKmh: 180, lapCount: 1, splinePosition: 0.5, previousLapTimeMs: 75576,
      driverName: "Assassin's Street", driverSteamID: '76561198015862674', id: 'alfa_giulietta_spider',
      wheels: [{ tyreWear: 1 }, { tyreWear: 1 }, { tyreWear: 0.999 }, { tyreWear: 0.999 }],
      ...(overrides.car || {})
    },
    sim: {
      serverName: '{GDSP_ Server test 1', trackID: 'ks_monza66-junior', trackLayout: 'junior',
      currentSessionType: 'practice', fuelRate: 100, tyreWearRate: 100,
      ...(overrides.sim || {})
    }
  };
}

/** Pousse une valeur JS simple (nombre, chaîne, table, tableau) en Lua. */
function pushValue(L, v) {
  if (typeof v === 'number') return lua.lua_pushnumber(L, v);
  if (typeof v === 'boolean') return lua.lua_pushboolean(L, v);
  if (v == null) return lua.lua_pushnil(L);
  if (typeof v === 'object') return pushTable(L, v);
  return lua.lua_pushstring(L, to_luastring(String(v)));
}

function pushTable(L, value) {
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((item, i) => {
      pushValue(L, item);
      lua.lua_rawseti(L, -2, i + 1);
    });
    return;
  }
  lua.lua_newtable(L);
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    pushValue(L, v);
    lua.lua_setfield(L, -2, to_luastring(k));
  }
}

/**
 * Charge `csp/gdsp_telemetry.lua` dans un état Lua neuf.
 * @returns {{sent:string[], messages:string[], error:string|null, L:object|null}}
 */
function runTelemetryScript(options = {}) {
  const cwd = options.cwd || path.resolve(__dirname, '..', '..');
  const env = defaultEnv(options);
  // `noGuid` : AUCUN identifiant Steam disponible, comme sur une vraie voiture
  // (l'API CSP n'expose ni driverGuid ni driverSteamID). Le script doit
  // continuer à lire les tours, pas se taire.
  if (options.noGuid) {
    env.car.driverGuid = undefined;
    env.car.driverSteamID = undefined;
  }
  const sent = [];
  const messages = [];
  const ui = [];
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  if (lauxlib.luaL_dostring(L, to_luastring(PRELUDE)) !== lua.LUA_OK) {
    return { sent, messages, ui, error: to_jsstring(lua.lua_tostring(L, -1)), L: null };
  }

  // `ac` : uniquement les fonctions utilisées par le script.
  lua.lua_newtable(L);
  lua.lua_pushjsfunction(L, () => 0);                    // ac.log
  lua.lua_setfield(L, -2, to_luastring('log'));
  lua.lua_pushjsfunction(L, () => 0);                    // ac.console
  lua.lua_setfield(L, -2, to_luastring('console'));
  lua.lua_pushjsfunction(L, (state) => {                 // ac.setMessage
    const title = to_jsstring(lua.lua_tostring(state, 1) || to_luastring(''));
    const body = to_jsstring(lua.lua_tostring(state, 2) || to_luastring(''));
    messages.push(title + ' — ' + body);
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('setMessage'));
  lua.lua_pushjsfunction(L, (state) => {                 // ac.configValues
    // Le 1er argument est le « layout » : on le remplit avec `options.config`
    // (ce que CSP lirait dans la section [SCRIPT_x] de csp_extra_options.ini),
    // puis on le renvoie. Sans lui, `url` reste vide et le script ne peut rien
    // envoyer — c'est exactement le cas « envoi sans URL ».
    if (options.config && typeof options.config === 'object') {
      for (const [k, v] of Object.entries(options.config)) {
        pushValue(L, v);
        lua.lua_setfield(state, 1, to_luastring(k));
      }
    }
    lua.lua_pushvalue(state, 1);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('configValues'));
  lua.lua_pushjsfunction(L, (state) => {                 // ac.getDriverName
    lua.lua_pushstring(state, to_luastring(env.car.driverName));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('getDriverName'));
  lua.lua_pushjsfunction(L, (state) => {                 // ac.getCarID
    lua.lua_pushstring(state, to_luastring(env.car.id));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('getCarID'));
  lua.lua_setglobal(L, to_luastring('ac'));

  pushTable(L, env.car);
  lua.lua_setglobal(L, to_luastring('car'));
  pushTable(L, env.sim);
  lua.lua_setglobal(L, to_luastring('sim'));

  // `web.post(url, headers, body, callback)` → succès immédiat, sans réseau.
  lua.lua_newtable(L);
  lua.lua_pushjsfunction(L, (state) => {
    const body = lua.lua_tostring(state, 3);
    const text = body ? to_jsstring(body) : '';
    sent.push(text);
    // `silentPost` : la requête part (donc elle est comptée) mais le callback
    // n'est JAMAIS appelé. C'est le cas réel d'un POST avalé par un proxy.
    if (options.silentPost) return 0;
    // `failPost` simule un réseau coupé : le script doit remettre les tours en
    // attente et les renvoyer plus tard, sans doublon côté serveur.
    const shouldFail = typeof options.failPost === 'function'
      ? options.failPost(sent.length, text)
      : false;
    if (lua.lua_type(state, 4) === lua.LUA_TFUNCTION) {
      // `options.status` permet de simuler un refus (401, 503…).
      // Même empilement que le cas nominal : callback(nil, res).
      if (typeof options.status === 'number') {
        lua.lua_pushvalue(state, 4);                       // callback
        lua.lua_pushnil(state);                            // err = nil
        lua.lua_newtable(state);                           // res
        lua.lua_pushinteger(state, options.status);
        lua.lua_setfield(state, -2, to_luastring('status'));
        lua.lua_pushstring(state, to_luastring('{}'));
        lua.lua_setfield(state, -2, to_luastring('body'));
        lua.lua_call(state, 2, 0);
        return 0;
      }
      lua.lua_pushvalue(state, 4);
      if (shouldFail) lua.lua_pushstring(state, to_luastring('réseau indisponible'));
      else lua.lua_pushnil(state);
      lua.lua_newtable(state);
      lua.lua_pushinteger(state, shouldFail ? 0 : 200);
      lua.lua_setfield(state, -2, to_luastring('status'));
      lua.lua_call(state, 2, 0);
    }
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('post'));
  // Sonde GET : même comportement que le POST pour les tests.
  lua.lua_pushjsfunction(L, (state) => {
    if (options.silentGet) return 0;
    lua.lua_pushvalue(state, 2);
    if (lua.lua_isfunction(state, -1)) {
      lua.lua_pushnil(state);
      lua.lua_newtable(state);
      lua.lua_pushinteger(state, 200);
      lua.lua_setfield(state, -2, to_luastring('status'));
      lua.lua_pushstring(state, to_luastring('ok'));
      lua.lua_setfield(state, -2, to_luastring('body'));
      lua.lua_call(state, 2, 0);
    } else {
      lua.lua_pop(state, 1);
    }
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('get'));
  lua.lua_setglobal(L, to_luastring('web'));
  // `ui` minimal : `drawUI` sert de canal de diagnostic, il doit pouvoir être
  // appelé sans planter, même hors rendu.
  lua.lua_newtable(L);
  lua.lua_pushjsfunction(L, (state) => {
    const text = lua.lua_tostring(state, 1);
    if (text) ui.push(to_jsstring(text));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('text'));
  lua.lua_setglobal(L, to_luastring('ui'));

  // `options.noWeb` simule un script en ligne où `web.post` n'est pas exposé :
  // le script doit alors le DIRE au lieu de rester silencieux, et retenter.
  if (options.noWeb) lua.lua_pushnil(L), lua.lua_setglobal(L, to_luastring('web'));

  const file = path.join(cwd, 'csp', 'gdsp_telemetry.lua');
  if (!fs.existsSync(file)) return { sent, messages, error: 'csp/gdsp_telemetry.lua absent', L: null };
  if (lauxlib.luaL_loadfile(L, to_luastring(file)) !== lua.LUA_OK) {
    return { sent, messages, ui, error: to_jsstring(lua.lua_tostring(L, -1)), L: null };
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    return { sent, messages, ui, error: to_jsstring(lua.lua_tostring(L, -1)), L: null };
  }

  // La route /csp/telemetry.lua ajoute `__GDSP_TELEMETRY__` À LA FIN du fichier
  // servi, donc APRÈS l'exécution du corps du script. La poser avant le
  // chargement masquerait tous les bugs d'ordre d'initialisation — c'est
  // exactement ce qui a laissé passer une URL vide jusqu'en production.
  if (options.injected && typeof options.injected === 'object') {
    lua.lua_newtable(L);
    for (const [k, v] of Object.entries(options.injected)) {
      pushValue(L, v);
      lua.lua_setfield(L, -2, to_luastring(k));
    }
    lua.lua_setglobal(L, to_luastring('__GDSP_TELEMETRY__'));
  }

  // Le script utilisé en jeu est celui que SERT le site : corps + table
  // injectée. Les tests doivent tourner sur ce texte-là, et non sur une
  // reconstitution approximative. `options.served` fait cette vérification.
  if (options.served) {
    const src = fs.readFileSync(file, 'utf8')
      + '\n__GDSP_TELEMETRY__ = { url = "https://servi.test/api/telemetry/push", token = "t" }\n';
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), Buffer.byteLength(src), '@servi') !== lua.LUA_OK
        || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      return { sent, messages, ui, error: to_jsstring(lua.lua_tostring(L, -1)), L: null };
    }
  }

  // CSP appelle `script.__init__` juste après le chargement : c'est là que le
  // script affiche son diagnostic « carburant lu / pneus lus ».
  if (options.callInit !== false) {
    lua.lua_getglobal(L, to_luastring('script'));
    lua.lua_getfield(L, -1, to_luastring('__init__'));
    if (lua.lua_isfunction(L, -1)) {
      lua.lua_remove(L, -2);
      if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
        return { sent, messages, ui, error: to_jsstring(lua.lua_tostring(L, -1)), L: null };
      }
    } else {
      lua.lua_pop(L, 2);
    }
  }
  return { sent, messages, ui, error: null, L };
}

/**
 * Charge le script puis exécute `script.update(dt)` pour chaque pas fourni.
 * `steps` peut contenir des fonctions (state) => dt pour modifier la voiture
 * entre deux appels, ce qui permet de simuler un tour complet.
 */
function simulate(options = {}) {
  const result = runTelemetryScript(options);
  if (result.error) return result;
  const L = result.L;
  const steps = options.steps || [{ dt: 0.016 }];

  function pushUpdate() {
    lua.lua_getglobal(L, to_luastring('script'));
    if (!lua.lua_istable(L, -1)) throw new Error('script n\'est pas une table');
    lua.lua_getfield(L, -1, to_luastring('update'));
    if (!lua.lua_isfunction(L, -1)) throw new Error('script.update absent');
    // la table `script` reste sous la fonction : on la retire avant l'appel.
    lua.lua_remove(L, -2);
  }

  // CSP appelle `drawUI` à chaque image, après `update` : on l'imite, sinon
  // le canal de diagnostic le plus sûr ne serait jamais exercé par les tests.
  function pushDrawUI() {
    lua.lua_getglobal(L, to_luastring('script'));
    if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return false; }
    lua.lua_getfield(L, -1, to_luastring('drawUI'));
    if (!lua.lua_isfunction(L, -1)) { lua.lua_pop(L, 2); return false; }
    lua.lua_remove(L, -2);
    return true;
  }

  for (const step of steps) {
    if (typeof step === 'function') { step(L); continue; }
    pushUpdate();
    lua.lua_pushnumber(L, typeof step === 'number' ? step : step.dt);
    if (lua.lua_pcall(L, 1, 0, 0) !== lua.LUA_OK) {
      return { ...result, error: to_jsstring(lua.lua_tostring(L, -1)) };
    }
    if (options.drawUI !== false && pushDrawUI()) {
      if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
        return { ...result, error: to_jsstring(lua.lua_tostring(L, -1)) };
      }
    }
  }
  return result;
}

/** Modifie un champ de la voiture depuis un pas de simulation. */
function setCar(L, field, value) {
  lua.lua_getglobal(L, to_luastring('car'));
  if (typeof value === 'object' && value !== null) {
    pushTable(L, value);
  } else {
    pushValue(L, value);
  }
  lua.lua_setfield(L, -2, to_luastring(field));
  lua.lua_pop(L, 1);
}

module.exports = { runTelemetryScript, simulate, setCar, defaultEnv, to_luastring, lua };

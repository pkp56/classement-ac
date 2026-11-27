'use strict';

// Pace car IA du depart lance GDSP : verification que le sous-systeme est bien
// cable dans csp/rolling_start.lua, que le systeme de safety car humaine reste
// intact, et que les nouvelles options passent par l'encodeur du configurateur.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const root = path.resolve(__dirname, '..');
const luaPath = path.join(root, 'csp', 'rolling_start.lua');
const luaSrc = fs.readFileSync(luaPath, 'utf8');

function loadLua(src, name) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const rc = lauxlib.luaL_loadbuffer(L, to_luastring(src), src.length, to_luastring('@' + name));
  if (rc !== lua.LUA_OK) {
    throw new Error('Lua syntax error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  return L;
}

test('rolling_start.lua compile malgre la limite Lua de 200 variables locales', () => {
  assert.doesNotThrow(() => loadLua(luaSrc, 'rolling_start.lua'));
});

test('Le pace car IA est optionnel et desactive par defaut', () => {
  assert.match(luaSrc, /aiPaceMode\s*=\s*'off'/);
  assert.match(luaSrc, /aiPaceName\s*=\s*'Pace Car'/);
  assert.match(luaSrc, /aiPaceKmh\s*=\s*90/);
  assert.match(luaSrc, /aiPaceLeadM\s*=\s*30/);
  assert.match(luaSrc, /aiPaceInLap\s*=\s*1/);
  // trois modes seulement : off / grid / any
  assert.match(luaSrc, /AI_PACE_MODE_CHOICES\s*=\s*\{\s*'off',\s*'grid',\s*'any'\s*\}/);
});

test('Le systeme de safety car humaine est inchange (cle, fallback, vitesse pace)', () => {
  // La detection historique doit rester intacte : le pace car IA ne la remplace pas.
  assert.match(luaSrc, /local function isSafetyCarMatch\(carId, driverName, customKey\)/);
  assert.ok(luaSrc.includes(",safety,pace_car,pace car,[sc],race_control,steward'"), 'mots-cles safety car historiques intacts');
  assert.match(luaSrc, /safetyCarKey = 'safety'/);
  assert.match(luaSrc, /paceKmh = 90/);
  // Le pace car IA est exclu du classement du depart, pas la safety car humaine.
  assert.match(luaSrc, /function G_AI\.isOurCar\(id\)/);
  assert.match(luaSrc, /if cfg\.startLength == 'full' and lead and not G_AI\.isOurCar\(lead\.sessionID\) then/);
});

test('Le pilotage IA utilise uniquement les API CSP verifiees', () => {
  // API confirmees par le script safety car CSP en ligne de reference (VVS SC Mark2).
  for (const api of [
    'physics.setCarAutopilot',
    'physics.setAITopSpeed',
    'physics.setAIThrottleLimit',
    'physics.setAIAggression',
    'physics.setAIPitStopRequest',
  ]) {
    assert.match(luaSrc, new RegExp(api.replace('.', '\\.')), api + ' doit rester utilise');
  }
  // Toute prise de controle doit rester protegee (pcall) : une API absente sur
  // une vieille version de CSP ne doit pas casser le depart lance.
  assert.match(luaSrc, /pcall\(function\(\)\s*\n\s*physics\.setCarAutopilot\(true, false\)/);
  // Le script ne doit jamais mettre la voiture du joueur en autopilote en mode 'off'.
  assert.match(luaSrc, /function G_AI\.active\(\)\s*\n\s*return cfg\.aiPaceMode ~= 'off'\s*\nend/);
});

test('La configuration du pace car IA est synchronisee entre les clients', () => {
  // Un octet compact suffit : mode (2 bits) + rentree aux stands (1 bit) + vitesse (5 bits).
  assert.match(luaSrc, /function G_AI\.packCode\(c\)/);
  assert.match(luaSrc, /function G_AI\.unpackCode\(code, base\)/);
  assert.match(luaSrc, /aiPaceCode = ac\.StructItem\.uint8\(\)/);
  assert.match(luaSrc, /p\.aiPaceCode = G_AI\.packCode\(cfg\)/);
  assert.match(luaSrc, /nc = G_AI\.unpackCode\(d\.aiPaceCode or 0, nc\)/);
  assert.match(luaSrc, /cmdAiPaceCode = ac\.StructItem\.uint8\(\)/);
  assert.match(luaSrc, /aiPaceState = ac\.StructItem\.uint8\(\)/);
});

test('Le pace car IA peut etre pilote a la voix pendant une course (!rs aipace)', () => {
  assert.match(luaSrc, /local aiVal = cmd:match\('\^aipace%s\+\(\.\*\)\$'\)/);
  assert.match(luaSrc, /nc\.aiPaceMode = 'off'/);
  assert.match(luaSrc, /elseif modeArg == 'on' or modeArg == 'any' then/);
  assert.match(luaSrc, /nc\.aiPaceKmh = speedArg/);
});

test('Encodeur : les options du pace car IA sont generees et assainies', () => {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'race-control', 'encoder.js'), 'utf8'), sandbox);
  const enc = sandbox.window.GDSPRaceEncoder;

  assert.equal(enc.CFG_DEFAULTS.aiPaceMode, 'off');
  assert.equal(enc.CFG_DEFAULTS.aiPaceName, 'Pace Car');
  assert.equal(enc.CFG_DEFAULTS.aiPaceKmh, 90);
  assert.equal(enc.CFG_DEFAULTS.aiPaceLeadM, 30);
  assert.equal(enc.CFG_DEFAULTS.aiPaceInLap, 1);

  // Config par defaut : compacte, donc aucune ligne aiPace* ne doit apparaitre.
  const compact = enc.buildCspExtraOptionsIni({});
  assert.doesNotMatch(compact, /aiPace/);

  // Active : les options apparaissent dans le bloc [SCRIPT_1].
  const active = enc.buildCspExtraOptionsIni({ aiPaceMode: 'grid', aiPaceName: 'Safety Car' });
  assert.match(active, /\[SCRIPT_1\]/);
  assert.match(active, /aiPaceMode=grid/);
  assert.match(active, /aiPaceName=Safety Car/);

  // Valeurs hors bornes : ramenees dans les limites du script Lua (le mode retombe
  // sur 'off', valeur par defaut, donc compactee hors du bloc genere).
  const clamped = enc.buildCspExtraOptionsIni({ aiPaceMode: 'n-importe-quoi', aiPaceKmh: 500, aiPaceLeadM: 1 });
  assert.doesNotMatch(clamped, /aiPaceMode=(?!off)/);
  assert.match(clamped, /aiPaceKmh=180/);
  assert.match(clamped, /aiPaceLeadM=10/);
});

test('Le configurateur expose les champs du pace car IA', () => {
  const html = fs.readFileSync(path.join(root, 'race-control.html'), 'utf8');
  for (const id of ['aiPaceMode', 'aiPaceName', 'aiPaceKmh', 'aiPaceLeadM', 'aiPaceInLap']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' manquant dans race-control.html');
  }
  assert.match(html, /Pace Car IA/);
  // Le systeme humain doit rester visible et inchange.
  assert.match(html, /id="safetyCarKey"/);
  assert.match(html, /id="paceKmh"/);

  const configurator = fs.readFileSync(path.join(root, 'race-control', 'configurator.js'), 'utf8');
  for (const id of ['aiPaceMode', 'aiPaceName', 'aiPaceKmh', 'aiPaceLeadM', 'aiPaceInLap']) {
    assert.match(configurator, new RegExp("'" + id + "'"), id + ' absent de FIELD_IDS');
  }
});

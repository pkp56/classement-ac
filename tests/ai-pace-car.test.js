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
  // La vitesse suit desormais le peloton : le pace car ne prend pas la tete du classement.
  assert.match(luaSrc, /function G_AI\.targetKmh\(cars, car\)/);
  assert.match(luaSrc, /lead and not G_AI\.isOurCar\(lead\.sessionID\)/);
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

test('La vitesse du pace car suit les pilotes et respecte le plafond choisi', () => {
  // Mode suivi : la consigne part de la vitesse reelle du leader, plafonnee.
  assert.match(luaSrc, /cfg\.aiPaceFollow = \(tonumber\(cfg\.aiPaceFollow\) or 1\) ~= 0 and 1 or 0/);
  assert.match(luaSrc, /function G_AI\.targetKmh\(cars, car\)/);
  assert.match(luaSrc, /return math\.min\(cap, math\.max\(25, leadKmh \+ 6\)\), true/);
  // Peloton arrete : allure de formation douce, jamais au-dela du plafond.
  assert.match(luaSrc, /return math\.min\(cap, 40\), true/);
  // Mode vitesse fixe conserve.
  assert.match(luaSrc, /if cfg\.aiPaceFollow ~= 1 then return cap, false end/);
});

test('Le modele de voiture sert de critere de selection sans casser le nom', () => {
  assert.match(luaSrc, /aiPaceModel = 'dodge_monaco_police'/);
  assert.match(luaSrc, /local wantModel = tostring\(cfg\.aiPaceModel or ''\):lower\(\):gsub\('%s\+\$', ''\)/);
  // Un modele renseigne filtre les candidats ; un nom vide n'empeche pas la selection.
  assert.match(luaSrc, /if not modelOk then dn = '' ; cid = '' end/);
});

test('Le paquet de configuration reseau reste sous la limite CSP de 175 octets', () => {
  const sizes = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float: 4, double: 8, boolean: 1, unorm8: 1, unorm16: 2 };
  const end = luaSrc.indexOf('onCfgEvent)');
  const start = luaSrc.lastIndexOf('local ok2', end);
  const chunk = luaSrc.slice(start, end);
  let total = 0;
  for (const m of chunk.matchAll(/(\w+) = ac\.StructItem\.(\w+)\(([0-9]*)\)/g)) {
    const [, , type, len] = m;
    total += type === 'string' ? Number(len) + 1 : (sizes[type] ?? 4);
  }
  assert.ok(total <= 175, `paquet de configuration trop gros : ${total} octets`);
  assert.ok(total > 0, 'aucun champ detecte');
});

test('Livraison : le bloc entry_list est genere et les identifiants sont valides', () => {
  const paceCar = require('../race-control/pace-car.js');

  const block = paceCar.buildEntryBlock({ model: 'dodge_monaco_police', driverName: 'Pace Car' }, { slot: 12 });
  assert.equal(block.valid, true);
  assert.match(block.text, /^\[CAR_12\]\nMODEL=dodge_monaco_police\n/);
  assert.match(block.text, /\nDRIVERNAME=Pace Car\n/);
  assert.match(block.text, /\nGUID=\n/);
  assert.match(block.text, /\nBALLAST=0\n/);

  // Identifiant de voiture invalide : refuse, jamais injecte dans le fichier.
  const bad = paceCar.buildEntryBlock({ model: '../../etc/passwd' });
  assert.equal(bad.valid, false);
  assert.match(bad.error, /invalide/i);

  // Le skin avec options CSP est ramene a l'identifiant seul.
  assert.equal(paceCar.skinId('gdsp_livery/carbon'), 'gdsp_livery');
  const withSkin = paceCar.buildEntryBlock({ model: 'mini_cooper', skin: 'livery_1/carbon' });
  assert.match(withSkin.text, /\nSKIN=livery_1\n/);
});

test('Livraison : les options CSP reprennent le modele et le nom du pace car', () => {
  const paceCar = require('../race-control/pace-car.js');
  const opts = paceCar.buildCspOptions({ model: 'dodge_monaco_police', driverName: 'Safety Car' });
  assert.match(opts, /aiPaceMode=grid/);
  assert.match(opts, /aiPaceName=Safety Car/);
  assert.match(opts, /aiPaceModel=dodge_monaco_police/);
  // Le nom est borne a ce que le script Lua accepte.
  const longName = paceCar.buildCspOptions({ model: 'x_car', driverName: 'A'.repeat(80) });
  assert.match(longName, /^aiPaceName=A{23}$/m, 'nom tronque a 23 caracteres comme cote Lua');
});

test('Livraison : l inventaire du serveur alimente la liste des modeles', () => {
  const paceCar = require('../race-control/pace-car.js');
  const choices = paceCar.carChoicesFromInventory({
    cars: [
      { id: 'ks_porsche_911', skins: ['a', 'b'] },
      { id: 'dodge_monaco_police', skins: ['default'] },
      { id: 'invalide espace', skins: [] },
    ],
  });
  assert.deepEqual(choices.map(c => c.id).sort(), ['dodge_monaco_police', 'ks_porsche_911']);
  assert.equal(choices.find(c => c.id === 'ks_porsche_911').skins.length, 2);
  // Reponse vide ou erronee : liste vide, pas de plantage.
  assert.deepEqual(paceCar.carChoicesFromInventory(null), []);
  assert.deepEqual(paceCar.carChoicesFromInventory({}), []);
});

test('Livraison : le bloc et les instructions designent la meme place', () => {
  const paceCar = require('../race-control/pace-car.js');
  const block = paceCar.buildEntryBlock({ model: 'dodge_monaco_police' }, { slot: 7 });
  const notes = paceCar.buildDeliveryNotes({ model: 'dodge_monaco_police' }, { slot: 7 });
  assert.match(block.text, /^\[CAR_7\]/);
  assert.match(notes.text, /\[CAR_7\]/);
  assert.doesNotMatch(notes.text, /\[CAR_0\]/);
  // Les instructions rappellent les deux fichiers a modifier.
  assert.match(notes.text, /entry_list\.ini/);
  assert.match(notes.text, /csp_extra_options\.ini/);
});

test('Le configurateur genere le bloc a livrer, avec la place choisie', () => {
  const html = fs.readFileSync(path.join(root, 'race-control.html'), 'utf8');
  // La section de livraison et son bouton doivent exister, et pace-car.js etre charge.
  // Deux blocs separes : entry_list.ini d'un cote, csp_extra_options.ini de l'autre.
  assert.match(html, /id="aiPaceEntryOut"/);
  assert.match(html, /id="aiPaceCspOut"/);
  assert.match(html, /id="copyAiPaceEntryBtn"/);
  assert.match(html, /id="copyAiPaceCspBtn"/);
  assert.match(html, /id="aiPaceInventoryBtn"/);
  assert.match(html, /<script src="\/race-control\/pace-car\.js"><\/script>/);
  // pace-car.js doit etre charge avant le configurateur qui l'utilise.
  const order = [html.indexOf('pace-car.js'), html.indexOf('configurator.js')];
  assert.ok(order[0] > 0 && order[0] < order[1], 'pace-car.js doit preceder configurator.js');

  // Le configurateur rebranche bien l'inventaire admin deja existant.
  const configurator = fs.readFileSync(path.join(root, 'race-control', 'configurator.js'), 'utf8');
  assert.match(configurator, /fetch\('\/api\/server-manager\/inventory'/);
  assert.match(configurator, /credentials: 'same-origin'/);
  assert.match(configurator, /carChoicesFromInventory/);
});

test('Livraison : aucun commentaire dans les blocs destines aux INI du serveur', () => {
  const paceCar = require('../race-control/pace-car.js');
  const d = paceCar.buildDelivery({ model: 'dodge_monaco_police', driverName: 'Pace Car' }, { slot: 4 });
  // Un '#' colle dans entry_list.ini ou csp_extra_options.ini peut casser la lecture serveur.
  assert.doesNotMatch(d.entry, /#/, 'pas de commentaire dans le bloc entry_list');
  assert.doesNotMatch(d.csp, /#/, 'pas de commentaire dans le bloc CSP');
  // Le bloc entry commence par son en-tete de place.
  assert.match(d.entry, /^\[CAR_4\]\nMODEL=dodge_monaco_police\n/);
  assert.match(d.csp, /^\[SCRIPT_1\]\nSCRIPT=/);
});

test('Livraison : les deux fichiers sont separes et jamais melanges', () => {
  const paceCar = require('../race-control/pace-car.js');
  const d = paceCar.buildDelivery({ model: 'ks_porsche_911', driverName: 'Safety' }, { slot: 9 });
  // Le bloc entry_list ne doit contenir aucune option CSP...
  assert.doesNotMatch(d.entry, /aiPace|SCRIPT_1|\[SCRIPT/);
  // ...et le bloc CSP ne doit contenir aucune place de grille.
  assert.doesNotMatch(d.csp, /CAR_|DRIVERNAME|BALLAST|MODEL=/);
  // Les instructions renvoient vers les deux fichiers, dans le bon ordre.
  assert.match(d.notes, /entry_list\.ini/);
  assert.match(d.notes, /csp_extra_options\.ini/);
  assert.equal(d.slot, 9);
  // Un modele invalide ne produit aucun bloc partiel.
  const bad = paceCar.buildDelivery({ model: 'pas bon' });
  assert.equal(bad.ok, false);
  assert.equal(bad.entry, '');
  assert.equal(bad.csp, '');
});

test('Garde-fou : le script ne pilote que sa propre voiture, jamais celle d un autre', () => {
  // physics.setCarAutopilot() n'a pas d'index : piloter une voiture distante
  // mettrait en autopilote la voiture du joueur. La protection doit rester.
  assert.match(luaSrc, /function G_AI\.isLocalCar\(car\)/);
  assert.match(luaSrc, /return car ~= nil and me ~= nil and car\.index == me\.index/);
  assert.match(luaSrc, /function G_AI\.canDrive\(car\)/);
  assert.match(luaSrc, /if cfg\.aiPaceDriver ~= 'remote' and not G_AI\.isLocalCar\(car\) then\s*\n\s*return false, 'pas la voiture locale'/);
  // Le refus doit etre journalise une seule fois, avec les index pour diagnostiquer.
  assert.match(luaSrc, /pace car IA : pilotage du client non applique \(%s\)/);
});

test('Mode dry-run : detection et journalisation sans aucun pilotage', () => {
  assert.match(luaSrc, /aiPaceDryRun = 0,/);
  assert.match(luaSrc, /cfg\.aiPaceDryRun = \(tonumber\(cfg\.aiPaceDryRun\) or 0\) ~= 0 and 1 or 0/);
  // En dry-run, canDrive refuse AVANT tout appel a l'autopilote.
  assert.match(luaSrc, /if cfg\.aiPaceDryRun == 1 then return false, 'dry-run' end/);
  // Le log annonce clairement le role, pour savoir qui doit piloter.
  assert.match(luaSrc, /DRY-RUN, aucun controle applique/);
  assert.match(luaSrc, /pilote par ce client \(voiture locale\)/);
  assert.match(luaSrc, /pilotage delegue au client qui la conduit/);
});

test('Le configurateur expose le choix du pilote et le mode test', () => {
  const html = fs.readFileSync(path.join(root, 'race-control.html'), 'utf8');
  assert.match(html, /id="aiPaceDriver"/);
  assert.match(html, /id="aiPaceDryRun"/);
  assert.match(html, /La voiture locale \(recommandé, seul cas fiable\)/);
  assert.match(html, /détecte et journalise seulement/);
});

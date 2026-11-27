'use strict';

// Livraison de la voiture pace car depuis Race Control.
//
// Genere le bloc [CAR_xx] a ajouter dans entry_list.ini du serveur AC, ainsi que
// les options CSP correspondantes. Le fichier du serveur n'est jamais modifie ni
// lu en ecriture : l'administrateur colle le bloc lui-meme, ce qui evite toute
// alteration automatique d'une grille de course.
const AI_PACE_DEFAULTS = Object.freeze({
  model: 'dodge_monaco_police',
  skin: '',
  driverName: 'Pace Car',
  team: 'GDSP Race Control',
  slot: 0,
});

const MODEL_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const SKIN_RE = /^[a-zA-Z0-9_\-=/]{0,120}$/;

function sanitizeModel(value) {
  const v = String(value ?? '').trim();
  return MODEL_RE.test(v) ? v : '';
}

function sanitizeSkin(value) {
  const v = String(value ?? '').trim();
  return SKIN_RE.test(v) ? v : '';
}

// Un skin peut contenir des options CSP du type "skin/base" : seul l'ID de skin
// doit figurer dans SKIN=, les options vont dans un champ separe gere par CM.
function skinId(value) {
  const v = sanitizeSkin(value);
  return v.split('/')[0];
}

function sanitizeSlot(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 999) return fallback;
  return n;
}

/**
 * Bloc entry_list.ini pour la voiture pace car.
 * @param {{model?:string,skin?:string,driverName?:string,team?:string,slot?:number}} input
 * @param {{slot?:number}} [options]
 * @returns {{text:string, slot:number, model:string, valid:boolean, error:string|null}}
 */
function buildEntryBlock(input = {}, options = {}) {
  const rawModel = String(input.model ?? '').trim();
  // Un identifiant fourni mais invalide est refuse : on ne remplace jamais
  // silencieusement la voiture demandee par une autre.
  if (rawModel !== '' && !MODEL_RE.test(rawModel)) {
    return { text: '', slot: 0, model: '', valid: false, error: 'Identifiant de voiture invalide.' };
  }
  const model = rawModel || AI_PACE_DEFAULTS.model;
  if (!MODEL_RE.test(model)) {
    return { text: '', slot: 0, model: '', valid: false, error: 'Identifiant de voiture invalide.' };
  }
  const rawSkin = String(input.skin ?? '').trim();
  if (rawSkin !== '' && !SKIN_RE.test(rawSkin)) {
    return { text: '', slot: 0, model, valid: false, error: 'Skin invalide.' };
  }
  const slot = sanitizeSlot(options.slot ?? input.slot, AI_PACE_DEFAULTS.slot);
  const driverName = String(input.driverName ?? AI_PACE_DEFAULTS.driverName)
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 40) || AI_PACE_DEFAULTS.driverName;
  const team = String(input.team ?? AI_PACE_DEFAULTS.team)
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 40) || AI_PACE_DEFAULTS.team;
  const skin = skinId(rawSkin);

  // AI=fixed : la voiture doit etre conduite par l'IA du jeu et personne ne peut
  // prendre la place. Reconnu par les serveurs derives d'AssettoServer ; ignore
  // (mais sans danger) par le serveur Kunos, qui ne sait pas creer de voiture IA.
  const aiField = input.aiFixed === false ? 'AI=none' : 'AI=fixed';

  const text = [
    `[CAR_${slot}]`,
    `MODEL=${model}`,
    `SKIN=${skin}`,
    'SPECTATOR_MODE=0',
    `DRIVERNAME=${driverName}`,
    `TEAM=${team}`,
    'GUID=',
    'BALLAST=0',
    'RESTRICTOR=0',
    aiField,
  ].join('\n') + '\n';

  const warnings = [];
  if (input.aiFixed === false) {
    warnings.push("Sans AI=fixed, aucun joueur n'occupe la place : la voiture restera immobile au depart.");
  } else {
    warnings.push("AI=fixed n'est pris en compte que par les serveurs derives d'AssettoServer. Sur le serveur Kunos (Content Manager), cette ligne est ignoree : la voiture n'apparaitra pas.");
  }

  return { text, slot, model, valid: true, error: null, warnings };
}

/**
 * Options CSP a ajouter dans csp_extra_options.ini / Extra options CM
 * pour que le script pilote cette voiture.
 */
function buildCspOptions(input = {}) {
  const model = sanitizeModel(input.model) || AI_PACE_DEFAULTS.model;
  const driverName = String(input.driverName ?? AI_PACE_DEFAULTS.driverName)
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 23) || AI_PACE_DEFAULTS.driverName;
  // Aucune ligne de commentaire ici : ce bloc est destine a etre colle dans un
  // fichier INI du serveur AC, ou un '#' n'est pas garanti comme commentaire.
  return [
    '[SCRIPT_1]',
    'SCRIPT=https://gdsp.duckdns.org/csp/rolling_start.lua',
    'aiPaceMode=grid',
    `aiPaceName=${driverName}`,
    `aiPaceModel=${model}`,
  ].join('\n') + '\n';
}

/**
 * Bloc complete de livraison en DEUX parties separees : l'une pour
 * entry_list.ini, l'autre pour csp_extra_options.ini. Melanger les deux dans un
 * seul bloc copie poussait l'administrateur a coller les options CSP dans le
 * mauvais fichier.
 */
function buildDelivery(input = {}, options = {}) {
  const block = buildEntryBlock(input, options);
  if (!block.valid) return { ok: false, error: block.error, entry: '', csp: '', notes: '' };
  const csp = buildCspOptions(input);
  const notes = buildDeliveryNotes(input, options);
  return {
    ok: true,
    entry: block.text,
    csp,
    notes: notes.text,
    slot: block.slot,
    model: block.model,
  };
}

/**
 * Instructions de livraison, en francais, pour l'administrateur.
 */
function buildDeliveryNotes(input = {}, options = {}) {
  const { slot, model, valid, error } = buildEntryBlock(input, options);
  if (!valid) return { ok: false, text: `Impossible de préparer la voiture : ${error}` };
  return {
    ok: true,
    text: [
      '1. Arrête le serveur Assetto Corsa concerné et ferme Content Manager.',
      '2. Ouvre entry_list.ini et ajoute le bloc ci-dessous à la fin.',
      '3. La voiture doit être présente dans "content/cars/" du serveur.',
      `4. Renumérote si besoin : la place doit rester libre ([CAR_${slot}] ici).`,
      '5. Ajoute les options CSP dans csp_extra_options.ini, puis redémarre le serveur.',
      '6. Lance une session d’essai : le pace car doit rouler devant le peloton.',
      '',
      'IMPORTANT — AI=fixed :',
      "  • Sur un serveur dérivé d'AssettoServer (trafic IA), la voiture est conduite",
      "    par l'IA du jeu et personne ne peut prendre la place.",
      "  • Sur le serveur Kunos lancé par Content Manager, le champ AI= est ignoré :",
      "    aucune voiture IA ne peut exister en ligne. Le pace car restera immobile.",
      "  • Le circuit doit avoir une ligne IA (dossier ai/ du circuit), sinon l'IA ne",
      '    peut pas rouler même avec AI=fixed.',
    ].join('\n'),
    model,
    slot,
  };
}

/**
 * Transforme la reponse de /api/server-manager/inventory en liste de choix.
 * L'API renvoie { cars: [{ id, skins: [...] }], tracks: [...] }.
 */
function carChoicesFromInventory(inventory) {
  const cars = Array.isArray(inventory?.cars) ? inventory.cars : [];
  return cars
    .map(car => ({
      id: sanitizeModel(car?.id),
      label: String(car?.id ?? ''),
      skins: Array.isArray(car?.skins) ? car.skins.filter(s => SKIN_RE.test(String(s))).slice(0, 200) : [],
    }))
    .filter(car => car.id !== '')
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

const GDSPPaceCar = {
  AI_PACE_DEFAULTS,
  buildEntryBlock,
  buildCspOptions,
  buildDelivery,
  buildDeliveryNotes,
  carChoicesFromInventory,
  sanitizeModel,
  sanitizeSkin,
  skinId,
};

if (typeof window !== 'undefined') window.GDSPPaceCar = GDSPPaceCar;
if (typeof module !== 'undefined' && module.exports) module.exports = GDSPPaceCar;

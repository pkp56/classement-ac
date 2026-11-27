'use strict';

const DEFAULT_SCRIPT_URL = 'https://gdsp.duckdns.org/csp/rolling_start.lua';
const BOOLEAN_FIELDS = [
  'enabled', 'everySession', 'allowP1Green', 'autoFormation',
  'jumpEnabled', 'jumpRollingCatch',
  'cutEnabled', 'cutEverySession',
];
const FIELD_IDS = [
  'enabled', 'everySession', 'autoFormation', 'formationMode', 'poleSide', 'startLength',
  'formationLaps', 'shortMode', 'shortDistanceM', 'shortGreenSpline', 'shortSec',
  'limiterMode', 'paceKmh', 'catchupKmh', 'fastKmh', 'fastPct', 'slowKmh', 'bunchM', 'targetGapM', 'greenTrigger', 'autoGreenAt', 'allowP1Green',
  'jumpEnabled', 'jumpStandingTolM', 'jumpRollingCatch', 'jumpPenaltyType',
  'jumpStopGoSec', 'jumpServeLaps', 'jumpEscPenalty', 'jumpEscStopGoSec', 'jumpTimePenaltySec',
  'cutEnabled', 'cutEverySession', 'cutWheelsMin', 'cutUseKunosInvalid',
  'cutMinDurationSec', 'cutMinSpeedKmh', 'cutCooldownSec', 'cutMaxBeforePenalty', 'cutRepeatEvery',
  'cutPenaltyType', 'cutStopGoSec', 'cutSlowSec', 'cutServeLaps', 'cutEscPenalty', 'cutEscStopGoSec',
  'cutFinishTimeSec', 'cutTimePenaltySec', 'cutDisabledZones',
  'scFallback', 'safetyCarKey',
  'aiPaceMode', 'aiPaceName', 'aiPaceKmh', 'aiPaceLeadM', 'aiPaceInLap',
];

let presets = [];
let defaults = {};
let cornerZones = []; // [{ name, sStart, sEnd, disabled: true }]

function $(id) { return document.getElementById(id); }

function getConfigFromForm() {
  const cfg = { ...defaults };
  for (const id of FIELD_IDS) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') {
      cfg[id] = el.checked ? 1 : 0;
    } else {
      cfg[id] = el.value;
    }
  }
  return cfg;
}

function parseZonesStringToList(str) {
  const out = [];
  if (!str || !String(str).trim()) return out;
  const parts = String(str).split(',');
  parts.forEach((p, idx) => {
    const m = p.trim().match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (m) {
      out.push({
        name: `Virage #${idx + 1}`,
        sStart: Number(m[1]).toFixed(3),
        sEnd: Number(m[2]).toFixed(3),
        disabled: true,
      });
    }
  });
  return out;
}

function syncZonesInputFromList() {
  const activeDisabled = cornerZones
    .filter((z) => z.disabled)
    .slice(0, 6)
    .map((z) => `${Number(z.sStart).toFixed(3)}-${Number(z.sEnd).toFixed(3)}`);
  $('cutDisabledZones').value = activeDisabled.join(',');
}

function renderZonesList() {
  const box = $('zonesList');
  box.innerHTML = '';
  if (cornerZones.length === 0) {
    box.innerHTML = '<div class="hint">Aucune zone configurée — les cuts sont surveillés sur 100% du circuit.</div>';
    return;
  }
  cornerZones.forEach((z, idx) => {
    const row = document.createElement('div');
    row.className = 'zone-row';

    const nameEl = document.createElement('strong');
    nameEl.textContent = z.name;

    const startEl = document.createElement('span');
    startEl.textContent = `Début: ${z.sStart}`;

    const endEl = document.createElement('span');
    endEl.textContent = `Fin: ${z.sEnd}`;

    const toggleLabel = document.createElement('label');
    toggleLabel.style.display = 'flex';
    toggleLabel.style.alignItems = 'center';
    toggleLabel.style.gap = '6px';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !z.disabled;
    chk.style.width = '15px';
    chk.style.height = '15px';
    const txt = document.createElement('span');
    txt.textContent = z.disabled ? 'Cut OFF' : 'Cut ON';
    txt.style.color = z.disabled ? 'var(--amber)' : 'var(--green)';
    chk.addEventListener('change', () => {
      z.disabled = !chk.checked;
      syncZonesInputFromList();
      renderZonesList();
      generateOutputs();
    });
    toggleLabel.appendChild(chk);
    toggleLabel.appendChild(txt);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = 'Suppr';
    delBtn.addEventListener('click', () => {
      cornerZones.splice(idx, 1);
      syncZonesInputFromList();
      renderZonesList();
      generateOutputs();
    });

    row.appendChild(nameEl);
    row.appendChild(startEl);
    row.appendChild(endEl);
    row.appendChild(toggleLabel);
    row.appendChild(delBtn);
    box.appendChild(row);
  });
}

function setFormFromConfig(cfg) {
  for (const id of FIELD_IDS) {
    const el = $(id);
    if (!el || cfg[id] === undefined) continue;
    if (el.type === 'checkbox') {
      el.checked = Number(cfg[id]) === 1;
    } else {
      el.value = String(cfg[id]);
    }
  }
  cornerZones = parseZonesStringToList(cfg.cutDisabledZones || '');
  renderZonesList();
  updateVisibility();
}

function updateVisibility() {
  const rollingOn = $('enabled').checked;
  const cutOn = $('cutEnabled').checked;
  const jumpOn = $('jumpEnabled').checked;

  $('rollingSettingsBox').classList.toggle('hidden', !rollingOn);
  $('startModeBadge').textContent = rollingOn ? 'DÉPART LANCÉ' : 'DÉPART ARRÊTÉ';
  $('startModeBadge').className = `badge ${rollingOn ? 'badge-blue' : 'badge-ok'}`;

  $('cutSettingsBox').classList.toggle('hidden', !cutOn);
  $('jumpSettingsBox').classList.toggle('hidden', !jumpOn);

  const is2x2 = $('formationMode').value === '2x2';
  const isShort = $('startLength').value === 'short';
  const sm = $('shortMode').value;

  $('poleSideField').classList.toggle('hidden', !is2x2);
  $('formationLapsField').classList.toggle('hidden', isShort);
  $('shortModeField').classList.toggle('hidden', !isShort);
  $('shortDistanceField').classList.toggle('hidden', !isShort || sm !== 'distance');
  $('shortSplineField').classList.toggle('hidden', !isShort || sm !== 'spline');
  $('shortSecField').classList.toggle('hidden', !isShort || sm !== 'timer');

  const maxCuts = Number($('cutMaxBeforePenalty').value || 0);
  $('cutTriggerExplain').textContent = `(pénalité au ${maxCuts + 1}ᵉ cut)`;

  updateSummaryStrip();
}

function updateSummaryStrip() {
  const cfg = getConfigFromForm();
  const strip = $('summaryStrip');
  const badges = [];

  badges.push({
    cls: Number(cfg.enabled) === 1 ? 'badge-blue' : 'badge-ok',
    txt: Number(cfg.enabled) === 1
      ? `Départ Lancé ${cfg.formationMode.toUpperCase()} • ${cfg.paceKmh} km/h`
      : 'Départ Arrêté Standard',
  });
  badges.push({
    cls: Number(cfg.jumpEnabled) === 1 ? 'badge-warn' : 'badge-err',
    txt: Number(cfg.jumpEnabled) === 1
      ? `Faux Départ : ${cfg.jumpPenaltyType} (${cfg.jumpServeLaps}t → ${cfg.jumpEscPenalty})`
      : 'Faux Départ : OFF',
  });
  badges.push({
    cls: Number(cfg.cutEnabled) === 1 ? 'badge-ok' : 'badge-err',
    txt: Number(cfg.cutEnabled) === 1
      ? `Cuts : ${cfg.cutMaxBeforePenalty} tolérés → ${cfg.cutPenaltyType} (${cfg.cutServeLaps}t → ${cfg.cutEscPenalty} | fin +${cfg.cutFinishTimeSec}s)`
      : 'Pénalités Cut : OFF',
  });

  strip.replaceChildren(...badges.map((b) => { const el = document.createElement('span'); el.className = 'badge ' + b.cls; el.textContent = b.txt; return el; }));
}

let pendingTimer = null;
function scheduleGenerate() {
  updateVisibility();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(generateOutputs, 100);
}

let motdGeneration = 0;
async function updateMotd(ini, generation) {
  const output = $('motdOut'), badge = $('motdSizeBadge'), error = $('motdError'), button = $('copyMotdBtn');
  output.value = ''; button.disabled = true; badge.textContent = 'Génération…'; error.textContent = '';
  if (!ini) { badge.textContent = 'Configuration invalide'; return; }
  try {
    const welcome = $('welcomeText').value.trimEnd();
    if (welcome.includes('$CSP0:')) throw new Error('Le message d’accueil ne doit pas contenir $CSP0:.');
    if (typeof CompressionStream !== 'function') throw new Error('Ce navigateur ne permet pas la génération MOTD. Utilise une version récente de Chrome ou Edge.');
    const compressed = new Blob([new TextEncoder().encode(ini)]).stream().pipeThrough(new CompressionStream('deflate'));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const motd = welcome + '\t'.repeat(32) + '$CSP0:' + btoa(binary).replace(/=+$/, '');
    if (generation !== motdGeneration) return;
    const size = new TextEncoder().encode(motd).length;
    output.value = motd; badge.textContent = `${size} / 2039 octets`;
    badge.className = 'badge ' + (size > 2039 ? 'badge-err' : (size > 1750 ? 'badge-warn' : 'badge-ok'));
    button.disabled = size > 2039;
    if (size > 2039) error.textContent = 'MOTD trop long : réduis le message ou les réglages avant de copier.';
  } catch (e) {
    if (generation !== motdGeneration) return;
    badge.textContent = 'MOTD indisponible'; error.textContent = e.message;
  }
}

function generateOutputs() {
  const generation = ++motdGeneration;
  const output = $('iniOut');
  const error = $('configError');
  try {
    const scriptUrl = $('scriptUrl').value.trim();
    if (!scriptUrl || /[\s\x00-\x1f]/.test(scriptUrl)) throw new Error('Saisis une URL HTTP ou HTTPS valide, sans espace.');
    const url = new URL(scriptUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Saisis une URL HTTP ou HTTPS valide, sans identifiants.');
    output.value = GDSPRaceEncoder.buildCspExtraOptionsIni(getConfigFromForm(), {scriptUrl, compact:false});
    error.textContent = '';
  } catch (e) {
    output.value = '';
    error.textContent = e.message;
  }
  updateMotd(output.value, generation);
}

function renderPresets() {
  const bar = $('presetsBar');
  bar.innerHTML = '';
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.type = 'button';
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setFormFromConfig({ ...defaults, ...p.values });
      generateOutputs();
    });
    bar.appendChild(btn);
  }
}

async function copyText(elId, btnId) {
  const txt = $(elId).value;
  try {
    await navigator.clipboard.writeText(txt);
    const btn = $(btnId);
    const orig = btn.textContent;
    btn.textContent = 'Copié !';
    setTimeout(() => { btn.textContent = orig; }, 1400);
  } catch {
    $(elId).select();
    document.execCommand('copy');
  }
}

async function init() {
  $('scriptUrl').value = DEFAULT_SCRIPT_URL;
  defaults = GDSPRaceEncoder.CFG_DEFAULTS;
  presets = GDSPRaceEncoder.PRESETS;
  renderPresets();
  setFormFromConfig(defaults);

  for (const id of FIELD_IDS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      if (id === 'cutDisabledZones') {
        cornerZones = parseZonesStringToList(el.value);
        renderZonesList();
      }
      scheduleGenerate();
    });
    el.addEventListener('change', scheduleGenerate);
  }
  $('scriptUrl').addEventListener('input', scheduleGenerate);
  $('welcomeText').addEventListener('input', scheduleGenerate);

  $('addZoneBtn').addEventListener('click', () => {
    const name = ($('zoneNameInput').value || '').trim() || `Virage #${cornerZones.length + 1}`;
    const sStart = Math.max(0, Math.min(0.999, Number($('zoneStartInput').value || 0))).toFixed(3);
    const sEnd = Math.max(0, Math.min(0.999, Number($('zoneEndInput').value || 0.05))).toFixed(3);
    cornerZones.push({ name, sStart, sEnd, disabled: true });
    syncZonesInputFromList();
    renderZonesList();
    generateOutputs();
  });

  $('copyIniBtn').addEventListener('click', () => copyText('iniOut', 'copyIniBtn'));
  $('copyMotdBtn').addEventListener('click', () => { if (!$('copyMotdBtn').disabled) copyText('motdOut', 'copyMotdBtn'); });
  generateOutputs();
}

init();

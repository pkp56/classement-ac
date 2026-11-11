'use strict';

// URL publique (GitHub) : les pilotes distants chargent le script sans ouvrir le port 3080.
// A remplacer par 'main' apres fusion de la branche.
const DEFAULT_SCRIPT_URL = 'https://raw.githubusercontent.com/pkp56/classement-ac/arena/7b28d07f-classement-ac/rolling-start/csp/gdsp_rolling_start.lua';
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

  strip.innerHTML = badges.map((b) => `<span class="badge ${b.cls}">${b.txt}</span>`).join('');
}

let pendingTimer = null;
function scheduleGenerate() {
  updateVisibility();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(generateOutputs, 100);
}

async function generateOutputs() {
  const cfg = getConfigFromForm();
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: cfg,
      scriptUrl: $('scriptUrl').value.trim() || DEFAULT_SCRIPT_URL,
      welcomeText: $('welcomeText').value,
    }),
  });
  if (!res.ok) return;
  const data = await res.json();
  $('motdOut').value = data.motd || '';
  $('iniOut').value = data.iniSnippet || '';
  $('urlOut').value = data.scriptUrlWithOverrides || '';

  const badge = $('motdSizeBadge');
  badge.textContent = `${data.byteLength} / 2039 octets`;
  badge.className = 'badge ' + (!data.withinLimit ? 'badge-err' : (data.byteLength > 1750 ? 'badge-warn' : 'badge-ok'));

  const localPreset = presets.find((p) => p.id === 'test_local_solo');
  const localBase = { ...defaults, ...(localPreset ? localPreset.values : {}) };
  const packParams = new URLSearchParams();
  for (const [k, v] of Object.entries(cfg)) {
    if (String(v) !== String(localBase[k])) {
      packParams.set(k, String(v));
    }
  }
  const activeUrl = $('scriptUrl').value.trim();
  if (activeUrl && activeUrl !== DEFAULT_SCRIPT_URL && activeUrl !== 'http://127.0.0.1:3080/gdsp_rolling_start.lua') {
    packParams.set('scriptUrl', activeUrl);
  }
  const packQs = packParams.toString();
  const packHref = `/cm-app/GDSP_LocalTestPack.zip${packQs ? `?${packQs}` : ''}`;
  const fullPackUrl = `${window.location.origin}${packHref}`;
  if ($('downloadLocalPackLink')) $('downloadLocalPackLink').href = packHref;
  if ($('downloadLocalPackCardLink')) $('downloadLocalPackCardLink').href = packHref;
  updateDownloadHelper(fullPackUrl, 'GDSP_LocalTestPack.zip');
}

function updateDownloadHelper(fullUrl, fileName = 'GDSP_LocalTestPack.zip') {
  if ($('directZipUrlInput')) $('directZipUrlInput').value = fullUrl;
  if ($('helperOpenTabLink')) $('helperOpenTabLink').href = fullUrl;
  if ($('psDownloadCmdInput')) {
    $('psDownloadCmdInput').value = `Invoke-WebRequest -Uri "${fullUrl}" -OutFile "$env:USERPROFILE\\Desktop\\${fileName}"`;
  }
}

async function triggerSafeDownload(e, anchorEl, fileName) {
  const href = anchorEl.getAttribute('href');
  const fullUrl = new URL(href, window.location.origin).toString();
  updateDownloadHelper(fullUrl, fileName);
  if ($('downloadHelperBanner')) $('downloadHelperBanner').classList.remove('hidden');

  if (window.self !== window.top) {
    // In sandboxed preview iframes, Blob downloads can be blocked; try Blob + fallback new tab
    e.preventDefault();
    try {
      const resp = await fetch(fullUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const tmp = document.createElement('a');
        tmp.href = blobUrl;
        tmp.download = fileName;
        tmp.style.display = 'none';
        document.body.appendChild(tmp);
        tmp.click();
        tmp.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      }
    } catch {
      // Fallback below
    }
    try {
      window.open(fullUrl, '_blank', 'noopener');
    } catch {
      // Helper banner stays visible with copyable URL & PowerShell command
    }
  }
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

async function decodeMotd() {
  const motd = $('decodeIn').value;
  const res = await fetch('/api/decode-motd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motd }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    $('decodeOut').value = `Erreur : ${data.error || 'invalide'}`;
    return;
  }
  $('decodeOut').value = `${data.iniText}\n\n--- Welcome ---\n${data.visibleText}`;
}

async function init() {
  $('scriptUrl').value = DEFAULT_SCRIPT_URL;
  const res = await fetch('/api/presets');
  const data = await res.json();
  defaults = data.defaults || {};
  presets = data.presets || [];
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

  $('copyMotdBtn').addEventListener('click', () => copyText('motdOut', 'copyMotdBtn'));
  $('copyIniBtn').addEventListener('click', () => copyText('iniOut', 'copyIniBtn'));
  $('copyUrlBtn').addEventListener('click', () => copyText('urlOut', 'copyUrlBtn'));
  $('decodeBtn').addEventListener('click', decodeMotd);
  if ($('copyDirectZipUrlBtn')) $('copyDirectZipUrlBtn').addEventListener('click', () => copyText('directZipUrlInput', 'copyDirectZipUrlBtn'));
  if ($('copyPsDownloadBtn')) $('copyPsDownloadBtn').addEventListener('click', () => copyText('psDownloadCmdInput', 'copyPsDownloadBtn'));

  [
    ['downloadLocalPackLink', 'GDSP_LocalTestPack.zip'],
    ['downloadLocalPackCardLink', 'GDSP_LocalTestPack.zip'],
    ['downloadCmAppLink', 'GDSP_RollingStart.zip'],
    ['downloadLuaLink', 'rolling_start.lua'],
  ].forEach(([id, fname]) => {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => triggerSafeDownload(e, el, fname));
  });

  if (window.self !== window.top && $('downloadHelperBanner')) {
    $('downloadHelperBanner').classList.remove('hidden');
  }
  if ($('presetLocalSamePcBtn')) {
    $('presetLocalSamePcBtn').addEventListener('click', () => {
      $('scriptUrl').value = 'http://127.0.0.1:3080/gdsp_rolling_start.lua';
      const localPreset = presets.find((p) => p.id === 'test_local_solo');
      if (localPreset) setFormFromConfig({ ...defaults, ...localPreset.values });
      generateOutputs();
    });
  }
  if ($('presetLocalLanBtn')) {
    $('presetLocalLanBtn').addEventListener('click', () => {
      const ip = window.prompt('Entrez l\'IP locale du PC qui héberge LANCER_SERVEUR_LOCAL.bat (ex: 192.168.1.50)', '192.168.1.50');
      if (!ip) return;
      $('scriptUrl').value = `http://${ip.trim()}:3080/gdsp_rolling_start.lua`;
      const localPreset = presets.find((p) => p.id === 'test_local_solo');
      if (localPreset) setFormFromConfig({ ...defaults, ...localPreset.values });
      generateOutputs();
    });
  }
  if ($('presetLocalDuckBtn')) {
    $('presetLocalDuckBtn').addEventListener('click', () => {
      const host = window.prompt('Entrez votre domaine DuckDNS (ex: monserveur.duckdns.org)', 'monserveur.duckdns.org');
      if (!host) return;
      const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
      $('scriptUrl').value = `http://${cleanHost}:3080/gdsp_rolling_start.lua`;
      const localPreset = presets.find((p) => p.id === 'test_local_solo');
      if (localPreset) setFormFromConfig({ ...defaults, ...localPreset.values });
      generateOutputs();
    });
  }

  await generateOutputs();
}

init();

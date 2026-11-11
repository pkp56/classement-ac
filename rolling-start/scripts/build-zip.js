#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'cm-app', 'GDSP_RollingStart');
const CSP_SCRIPT_PATH = path.join(ROOT, 'csp', 'gdsp_rolling_start.lua');
const OUT_DIR = path.join(ROOT, 'packages');
const OUT_ZIP = path.join(OUT_DIR, 'GDSP_RollingStart.zip');
const OUT_LOCAL_PACK_ZIP = path.join(OUT_DIR, 'GDSP_LocalTestPack.zip');
const encoder = require('../lib/csp-encoder');

const APP_FILES = [
  'manifest.ini',
  'icon.png',
  'rs_protocol.lua',
  'rs_hud.lua',
  'rs_admin.lua',
  'GDSP_RollingStart.lua',
];

// Deterministic CRC-32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Fixed DOS timestamp: 2026-01-01 00:00:00
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.zipPath, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;

    const localHdr = Buffer.alloc(30 + nameBuf.length);
    localHdr.writeUInt32LE(0x04034b50, 0); // local file header sig
    localHdr.writeUInt16LE(20, 4);         // version needed
    localHdr.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt16LE(dosTime, 10);
    localHdr.writeUInt16LE(dosDate, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(payload.length, 18);
    localHdr.writeUInt32LE(raw.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);
    nameBuf.copy(localHdr, 30);

    localParts.push(localHdr, payload);

    const centralHdr = Buffer.alloc(46 + nameBuf.length);
    centralHdr.writeUInt32LE(0x02014b50, 0); // central dir sig
    centralHdr.writeUInt16LE(0x031e, 4);     // version made by
    centralHdr.writeUInt16LE(20, 6);         // version needed
    centralHdr.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHdr.writeUInt16LE(method, 10);
    centralHdr.writeUInt16LE(dosTime, 12);
    centralHdr.writeUInt16LE(dosDate, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(payload.length, 20);
    centralHdr.writeUInt32LE(raw.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE((0o100644 << 16) >>> 0, 38); // attributs Unix : fichier rw-r--r--
    centralHdr.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHdr, 46);

    centralParts.push(centralHdr);
    offset += localHdr.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function buildPackage() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = APP_FILES.map((file) => {
    const abs = path.join(SRC_DIR, file);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing CM app file: ${abs}`);
    }
    return {
      zipPath: `apps/lua/GDSP_RollingStart/${file}`,
      data: fs.readFileSync(abs),
    };
  });
  const zipBuf = buildZipBuffer(entries);
  fs.writeFileSync(OUT_ZIP, zipBuf);
  return { outZip: OUT_ZIP, size: zipBuf.length, files: entries.map((e) => e.zipPath) };
}

function buildLocalTestPackBuffer(queryObj = {}) {
  if (!fs.existsSync(OUT_ZIP)) {
    buildPackage();
  }
  const cloned = Object.assign({}, queryObj);
  const localUrl = (typeof cloned.scriptUrl === 'string' && cloned.scriptUrl.trim())
    ? cloned.scriptUrl.trim()
    : 'http://127.0.0.1:3080/gdsp_rolling_start.lua';
  delete cloned.scriptUrl;
  const testPreset = encoder.PRESETS.find((p) => p.id === 'test_local_solo');
  const baseLocalCfg = Object.assign({}, encoder.CFG_DEFAULTS, testPreset ? testPreset.values : {}, cloned);
  const cfg = encoder.sanitizeConfig(baseLocalCfg);
  const rawLua = fs.readFileSync(CSP_SCRIPT_PATH, 'utf8');
  // Pas de QUERY_OVERRIDES figes : la table ecrasait le [SCRIPT_1] du serveur (cuts, startLength...).
  // Le script lit uniquement la config du serveur (ac.configValues).
  const bakedLua = rawLua;
  const iniLocal = encoder.buildCspExtraOptionsIni(cfg, { scriptUrl: localUrl, compact: false });
  const compactIniLocal = encoder.buildCspExtraOptionsIni(cfg, { scriptUrl: localUrl, compact: true });
  const motdLocal = encoder.buildMotdPayload({
    welcomeText: 'GDSP Race Control (Test Serveur Local) — !yellow / !green / !rshud',
    iniText: compactIniLocal,
  });

  const miniHttpServerJs = fs.readFileSync(path.join(__dirname, 'local-http-template.cjs'), 'utf8');

  const batRunner = [
    '@echo off',
    'title GDSP Race Control — Serveur Script Local (port 3080)',
    'cd /d "%~dp0"',
    'where node >nul 2>nul',
    'if %errorlevel%==0 (',
    '  node gdsp_local_http.cjs',
    '  goto :end',
    ')',
    'where python >nul 2>nul',
    'if %errorlevel%==0 (',
    '  echo Serveur HTTP Python sur http://127.0.0.1:3080/gdsp_rolling_start.lua',
    '  python -m http.server 3080 --bind 0.0.0.0',
    '  goto :end',
    ')',
    'where py >nul 2>nul',
    'if %errorlevel%==0 (',
    '  echo Serveur HTTP Python (py -3) sur http://127.0.0.1:3080/gdsp_rolling_start.lua',
    '  py -3 -m http.server 3080 --bind 0.0.0.0',
    '  goto :end',
    ')',
    'echo Installez Node.js (nodejs.org) ou Python 3 pour servir le script HTTP sur le port 3080.',
    ':end',
    'pause',
    '',
  ].join('\r\n');

  const readmeLocal = [
    'GDSP RACE CONTROL — GUIDE RAPIDE DE TEST SUR SERVEUR LOCAL',
    '===========================================================',
    '',
    '1. INSTALLER L\'APP CONTENT MANAGER',
    '   - Glissez-deposez "GDSP_RollingStart.zip" dans Content Manager (puis cochez-la dans Apps / Lua).',
    '',
    '2. DEMARRER LE PETIT SERVEUR SCRIPT LOCAL (POUR TELECHARGER LE LUA EN JEU)',
    '   - Double-cliquez sur "LANCER_SERVEUR_LOCAL.bat".',
    '   - Si vous testez sur le MEME PC (serveur + jeu sur le meme PC) : utilisez http://127.0.0.1:3080/gdsp_rolling_start.lua',
    '   - Si votre serveur tourne sur un 2e PC du reseau ou avec des amis : remplacez 127.0.0.1 par l\'IP affichee dans la fenetre noire (ex: 192.168.1.XX:3080) et ouvrez 3080 TCP, 9600 TCP/UDP, 8081 TCP.',
    '',
    '3. CONFIGURER VOTRE SERVEUR ASSETTO CORSA',
    '   - Option A (CSP Extra Options) : collez le contenu de "csp_extra_options_LOCAL.ini" dans votre fichier csp_extra_options.ini (ou Content Manager > Server > Custom / CSP Options).',
    '   - Option B (MOTD $CSP0:) : collez le contenu de "motd_CSP0_LOCAL.txt" dans le champ MOTD / Welcome Message de votre serveur.',
    '   - Astuce Admin : mettez un mot de passe admin dans Content Manager Server (ex: admin) puis en jeu tapez "/admin VotreMotDePasse" dans le chat pour tester les droits admin.',
    '',
    '4. SCENARIOS DE TEST RAPIDES EN JEU (Essais ou Course)',
    '   - HUD Pilote & Compteur Cuts : chaque element du HUD est deplacable a la souris et redimensionnable (coin bas-droit / molette / !rshud).',
    '   - Depart Lance 2x2 court (300 m) : cochez Course ou tapez "!yellow" puis "!green" dans le chat (ou boutons Race Control).',
    '   - Cuts : sortez 4 roues hors piste 2 fois -> avertissements -> 3e cut = Drive-Through.',
    '   - Safety Car vs Pilote : connectez-vous avec une voiture ayant "safety" dans son ID/nom -> bouton "Peloton Cuts" visible ; en voiture normale -> seul le compteur discret "Cuts : X/2" est visible.',
    '   - Designer un commissaire live : "!rs steward NomPilote" ou "!rs steward off".',
  ].join('\r\n');

  return buildZipBuffer([
    { zipPath: 'GDSP_RollingStart.zip', data: fs.readFileSync(OUT_ZIP) },
    { zipPath: 'gdsp_rolling_start.lua', data: Buffer.from(bakedLua, 'utf8') },
    { zipPath: 'gdsp_local_http.cjs', data: Buffer.from(miniHttpServerJs, 'utf8') },
    { zipPath: 'lib/csp-encoder.js', data: fs.readFileSync(path.join(ROOT, 'lib', 'csp-encoder.js')) },
    { zipPath: 'web/index.html', data: fs.readFileSync(path.join(ROOT, 'server', 'public', 'index.html')) },
    { zipPath: 'web/app.js', data: fs.readFileSync(path.join(ROOT, 'server', 'public', 'app.js')) },
    { zipPath: 'web/assets/gdsp-logo.png', data: fs.readFileSync(path.join(ROOT, 'server', 'public', 'assets', 'gdsp-logo.png')) },
    { zipPath: 'LANCER_SERVEUR_LOCAL.bat', data: Buffer.from(batRunner, 'utf8') },
    { zipPath: 'csp_extra_options_LOCAL.ini', data: Buffer.from(iniLocal, 'utf8') },
    { zipPath: 'motd_CSP0_LOCAL.txt', data: Buffer.from(motdLocal.motd, 'utf8') },
    { zipPath: 'LISEZMOI_TEST_LOCAL.txt', data: Buffer.from(readmeLocal, 'utf8') },
  ]);
}

function buildLocalTestPackPackage(queryObj = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipBuf = buildLocalTestPackBuffer(queryObj);
  fs.writeFileSync(OUT_LOCAL_PACK_ZIP, zipBuf);
  return { outZip: OUT_LOCAL_PACK_ZIP, size: zipBuf.length };
}

if (require.main === module) {
  const res = buildPackage();
  const localRes = buildLocalTestPackPackage();
  console.log(`Built ${res.outZip} (${res.size} bytes, ${res.files.length} files)`);
  console.log(`Built ${localRes.outZip} (${localRes.size} bytes)`);
}

module.exports = {
  buildPackage,
  buildLocalTestPackBuffer,
  buildLocalTestPackPackage,
  buildZipBuffer,
  APP_FILES,
};

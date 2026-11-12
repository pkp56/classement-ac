#!/usr/bin/env node
'use strict';
/*
 * Inscrit les deux lignes de plugin UDP dans un server_cfg.ini d'Assetto Corsa.
 *
 * C'est ce qui manque quand on lance son serveur depuis Content Manager : le
 * live timing a besoin de
 *
 *   UDP_PLUGIN_ADDRESS    = 127.0.0.1:12000
 *   UDP_PLUGIN_LOCAL_PORT = 12001
 *
 * dans la section [SERVER], et CM n'a pas de case dédiée (elles sont effacées
 * quand le preset est réenregistré).
 *
 * Le script modifie le fichier EN PLACE, après avoir fait une sauvegarde
 * server_cfg.ini.bak (jamais écrasée ensuite) et affiche exactement ce qui a
 * changé. Réexécutable sans risque : les lignes existantes sont mises à jour,
 * les sections ne sont pas touchées.
 *
 * Usage :
 *   node tools/live-timing/set-plugin-ports.js "C:\...\server\cfg\server_cfg.ini"
 *   node tools/live-timing/set-plugin-ports.js --check <fichier>   (ne modifie rien)
 *   node tools/live-timing/set-plugin-ports.js --find              (cherche acServer.exe)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LISTEN = '127.0.0.1:12000'; // UDP_PLUGIN_ADDRESS (le serveur y envoie)
const DEFAULT_LOCAL = '12001';            // UDP_PLUGIN_LOCAL_PORT (le serveur y écoute)

function readIni(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}


/** Positionne les deux clés dans [SERVER] et rend {text, changes[]}. */
function patchIni(text, opts = {}) {
  const address = opts.address || DEFAULT_LISTEN;
  const localPort = String(opts.localPort || DEFAULT_LOCAL);
  const lines = text.split('\n');
  const changes = [];
  let inServer = false;
  let serverStart = -1;
  let seenAddress = false;
  let seenLocal = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      // On referme la section précédente : si [SERVER] est terminée et qu'il
      // manquait des clés, on les ajoute à la fin de cette section (avant la
      // ligne vide qui la sépare de la suivante, pour rester lisible).
      if (inServer && (!seenAddress || !seenLocal)) {
        const inserts = [];
        if (!seenAddress) inserts.push(`UDP_PLUGIN_ADDRESS=${address}`);
        if (!seenLocal) inserts.push(`UDP_PLUGIN_LOCAL_PORT=${localPort}`);
        let at = i;
        while (at > 0 && lines[at - 1].trim() === '' && at > serverStart + 1) at--;
        lines.splice(at, 0, ...inserts);
        changes.push(...inserts.map(l => `+ ${l}`));
        i += inserts.length;
        seenAddress = seenLocal = true;
      }
      inServer = section[1].trim().toUpperCase() === 'SERVER';
      if (inServer) serverStart = i;
      continue;
    }
    if (!inServer) continue;
    const kv = /^\s*(UDP_PLUGIN_ADDRESS|UDP_PLUGIN_LOCAL_PORT)\s*=\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1].toUpperCase();
    const wanted = key === 'UDP_PLUGIN_ADDRESS' ? address : localPort;
    const current = kv[2].trim();
    if (key === 'UDP_PLUGIN_ADDRESS') seenAddress = true; else seenLocal = true;
    if (current !== wanted) {
      lines[i] = `${key}=${wanted}`;
      changes.push(`~ ${key}: ${current || '(vide)'} → ${wanted}`);
    }
  }

  // Section [SERVER] en fin de fichier.
  if (inServer && (!seenAddress || !seenLocal)) {
    const inserts = [];
    if (!seenAddress) inserts.push(`UDP_PLUGIN_ADDRESS=${address}`);
    if (!seenLocal) inserts.push(`UDP_PLUGIN_LOCAL_PORT=${localPort}`);
    lines.push(...inserts);
    changes.push(...inserts.map(l => `+ ${l}`));
    seenAddress = seenLocal = true;
  }

  // Aucune section [SERVER] : fichier inattendu, on n'invente rien.
  if (serverStart === -1) return { text, changes: [], error: 'section [SERVER] introuvable' };

  return { text: lines.join('\n'), changes };
}

/** Cherche un server_cfg.ini à partir d'un dossier (profondeur limitée). */
function findServerCfg(startDir, depth = 4) {
  const results = [];
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && /^server_cfg\.ini$/i.test(e.name)) results.push(full);
      else if (e.isDirectory() && !/^(node_modules|\.git)$/i.test(e.name)) walk(full, level + 1);
    }
  };
  walk(startDir, 0);
  return results;
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const find = args.includes('--find');
  const positional = args.filter(a => !a.startsWith('--'));

  let file = positional[0] || '';
  if (!file && find) {
    const candidates = findServerCfg(path.join(os.homedir(), 'Documents'), 5)
      .concat(findServerCfg(process.cwd(), 5));
    if (!candidates.length) {
      console.error('Aucun server_cfg.ini trouvé. Donne le chemin en argument :');
      console.error('  node tools/live-timing/set-plugin-ports.js "C:\\...\\server\\cfg\\server_cfg.ini"');
      return 2;
    }
    file = candidates[0];
    console.log(`Trouvé : ${file}`);
    if (candidates.length > 1) {
      console.log('Autres trouvés (non modifiés) :');
      for (const c of candidates.slice(1)) console.log(`  ${c}`);
    }
  }
  if (!file) {
    console.error('Usage : node tools/live-timing/set-plugin-ports.js <server_cfg.ini> [--check]');
    return 2;
  }
  file = path.resolve(file);
  if (!fs.existsSync(file)) {
    console.error(`Fichier introuvable : ${file}`);
    return 2;
  }

  const before = readIni(file);
  const { text, changes, error } = patchIni(before);
  if (error) {
    console.error(`✗ ${error} dans ${file}`);
    console.error("  Ce fichier n'est peut-être pas un server_cfg.ini. Rien n'a été modifié.");
    return 1;
  }

  if (!changes.length) {
    console.log(`✓ ${file} est déjà correct (UDP_PLUGIN_ADDRESS=${DEFAULT_LISTEN}, UDP_PLUGIN_LOCAL_PORT=${DEFAULT_LOCAL}).`);
    return 0;
  }

  console.log(`Fichier : ${file}`);
  for (const c of changes) console.log(`  ${c}`);
  if (check) {
    console.log('(--check : aucune modification écrite)');
    return 0;
  }

  const backup = file + '.bak';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before);
  // On garde les fins de ligne d'origine (CRLF sous Windows) : acServer les lit,
  // mais un fichier mixte est pénible à éditer ensuite.
  const out = /\r\n/.test(fs.readFileSync(file, 'utf8')) ? text.replace(/\n/g, '\r\n') : text;
  fs.writeFileSync(file, out);
  console.log(`✓ Écrit. Sauvegarde d'origine : ${path.basename(backup)}`);
  console.log('  Redémarre acServer pour que les deux ports soient pris en compte.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { patchIni, findServerCfg, DEFAULT_LISTEN, DEFAULT_LOCAL };

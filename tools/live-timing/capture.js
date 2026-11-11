#!/usr/bin/env node
'use strict';
/*
 * Enregistre une capture de /INFO et /ENTRY d'un serveur Assetto Corsa.
 *
 * Utilité : certains serveurs dédiés répondent à un PC ou à un navigateur mais
 * coupent la connexion des adresses de datacenter (ECONNRESET). Le site hébergé
 * ne peut alors pas lire le serveur lui-même. On lance ce script sur un PC qui
 * le voit, et on publie la capture : la page /live-timing l'affiche en le
 * signalant clairement comme « capture enregistrée » et non comme du direct.
 *
 * Usage :
 *   node tools/live-timing/capture.js http://82.66.165.242:16835
 *   node tools/live-timing/capture.js <lien acstuff.club> -o data/live-mirror.json
 *   node tools/live-timing/capture.js <url> --watch 5   (rafraîchit toutes les 5 s)
 *
 * Ensuite, côté site : LIVE_MIRROR_FILE=data/live-mirror.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const NAVIGATOR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'identity',
  Connection: 'close'
};

/** Accepte une URL, un « ip:port » ou un lien acstuff.club. */
function normalizeSource(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  const acstuff = /[?&]ip=([^&]+)(?:[^#]*?[?&]httpPort=(\d+))?/i.exec(v);
  if (acstuff) {
    const ip = decodeURIComponent(acstuff[1]);
    const port = acstuff[2];
    v = `http://${ip}${port ? ':' + port : ''}`;
  }
  // Un autre schéma (ftp:, ws:…) n'est pas un serveur AC : on refuse au lieu
  // de fabriquer « http://ftp » par accident.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/^https?:\/\//i.test(v)) return null;
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin.replace(/\/+$/, '');
  } catch (e) {
    return null;
  }
}

function fetchText(base, urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, base);
    const proto = target.protocol === 'https:' ? https : http;
    const req = proto.get(target, { timeout: timeoutMs, headers: NAVIGATOR_HEADERS, rejectUnauthorized: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} sur ${urlPath}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`délai dépassé sur ${urlPath}`)));
    req.on('error', reject);
  });
}

async function captureOnce(url) {
  const infoText = await fetchText(url, '/INFO').catch(() => null);
  const entryHtml = await fetchText(url, '/ENTRY');
  let info = null;
  if (infoText) {
    try { info = JSON.parse(infoText); } catch (e) { info = null; }
  }
  return {
    capturedAt: new Date().toISOString(),
    sourceUrl: url,
    acstuffUrl: null,
    info,
    entryHtml,
    note: "Capture reelle de /INFO et /ENTRY enregistree pour etre rejouee par le site."
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const flags = { out: 'data/live-mirror.json', watch: 0 };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') flags.out = args[++i];
    else if (a === '--watch') flags.watch = Number(args[++i] || 0) || 0;
    else if (a === '-h' || a === '--help') {
      console.log('Usage : node tools/live-timing/capture.js <url|ip:port|lien acstuff> [-o fichier] [--watch secondes]');
      return 0;
    } else positional.push(a);
  }
  const rawSource = positional[0] || process.env.CAPTURE_URL || '';
  const url = normalizeSource(rawSource);
  if (!url) {
    console.error('Source invalide. Exemple : node tools/live-timing/capture.js http://82.66.165.242:16835');
    return 2;
  }
  const outPath = path.resolve(process.cwd(), flags.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const write = async () => {
    try {
      const data = await captureOnce(url);
      if (/acstuff\.club/i.test(rawSource)) data.acstuffUrl = rawSource;
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
      const name = data.info && data.info.name ? data.info.name : '(nom inconnu)';
      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] capture OK — ${name} — ${url} → ${flags.out}`);
      return true;
    } catch (err) {
      const hint = /ECONNRESET|EPIPE|socket hang up/i.test(err.message)
        ? "le serveur coupe la connexion (filtrage d'IP ?) : essaie depuis un PC sur une connexion grand public"
        : /ECONNREFUSED/.test(err.message)
          ? 'rien n\'écoute sur ce port : serveur arrêté ou HTTP_PORT non redirigé'
          : /délai dépassé|ETIMEDOUT/.test(err.message) ? 'pas de réponse dans le délai' : '';
      console.error(`capture impossible — ${err.message}${hint ? ' → ' + hint : ''}`);
      return false;
    }
  };

  const ok = await write();
  if (flags.watch > 0) {
    console.log(`Rafraîchissement toutes les ${flags.watch} s (Ctrl+C pour arrêter).`);
    const timer = setInterval(write, flags.watch * 1000);
    if (timer.unref) timer.unref();
    await new Promise(() => {});
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv).then(code => process.exit(code)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { normalizeSource, captureOnce };

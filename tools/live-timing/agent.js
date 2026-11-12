#!/usr/bin/env node
'use strict';
/*
 * Agent « live timing » à faire tourner sur le PC qui héberge le serveur AC.
 *
 * Il lit les paquets ACSP d'acServer (comme le collecteur du site), puis pousse
 * un instantané JSON vers le site hébergé (Render ou autre), une fois par
 * seconde. Aucun port entrant à ouvrir, aucune IP publique à connaître : c'est
 * le PC qui sort.
 *
 *   SITE_URL       URL du site             (ex. https://classement-ac-1.onrender.com)
 *   PUSH_TOKEN     secret partagé          (même valeur que sur le site)
 *   AC_HOST        127.0.0.1
 *   AC_LISTEN_PORT 12000   (= UDP_PLUGIN_ADDRESS)
 *   AC_PLUGIN_PORT 12001   (= UDP_PLUGIN_LOCAL_PORT)
 *   AC_HTTP_URL    http://127.0.0.1:8081   (facultatif)
 *   PUSH_INTERVAL_MS 1000
 *
 * Variante « veille » : si WATCH_URL est défini (ex. un serveur public qu'on ne
 * possède pas, http://82.66.165.242:16835), l'agent n'écoute plus l'UDP mais
 * interroge /INFO + /ENTRY de ce serveur et pousse le résultat. Utile quand le
 * serveur refuse les connexions venant d'un datacenter (Render) mais accepte
 * celles d'une box.
 *
 * Démarrage : node tools/live-timing/agent.js
 */

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { LiveTimingCollector } = require('./collector');
const { RemoteHttpSource } = require('./http-source');

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const SITE_URL = String(process.env.SITE_URL || process.env.GDSP_SITE_URL || '').replace(/\/+$/, '');
const PUSH_TOKEN = String(process.env.PUSH_TOKEN || '');
const PUSH_PATH = process.env.PUSH_PATH || '/api/live/push';
const INTERVAL_MS = envInt('PUSH_INTERVAL_MS', 1000);

if (!SITE_URL) {
  console.error('✗ SITE_URL manquant. Exemple :\n  SITE_URL=https://classement-ac-1.onrender.com PUSH_TOKEN=secret node tools/live-timing/agent.js');
  process.exit(1);
}
if (!PUSH_TOKEN) {
  console.error('✗ PUSH_TOKEN manquant (doit être identique à LIVE_PUSH_TOKEN côté site).');
  process.exit(1);
}

const WATCH_URL = String(process.env.WATCH_URL || '').replace(/\/+$/, '');
// Deux modes : écoute UDP d'acServer (par défaut) ou lecture HTTP d'un serveur
// distant (WATCH_URL), dans les deux cas on pousse le résultat au site.
const watcher = WATCH_URL
  ? new RemoteHttpSource({ url: WATCH_URL, intervalMs: Math.max(500, INTERVAL_MS) })
  : null;
const collector = watcher ? null : new LiveTimingCollector({ autoStart: true });
if (watcher) watcher.start();
let sending = false;
let failures = 0;
let idleWarned = false;
let lastOkAt = 0;
let stopping = false;

function post(payload) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(SITE_URL + PUSH_PATH); } catch (e) { return reject(new Error('SITE_URL invalide')); }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const proto = target.protocol === 'https:' ? https : http;
    const req = proto.request(target, {
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-Live-Token': PUSH_TOKEN,
        'User-Agent': 'GDSP-LiveAgent/1.0'
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, text });
        reject(Object.assign(new Error(`HTTP ${res.statusCode} ${text.slice(0, 180)}`), { status: res.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé (site injoignable)')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function tick() {
  if (sending || stopping) return;
  sending = true;
  try {
    const snapshot = (watcher || collector).snapshot();
    snapshot.status = { ...snapshot.status, host: os.hostname(), agent: 'gdsp-live-agent' };
    // Versions déployées avant l'ajout de `agent` : elles comptaient comme
    // « serveur en direct » un instantané pourtant vide. On n'envoie donc rien
    // tant qu'il n'y a ni voiture ni session : inutile de faire croire au site
    // qu'un direct est en cours.
    const cars = Array.isArray(snapshot.cars) ? snapshot.cars.length : 0;
    const hasSession = !!(snapshot.session && (snapshot.session.type || snapshot.session.name));
    if (!cars && !hasSession) {
      failures = 0;
      if (!lastOkAt && !idleWarned) {
        idleWarned = true;
        console.log('· rien à envoyer pour l\'instant (aucune voiture, aucune session) — normal hors course');
      }
      return;
    }
    await post(snapshot);
    failures = 0;
    if (!lastOkAt) console.log(`✓ Premier envoi accepté par ${SITE_URL}${PUSH_PATH}`);
    lastOkAt = Date.now();
  } catch (err) {
    failures += 1;
    // On ne casse pas le terminal : un rappel toutes les 5 erreurs consécutives.
    if (failures === 1 || failures % 5 === 0) {
      console.error(`⚠ Envoi impossible (${failures}×) : ${err.message}`);
    }
  } finally {
    sending = false;
  }
}

const timer = setInterval(tick, INTERVAL_MS);
if (collector) {
  collector.on('event', e => {
    if (e.kind === 'error' || e.kind === 'session') console.log(`· ${e.text}`);
  });
}

// Rappel utile si acServer n'a jamais parlé : la config des deux ports est la
// cause n°1 d'un live timing vide.
let noDataWarnings = 0;
const watchdog = setInterval(() => {
  if (stopping) return;
  if (watcher) {
    if (!watcher.lastError && watcher.lastOkAt) return;
    noDataWarnings += 1;
    if (noDataWarnings === 1 || noDataWarnings % 6 === 0) {
      console.warn(`⚠ ${WATCH_URL} illisible : ${watcher.lastError || 'aucune réponse'}${watcher.hint() ? '\n  → ' + watcher.hint() : ''}`);
    }
    return;
  }
  if (collector.lastPacketAt) return;
  noDataWarnings += 1;
  if (noDataWarnings > 1 && noDataWarnings % 6 !== 0) return;
  console.warn(
    '⚠ Aucun paquet reçu d\'acServer. Vérifie server_cfg.ini :\n' +
    `    UDP_PLUGIN_ADDRESS = 127.0.0.1:${collector.options.listenPort}\n` +
    `    UDP_PLUGIN_LOCAL_PORT = ${collector.options.pluginPort}\n` +
    '  (les deux valeurs doivent être différentes) puis redémarre le serveur AC.\n' +
    '  Serveur lancé par Content Manager ? CM réécrit ce fichier :\n' +
    '    node tools/live-timing/set-plugin-ports.js "chemin\\vers\\server\\cfg\\server_cfg.ini"\n' +
    '  puis relance le serveur depuis CM.'
  );
}, 10000);
watchdog.unref();

function shutdown() {
  stopping = true;
  clearInterval(timer);
  clearInterval(watchdog);
  if (watcher) watcher.stop();
  if (collector) collector.stop();
  const ago = lastOkAt ? `dernier envoi réussi il y a ${Math.round((Date.now() - lastOkAt) / 1000)} s` : 'aucun envoi réussi';
  console.log(`\nAgent arrêté (${ago}).`);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('GDSP live timing — agent local');
if (watcher) {
  console.log(`  serveur suivi: ${WATCH_URL} (lecture HTTP /INFO + /ENTRY)`);
} else {
  console.log(`  serveur AC   : ${collector.options.host}:${collector.options.pluginPort} (écoute UDP ${collector.options.listenPort})`);
}
console.log(`  site         : ${SITE_URL}${PUSH_PATH}`);
console.log(`  fréquence    : 1 envoi / ${INTERVAL_MS} ms`);
if (!watcher) console.log(`  acServer doit contenir : UDP_PLUGIN_ADDRESS=127.0.0.1:${collector.options.listenPort} et UDP_PLUGIN_LOCAL_PORT=${collector.options.pluginPort}`);
console.log(`  (${path.basename(process.argv[1])} · Ctrl+C pour arrêter)`);
void tick;

'use strict';

// Le navigateur ne choisit que parmi les origines explicitement configurées.
// La résolution DNS est contrôlée puis figée pour la connexion, y compris les
// redirections, afin de ne jamais accéder à un service du réseau local.
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_SERVERS = 'https://fr2.assettohosting.com:50648,https://fr5.assettohosting.com:50145';
const HOSTS = new Set(['fr2.assettohosting.com', 'fr5.assettohosting.com']);
const MAX_BODY = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const blocked = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15],
  ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4]
]) blocked.addSubnet(address, bits, 'ipv4');

function parsedUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch (_) { throw new Error('URL non autorisée.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.hash) {
    throw new Error('URL non autorisée.');
  }
  return url;
}

function configuredServers(value = DEFAULT_SERVERS) {
  return [...new Set(String(value).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const url = parsedUrl(s);
    if (url.pathname !== '/' || url.search) throw new Error('AH_SERVERS doit contenir uniquement des origines.');
    return url.origin;
  }))];
}

function createAssettoHostingFetcher(servers, options = {}) {
  const origins = new Set(configuredServers(servers.join(',')));
  const resolve = options.resolve || ((host) => dns.promises.lookup(host, { family: 4, all: true }));
  const get = options.get || ((url, opts, callback) => (url.protocol === 'https:' ? https : http).get(opts, callback));
  const maxBody = options.maxBody || MAX_BODY;
  const maxRedirects = options.maxRedirects === undefined ? MAX_REDIRECTS : options.maxRedirects;

  function authorize(value, serverOnly = false) {
    const url = parsedUrl(value);
    if (!origins.has(url.origin) || (serverOnly && (url.pathname !== '/' || url.search))) throw new Error('URL non autorisée.');
    return url;
  }

  async function fetchUrl(value, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Le délai couvre également la résolution DNS et toute la chaîne de redirections.
    async function beforeDeadline(promise) {
      if (controller.signal.aborted) throw new Error('Délai AssettoHosting dépassé.');
      return new Promise((resolvePromise, rejectPromise) => {
        const abort = () => rejectPromise(new Error('Délai AssettoHosting dépassé.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolvePromise, rejectPromise).finally(() => controller.signal.removeEventListener('abort', abort));
      });
    }
    async function follow(value, count, previous) {
      const url = authorize(value);
      if (previous && previous.protocol === 'https:' && url.protocol !== 'https:') throw new Error('Redirection HTTPS non sécurisée.');
      const records = await beforeDeadline(resolve(url.hostname));
      if (!Array.isArray(records) || !records.length || records.some(r => r.family !== 4 || net.isIP(r.address) !== 4 || blocked.check(r.address, 'ipv4'))) {
        throw new Error('Adresse AssettoHosting non autorisée.');
      }
      const address = records[0].address;
      const result = await beforeDeadline(new Promise((resolveResponse, rejectResponse) => {
        const opts = {
          protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search, family: 4, agent: false, signal: controller.signal,
          // Figer l'adresse validée ; conserver hostname pour Host et TLS/SNI.
          lookup: (_host, lookupOptions, cb) => lookupOptions.all ? cb(null, [{address, family:4}]) : cb(null, address, 4),
          headers: { 'User-Agent': 'GDSP-Importer/1.0', 'Accept': 'application/json,*/*' }
        };
        const req = get(url, opts, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // Le corps d'une redirection n'est pas utile : ne pas le télécharger
            // indéfiniment pendant que la requête suivante est lancée.
            res.destroy();
            if (count >= maxRedirects) return rejectResponse(new Error('Trop de redirections AssettoHosting.'));
            let next;
            try { next = new URL(res.headers.location, url).toString(); } catch (_) { return rejectResponse(new Error('Redirection invalide.')); }
            return resolveResponse({ redirect: next });
          }
          let size = 0;
          const chunks = [];
          res.on('data', chunk => {
            size += chunk.length;
            if (size > maxBody) { rejectResponse(new Error('Réponse AssettoHosting trop volumineuse.')); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on('error', rejectResponse);
          res.on('aborted', () => rejectResponse(new Error('Réponse AssettoHosting interrompue.')));
          res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', rejectResponse);
      }));
      return result.redirect ? follow(result.redirect, count + 1, url) : result;
    }
    try { return await follow(value, 0, null); }
    finally { clearTimeout(timer); }
  }
  return { authorize, fetch: fetchUrl };
}

module.exports = { DEFAULT_SERVERS, configuredServers, createAssettoHostingFetcher };

'use strict';
/*
 * Lecture d'un serveur Assetto Corsa *public* (qu'on ne possède pas), à partir
 * de son port HTTP (HTTP_PORT d'acServer, ex. http://82.66.165.242:16835).
 *
 * acServer y expose deux pages en clair :
 *   /INFO   → JSON : nom, circuit, places, temps restant, mot de passe…
 *   /ENTRY  → HTML : la feuille de temps (ID, pilote, voiture, ping, tours,
 *             dernier tour, meilleur tour, total, guid) ou, en course,
 *             (POS, pilote, voiture, tours, temps, écart).
 *
 * Aucune authentification, aucune installation côté serveur : c'est le même
 * mécanisme que le lobby et Content Manager utilisent pour la liste des
 * serveurs. On interroge périodiquement et on reconstruit un instantané au
 * format de la page /live-timing.
 *
 * important : certains serveurs ne répondent qu'à des clients « normaux » —
 * ils coupent brutalement (ECONNRESET) les sockets qui arrivent depuis une IP
 * de datacenter. La page affiche alors « Serveur injoignable » en expliquant
 * que la lecture doit se faire depuis un PC (mode push / agent) et non depuis
 * l'hébergeur du site. C'est une limite du serveur distant, pas du code.
 *
 * Limites de ce mode : pas de positions temps réel (le HTTP ne les donne pas),
 * pas de secteurs, et les pilotes sans tour enregistré n'ont pas de temps.
 */

const http = require('http');
const https = require('https');

const DEFAULT_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 15000;

// --- petites aides de parsing ------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    const v = ENTITIES[code.toLowerCase()];
    return v == null ? m : v;
  });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Extrait les tableaux d'une page HTML : [[[cellules], …], …] */
function parseTables(html) {
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(m[1])) !== null) {
      const cells = [];
      const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c;
      while ((c = cellRe.exec(r[1])) !== null) cells.push(stripTags(c[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/**
 * « 1:19:501 » (format Assetto : minutes:secondes:millièmes) → 79501 ms
 * Accepte aussi « 2.345 » (secondes.millièmes) et « +0:03:280 ».
 */
function parseAcTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /^[-–—]+$/.test(s) || /^\+?--/.test(s)) return null;
  const negative = s.startsWith('-');
  const t = s.replace(/^[+\-]/, '');
  const parts = t.split(':');
  if (parts.length < 2 || parts.length > 3) {
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
  }
  const nums = parts.map(p => Number(String(p).replace(',', '.')));
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  let ms;
  if (parts.length === 3) ms = nums[0] * 60000 + nums[1] * 1000 + nums[2];
  else ms = /^\d{1,2}$/.test(parts[0]) ? nums[0] * 1000 + nums[1] : nums[0] * 60000 + nums[1] * 1000;
  return negative ? -Math.round(ms) : Math.round(ms);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mm = String(total % 1000).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${mm}` : `${s}.${mm}`;
}

/**
 * Parse la page /ENTRY d'acServer.
 * @returns {{session:{type:string|null,timeLeftMinutes:number|null}, cars:Array, mode:'practice'|'race'}}
 */
function parseEntryPage(html) {
  const text = stripTags(html);
  const header = /Session\s*:\s*([A-Za-z]+)/i.exec(text);
  const timeLeft = /TIME\s*LEFT\s*([0-9]+):([0-9]{2})/i.exec(text);
  const tables = parseTables(html);
  const result = { session: { type: header ? header[1].toLowerCase() : null, timeLeftMinutes: timeLeft ? Number(timeLeft[1]) + Number(timeLeft[2]) / 60 : null }, cars: [], mode: 'practice' };

  for (const rows of tables) {
    if (!rows.length) continue;
    const norm = cells => cells.map(c => String(c).toLowerCase().replace(/\s+/g, ' ').trim());
    const headerRow = rows.find(r => norm(r).includes('driver'));
    if (!headerRow) continue;
    const keys = norm(headerRow);
    const col = name => keys.indexOf(name);
    const iDriver = col('driver');
    const iLaps = col('laps');
    const iLast = col('last');
    const iBest = col('best');
    const iTotal = col('total');
    const iPing = col('ping');
    const iGuid = col('guid');
    const iCar = col('car');
    const iTeam = col('team');
    const iDiff = col('diff');
    const iTime = col('time');
    const iPos = col('pos');
    const isRace = iPos !== -1 && iTotal === -1;

    for (const row of rows) {
      if (row === headerRow) continue;
      if (norm(row).includes('driver')) continue;
      const name = iDriver === -1 ? '' : String(row[iDriver] || '').trim();
      if (!name) continue;
      const laps = iLaps === -1 ? null : Number(String(row[iLaps]).replace(/[^0-9]/g, '')) || 0;
      const bestMs = iBest === -1 ? null : parseAcTime(row[iBest]);
      const lastMs = iLast === -1 ? null : parseAcTime(row[iLast]);
      const totalMs = iTotal !== -1 ? parseAcTime(row[iTotal]) : (iTime !== -1 ? parseAcTime(row[iTime]) : null);
      const diffMs = iDiff === -1 ? null : parseAcTime(row[iDiff]);
      result.cars.push({
        name,
        team: iTeam === -1 ? '' : String(row[iTeam] || '').trim(),
        model: iCar === -1 ? '' : String(row[iCar] || '').trim(),
        laps: laps == null ? 0 : laps,
        bestLapMs: bestMs && bestMs > 0 ? bestMs : null,
        lastLapMs: lastMs && lastMs > 0 ? lastMs : null,
        totalMs: totalMs && totalMs > 0 ? totalMs : null,
        gapMs: diffMs != null && diffMs !== 0 ? Math.abs(diffMs) : null,
        ping: iPing === -1 ? null : Number(String(row[iPing]).replace(/[^0-9]/g, '')) || null,
        guid: iGuid === -1 ? '' : String(row[iGuid] || '').trim(),
        position: iPos === -1 || Number.isNaN(Number(row[iPos])) ? null : Number(row[iPos]) + 1
      });
    }
    if (result.cars.length) {
      result.mode = isRace ? 'race' : 'practice';
      break;
    }
  }
  return result;
}

/** Transforme /ENTRY en classement trié (positions, écarts affichables). */
function buildStandings(parsed) {
  const cars = parsed.cars.slice();
  const race = parsed.mode === 'race' && cars.some(c => c.position != null);
  if (!race) {
    cars.sort((a, b) => {
      if (b.laps !== a.laps) return b.laps - a.laps;
      const A = a.bestLapMs || Infinity;
      const B = b.bestLapMs || Infinity;
      if (A !== B) return A - B;
      return String(a.name).localeCompare(String(b.name), 'fr');
    });
  } else {
    cars.sort((a, b) => (a.position || 999) - (b.position || 999));
  }
  const leaderBest = cars.reduce((m, c) => (c.bestLapMs && c.bestLapMs < m ? c.bestLapMs : m), Infinity);
  return cars.map((c, i) => {
    const position = c.position != null && race ? c.position : i + 1;
    const isLeader = position === 1 || i === 0;
    let gapMs = c.gapMs;
    if (isLeader) {
      gapMs = 0;
    } else if (gapMs == null) {
      if (!race && Number.isFinite(leaderBest) && c.bestLapMs) gapMs = c.bestLapMs - leaderBest;
    }
    return {
      carId: i, // identifiant local (l'ACSP n'en donne pas via HTTP)
      position,
      name: c.name,
      team: c.team || '',
      model: c.model || '',
      laps: c.laps,
      lastLapMs: c.lastLapMs,
      lastLap: fmtMs(c.lastLapMs),
      bestLapMs: c.bestLapMs,
      bestLap: fmtMs(c.bestLapMs),
      totalMs: c.totalMs,
      total: fmtMs(c.totalMs),
      gapMs: gapMs == null ? null : gapMs,
      gap: gapMs == null ? '' : isLeader ? 'leader' : '+' + fmtMs(gapMs),
      gapEstimated: c.gapMs == null,
      ping: c.ping,
      connected: true,
      inPit: false,
      speedKmh: null
    };
  }).map((row, i, all) => {
    const ahead = all[i - 1];
    row.intervalMs = i === 0 || !row.gapMs || !ahead || ahead.gapMs == null ? null : Math.max(0, row.gapMs - ahead.gapMs);
    row.interval = i === 0 ? '' : row.intervalMs == null ? '' : '+' + fmtMs(row.intervalMs);
    return row;
  });
}

// --- la source ---------------------------------------------------------------

const NAVIGATOR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'identity',
  Connection: 'close',
  'Upgrade-Insecure-Requests': '1'
};

class RemoteHttpSource {
  constructor(options = {}) {
    this.url = String(options.url || '').replace(/\/+$/, '');
    this.intervalMs = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
    this.label = options.label || this.url;
    this.timer = null;
    this.polling = false;
    this.lastOkAt = null;
    this.lastError = null;
    this.lastErrorCode = null;
    this.info = null;
    this.entry = null;
    this.startedAt = null;
  }

  get target() {
    try { return new URL(this.url); } catch (e) { return null; }
  }

  fetchText(path, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const base = this.target;
      if (!base) return reject(new Error('URL de serveur invalide'));
      const target = new URL(path, base);
      const proto = target.protocol === 'https:' ? https : http;
      const req = proto.get(target, {
        timeout: timeoutMs,
        headers: NAVIGATOR_HEADERS,
        rejectUnauthorized: false // certains serveurs AC ont un certificat auto-signé
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} sur ${path}`));
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`délai dépassé sur ${path}`)));
      req.on('error', err => reject(Object.assign(err, { path })));
    });
  }

  /**
   * Lit /INFO et /ENTRY. /ENTRY est indispensable : sans lui on ne sait rien du
   * classement, donc une erreur y met la source « hors ligne » avec le détail.
   */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const [infoResult, entryRaw] = await Promise.all([
        this.fetchText('/INFO').then(t => ({ ok: true, text: t }), e => ({ ok: false, error: e })),
        this.fetchText('/ENTRY').catch(e => { throw e; })
      ]);
      if (infoResult.ok) {
        try { this.info = JSON.parse(infoResult.text); } catch (e) { /* INFO illisible : on garde l'ancien */ }
      } else if (!this.info) {
        // Pas de /INFO mais /ENTRY répond : on affiche quand même la feuille.
        this.lastInfoError = infoResult.error.message;
      }
      this.entry = parseEntryPage(entryRaw);
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.lastErrorCode = null;
    } catch (err) {
      this.lastError = err.message;
      this.lastErrorCode = err.code || null;
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (this.timer) return this;
    this.startedAt = Date.now();
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Message d'aide adapté à la cause de l'échec. */
  hint() {
    if (!this.lastError) return null;
    if (/ECONNRESET|EPIPE|socket hang up/i.test(this.lastError) || this.lastErrorCode === 'ECONNRESET') {
      return "Le serveur accepte la connexion puis la coupe : il ne répond qu'à certains clients (souvent il refuse les IP de datacenter). Fais tourner l'agent sur un PC (mode push) pour le suivre depuis un site hébergé.";
    }
    if (/ECONNREFUSED/.test(this.lastError) || this.lastErrorCode === 'ECONNREFUSED') {
      return "Rien n'écoute sur ce port : le serveur est arrêté, ou HTTP_PORT n'est pas ouvert/redirigé sur la box.";
    }
    if (/délai dépassé|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(this.lastError)) {
      return "Le serveur ne répond pas dans le délai imparti : box qui filtre, serveur saturé ou mauvaise adresse.";
    }
    if (/ENOTFOUND/i.test(this.lastError)) return "Nom d'hôte introuvable.";
    return null;
  }

  snapshot(now = Date.now()) {
    const ageMs = this.lastOkAt ? now - this.lastOkAt : null;
    const live = ageMs != null && ageMs < STALE_AFTER_MS;
    const info = this.info || {};
    const entry = this.entry || { session: {}, cars: [] };
    const rows = buildStandings(entry);
    const bestLaps = rows
      .filter(r => r.bestLapMs)
      .sort((a, b) => a.bestLapMs - b.bestLapMs)
      .map((r, i) => ({ rank: i + 1, name: r.name, team: r.team, bestLap: r.bestLap, bestLapMs: r.bestLapMs, laps: r.laps }));
    const sessionType = entry.session.type || (Array.isArray(info.sessiontypes) && info.sessiontypes.length
      ? ['booking', 'practice', 'qualify', 'race'][info.session] || null
      : null);
    const timeLeftSeconds = Number.isFinite(info.timeleft) ? info.timeleft : null;
    const remainingMs = timeLeftSeconds != null ? Math.max(0, timeLeftSeconds * 1000) : null;
    return {
      status: {
        status: this.lastError && !live ? 'offline' : live ? 'live' : 'stale',
        mode: 'http-remote',
        sourceUrl: this.url,
        lastOkAgoMs: ageMs,
        error: this.lastError,
        hint: this.hint(),
        startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
        readOnly: true
      },
      server: {
        name: info.name ? String(info.name).replace(/\s*ℹ\d+$/, '') : this.label,
        track: info.track || null,
        trackConfig: null,
        weather: null,
        ambientTemp: null,
        roadTemp: null,
        protocolVersion: null,
        httpClients: Number.isFinite(info.clients) ? info.clients : rows.length,
        httpMaxClients: Number.isFinite(info.maxclients) ? info.maxclients : null,
        passwordProtected: info.pass != null ? !!info.pass : null,
        port: info.port || null,
        httpPort: info.cport || null
      },
      session: {
        type: sessionType,
        name: sessionType,
        index: Number.isFinite(info.session) ? info.session : null,
        count: Array.isArray(info.sessiontypes) ? info.sessiontypes.length : null,
        laps: 0,
        timeMinutes: Array.isArray(info.durations) && Number.isFinite(info.durations[0]) ? info.durations[0] : 0,
        waitTimeMinutes: 0,
        elapsedMs: null,
        remainingMs,
        remaining: fmtMs(remainingMs),
        elapsed: null
      },
      cars: rows,
      bestLaps,
      referenceLapMs: bestLaps.length ? bestLaps[0].bestLapMs : null,
      events: [],
      collisions: [],
      updatedAt: new Date(now).toISOString(),
      serverTimeMs: now
    };
  }
}

module.exports = {
  RemoteHttpSource,
  parseEntryPage,
  buildStandings,
  parseAcTime,
  parseTables,
  stripTags,
  fmtMs,
  DEFAULT_INTERVAL_MS,
  STALE_AFTER_MS
};

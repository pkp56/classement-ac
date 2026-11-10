'use strict';
/*
 * Collecteur "live timing" pour un serveur Assetto Corsa dédié.
 *
 * Il se comporte comme un plugin ACSP : il écoute en UDP les événements envoyés
 * par acServer (connexions, tours bouclés, positions temps réel, chat...) et
 * reconstruit un classement en direct, exposé en JSON + SSE par app.js.
 *
 * Configuration serveur (server_cfg.ini) :
 *   [SERVER]
 *   UDP_PLUGIN_ADDRESS    = 127.0.0.1:12000   ; notre port d'écoute
 *   UDP_PLUGIN_LOCAL_PORT = 12001             ; port d'écoute d'acServer
 *
 * Variables d'environnement lues par app.js :
 *   LIVE_TIMING_ENABLED     1 pour activer (défaut 1)
 *   AC_HOST                 127.0.0.1 (IP du serveur AC, même machine en général)
 *   AC_PLUGIN_PORT          12001 (UDP_PLUGIN_LOCAL_PORT)
 *   AC_LISTEN_PORT          12000 (port UDP_PLUGIN_ADDRESS)
 *   AC_HTTP_URL             http://127.0.0.1:8081 (facultatif : résumé /INFO)
 *   AC_REALTIME_MS          500 (fréquence des positions)
 *   AC_SERVER_LABEL         nom affiché si acServer ne le fournit pas
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { parsePacket, encode, SESSION_TYPE } = require('./acsp');

const STALE_AFTER_MS = 8000;      // plus de paquet depuis 8 s → liaison perdue
const PIT_SPEED_KMH = 3;          // sous ce seuil, on considère l'arrêt en stand
const PIT_MIN_MS = 4000;
const MAX_EVENTS = 60;
const MAX_COLLISIONS = 30;

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const ss = String(s).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return m > 0 ? `${m}:${ss}.${mmm}` : `${s}.${mmm}`;
}

/**
 * Construit le classement (partie pure, testable).
 *
 * L'ACSP ne transmet pas les écarts officiels : on les estime à partir de la
 * progression (tours + position normalisée) et du meilleur tour de référence.
 * C'est la méthode utilisée par la plupart des outils (stracker, ptracker).
 */
function computeStandings(state, now = Date.now()) {
  const cars = [...state.cars.values()];
  const connected = cars.filter(c => c.connected);
  const referenceLapMs = connected.reduce(
    (best, c) => (c.bestLapMs && c.bestLapMs < best ? c.bestLapMs : best),
    Infinity
  );
  const ref = Number.isFinite(referenceLapMs) ? referenceLapMs : null;
  const leadProgress = connected.reduce(
    (max, c) => Math.max(max, c.laps + (c.spline || 0)),
    0
  );

  const rows = cars.map(c => {
    const progress = c.laps + (c.spline || 0);
    const estGapMs = ref && c.connected ? Math.round((leadProgress - progress) * ref) : null;
    const speedKmh = c.speedKmh;
    return {
      carId: c.carId,
      name: c.name || `Voiture #${c.carId}`,
      team: c.team || '',
      model: c.model || '',
      skin: c.skin || '',
      connected: c.connected,
      laps: c.laps || 0,
      spline: Number((c.spline || 0).toFixed(4)),
      progress: Number(progress.toFixed(4)),
      lastLapMs: c.lastLapMs || null,
      lastLap: fmtMs(c.lastLapMs),
      bestLapMs: c.bestLapMs || null,
      bestLap: fmtMs(c.bestLapMs),
      lastLapCuts: c.lastLapCuts || 0,
      bestLapCuts: c.bestLapCuts || 0,
      totalMs: c.totalMs || 0,
      gear: c.gear ?? null,
      rpm: c.rpm ?? null,
      speedKmh: speedKmh != null ? Math.round(speedKmh) : null,
      inPit: !!c.inPit,
      pitStops: c.pitStops || 0,
      gapMs: estGapMs,
      gap: estGapMs == null ? '' : estGapMs === 0 ? 'leader' : '+' + fmtMs(estGapMs),
      gapEstimated: true,
      lastSeenMs: c.lastUpdateAt ? Math.max(0, now - c.lastUpdateAt) : null,
      currentLapMs: c.lapStartedAt && c.connected ? Math.max(0, now - c.lapStartedAt) : null
    };
  });

  rows.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    if (b.progress !== a.progress) return b.progress - a.progress;
    return (a.bestLapMs || Infinity) - (b.bestLapMs || Infinity);
  });

  let leaderGapMs = 0;
  rows.forEach((row, i) => {
    row.position = i + 1;
    if (i === 0) {
      row.intervalMs = null;
      row.interval = row.gap;
      return;
    }
    const ahead = rows[i - 1];
    row.intervalMs = row.gapMs != null && ahead.gapMs != null ? Math.max(0, row.gapMs - ahead.gapMs) : null;
    row.interval = row.intervalMs == null ? '' : '+' + fmtMs(row.intervalMs);
    if (row.gapMs != null) leaderGapMs = Math.max(leaderGapMs, row.gapMs);
  });

  const bestLaps = rows
    .filter(r => r.bestLapMs)
    .sort((a, b) => a.bestLapMs - b.bestLapMs)
    .map((r, i) => ({ rank: i + 1, name: r.name, team: r.team, bestLap: r.bestLap, bestLapMs: r.bestLapMs, laps: r.laps }));

  return { rows, bestLaps, referenceLapMs: ref };
}

class LiveTimingCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      host: options.host || process.env.AC_HOST || '127.0.0.1',
      pluginPort: Number(options.pluginPort || process.env.AC_PLUGIN_PORT || 12001),
      listenPort: Number(options.listenPort || process.env.AC_LISTEN_PORT || 12000),
      realtimeMs: Number(options.realtimeMs || process.env.AC_REALTIME_MS || 500),
      httpUrl: (options.httpUrl || process.env.AC_HTTP_URL || '').replace(/\/+$/, ''),
      label: options.label || process.env.AC_SERVER_LABEL || 'Serveur Assetto Corsa',
      autoStart: options.autoStart !== false
    };
    this.socket = null;
    this.timers = [];
    this.startedAt = null;
    this.lastPacketAt = null;
    this.lastHttpAt = null;
    this.httpInfo = null;
    this.httpError = null;
    this.error = null;
    this.bindState = 'idle';
    this.reset();
    if (this.options.autoStart) this.start();
  }

  reset() {
    this.state = {
      protocolVersion: null,
      serverName: null,
      track: null,
      trackConfig: null,
      weather: null,
      ambientTemp: null,
      roadTemp: null,
      session: null,
      sessionStartedAt: null,
      sessionElapsedMs: null,
      cars: new Map(),
      events: [],
      collisions: [],
      packetCount: 0,
      packetTypes: {}
    };
  }

  log(kind, text, extra = {}) {
    const entry = { at: new Date().toISOString(), kind, text, ...extra };
    this.state.events.unshift(entry);
    if (this.state.events.length > MAX_EVENTS) this.state.events.length = MAX_EVENTS;
    this.emit('event', entry);
    return entry;
  }

  car(carId) {
    let c = this.state.cars.get(carId);
    if (!c) {
      c = {
        carId, name: null, team: null, model: null, skin: null, guid: null,
        connected: true,
        spline: 0, laps: 0, lastLapMs: null, lastLapCuts: 0,
        bestLapMs: null, bestLapCuts: 0, totalMs: 0,
        pos: null, gear: null, rpm: null, speedKmh: null,
        inPit: false, slowSince: null, pitStops: 0,
        lapStartedAt: null, lastUpdateAt: null, infoRequestedAt: 0
      };
      this.state.cars.set(carId, c);
    }
    return c;
  }

  start() {
    if (this.socket) return this;
    this.startedAt = Date.now();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', err => {
      this.error = err.message;
      this.bindState = 'error';
      this.log('error', 'Erreur UDP : ' + err.message);
      try { socket.close(); } catch (e) { /* déjà fermé */ }
      this.socket = null;
    });
    socket.on('message', (buf, rinfo) => this.handleDatagram(buf, rinfo));
    socket.bind(this.options.listenPort, '0.0.0.0', () => {
      this.bindState = 'listening';
      this.log('info', `Écoute ACSP sur UDP ${this.options.listenPort} (émission vers ${this.options.host}:${this.options.pluginPort})`);
      this.emit('status', this.statusSnapshot());
      this.requestSessionInfo();
      this.send(Buffer.from([0x38])); // demande la version du protocole
    });
    // Re-réclame les infos de session tant que rien n'arrive (acServer peut
    // démarrer après nous) et garde la liaison vivante.
    this.timers.push(setInterval(() => this.heartbeat(), 5000));
    if (this.options.httpUrl) {
      this.pollHttp();
      this.timers.push(setInterval(() => this.pollHttp(), 3000));
    }
    return this;
  }

  stop() {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* ignore */ }
      this.socket = null;
    }
  }

  heartbeat() {
    const since = this.lastPacketAt ? Date.now() - this.lastPacketAt : Infinity;
    if (since > STALE_AFTER_MS) {
      // Toujours en attente : on redemande la session, sans spammer le log.
      this.requestSessionInfo();
    }
  }

  send(buf) {
    if (!this.socket) return false;
    try {
      this.socket.send(buf, 0, buf.length, this.options.pluginPort, this.options.host);
      return true;
    } catch (e) {
      this.log('error', 'Envoi UDP impossible : ' + e.message);
      return false;
    }
  }

  requestSessionInfo() { return this.send(encode.getSessionInfo(-1)); }

  requestCarInfo(carId) {
    const car = this.state.cars.get(carId);
    const now = Date.now();
    if (car && now - (car.infoRequestedAt || 0) < 3000) return;
    if (car) car.infoRequestedAt = now;
    this.send(encode.getCarInfo(carId));
  }

  handleDatagram(buf, rinfo) {
    let packet;
    try {
      packet = parsePacket(buf);
    } catch (err) {
      this.log('error', `Paquet ACSP illisible (${buf.length} o) : ${err.message}`);
      return;
    }
    this.lastPacketAt = Date.now();
    this.error = null;
    this.state.packetCount += 1;
    this.state.packetTypes[packet.typeName] = (this.state.packetTypes[packet.typeName] || 0) + 1;
    this.apply(packet, rinfo);
    this.emit('packet', packet);
  }

  apply(packet, rinfo) {
    const { typeName, payload } = packet;
    const state = this.state;
    switch (typeName) {
      case 'version': {
        state.protocolVersion = payload.protocolVersion;
        this.log('info', `acServer connecté (protocole ACSP v${payload.protocolVersion})`);
        break;
      }
      case 'new_session':
      case 'session_info': {
        // Une nouvelle manche commence si l'index change, ou si le chrono de
        // session repart de zéro (même index relancé, LOOP_MODE par exemple).
        const previousIndex = state.session ? state.session.sessionIndex : null;
        const previousElapsed = state.sessionElapsedMs;
        const restarted = previousElapsed != null && payload.elapsedMs + 2000 < previousElapsed;
        const changed = !state.session || previousIndex !== payload.sessionIndex || restarted;
        state.sessionElapsedMs = payload.elapsedMs;
        state.serverName = payload.serverName || state.serverName;
        state.track = payload.track || state.track;
        state.trackConfig = payload.trackConfig || state.trackConfig;
        state.weather = payload.weather || state.weather;
        state.ambientTemp = payload.ambientTemp;
        state.roadTemp = payload.roadTemp;
        state.session = {
          index: payload.sessionIndex,
          currentIndex: payload.currentSessionIndex,
          count: payload.sessionCount,
          type: SESSION_TYPE[payload.type] || 'session',
          name: payload.name || '',
          timeMinutes: payload.timeMinutes,
          laps: payload.laps,
          waitTimeMinutes: payload.waitTimeMinutes,
          elapsedMs: payload.elapsedMs
        };
        state.sessionStartedAt = Date.now() - Math.max(0, payload.elapsedMs || 0);
        if (changed) {
          // Nouvelle session : remise à zéro des compteurs de la manche,
          // les identités des pilotes sont conservées.
          for (const car of state.cars.values()) {
            car.laps = 0; car.totalMs = 0; car.lastLapMs = null; car.lastLapCuts = 0;
            car.bestLapMs = null; car.bestLapCuts = 0; car.lapStartedAt = null;
            car.pitStops = 0; car.spline = 0;
          }
          this.log('session', `Session ${state.session.type} : ${state.session.name || state.track || ''}`);
        }
        // Les positions temps réel n'arrivent que si on les demande.
        this.send(encode.setRealtimeInterval(this.options.realtimeMs));
        break;
      }
      case 'end_session': {
        this.log('session', 'Fin de session' + (payload.reportFile ? ` — ${payload.reportFile}` : ''));
        break;
      }
      case 'new_connection': {
        const car = this.car(payload.carId);
        car.connected = true;
        car.name = payload.driverName || car.name;
        car.guid = payload.driverGuid || car.guid;
        car.model = payload.model || car.model;
        car.skin = payload.skin || car.skin;
        car.lastUpdateAt = Date.now();
        this.log('driver', `${car.name || 'Pilote #' + payload.carId} rejoint le serveur`, { carId: payload.carId });
        this.requestCarInfo(payload.carId);
        break;
      }
      case 'closed_connection': {
        const car = this.car(payload.carId);
        car.connected = false;
        if (payload.driverName) car.name = payload.driverName;
        this.log('driver', `${car.name || 'Pilote #' + payload.carId} quitte le serveur`, { carId: payload.carId });
        break;
      }
      case 'car_info': {
        const car = this.car(payload.carId);
        if (payload.driverName) car.name = payload.driverName;
        if (payload.team) car.team = payload.team;
        if (payload.model) car.model = payload.model;
        if (payload.skin) car.skin = payload.skin;
        if (payload.driverGuid) car.guid = payload.driverGuid;
        car.connected = payload.isConnected;
        break;
      }
      case 'client_loaded': {
        const car = this.car(payload.carId);
        car.lastUpdateAt = Date.now();
        if (!car.name) this.requestCarInfo(payload.carId);
        break;
      }
      case 'car_update': {
        const car = this.car(payload.carId);
        const previousSpline = car.spline;
        car.spline = Number.isFinite(payload.spline) ? payload.spline : car.spline;
        car.pos = payload.pos;
        car.gear = payload.gear;
        car.rpm = payload.engineRpm;
        const v = payload.velocity || { x: 0, y: 0, z: 0 };
        car.speedKmh = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
        car.connected = true;
        car.lastUpdateAt = Date.now();
        // Détection stand : immobile plusieurs secondes dans le tour.
        if (car.speedKmh < PIT_SPEED_KMH) {
          if (!car.slowSince) car.slowSince = Date.now();
          else if (!car.inPit && Date.now() - car.slowSince > PIT_MIN_MS) {
            car.inPit = true;
            car.pitStops = (car.pitStops || 0) + 1;
            this.log('pit', `${car.name || 'Voiture #' + car.carId} aux stands`, { carId: car.carId });
          }
        } else {
          car.slowSince = null;
          car.inPit = false;
        }
        if (previousSpline > 0.9 && car.spline < 0.1 && !car.lapStartedAt) car.lapStartedAt = Date.now();
        if (!car.name) this.requestCarInfo(payload.carId);
        break;
      }
      case 'lap_completed': {
        const now = Date.now();
        const author = this.car(payload.carId);
        const valid = !payload.cuts;
        author.lastLapMs = payload.lapTimeMs;
        author.lastLapCuts = payload.cuts || 0;
        author.totalMs = (author.totalMs || 0) + payload.lapTimeMs;
        author.lapStartedAt = now;
        if (valid && (!author.bestLapMs || payload.lapTimeMs < author.bestLapMs)) {
          author.bestLapMs = payload.lapTimeMs;
          author.bestLapCuts = 0;
        }
        for (const entry of payload.cars) {
          const car = this.car(entry.carId);
          const before = car.laps;
          car.laps = entry.laps;
          if (entry.carId === payload.carId) {
            car.laps = Math.max(entry.laps, before);
          }
          if (entry.completed) car.connected = true;
          if (!car.name) this.requestCarInfo(entry.carId);
        }
        this.log('lap', `${author.name || 'Voiture #' + payload.carId} — tour ${fmtMs(payload.lapTimeMs)}${payload.cuts ? ' (coupures)' : ''}`, { carId: payload.carId });
        break;
      }
      case 'chat': {
        const car = this.car(payload.carId);
        // Les messages CSP chiffrés commencent par "RP>" : on ne les affiche pas.
        if (!/^[A-Z]{2}>/.test(payload.message)) {
          this.log('chat', `${car.name || 'Serveur'} : ${payload.message}`.slice(0, 240));
        }
        break;
      }
      case 'client_event': {
        const c = payload;
        if (this.state.collisions.length >= MAX_COLLISIONS) this.state.collisions.shift();
        this.state.collisions.push({
          at: new Date().toISOString(),
          carId: c.carId,
          targetCarId: c.targetCarId ?? null,
          kind: c.kind,
          speedKmh: Math.round(c.speedKmh || 0)
        });
        break;
      }
      case 'error': {
        this.log('error', 'acServer : ' + payload.message);
        this.error = payload.message;
        break;
      }
      default:
        break;
    }
    void rinfo;
  }

  pollHttp() {
    const url = this.options.httpUrl;
    if (!url) return;
    let target;
    try { target = new URL(url + '/INFO'); } catch (e) { return; }
    const proto = target.protocol === 'https:' ? https : http;
    const req = proto.get(target, { timeout: 4000, headers: { Accept: 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { this.httpError = 'HTTP ' + res.statusCode; return; }
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          this.httpInfo = info;
          this.httpError = null;
          this.lastHttpAt = Date.now();
          if (!this.state.serverName && info.name) this.state.serverName = String(info.name).replace(/\s*ℹ\d+$/, '');
          if (!this.state.track && info.track) this.state.track = info.track;
        } catch (e) {
          this.httpError = 'Réponse /INFO illisible';
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => { this.httpError = err.message; });
  }

  statusSnapshot() {
    const now = Date.now();
    const since = this.lastPacketAt ? now - this.lastPacketAt : null;
    const acspLive = since != null && since < STALE_AFTER_MS;
    let mode = 'offline';
    let status = 'waiting';
    if (acspLive) { mode = 'acsp'; status = 'live'; }
    else if (this.lastHttpAt && now - this.lastHttpAt < 10000) { mode = 'http'; status = 'http'; }
    return {
      status,
      mode,
      listening: !!this.socket,
      udp: { listenPort: this.options.listenPort, serverPort: this.options.pluginPort, host: this.options.host, bound: this.bindState },
      lastPacketAgoMs: since,
      lastHttpAgoMs: this.lastHttpAt ? now - this.lastHttpAt : null,
      error: this.error || this.httpError || null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null
    };
  }

  snapshot() {
    const now = Date.now();
    const status = this.statusSnapshot();
    const { rows, bestLaps, referenceLapMs } = computeStandings(this.state, now);
    const session = this.state.session || {};
    const remainingMs = (() => {
      if (!this.state.sessionStartedAt) return null;
      const totalMs = Number.isFinite(session.timeMinutes) ? session.timeMinutes * 60000 : null;
      if (!totalMs) return null;
      return Math.max(0, this.state.sessionStartedAt + totalMs - now);
    })();
    return {
      status,
      server: {
        name: this.state.serverName || (this.httpInfo && this.httpInfo.name) || this.options.label,
        track: this.state.track || (this.httpInfo && this.httpInfo.track) || null,
        trackConfig: this.state.trackConfig || null,
        weather: this.state.weather || null,
        ambientTemp: this.state.ambientTemp ?? null,
        roadTemp: this.state.roadTemp ?? null,
        protocolVersion: this.state.protocolVersion,
        httpClients: this.httpInfo ? this.httpInfo.clients ?? null : null,
        httpMaxClients: this.httpInfo ? this.httpInfo.maxclients ?? null : null,
        passwordProtected: this.httpInfo ? !!this.httpInfo.pass : null
      },
      session: {
        type: session.type || null,
        name: session.name || null,
        index: session.index ?? null,
        count: session.count ?? null,
        laps: session.laps || 0,
        timeMinutes: session.timeMinutes || 0,
        waitTimeMinutes: session.waitTimeMinutes || 0,
        elapsedMs: this.state.sessionStartedAt ? now - this.state.sessionStartedAt : null,
        remainingMs,
        remaining: remainingMs == null ? null : fmtMs(remainingMs),
        elapsed: this.state.sessionStartedAt ? fmtMs(now - this.state.sessionStartedAt) : null
      },
      cars: rows,
      bestLaps,
      referenceLapMs,
      events: this.state.events,
      collisions: this.state.collisions.slice(-10).reverse(),
      updatedAt: new Date(now).toISOString(),
      serverTimeMs: now
    };
  }

  command(name, args = {}) {
    switch (name) {
      case 'chat': return this.send(encode.broadcastChat(String(args.message || '').slice(0, 200)));
      case 'kick': return this.send(encode.kickUser(Number(args.carId)));
      case 'next-session': return this.send(encode.nextSession());
      case 'restart-session': return this.send(encode.restartSession());
      default: return false;
    }
  }
}

module.exports = { LiveTimingCollector, computeStandings, fmtMs, STALE_AFTER_MS };

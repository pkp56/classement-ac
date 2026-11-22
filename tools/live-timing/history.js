'use strict';
/*
 * Historique persistant du live timing.
 *
 * La page /live-timing montre le DIRECT (SSE, mémoire) : au redémarrage du
 * site — ou simplement une fois la séance finie — il ne reste rien. Ici, chaque
 * séance vue par le site (agent push, UDP local, source HTTP) est conservée :
 * identité, durée et temps observés ; les anciennes archives restent lisibles.
 *
 * Rien n'est fabriqué : on stocke les instantanés tels qu'ils arrivent, et la
 * séance se ferme quand une différente commence ; une interruption seule ne prouve pas un arrêt.
 *
 * Stockage : PostgreSQL (LIVE_DATABASE_URL ou DATABASE_URL, table
 * gdsp_live_sessions) sinon fichier JSON (data/live-history.json) — le site
 * local et les tests n'ont rien à installer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS_CAP = 150;   // fil conservé par séance : au-delà, on garde la queue

/** Signature d'une séance : change = nouvelle séance. */
function sessionSignature(snap) {
  const server = (snap && snap.server) || {};
  const session = (snap && snap.session) || {};
  return [
    String(server.name || ''),
    String(server.track || ''),
    String(server.trackConfig || ''),
    String(session.type || ''),
    String(session.index == null ? '' : session.index)
  ].join('|');
}

/** Ce qu'on garde d'un instantané : le classement, sans les champs volatils. */
function classification(snap) {
  return (snap.cars || []).map(c => ({
    position: c.position == null ? null : c.position,
    name: c.name || '',
    team: c.team || null,
    model: c.model || null,
    laps: c.laps || 0,
    gap: c.gap == null ? null : c.gap,
    interval: c.interval == null ? null : c.interval,
    lastLap: c.lastLap || null,
    bestLap: c.bestLap || null,
    inPit: !!c.inPit,
    connected: c.connected !== false
  }));
}

// Les nouvelles archives contiennent le tableau des temps observés seulement.
// Les anciens formats restent lisibles sans les modifier.
function archivedSnapshot(snap){
  if(!Array.isArray(snap.storedTimes))return snap;
  return {...snap,cars:[],bestLaps:[],events:[],collisions:[],storedTimes:snap.storedTimes.map(row=>({...row,connected:false}))};
}
function archiveClassification(snap){
  if(!Array.isArray(snap.storedTimes))return classification(snap);
  return snap.storedTimes.map(row=>({name:row.name||'',team:row.team||null,model:row.model||null,laps:row.laps||0,lastLap:row.lastLap||null,bestLap:row.bestLap||null,topSpeedKmh:row.topSpeedKmh??null,identityUncertain:!!row.identityUncertain,connected:false}));
}
function connectedDrivers(cars){
  return cars.filter(c=>c.connected===true &&
    (c.driverIdentified===true || (c.driverIdentified==null && typeof c.name==='string' && c.name.trim() && !/^Voiture #\d+$/i.test(c.name.trim())))).length;
}
function hasLapTime(row){
  if(!row || typeof row!=='object')return false;
  return ['bestLapMs','lastLapMs','averageLapMs'].some(k=>typeof row[k]==='number' && Number.isFinite(row[k]) && row[k]>0) ||
    ['bestLap','lastLap'].some(k=>typeof row[k]==='string' && /^(?:\d+:)?\d{1,2}\.\d{1,3}$/.test(row[k].trim()));
}
function hasSessionTime(snap){
  if(Array.isArray(snap.storedTimes)){
    // Les temps conservés traversent les séances : leur seule présence ne
    // prouve pas qu'un tour a été observé dans la séance courante.
    const hasStored=snap.storedTimes.some(hasLapTime);
    if(!hasStored)return false;
    if(typeof snap.sessionObservedLaps==='number')return Number.isFinite(snap.sessionObservedLaps) && snap.sessionObservedLaps>0;
    // Ancien agent : utiliser seulement un temps courant réellement reçu.
    return Array.isArray(snap.cars) && snap.cars.some(hasLapTime);
  }
  return (Array.isArray(snap.cars) && snap.cars.some(hasLapTime)) || (Array.isArray(snap.bestLaps) && snap.bestLaps.some(hasLapTime));
}
/** Un enregistreur : accumule, détecte les changements de séance, écrit. */
class LiveHistoryRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.writeIntervalMs = Number(options.writeIntervalMs ?? 10000);
    this.current = null;          // { signature, id, lastWriteMs }
    this.models = new Set();
    this.source = options.source || null;
    this.pendingConnected = false;
    this.lastArchiveSnap = null;
  }

  /** Un instantané à prendre en compte (ou pas : le vide n'ouvre pas une séance). */
  async record(snap, nowMs = Date.now(), force = false) {
    try {
      if (!snap || !snap.server) return;
      // Une capture rejouée (miroir) n'est PAS une séance de plus : l'historique
      // ne doit contenir que ce qui s'est vraiment passé sur le serveur.
      if (snap.status && ['mirror','offline','error'].includes(snap.status.mode)) return;
      const server = snap.server;
      const cars = Array.isArray(snap.cars) ? snap.cars : [];
      // Un emplacement sans pilote (ou un nom provisoire) ne suffit pas.
      // Pour les sources plus anciennes sans indicateur explicite, ne garder
      // qu'un nom réel et un état connecté confirmé.
      const connected = connectedDrivers(cars);
      const hasSession=String(server.track||'')!=='' || (snap.session && String(snap.session.type||'')!=='');
      if(!hasSession)return;
      const signature = sessionSignature(snap);
      const at = new Date(nowMs).toISOString();

      // La séance précédente n'est plus vue : on la ferme, en écrivant d'abord
      // sa dernière photo (la ligne d'arrivée vaut plus qu'un dixième d'écart).
      const prevElapsed=Number(this.lastSnap?.session?.elapsedMs),elapsed=Number(snap.session?.elapsedMs);
      const restarted=this.lastSnap?.session?.elapsedMs != null && snap.session?.elapsedMs != null && Number.isFinite(prevElapsed) && Number.isFinite(elapsed) && elapsed + 2000 < prevElapsed;
      const previousSignature=this.lastSnap ? sessionSignature(this.lastSnap) : null;
      if (previousSignature && (previousSignature !== signature || restarted)) {
        if(this.current)await this.closeCurrent(nowMs, this.lastArchiveSnap);
        this.pendingConnected=false;
        this.models=new Set();
      }
      if(connected)this.pendingConnected=true;
      for(const car of cars)if(car.model)this.models.add(String(car.model));
      snap = {...snap, archiveSource:this.source, archiveModels:[...this.models].sort((a,b)=>a.localeCompare(b,'fr'))};
      this.lastSnap = snap;
      // Une connexion sans temps ne produit pas d'archive ; un résultat
      // hérité d'une séance précédente ne suffit pas non plus.
      if(!hasSessionTime(snap))return;
      if(!this.current && !this.pendingConnected)return;
      this.lastArchiveSnap = snap;

      if (!this.current) {
        const row = await this.store.upsert({
          session_key: signature + '@' + crypto.randomUUID(), // pas de collision entre deux boucles
          server_name: server.name || null,
          track: server.track || null,
          track_config: server.trackConfig || null,
          session_type: (snap.session && snap.session.type) || null,
          started_at: at,
          last_seen_at: at,
          ended_at: null,
          drivers: connected,
          snapshot: archivedSnapshot(snap),
          classification: archiveClassification(snap),
          best_laps: Array.isArray(snap.storedTimes)?[]:(snap.bestLaps || []).slice(0, 20),
          events: Array.isArray(snap.storedTimes)?[]:(snap.events || []).slice(-EVENTS_CAP)
        });
        this.current = { signature, id: row.id, lastWriteMs: nowMs };
        return;
      }

      // Même séance : écriture au plus toutes les writeIntervalMs, et toujours
      // la dernière photo avant fermeture.
      if (force || nowMs - this.current.lastWriteMs >= this.writeIntervalMs) {
        await this.store.update(this.current.id, {
          last_seen_at: at,
          drivers: connected,
          snapshot: archivedSnapshot(snap),
          classification: archiveClassification(snap),
          best_laps: Array.isArray(snap.storedTimes)?[]:(snap.bestLaps || []).slice(0, 20),
          events: Array.isArray(snap.storedTimes)?[]:(snap.events || []).slice(-EVENTS_CAP)
        });
        this.current.lastWriteMs = nowMs;
      }
    } catch (e) {
      // L'historique ne doit JAMAIS casser le direct.
      console.error('live-history:', e.message);
    }
  }

  /** Ferme la séance courante (sans la perdre : dernière photo conservée). */
  async closeCurrent(nowMs = Date.now(), finalSnap = null) {
    if (!this.current) return;
    try {
      if (finalSnap && finalSnap.server &&
          !(finalSnap.status && finalSnap.status.mode === 'mirror')) {
        const cars = Array.isArray(finalSnap.cars) ? finalSnap.cars : [];
        await this.store.update(this.current.id, {
          last_seen_at: new Date(nowMs).toISOString(),
          drivers: connectedDrivers(cars),
          snapshot: archivedSnapshot(finalSnap),
          classification: archiveClassification(finalSnap),
          best_laps: Array.isArray(finalSnap.storedTimes)?[]:(finalSnap.bestLaps || []).slice(0, 20),
          events: Array.isArray(finalSnap.storedTimes)?[]:(finalSnap.events || []).slice(-EVENTS_CAP)
        });
      }
      await this.store.close(this.current.id, new Date(nowMs).toISOString());
    } catch (e) {
      console.error('live-history:', e.message);
    }
    this.current = null;
    this.lastArchiveSnap = null;
  }
}

// --- stockage fichier ---------------------------------------------------------

class FileLiveHistory {
  constructor(file) {
    this.file = file;
    this.rows = [];
    this.byId = new Map();
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if(!Array.isArray(data))throw new Error('Format invalide');
        this.rows = data;
        for (const row of this.rows) this.byId.set(row.id, row);
      } catch (e) { throw new Error('Fichier historique illisible : aucune archive ne sera écrasée'); }
    }
  }
  _nextId() { return this.rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1; }
  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp=this.file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify(this.rows,null,1),{flag:'wx'});fs.renameSync(temp,this.file);}
    finally{try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  async upsert(row) {
    const existing = this.rows.find(r => r.session_key === row.session_key);
    if (existing) {
      Object.assign(existing, row, { id: existing.id });
      this._persist();
      return existing;
    }
    const full = { id: this._nextId(), ended_at: null, ...row };
    this.rows.push(full);
    this.byId.set(full.id, full);
    this._persist();
    return full;
  }
  async update(id, patch) {
    const row = this.byId.get(Number(id));
    if (!row) return null;
    Object.assign(row, patch);
    this._persist();
    return row;
  }
  async close(id, endedAt) {
    const row = this.byId.get(Number(id));
    if (!row) return null;
    row.ended_at = endedAt;
    this._persist();
    return row;
  }
  async list(limit = 50, offset = 0) {
    limit=Math.max(1,Math.min(500,Math.floor(Number(limit)||50)));
    offset=Math.max(0,Math.floor(Number(offset)||0));
    return this.rows.slice().sort((a, b) =>
      String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')) || b.id-a.id).slice(offset, offset+limit);
  }
  async get(id) { return this.byId.get(Number(id)) || null; }
  async closeStore() { this._persist(); }
}

// --- stockage PostgreSQL ------------------------------------------------------

const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gdsp_live_sessions (
  id            BIGSERIAL PRIMARY KEY,
  session_key   TEXT UNIQUE NOT NULL,
  server_name   TEXT,
  track         TEXT,
  track_config  TEXT,
  session_type  TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  drivers       INT,
  snapshot      JSONB,
  classification JSONB,
  best_laps     JSONB,
  events        JSONB
);
CREATE INDEX IF NOT EXISTS gdsp_live_sessions_recent ON gdsp_live_sessions (last_seen_at DESC);
`;

class PgLiveHistory {
  constructor(pool) { this.pool = pool; }
  async init() {
    await this.pool.query(PG_SCHEMA_SQL);
    return this;
  }
  async upsert(row) {
    const keys = Object.keys(row);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');
    const updates = keys.filter(k => k !== 'session_key' && k !== 'started_at')
      .map((k, i) => `"${k}" = $${keys.length + 1 + i}`).join(', ');
    const value=(k,v)=>['snapshot','classification','best_laps','events'].includes(k)?JSON.stringify(v):v;
    const res = await this.pool.query(
      `INSERT INTO gdsp_live_sessions (${cols}) VALUES (${params})
       ON CONFLICT (session_key) DO UPDATE SET ${updates} RETURNING *`,
      [...keys.map(k => value(k,row[k])), ...keys.filter(k => k !== 'session_key' && k !== 'started_at').map(k => value(k,row[k]))]
    );
    return res.rows[0];
  }
  async update(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const res = await this.pool.query(
      `UPDATE gdsp_live_sessions SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map(k => ['snapshot','classification','best_laps','events'].includes(k)?JSON.stringify(patch[k]):patch[k]), Number(id)]
    );
    return res.rows[0] || null;
  }
  async close(id, endedAt) {
    const res = await this.pool.query(
      `UPDATE gdsp_live_sessions SET ended_at = $1 WHERE id = $2 RETURNING *`,
      [endedAt, Number(id)]
    );
    return res.rows[0] || null;
  }
  async list(limit = 50, offset = 0) {
    const res = await this.pool.query(
      `SELECT id, session_key, server_name, track, track_config, session_type,
              started_at, last_seen_at, ended_at, drivers, classification, snapshot->'archiveModels' AS archive_models, snapshot->>'archiveSource' AS archive_source
       FROM gdsp_live_sessions ORDER BY last_seen_at DESC, id DESC LIMIT $1 OFFSET $2`, [Math.max(1, Math.min(500, Math.floor(Number(limit) || 50))), Math.max(0, Math.floor(Number(offset) || 0))]
    );
    return res.rows;
  }
  async get(id) {
    const res = await this.pool.query(`SELECT * FROM gdsp_live_sessions WHERE id = $1`, [Number(id)]);
    return res.rows[0] || null;
  }
  async closeStore() { /* pool géré par l'appelant */ }
}

/**
 * Ouvre le stockage : PostgreSQL si une URL est là (LIVE_DATABASE_URL, puis
 * DATABASE_URL), sinon fichier. Renvoie null si rien n'est possible —
 * l'historique est une facilité, jamais une dépendance dure.
 */
async function openLiveHistory(options = {}) {
  // « off » coupe l'historique ; un chemin impose le stockage fichier (tests,
  // poste sans base).
  const fileEnv = String(process.env.LIVE_HISTORY_FILE || '').trim();
  if (fileEnv === 'off') return null;
  if (fileEnv && !options.file) options.file = fileEnv;
  const url = options.databaseUrl || process.env.LIVE_DATABASE_URL || process.env.DATABASE_URL || '';
  if (url && !options.file) {
    try {
      const pg = require('pg');
      const pool = options.pool || new pg.Pool({
        connectionString: url,
        ssl: /neon\.tech|render\.com/i.test(url) ? { rejectUnauthorized: false } : undefined
      });
      return await new PgLiveHistory(pool).init();
    } catch (e) {
      console.error('live-history: base indisponible, repli fichier —', e.message);
    }
  }
  const file = options.file || path.join(process.cwd(), 'data', 'live-history.json');
  if (options.file === null) return null;
  return new FileLiveHistory(file);
}

module.exports = { LiveHistoryRecorder, FileLiveHistory, PgLiveHistory, openLiveHistory, sessionSignature, classification, EVENTS_CAP };

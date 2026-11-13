'use strict';
/*
 * Historique persistant du live timing.
 *
 * La page /live-timing montre le DIRECT (SSE, mémoire) : au redémarrage du
 * site — ou simplement une fois la séance finie — il ne reste rien. Ici, chaque
 * séance vue par le site (agent push, UDP local, source HTTP) est conservée :
 * identité, durée, classement final, meilleurs tours, fil d'événements.
 *
 * Rien n'est fabriqué : on stocke les instantanés tels qu'ils arrivent, et la
 * séance se ferme quand une différente commence (ou qu'on ne la voit plus).
 *
 * Stockage : PostgreSQL (LIVE_DATABASE_URL ou DATABASE_URL, table
 * gdsp_live_sessions) sinon fichier JSON (data/live-history.json) — le site
 * local et les tests n'ont rien à installer.
 */

const fs = require('fs');
const path = require('path');

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

/** Un enregistreur : accumule, détecte les changements de séance, écrit. */
class LiveHistoryRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.writeIntervalMs = Number(options.writeIntervalMs || 10000);
    this.current = null;          // { signature, id, lastWriteMs }
    this.lastSeenBySignature = new Map();
  }

  /** Un instantané à prendre en compte (ou pas : le vide n'ouvre pas une séance). */
  async record(snap, nowMs = Date.now()) {
    try {
      if (!snap || !snap.server) return;
      // Une capture rejouée (miroir) n'est PAS une séance de plus : l'historique
      // ne doit contenir que ce qui s'est vraiment passé sur le serveur.
      if (snap.status && snap.status.mode === 'mirror') return;
      const server = snap.server;
      const cars = Array.isArray(snap.cars) ? snap.cars : [];
      const hasContent = String(server.name || '') !== '' || String(server.track || '') !== '' || cars.length > 0;
      if (!hasContent) return;
      const signature = sessionSignature(snap);
      const at = new Date(nowMs).toISOString();

      // La séance précédente n'est plus vue : on la ferme, en écrivant d'abord
      // sa dernière photo (la ligne d'arrivée vaut plus qu'un dixième d'écart).
      if (this.current && this.current.signature !== signature) {
        await this.closeCurrent(nowMs, this.lastSnap);
      }
      this.lastSnap = snap;

      if (!this.current) {
        const row = await this.store.upsert({
          session_key: signature + '@' + at.slice(0, 16),   // identité stable par créneau
          server_name: server.name || null,
          track: server.track || null,
          track_config: server.trackConfig || null,
          session_type: (snap.session && snap.session.type) || null,
          started_at: at,
          last_seen_at: at,
          ended_at: null,
          drivers: cars.filter(c => c.connected !== false).length,
          snapshot: snap,
          classification: classification(snap),
          best_laps: (snap.bestLaps || []).slice(0, 20),
          events: (snap.events || []).slice(-EVENTS_CAP)
        });
        this.current = { signature, id: row.id, lastWriteMs: nowMs };
        return;
      }

      // Même séance : écriture au plus toutes les writeIntervalMs, et toujours
      // la dernière photo avant fermeture.
      if (nowMs - this.current.lastWriteMs >= this.writeIntervalMs) {
        await this.store.update(this.current.id, {
          last_seen_at: at,
          drivers: cars.filter(c => c.connected !== false).length,
          snapshot: snap,
          classification: classification(snap),
          best_laps: (snap.bestLaps || []).slice(0, 20),
          events: (snap.events || []).slice(-EVENTS_CAP)
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
          drivers: cars.filter(c => c.connected !== false).length,
          snapshot: finalSnap,
          classification: classification(finalSnap),
          best_laps: (finalSnap.bestLaps || []).slice(0, 20),
          events: (finalSnap.events || []).slice(-EVENTS_CAP)
        });
      }
      await this.store.close(this.current.id, new Date(nowMs).toISOString());
    } catch (e) {
      console.error('live-history:', e.message);
    }
    this.current = null;
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
        this.rows = Array.isArray(data) ? data : [];
        for (const row of this.rows) this.byId.set(row.id, row);
      } catch (e) { /* fichier illisible : on repart propre */ }
    }
  }
  _nextId() { return this.rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1; }
  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.rows, null, 1));
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
  async list(limit = 50) {
    return this.rows.slice().sort((a, b) =>
      String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))).slice(0, limit);
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
    const res = await this.pool.query(
      `INSERT INTO gdsp_live_sessions (${cols}) VALUES (${params})
       ON CONFLICT (session_key) DO UPDATE SET ${updates} RETURNING *`,
      [...keys.map(k => row[k]), ...keys.filter(k => k !== 'session_key' && k !== 'started_at').map(k => row[k])]
    );
    return res.rows[0];
  }
  async update(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const res = await this.pool.query(
      `UPDATE gdsp_live_sessions SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map(k => patch[k]), Number(id)]
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
  async list(limit = 50) {
    const res = await this.pool.query(
      `SELECT id, session_key, server_name, track, track_config, session_type,
              started_at, last_seen_at, ended_at, drivers
       FROM gdsp_live_sessions ORDER BY last_seen_at DESC LIMIT $1`, [Math.min(500, Number(limit) || 50)]
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

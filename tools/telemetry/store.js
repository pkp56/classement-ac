'use strict';
/*
 * Stockage de la télémétrie — schéma `telemetry`, ISOLÉ du championnat.
 *
 * Règle d'or : ce module ne lit et n'écrit QUE dans le schéma `telemetry`.
 * Aucune clé étrangère vers `championship`/les événements, aucun JOIN possible
 * par accident : on peut supprimer la télémétrie sans que le classement global
 * ni les fiches pilotes s'en aperçoivent.
 *
 * Deux moteurs :
 *   - PostgreSQL / Neon   (DATABASE_URL) — c'est le cas du site déployé ;
 *   - fichier JSON local  (aucune dépendance) — pour les tests et le
 *     fonctionnement hors ligne, avec la même API.
 *
 * Les colonnes de contexte (météo, grip, FUEL_RATE, TYRE_WEAR_RATE) sont
 * stockées avec chaque session : sans elles, deux sessions ne sont pas
 * comparables et tout calcul de BoP serait faux.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA = 'telemetry';

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

-- Une session de test = un run sur un circuit, avec un contexte unique.
CREATE TABLE IF NOT EXISTS ${SCHEMA}.session (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  server_name     TEXT,
  track           TEXT NOT NULL,
  track_config    TEXT,
  session_type    TEXT,                       -- practice / qualify / race
  air_temp_c      NUMERIC(4,1),
  road_temp_c     NUMERIC(4,1),
  grip            NUMERIC(5,3),
  weather         TEXT,
  fuel_rate       NUMERIC(7,2),               -- FUEL_RATE du serveur : sans lui, rien n'est comparable
  tyre_wear_rate  NUMERIC(7,2),               -- TYRE_WEAR_RATE du serveur
  campaign        TEXT,                       -- ex. « campagne-2026-11 » (10 jours de test)
  notes           TEXT,
  CONSTRAINT session_unique_run UNIQUE (started_at, track, COALESCE(track_config,''))
);

-- Un relais = tours consécutifs d'un pilote dans une voiture, sans arrêt.
CREATE TABLE IF NOT EXISTS ${SCHEMA}.stint (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES ${SCHEMA}.session(id) ON DELETE CASCADE,
  driver_guid     TEXT NOT NULL,              -- identité stable, pas le pseudo
  driver_name     TEXT,
  car             TEXT NOT NULL,
  started_at      TIMESTAMPTZ,
  laps            INT,
  fuel_start_l    NUMERIC(6,3),
  fuel_end_l      NUMERIC(6,3),
  tyre_wear_start NUMERIC(5,2),
  tyre_wear_end   NUMERIC(5,2),
  median_lap_ms   INT
);

-- Un tour : la donnée de base de tout le BoP.
CREATE TABLE IF NOT EXISTS ${SCHEMA}.lap (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES ${SCHEMA}.session(id) ON DELETE CASCADE,
  stint_id        BIGINT REFERENCES ${SCHEMA}.stint(id) ON DELETE SET NULL,
  driver_guid     TEXT NOT NULL,
  driver_name     TEXT,
  car             TEXT NOT NULL,
  lap_number      INT,
  lap_ms          INT NOT NULL,
  cuts            INT DEFAULT 0,
  fuel_used_l     NUMERIC(6,3),
  fuel_loaded_l   NUMERIC(6,3),
  tyre_wear_pct   NUMERIC(5,2),               -- usure moyenne des 4 roues sur le tour
  tyre_wear_fl    NUMERIC(5,2),
  tyre_wear_fr    NUMERIC(5,2),
  tyre_wear_rl    NUMERIC(5,2),
  tyre_wear_rr    NUMERIC(5,2),
  tyre_temp_avg_c NUMERIC(5,1),
  speed_max_kmh   INT,
  measured        BOOLEAN NOT NULL DEFAULT FALSE,  -- false = estimé (n'entre pas dans un BoP)
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mesures de contexte uniques par circuit (faites une fois, réutilisées).
CREATE TABLE IF NOT EXISTS ${SCHEMA}.circuit_profile (
  id              BIGSERIAL PRIMARY KEY,
  track           TEXT NOT NULL,
  track_config    TEXT,
  pit_lane_loss_ms INT,                       -- temps perdu entrée → sortie des stands
  refuel_rate_lps NUMERIC(5,3),               -- débit de ravitaillement mesuré
  tyre_change_ms  INT,                        -- durée d'un changement de gommes
  measured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT,
  CONSTRAINT circuit_profile_unique UNIQUE (track, COALESCE(track_config,''))
);

CREATE INDEX IF NOT EXISTS lap_car_idx      ON ${SCHEMA}.lap (car);
CREATE INDEX IF NOT EXISTS lap_driver_idx   ON ${SCHEMA}.lap (driver_guid);
CREATE INDEX IF NOT EXISTS lap_session_idx  ON ${SCHEMA}.lap (session_id);
CREATE INDEX IF NOT EXISTS session_track_idx ON ${SCHEMA}.session (track);
`;

/** Toutes les instructions du schéma, une par élément (tests + migration). */
function schemaStatements() {
  return SCHEMA_SQL
    .split(';')
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean)
    .map(s => s + ';');
}

// --- backend fichier (tests, hors ligne) -------------------------------------

class FileStore {
  constructor(file) {
    this.file = file;
    this.data = { session: [], stint: [], lap: [], circuit_profile: [], seq: { session: 0, stint: 0, lap: 0, circuit_profile: 0 } };
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = Object.assign(this.data, parsed);
        this.data.seq = Object.assign({ session: 0, stint: 0, lap: 0, circuit_profile: 0 }, parsed.seq || {});
      } catch (e) { /* fichier corrompu : on repart proprement */ }
    }
  }
  get kind() { return 'file'; }
  async init() { return this; }
  _next(table) {
    this.data.seq[table] = (this.data.seq[table] || 0) + 1;
    return this.data.seq[table];
  }
  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  async insert(table, row) {
    if (!this.data[table]) throw new Error(`table inconnue : ${table}`);
    const withId = Object.assign({ id: this._next(table) }, row);
    this.data[table].push(withId);
    this._persist();
    return withId;
  }
  async select(table, filter = {}) {
    if (!this.data[table]) throw new Error(`table inconnue : ${table}`);
    return this.data[table].filter(row => Object.keys(filter).every(k => row[k] === filter[k]));
  }
  async update(table, id, patch) {
    if (!this.data[table]) throw new Error(`table inconnue : ${table}`);
    const row = this.data[table].find(r => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    this._persist();
    return row;
  }
  async close() { this._persist(); }
}

// --- backend PostgreSQL / Neon ----------------------------------------------

class PgStore {
  constructor(pool) {
    this.pool = pool;
    this._kind = 'postgres';
  }
  get kind() { return this._kind; }
  async init() {
    for (const stmt of schemaStatements()) await this.pool.query(stmt);
    return this;
  }
  async insert(table, row) {
    const keys = Object.keys(row);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');
    const res = await this.pool.query(
      `INSERT INTO ${SCHEMA}.${table} (${cols}) VALUES (${params}) RETURNING *`,
      keys.map(k => row[k])
    );
    return res.rows[0];
  }
  async select(table, filter = {}) {
    const keys = Object.keys(filter);
    const where = keys.length ? ' WHERE ' + keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ') : '';
    const res = await this.pool.query(`SELECT * FROM ${SCHEMA}.${table}${where}`, keys.map(k => filter[k]));
    return res.rows;
  }
  async update(table, id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const res = await this.pool.query(
      `UPDATE ${SCHEMA}.${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map(k => patch[k]), id]
    );
    return res.rows[0] || null;
  }
  async close() { /* pool géré par l'appelant */ }
}

/**
 * Ouvre le stockage : PostgreSQL si `DATABASE_URL` est présent, sinon fichier.
 * `pg` est requis à la demande pour que le mode fichier n'impose aucune
 * dépendance (tests, poste sans base).
 */
async function openStore(options = {}) {
  const url = options.databaseUrl || process.env.TELEMETRY_DATABASE_URL || '';
  if (url) {
    let pg;
    try { pg = require('pg'); } catch (e) {
      throw new Error("Le module 'pg' est requis pour PostgreSQL. Installe-le ('npm i pg') ou retire TELEMETRY_DATABASE_URL.");
    }
    const pool = options.pool || new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
    const store = new PgStore(pool);
    await store.init();
    return store;
  }
  // Le chemin du fichier est configurable : sur l'hébergeur, `data/` peut être
  // un disque éphémère, et les tests doivent pouvoir travailler hors du dépôt.
  const file = options.file || process.env.TELEMETRY_STORE_FILE || path.join(process.cwd(), 'data', 'telemetry-store.json');
  return new FileStore(file).init();
}

module.exports = {
  SCHEMA,
  SCHEMA_SQL,
  schemaStatements,
  FileStore,
  PgStore,
  openStore
};

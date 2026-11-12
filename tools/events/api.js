'use strict';
/*
 * Événements & authentification — rapatriés du service `gdsp-render-backend`
 * dans ce dépôt, pour que le site n'ait plus qu'un seul service à joindre.
 *
 * Ce module remplace exactement l'API du backend, contrat inchangé :
 *
 *   POST   /api/admin/login          {username,password} → {token,expiresIn}
 *   GET    /api/events               → {events:[{slug,name,kind,points_config,updated_at}]}
 *   GET    /api/events/:slug         → {slug,name,kind,points_config,data,updated_at}
 *   POST   /api/events               création (admin)   — 409 si le slug existe
 *   PUT    /api/events/:slug         métadonnées (admin)
 *   DELETE /api/events/:slug         suppression (admin)
 *   POST   /api/events/:slug/data    sauvegarde du championnat (admin)
 *   GET    /api/championship         compat mono-événement
 *   POST   /api/save-championship    compat mono-événement (admin)
 *
 * Différences volontaires avec l'ancien service :
 *   1. Aucun identifiant de secours. L'ancien code acceptait `gdspadmin` /
 *      `gdsp290` et signait ses jetons avec `"dev-jwt-secret-change-me"` quand
 *      les variables manquaient : ce dépôt est public, ces valeurs aussi.
 *      Ici, sans `ADMIN_PASSWORD` et `JWT_SECRET`, le login refuse de signer.
 *   2. Plus de CORS : le site et l'API sont servis par la même origine.
 *   3. Le jeton est un JWT HS256 de 8 h, comme avant — les sessions ouvertes
 *      sur l'ancien backend restent valides tant que `JWT_SECRET` est le même.
 *
 * Tables utilisées : `gdsp_events` uniquement (plus `gdsp_championship_data`,
 * relue une fois pour la migration si elle existe). Aucune table du schéma
 * `telemetry`.
 */

const crypto = require('crypto');

const DEFAULT_POINTS = {
  pointsScale: [41, 38, 35, 32, 30, 28, 26, 24, 22, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  polePoints: 1,
  doubleLongRaces: false,
  longRaceMinutes: 60,
  minPercentDistance: 0.75,
  jokerCount: 0,
  globalCoef: 1.0
};

const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const LEGACY_SLUG = 'lola-t290-2026';
const LEGACY_NAME = 'International Series Lola T290 — 2026';
const LEGACY_POINTS = {
  pointsScale: DEFAULT_POINTS.pointsScale,
  polePoints: 1,
  doubleLongRaces: true,
  longRaceMinutes: 60,
  minPercentDistance: 0.75,
  jokerCount: 5,
  globalCoef: 1.0
};

function isNonEmptyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function validSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{1,60}$/.test(slug);
}

/**
 * Secret de signature des jetons.
 *
 * `JWT_SECRET` (32+ caractères, `openssl rand -hex 32`) est la bonne réponse.
 * Faute de mieux, on le dérive de `ADMIN_PASSWORD` : c'est aussi un secret
 * serveur, il n'est pas public, et cela évite de bloquer un déploiement où
 * seul le mot de passe a été configuré. Ce qui est formellement interdit, et
 * que faisait l'ancien backend, c'est une constante écrite dans ce dépôt
 * public (`"dev-jwt-secret-change-me"`) : n'importe qui pouvait signer un jeton.
 */
function jwtSecret(env = process.env) {
  const secret = String(env.JWT_SECRET || '').trim();
  if (secret.length >= 16) return secret;
  const password = String(env.ADMIN_PASSWORD || '').trim();
  if (!password) {
    throw new Error(
      'Ni JWT_SECRET ni ADMIN_PASSWORD ne sont configurés : impossible de signer un jeton. ' +
      'Génère un secret avec : openssl rand -hex 32'
    );
  }
  return crypto.createHash('sha256').update('gdsp-admin-token|' + password).digest('hex');
}

/**
 * Comptes administrateurs. Un seul couple historiquement, mais la variable
 * accepte plusieurs comptes séparés par des virgules : `nom:$2…,autre:secret`.
 * Le mot de passe peut être un hash bcrypt (`$2…`), comme le backend le faisait.
 */
function adminUsers(env = process.env) {
  const raw = String(env.ADMIN_PASSWORD || '').trim();
  if (!raw) return [];
  const names = String(env.ADMIN_USERNAME || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Un seul utilisateur : le comportement historique.
  if (!raw.includes(':') || raw.startsWith('$2')) {
    return [{ username: names[0] || 'admin', password: raw }];
  }
  return raw.split(',').map(pair => {
    const i = pair.indexOf(':');
    return { username: pair.slice(0, i).trim(), password: pair.slice(i + 1).trim() };
  }).filter(u => u.username && u.password);
}

/**
 * Vérifie un couple identifiant / mot de passe.
 * bcrypt est requis à la demande : un mot de passe en clair n'en a pas besoin.
 */
async function checkCredentials(username, password, env = process.env) {
  const users = adminUsers(env);
  if (!users.length) return { ok: false, error: 'Aucun compte administrateur configuré (ADMIN_PASSWORD absent).' };
  const user = users.find(u => u.username === String(username || ''));
  if (!user) return { ok: false, error: 'Identifiant ou mot de passe incorrect.' };
  const given = String(password || '');
  if (user.password.startsWith('$2')) {
    let bcrypt;
    try { bcrypt = require('bcryptjs'); } catch (e) {
      return { ok: false, error: "Le mot de passe est un hash bcrypt : installe 'bcryptjs' (npm i bcryptjs)." };
    }
    const same = await bcrypt.compare(given, user.password);
    return same ? { ok: true, user: user.username } : { ok: false, error: 'Identifiant ou mot de passe incorrect.' };
  }
  // Comparaison à longueur constante : évite de révéler le préfixe correct.
  return timingSafeStringEqual(given, user.password)
    ? { ok: true, user: user.username }
    : { ok: false, error: 'Identifiant ou mot de passe incorrect.' };
}

function timingSafeStringEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

/** Signe un jeton admin (HS256, 8 h) — même format que l'ancien backend. */
function signAdminToken(username, env = process.env) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: username, role: 'admin' }, jwtSecret(env), { expiresIn: TOKEN_TTL_SECONDS });
}

/**
 * Vérifie un en-tête `Authorization: Bearer …`.
 * @returns {{ok:true,user:string}|{ok:false,reason:'missing'|'invalid'}}
 */
function verifyAdminToken(header, env = process.env) {
  const raw = String(header || '');
  if (!/^Bearer\s+\S/.test(raw)) return { ok: false, reason: 'missing' };
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  let jwt;
  try { jwt = require('jsonwebtoken'); } catch (e) { return { ok: false, reason: 'invalid' }; }
  try {
    const payload = jwt.verify(token, jwtSecret(env));
    return { ok: true, user: String(payload.sub || 'admin') };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

// --- stockage ---------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gdsp_events (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('championship','open','archive')),
  points_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_gdsp_events_kind ON gdsp_events(kind);
`;

/** Store PostgreSQL minimal : mêmes requêtes que l'ancien backend. */
class EventStore {
  constructor(pool) {
    this.pool = pool;
  }
  async init() {
    await this.pool.query(SCHEMA_SQL);
    // Reprise de l'ancienne table mono-championnat, si elle existe encore.
    const legacy = await this.pool.query(`SELECT to_regclass('public.gdsp_championship_data') AS tbl`);
    if (legacy.rows[0] && legacy.rows[0].tbl) {
      const { rows } = await this.pool.query('SELECT championship FROM gdsp_championship_data WHERE id = 1');
      const legacyData = rows[0] && rows[0].championship;
      if (isNonEmptyObject(legacyData)) {
        await this.pool.query(
          `INSERT INTO gdsp_events (slug, name, kind, points_config, data, updated_by)
           VALUES ($1,$2,'championship',$3::jsonb,$4::jsonb,'migration')
           ON CONFLICT (slug) DO NOTHING`,
          [LEGACY_SLUG, LEGACY_NAME, JSON.stringify(LEGACY_POINTS), JSON.stringify(legacyData)]
        );
      }
    }
    return this;
  }
  async list() {
    const { rows } = await this.pool.query(
      `SELECT slug, name, kind, points_config, updated_at
         FROM gdsp_events
        ORDER BY kind = 'championship' DESC, kind = 'open' DESC, updated_at DESC`
    );
    return rows;
  }
  async get(slug) {
    const { rows } = await this.pool.query(
      `SELECT slug, name, kind, points_config, data, updated_at FROM gdsp_events WHERE slug = $1`,
      [slug]
    );
    return rows[0] || null;
  }
  async create({ slug, name, kind, pointsConfig, data, user }) {
    const { rows } = await this.pool.query(
      `INSERT INTO gdsp_events (slug, name, kind, points_config, data, updated_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug, name, kind`,
      [slug, name, kind, JSON.stringify(pointsConfig), JSON.stringify(data), user]
    );
    return rows[0] || null;
  }
  async update(slug, patch, user) {
    const fields = [];
    const values = [slug];
    let i = 2;
    if (typeof patch.name === 'string') { fields.push(`name = $${i++}`); values.push(patch.name); }
    if (typeof patch.kind === 'string') { fields.push(`kind = $${i++}`); values.push(patch.kind); }
    if (patch.pointsConfig && typeof patch.pointsConfig === 'object') {
      fields.push(`points_config = $${i++}::jsonb`); values.push(JSON.stringify(patch.pointsConfig));
    }
    if (isNonEmptyObject(patch.data)) { fields.push(`data = $${i++}::jsonb`); values.push(JSON.stringify(patch.data)); }
    if (!fields.length) return { error: 'Rien à mettre à jour.' };
    fields.push('updated_at = NOW()', `updated_by = $${i++}`);
    values.push(user);
    const { rows } = await this.pool.query(
      `UPDATE gdsp_events SET ${fields.join(', ')} WHERE slug = $1
        RETURNING slug, name, kind, points_config, updated_at`,
      values
    );
    return { event: rows[0] || null };
  }
  async saveData(slug, data, user) {
    const { rows } = await this.pool.query(
      `UPDATE gdsp_events SET data = $2::jsonb, updated_at = NOW(), updated_by = $3
        WHERE slug = $1 RETURNING updated_at`,
      [slug, JSON.stringify(data), user]
    );
    return rows[0] || null;
  }
  async remove(slug) {
    const { rowCount } = await this.pool.query('DELETE FROM gdsp_events WHERE slug = $1', [slug]);
    return rowCount > 0;
  }
  async legacyChampionship() {
    const { rows } = await this.pool.query(
      `SELECT data AS championship, updated_at, points_config FROM gdsp_events WHERE slug = $1`,
      [LEGACY_SLUG]
    );
    return rows[0] || null;
  }
  async saveLegacy(data, user) {
    const { rows } = await this.pool.query(
      `INSERT INTO gdsp_events (slug, name, kind, data, points_config, updated_by)
       VALUES ($1,$2,'championship',$3::jsonb,$4::jsonb,$5)
       ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [LEGACY_SLUG, LEGACY_NAME, JSON.stringify(data), JSON.stringify(LEGACY_POINTS), user]
    );
    return rows[0] || null;
  }
}

/** Ouvre le store depuis une URL PostgreSQL (même base que le site). */
async function openEventStore(options = {}) {
  const url = options.databaseUrl || process.env.EVENTS_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) return null;                       // pas de base : le proxy reste en service
  let pg;
  try { pg = require('pg'); } catch (e) { throw new Error("Le module 'pg' est requis (npm i pg)."); }
  const pool = options.pool || new pg.Pool({
    connectionString: url,
    ssl: /neon\.tech|render\.com/i.test(url) ? { rejectUnauthorized: false } : undefined
  });
  const store = new EventStore(pool);
  await store.init();
  return store;
}

// --- routes -----------------------------------------------------------------

/**
 * Monte les routes sur une application Express.
 *
 * Elles doivent être déclarées AVANT le proxy `/api/*` : c'est ce qui permet de
 * garder l'ancien backend en secours route par route (`EVENTS_SOURCE=backend`).
 *
 * @param {import('express').Application} app
 * @param {object} deps { getStore: () => Promise<EventStore|null>, allowLocalAuth }
 */
function mountEventRoutes(app, deps) {
  const getStore = deps.getStore;
  /*
   * Pas de base configurée sur ce service (DATABASE_URL absent) : on ne casse
   * rien, on laisse passer la requête. Le proxy `/api/*` déclaré juste après
   * prend le relais et l'ancien backend répond — le site continue de marcher
   * pendant la migration, sans variable à ajouter.
   */
  const storeOrDelegate = async (next) => {
    let store = null;
    try {
      store = await getStore();
    } catch (e) {
      console.error('événements: base injoignable —', e.message);
    }
    if (!store) {
      next();
      return null;
    }
    return store;
  };

  // Connexion : le jeton est un JWT de 8 h, vérifiable ensuite sans base.
  app.post('/api/admin/login', async (req, res, next) => {
    const username = String((req.body && req.body.username) || '');
    const password = String((req.body && req.body.password) || '');
    const check = await checkCredentials(username, password);
    if (!check.ok) return res.status(401).json({ error: check.error });
    try {
      const token = signAdminToken(check.user);
      res.set('X-Admin-Source', 'local');
      res.json({ token, user: check.user, expiresIn: TOKEN_TTL_SECONDS });
    } catch (e) {
      console.error('admin login:', e.message);
      res.status(503).json({ error: e.message, code: 'auth-not-configured' });
    }
  });

  // Vérification : dit oui ou non, sans jamais révéler le secret.
  app.get('/api/admin/verify', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const check = verifyAdminToken(req.headers.authorization);
    if (!check.ok) return res.status(401).json({ ok: false, reason: check.reason });
    res.json({ ok: true, user: check.user });
  });

  // --- lecture publique ---
  app.get('/api/events', async (_req, res, next) => {
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      return res.json({ events: await store.list() });
    } catch (e) {
      console.error('GET events:', e.message);
      return res.status(500).json({ error: 'Impossible de lister les événements.' });
    }
  });

  app.get('/api/events/:slug', async (req, res, next) => {
    if (!validSlug(req.params.slug)) return res.status(400).json({ error: 'Slug invalide.' });
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const event = await store.get(req.params.slug);
      if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
      return res.json(event);
    } catch (e) {
      console.error('GET event:', e.message);
      return res.status(500).json({ error: "Impossible de lire l'événement." });
    }
  });

  app.get('/api/championship', async (_req, res, next) => {
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const row = await store.legacyChampionship();
      return res.json({
        championship: (row && row.championship) || {},
        pointsConfig: (row && row.points_config) || null,
        updatedAt: (row && row.updated_at) || null
      });
    } catch (e) {
      return res.status(500).json({ error: 'Impossible de lire le championnat.' });
    }
  });

  // --- écriture (admin) ---
  const admin = (req, res) => {
    const check = verifyAdminToken(req.headers.authorization);
    if (check.ok) return check.user;
    res.status(401).json({
      error: check.reason === 'missing'
        ? 'Connexion administrateur requise.'
        : 'Session expirée ou invalide. Reconnecte-toi.'
    });
    return null;
  };

  app.post('/api/events', async (req, res, next) => {
    const user = admin(req, res);
    if (!user) return undefined;
    const body = req.body || {};
    const slug = String(body.slug || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const kind = String(body.kind || 'championship');
    if (!validSlug(slug)) return res.status(400).json({ error: 'Identifiant (slug) invalide. Utilisez lettres, chiffres et tirets.' });
    if (!name || name.length > 120) return res.status(400).json({ error: 'Nom manquant ou trop long.' });
    if (!['championship', 'open', 'archive'].includes(kind)) return res.status(400).json({ error: 'Type invalide.' });
    const pointsConfig = Object.assign({}, DEFAULT_POINTS, { globalCoef: kind === 'open' ? 0.5 : 1.0 }, body.pointsConfig || {});
    const data = isNonEmptyObject(body.data) ? body.data : {};
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const created = await store.create({ slug, name, kind, pointsConfig, data, user });
      if (!created) return res.status(409).json({ error: 'Un événement avec cet identifiant existe déjà.' });
      return res.json({ status: 'ok', event: created });
    } catch (e) {
      console.error('POST event:', e.message);
      return res.status(500).json({ error: "Impossible de créer l'événement." });
    }
  });

  app.put('/api/events/:slug', async (req, res, next) => {
    const user = admin(req, res);
    if (!user) return undefined;
    if (!validSlug(req.params.slug)) return res.status(400).json({ error: 'Slug invalide.' });
    const body = req.body || {};
    if (typeof body.name === 'string') {
      body.name = body.name.trim();
      if (!body.name || body.name.length > 120) return res.status(400).json({ error: 'Nom invalide.' });
    }
    if (typeof body.kind === 'string' && !['championship', 'open', 'archive'].includes(body.kind)) {
      return res.status(400).json({ error: 'Type invalide.' });
    }
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const result = await store.update(req.params.slug, body, user);
      if (result.error) return res.status(400).json({ error: result.error });
      if (!result.event) return res.status(404).json({ error: 'Événement introuvable.' });
      return res.json({ status: 'ok', event: result.event });
    } catch (e) {
      console.error('PUT event:', e.message);
      return res.status(500).json({ error: "Impossible de mettre à jour l'événement." });
    }
  });

  app.delete('/api/events/:slug', async (req, res, next) => {
    const user = admin(req, res);
    if (!user) return undefined;
    if (!validSlug(req.params.slug)) return res.status(400).json({ error: 'Slug invalide.' });
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const removed = await store.remove(req.params.slug);
      if (!removed) return res.status(404).json({ error: 'Événement introuvable.' });
      return res.json({ status: 'ok' });
    } catch (e) {
      console.error('DELETE event:', e.message);
      return res.status(500).json({ error: "Impossible de supprimer l'événement." });
    }
  });

  app.post('/api/events/:slug/data', async (req, res, next) => {
    const user = admin(req, res);
    if (!user) return undefined;
    if (!validSlug(req.params.slug)) return res.status(400).json({ error: 'Slug invalide.' });
    if (!isNonEmptyObject(req.body)) return res.status(400).json({ error: 'Données invalides.' });
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const saved = await store.saveData(req.params.slug, req.body, user);
      if (!saved) return res.status(404).json({ error: 'Événement introuvable.' });
      return res.json({ status: 'ok', updatedAt: saved.updated_at });
    } catch (e) {
      console.error('POST event data:', e.message);
      return res.status(500).json({ error: "Impossible d'enregistrer les données." });
    }
  });

  app.post('/api/save-championship', async (req, res, next) => {
    const user = admin(req, res);
    if (!user) return undefined;
    if (!isNonEmptyObject(req.body)) return res.status(400).json({ error: 'Championnat JSON invalide.' });
    try {
      const store = await storeOrDelegate(next);
      if (!store) return undefined;
      const saved = await store.saveLegacy(req.body, user);
      return res.json({ status: 'ok', message: 'Championnat enregistré.', updatedAt: saved && saved.updated_at });
    } catch (e) {
      console.error('legacy save:', e.message);
      return res.status(500).json({ error: "Impossible d'enregistrer." });
    }
  });
}

module.exports = {
  DEFAULT_POINTS,
  LEGACY_SLUG,
  TOKEN_TTL_SECONDS,
  isNonEmptyObject,
  validSlug,
  adminUsers,
  checkCredentials,
  signAdminToken,
  verifyAdminToken,
  EventStore,
  openEventStore,
  mountEventRoutes
};

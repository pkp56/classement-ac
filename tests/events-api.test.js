'use strict';
/*
 * Événements & authentification rapatriés du service `gdsp-render-backend`.
 *
 * Ce qui est vérifié ici, c'est le CONTRAT : les réponses doivent être celles
 * que `site.js` attend, à l'identique — c'est la condition pour que la bascule
 * ne casse pas le championnat. Un faux pool `pg` enregistre le SQL et répond
 * comme PostgreSQL, ce qui permet de tester sans base.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  EventStore,
  openEventStore,
  adminUsers,
  checkCredentials,
  signAdminToken,
  verifyAdminToken,
  validSlug,
  isNonEmptyObject,
  DEFAULT_POINTS
} = require('../tools/events/api');

const ENV = {
  ADMIN_USERNAME: 'gdspadmin',
  ADMIN_PASSWORD: 'motdepasse-de-test',
  JWT_SECRET: 'secret-de-test-suffisamment-long'
};
// Les routes montées lisent `process.env` (comme en production) : on fixe ici
// les valeurs du service, et on les retire à la fin pour ne pas polluer les
// autres fichiers de test.
const SAVED_ENV = { ...process.env };
process.env.ADMIN_USERNAME = ENV.ADMIN_USERNAME;
process.env.ADMIN_PASSWORD = ENV.ADMIN_PASSWORD;
process.env.JWT_SECRET = ENV.JWT_SECRET;
process.on('exit', () => { process.env = SAVED_ENV; });

/** Faux pool : enregistre les requêtes et imite le sous-ensemble utilisé. */
function fakePool(seed = []) {
  const calls = [];
  const rows = seed.map(r => Object.assign({ created_at: null, updated_by: null }, r));
  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^CREATE|^SELECT to_regclass/.test(sql.trim())) return { rows: [{ tbl: null }], rowCount: 0 };
      if (/^SELECT championship/.test(sql.trim())) return { rows: [] };
      if (/^SELECT slug, name, kind, points_config, updated_at/.test(sql.trim())) {
        return { rows: rows.map(r => ({ slug: r.slug, name: r.name, kind: r.kind, points_config: r.points_config, updated_at: r.updated_at })) };
      }
      if (/^SELECT slug, name, kind, points_config, data/.test(sql.trim())) {
        const found = rows.find(r => r.slug === params[0]);
        return { rows: found ? [found] : [] };
      }
      if (/^SELECT data AS championship/.test(sql.trim())) {
        const found = rows.find(r => r.slug === params[0]);
        return { rows: found ? [{ championship: found.data, points_config: found.points_config, updated_at: found.updated_at }] : [] };
      }
      if (/^INSERT INTO gdsp_events/.test(sql.trim())) {
        const slug = params[0];
        const isLegacy = /ON CONFLICT \(slug\) DO UPDATE/.test(sql);
        if (rows.some(r => r.slug === slug) && /ON CONFLICT \(slug\) DO NOTHING/.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        // Deux INSERT différents :
        //   (slug,name,kind,points_config,data,user)  → 6 paramètres
        //   (slug,name,'championship',data,points_config,user) → `kind` littéral,
        //   donc 5 paramètres seulement.
        const row = isLegacy
          ? {
              slug, name: params[1], kind: 'championship',
              data: JSON.parse(params[2]), points_config: JSON.parse(params[3]),
              updated_by: params[4], updated_at: '2026-11-12T00:00:00.000Z'
            }
          : {
              slug, name: params[1], kind: params[2],
              points_config: JSON.parse(params[3]), data: JSON.parse(params[4]),
              updated_by: params[5], updated_at: '2026-11-12T00:00:00.000Z'
            };
        const existing = rows.findIndex(r => r.slug === slug);
        if (existing >= 0) {
          if (!isLegacy) return { rows: [], rowCount: 0 };
          rows[existing] = Object.assign(rows[existing], row);
          return { rows: [{ updated_at: row.updated_at }], rowCount: 1 };
        }
        rows.push(row);
        return { rows: [isLegacy ? { updated_at: row.updated_at } : row], rowCount: 1 };
      }
      if (/^UPDATE gdsp_events/.test(sql.trim())) {
        const found = rows.find(r => r.slug === params[0]);
        if (!found) return { rows: [], rowCount: 0 };
        if (/RETURNING updated_at/.test(sql)) {
          found.data = JSON.parse(params[1]);
          found.updated_at = '2026-11-12T01:00:00.000Z';
          return { rows: [{ updated_at: found.updated_at }], rowCount: 1 };
        }
        // Les colonnes mises à jour sont lues dans le SQL, dans l'ordre des
        // paramètres — comme le ferait PostgreSQL.
        let idx = 1;
        // Uniquement la partie SET : la clause WHERE contient aussi « slug = $1 ».
        const setSql = sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(' WHERE '));
        for (const m of setSql.matchAll(/"?([a-z_]+)"? = \$(\d+)/g)) {
          const value = params[idx++];
          if (m[1] === 'points_config' || m[1] === 'data') found[m[1]] = JSON.parse(value);
          else found[m[1]] = value;
        }
        return { rows: [found], rowCount: 1 };
      }
      if (/^DELETE FROM gdsp_events/.test(sql.trim())) {
        const i = rows.findIndex(r => r.slug === params[0]);
        if (i < 0) return { rows: [], rowCount: 0 };
        rows.splice(i, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

/** Capture les routes montées sur une fausse application Express. */
function fakeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  async function call(method, path, { body, headers } = {}) {
    const route = routes.find(r => r.method === method && r.path === path);
    if (!route) throw new Error(`route absente : ${method} ${path}`);
    const handler = route.handlers[route.handlers.length - 1];
    // Le paramètre d'URL vient du corps (`__param`), puisque le chemin enregistré
    // est le motif Express (`/api/events/:slug`).
    const req = { body: body || {}, params: {}, headers: headers || {} };
    const m = path.match(/:(\w+)/);
    if (m && body && body.__param) req.params[m[1]] = body.__param;
    const payload = Object.assign({}, req.body);
    delete payload.__param;
    req.body = payload;
    const res = {
      statusCode: 200,
      body: undefined,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.headersSent = true; return this; },
      set() { return this; }
    };
    // `next()` = « je n'ai pas de base, laisse le proxy répondre ».
    let delegated = false;
    await handler(req, res, () => { delegated = true; });
    res.delegated = delegated;
    return res;
  }
  return { app, routes, call, mount(app_, deps) { require('../tools/events/api').mountEventRoutes(app_, deps); } };
}

// --- authentification --------------------------------------------------------

test('sans ADMIN_PASSWORD, aucun compte n\'existe (pas de secours codé en dur)', async () => {
  assert.deepEqual(adminUsers({}), []);
  const check = await checkCredentials('gdspadmin', 'gdsp290', {});
  assert.equal(check.ok, false);
  assert.match(check.error, /ADMIN_PASSWORD absent/);
});

test('les identifiants de secours de l\'ancien backend ne passent plus', async () => {
  // `gdspadmin` / `gdsp290` étaient acceptés par défaut dans gdsp-render-backend.
  const check = await checkCredentials('gdspadmin', 'gdsp290', ENV);
  assert.equal(check.ok, false, 'le mot de passe de secours ne doit plus ouvrir');
  const good = await checkCredentials('gdspadmin', 'motdepasse-de-test', ENV);
  assert.equal(good.ok, true);
});

test('un mot de passe bcrypt reste accepté (compatibilité avec l\'ancien service)', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('secret-hache', 4);
  const env = { ADMIN_USERNAME: 'gdspadmin', ADMIN_PASSWORD: hash, JWT_SECRET: ENV.JWT_SECRET };
  assert.equal((await checkCredentials('gdspadmin', 'secret-hache', env)).ok, true);
  assert.equal((await checkCredentials('gdspadmin', 'mauvais', env)).ok, false);
});

test('plusieurs comptes peuvent cohabiter (nom:$2…,autre:secret)', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('un', 4);
  const env = {
    ADMIN_PASSWORD: `direction:${hash},lecture:motdepasse`,
    JWT_SECRET: ENV.JWT_SECRET
  };
  const users = adminUsers(env);
  assert.deepEqual(users.map(u => u.username), ['direction', 'lecture']);
  assert.equal((await checkCredentials('direction', 'un', env)).ok, true);
  assert.equal((await checkCredentials('lecture', 'motdepasse', env)).ok, true);
  assert.equal((await checkCredentials('lecture', 'un', env)).ok, false);
});

test('jamais de secret par défaut : sans JWT_SECRET ni ADMIN_PASSWORD, on refuse', () => {
  // L'ancien backend signait avec "dev-jwt-secret-change-me", une constante du
  // dépôt public : n'importe qui pouvait fabriquer un jeton d'admin.
  assert.throws(
    () => signAdminToken('gdspadmin', { ADMIN_USERNAME: 'gdspadmin' }),
    /impossible de signer un jeton/
  );
  // Avec un ADMIN_PASSWORD, le secret est dérivé de ce mot de passe (secret
  // serveur, jamais public) : le service démarre quand même.
  const derived = signAdminToken('gdspadmin', { ADMIN_PASSWORD: 'motdepasse-de-test' });
  assert.deepEqual(
    verifyAdminToken('Bearer ' + derived, { ADMIN_PASSWORD: 'motdepasse-de-test' }),
    { ok: true, user: 'gdspadmin' }
  );
  // Un autre mot de passe produit un autre secret : le jeton ne passe plus.
  assert.deepEqual(
    verifyAdminToken('Bearer ' + derived, { ADMIN_PASSWORD: 'autre-mot-de-passe' }),
    { ok: false, reason: 'invalid' }
  );
  assert.ok(signAdminToken('gdspadmin', ENV));
});

test('le jeton est un JWT HS256 de 8 h, vérifiable sans base', () => {
  const jwt = require('jsonwebtoken');
  const token = signAdminToken('gdspadmin', ENV);
  const decoded = jwt.decode(token);
  assert.equal(decoded.sub, 'gdspadmin');
  assert.equal(decoded.role, 'admin');
  assert.equal(decoded.exp - decoded.iat, 8 * 60 * 60);
  assert.deepEqual(verifyAdminToken(`Bearer ${token}`, ENV), { ok: true, user: 'gdspadmin' });
});

test('un jeton d\'un autre service (autre secret) est refusé, pas une erreur 500', () => {
  const token = signAdminToken('gdspadmin', { ...ENV, JWT_SECRET: 'un-autre-secret-assez-long' });
  const check = verifyAdminToken(`Bearer ${token}`, ENV);
  assert.deepEqual(check, { ok: false, reason: 'invalid' });
  assert.deepEqual(verifyAdminToken('', ENV), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyAdminToken('Bearer nimportequoi', ENV), { ok: false, reason: 'invalid' });
});

test('un jeton expiré est refusé', () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ sub: 'gdspadmin', role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 }, ENV.JWT_SECRET);
  assert.deepEqual(verifyAdminToken(`Bearer ${expired}`, ENV), { ok: false, reason: 'invalid' });
});

// --- validation --------------------------------------------------------------

test('les règles de slug et d\'objet sont celles de l\'ancien service', () => {
  assert.equal(validSlug('alpha-romeo-cup'), true);
  assert.equal(validSlug('7-gdsp-nissan-r32'), true);
  assert.equal(validSlug('a'), false, 'trop court');
  assert.equal(validSlug('Majuscule'), false);
  assert.equal(validSlug('espace ici'), false);
  assert.equal(validSlug(''), false);
  assert.equal(isNonEmptyObject({}), false);
  assert.equal(isNonEmptyObject({ a: 1 }), true);
  assert.equal(isNonEmptyObject([1]), false);
  assert.equal(isNonEmptyObject(null), false);
  assert.equal(DEFAULT_POINTS.pointsScale.length, 28);
});

// --- contrat des routes ------------------------------------------------------

test('GET /api/events renvoie {events:[…]} avec les champs attendus par site.js', async () => {
  const pool = fakePool([{
    slug: 'alpha-romeo-cup', name: 'alpha romeo cup', kind: 'championship',
    points_config: { polePoints: 1 }, data: {}, updated_at: '2026-11-08T19:36:26.904Z'
  }]);
  const store = new EventStore(pool);
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => store });

  const res = await harness.call('get', '/api/events');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.events));
  const ev = res.body.events[0];
  assert.deepEqual(Object.keys(ev).sort(), ['kind', 'name', 'points_config', 'slug', 'updated_at']);
});

test('GET /api/events/:slug renvoie data, points_config et updated_at', async () => {
  const pool = fakePool([{
    slug: 'alpha-romeo-cup', name: 'alpha romeo cup', kind: 'championship',
    points_config: { jokerCount: 0 }, data: { sessions: [{ date: '2026-11-01' }] }, updated_at: '2026-11-08T19:36:26.904Z'
  }]);
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => new EventStore(pool) });

  const res = await harness.call('get', '/api/events/:slug', { body: { __param: 'alpha-romeo-cup' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.slug, 'alpha-romeo-cup');
  assert.equal(res.body.kind, 'championship');
  assert.ok(Array.isArray(res.body.data.sessions));

  const missing = await harness.call('get', '/api/events/:slug', { body: { __param: 'inconnu-123' } });
  assert.equal(missing.statusCode, 404);
  const bad = await harness.call('get', '/api/events/:slug', { body: { __param: 'Pas Bon' } });
  assert.equal(bad.statusCode, 400);
});

test('POST /api/events exige un jeton, refuse le doublon, applique les barèmes par défaut', async () => {
  const pool = fakePool();
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => new EventStore(pool) });

  const anonymous = await harness.call('post', '/api/events', { body: { slug: 'open-test', name: 'Open test' } });
  assert.equal(anonymous.statusCode, 401);

  const auth = { authorization: `Bearer ${signAdminToken('gdspadmin', ENV)}` };
  const created = await harness.call('post', '/api/events', {
    headers: auth, body: { slug: 'open-test', name: 'Open test', kind: 'open' }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.status, 'ok');
  assert.equal(created.body.event.slug, 'open-test');
  // Un « open » reçoit un coefficient 0,5, comme avant.
  const stored = pool.rows.find(r => r.slug === 'open-test');
  assert.equal(stored.points_config.globalCoef, 0.5);
  assert.equal(stored.points_config.pointsScale.length, 28);

  const duplicate = await harness.call('post', '/api/events', {
    headers: auth, body: { slug: 'open-test', name: 'Encore' }
  });
  assert.equal(duplicate.statusCode, 409);

  const badKind = await harness.call('post', '/api/events', {
    headers: auth, body: { slug: 'autre-test', name: 'Autre', kind: 'inconnu' }
  });
  assert.equal(badKind.statusCode, 400);
});

test('POST /api/events/:slug/data enregistre le championnat et renvoie updatedAt', async () => {
  const pool = fakePool([{
    slug: 'lola-t290-gdsp-championnat-2026', name: 'Lola', kind: 'championship',
    points_config: {}, data: {}, updated_at: null
  }]);
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => new EventStore(pool) });
  const auth = { authorization: `Bearer ${signAdminToken('gdspadmin', ENV)}` };

  const res = await harness.call('post', '/api/events/:slug/data', {
    headers: auth,
    body: { __param: 'lola-t290-gdsp-championnat-2026', sessions: [{ date: '2026-11-08' }], penMap: {} }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.updatedAt, 'site.js n\'affiche pas le résultat sans updatedAt');
  assert.equal(pool.rows[0].data.sessions.length, 1);

  const empty = await harness.call('post', '/api/events/:slug/data', {
    headers: auth, body: { __param: 'lola-t290-gdsp-championnat-2026' }
  });
  assert.equal(empty.statusCode, 400);
});

test('PUT et DELETE suivent le contrat : 400 sur données invalides, 404 sur slug inconnu', async () => {
  const pool = fakePool([{ slug: 'alpha-romeo-cup', name: 'alpha', kind: 'championship', points_config: {}, data: {} }]);
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => new EventStore(pool) });
  const auth = { authorization: `Bearer ${signAdminToken('gdspadmin', ENV)}` };

  const renamed = await harness.call('put', '/api/events/:slug', {
    headers: auth, body: { __param: 'alpha-romeo-cup', name: 'Alpha Romeo Cup 2026' }
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(pool.rows[0].name, 'Alpha Romeo Cup 2026');

  const nothing = await harness.call('put', '/api/events/:slug', { headers: auth, body: { __param: 'alpha-romeo-cup' } });
  assert.equal(nothing.statusCode, 400);

  const badKind = await harness.call('put', '/api/events/:slug', {
    headers: auth, body: { __param: 'alpha-romeo-cup', kind: 'autre' }
  });
  assert.equal(badKind.statusCode, 400);

  const removed = await harness.call('delete', '/api/events/:slug', { headers: auth, body: { __param: 'alpha-romeo-cup' } });
  assert.equal(removed.statusCode, 200);
  const again = await harness.call('delete', '/api/events/:slug', { headers: auth, body: { __param: 'alpha-romeo-cup' } });
  assert.equal(again.statusCode, 404);
});

test('GET /api/championship et POST /api/save-championship restent compatibles', async () => {
  const pool = fakePool();
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => new EventStore(pool) });

  const empty = await harness.call('get', '/api/championship');
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body, { championship: {}, pointsConfig: null, updatedAt: null });

  const auth = { authorization: `Bearer ${signAdminToken('gdspadmin', ENV)}` };
  const saved = await harness.call('post', '/api/save-championship', {
    headers: auth, body: { sessions: [{ date: '2026-11-08' }], penMap: { pilote: 5 } }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.status, 'ok');
  assert.equal(pool.rows[0].slug, 'lola-t290-2026');

  const read = await harness.call('get', '/api/championship');
  assert.equal(read.body.championship.penMap.pilote, 5);
});

test('sans base configurée, la requête est laissée au proxy (le site continue de marcher)', async () => {
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => null });
  const res = await harness.call('get', '/api/events');
  assert.equal(res.delegated, true, 'sans base, on ne casse pas : on délègue');
  assert.equal(res.body, undefined, 'aucune réponse locale');

  // Une base qui échoue à s'ouvrir ne doit pas produire de 500 non plus.
  const failing = fakeApp();
  failing.mount(failing.app, { getStore: async () => { throw new Error('ECONNREFUSED'); } });
  const res2 = await failing.call('get', '/api/events');
  assert.equal(res2.delegated, true);
});

test('la connexion admin reste locale même sans base (aucun jeton sans ADMIN_PASSWORD)', async () => {
  const harness = fakeApp();
  harness.mount(harness.app, { getStore: async () => null });
  const res = await harness.call('post', '/api/admin/login', { body: { username: 'gdspadmin', password: 'motdepasse-de-test' } });
  // Le login ne dépend pas de la base : il signe un jeton et répond.
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test('openEventStore ne tente rien sans URL de base', async () => {
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.EVENTS_DATABASE_URL;
  try {
    assert.equal(await openEventStore(), null);
  } finally {
    process.env = saved;
  }
});

// --- pages publiques sans backend -------------------------------------------

/*
 * Le dernier kilomètre de la fusion : l'accueil, la page d'un événement et le
 * sitemap sont rendus côté serveur. Ils interrogeaient le backend en HTTP ; ils
 * lisent maintenant la base. Ce test lance le vrai `app.js` avec une base
 * factice (aucun backend joignable) et vérifie que les pages sortent quand même.
 */
function fakeEventPool() {
  const events = [
    {
      slug: 'alpha-romeo-cup', name: 'alpha romeo cup', kind: 'championship',
      points_config: { polePoints: 1 },
      data: { eventInfo: { briefing: 'Une manche de démonstration' }, sessions: [{ date: '2026-11-08', track: 'Spa' }] },
      updated_at: '2026-11-08T19:36:26.904Z'
    },
    {
      slug: '7-gdsp-nissan-r32', name: 'Open #7 GDSP', kind: 'archive',
      points_config: {}, data: {}, updated_at: '2026-11-08T20:00:37.809Z'
    }
  ];
  const pool = {
    async query(sql, params = []) {
      const s = sql.trim();
      if (/^CREATE|^SELECT to_regclass/.test(s)) return { rows: [{ tbl: null }], rowCount: 0 };
      if (/^SELECT championship/.test(s)) return { rows: [] };
      if (/^SELECT slug, name, kind, points_config, updated_at/.test(s)) {
        return { rows: events.map(e => ({ slug: e.slug, name: e.name, kind: e.kind, points_config: e.points_config, updated_at: e.updated_at })) };
      }
      if (/^SELECT slug, name, kind, points_config, data/.test(s)) {
        const found = events.find(e => e.slug === params[0]);
        return { rows: found ? [found] : [] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return pool;
}

test('sans backend : accueil, page événement et sitemap sortent depuis la base', async t => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');

  // Un port libre, puis on le libère pour le serveur enfant.
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));

  /*
   * Le vrai `app.js` est lancé, mais `require('pg')` est remplacé par un faux
   * pool (préchargé via --require) : aucune connexion réseau, et le module est
   * intercepté là où il est demandé, c'est-à-dire dans tools/events/api.js.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-pages-'));
  const preload = path.join(dir, 'fake-pg.js');
  fs.writeFileSync(preload, `
    const Module = require('module');
    const fake = { Pool: function () { return (${fakeEventPool.toString()})(); } };
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'pg') return fake;
      return load.call(this, request, parent, isMain);
    };
  `, 'utf8');
  const runner = path.join(dir, 'run.js');
  fs.writeFileSync(runner, `require(${JSON.stringify(path.join(ROOT, 'app.js'))});`, 'utf8');

  const child = spawn(process.execPath, ['--require', preload, runner], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',     // backend volontairement éteint
      DATABASE_URL: 'postgres://faux/faux',
      EVENTS_SOURCE: 'local',
      LIVE_TIMING_ENABLED: '0',
      PUBLIC_SITE_URL: 'https://gdsp.example',
      ADMIN_PASSWORD: 'motdepasse-de-test',
      JWT_SECRET: 'secret-de-test-suffisamment-long'
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('démarrage trop long')), 20000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => {
      if (/Cannot find|SyntaxError/.test(String(chunk))) { clearTimeout(timer); reject(new Error(String(chunk).slice(0, 400))); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('serveur arrêté ' + code)); });
  });
  const get = p => fetch(`http://127.0.0.1:${port}${p}`);

  // 1. Accueil : les deux événements sont listés, avec leurs liens.
  const home = await get('/');
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /href="\/evenements\/alpha-romeo-cup"/);
  assert.match(homeHtml, /href="\/evenements\/7-gdsp-nissan-r32"/);

  // 2. Page événement rendue côté serveur, sans JavaScript.
  const page = await get('/evenements/alpha-romeo-cup');
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /alpha romeo cup/);
  assert.match(pageHtml, /Une manche de démonstration/);

  // 3. Sitemap : les URLs viennent de la base.
  const sitemap = await get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  const xml = await sitemap.text();
  assert.match(xml, /<loc>https:\/\/gdsp\.example\/evenements\/alpha-romeo-cup<\/loc>/);

  // 4. Un slug inexistant reste un 404 : inutile d'interroger un backend mort.
  const missing = await get('/evenements/inexistant-xyz');
  assert.equal(missing.status, 404);
});

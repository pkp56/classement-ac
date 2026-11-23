'use strict';

// Protection de ressources, pas une authentification : le jeton CSP distribué
// dans le script reste public. État volontairement borné et local au processus.
const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMIT = 1200;
const MAX_CLIENTS = 10000;
const BODY_LIMIT = '256kb';

function rateLimitFromEnv(value) {
  if (value == null || value === '') return DEFAULT_LIMIT;
  const n = Number(value);
  // Une configuration invalide ne désactive pas la protection.
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : DEFAULT_LIMIT;
}

function createRateLimiter({ limit = DEFAULT_LIMIT, now = () => Date.now(), maxClients = MAX_CLIENTS } = {}) {
  const entries = new Map();
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const time = now();
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    let entry = entries.get(key);
    if (entry && entry.until <= time) { entries.delete(key); entry = null; }
    if (!entry) {
      if (entries.size >= maxClients) {
        for (const [ip, item] of entries) if (item.until <= time) entries.delete(ip);
        if (entries.size >= maxClients) return res.set('Retry-After', '60').status(429).json({error:'Trop de requêtes télémétrie.', code:'telemetry-rate-limited'});
      }
      entry = { count: 0, until: time + WINDOW_MS };
      entries.set(key, entry);
    }
    if (entry.count >= limit) return res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until-time)/1000))))
      .status(429).json({error:'Trop de requêtes télémétrie. Réessaie plus tard.', code:'telemetry-rate-limited'});
    entry.count++;
    next();
  };
}

// Contrôles de forme communs aux pings, tours et mesures guidées. Pas de rejet
// arbitraire des valeurs sportives : une donnée plausible peut être falsifiée.
function validateEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Charge utile invalide.';
  const fields = {
    kind: 32, script: 80, campaign: 120, serverName: 120, track: 160,
    trackConfig: 80, sessionType: 80, sessionKey: 64, clientSecret: 128,
    car: 120, driverGuid: 64, driverName: 100
  };
  function validField(value, max) {
    return value == null || ((typeof value === 'string' || typeof value === 'number')
      && String(value).length <= max && !/[\x00-\x1f\x7f]/.test(String(value)));
  }
  for (const [key, max] of Object.entries(fields)) if (!validField(payload[key], max)) return `Champ ${key} invalide.`;
  if (payload.driver != null) {
    if (typeof payload.driver !== 'object' || Array.isArray(payload.driver)) return 'Pilote invalide.';
    if (!validField(payload.driver.guid, 64) || !validField(payload.driver.name, 100) || !validField(payload.driver.car, 120)) return 'Pilote invalide.';
  }
  if (payload.laps != null && (!Array.isArray(payload.laps) || payload.laps.length > 200)) return 'Liste de tours invalide.';
  if (payload.measurement != null && (typeof payload.measurement !== 'object' || Array.isArray(payload.measurement))) return 'Mesure invalide.';
  return null;
}

module.exports = { BODY_LIMIT, DEFAULT_LIMIT, createRateLimiter, rateLimitFromEnv, validateEnvelope };

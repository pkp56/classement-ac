'use strict';
/*
 * Point de dépôt des instantanés « live timing » envoyés par un agent distant.
 *
 * Cas d'usage : le serveur Assetto Corsa tourne sur un PC (à la maison), le site
 * GDSP est hébergé ailleurs (Render). Le PC ne peut pas recevoir de connexion
 * entrante, mais il peut envoyer : tools/live-timing/agent.js pousse alors un
 * instantané par seconde en POST /api/live/push.
 *
 * Ce module garde le dernier instantané en mémoire (pas de disque, pas de
 * base) : si le PC s'arrête, la page repasse simplement « hors ligne ».
 */

const MAX_AGE_MS = 20000;      // au-delà, l'instantané est considéré périmé
const MAX_STALE_KEEP_MS = 300000; // on garde la dernière photo 5 min pour l'afficher

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Vérifie la forme d'un instantané poussé. On reste tolérant sur le contenu
 * (l'agent et le site partagent le même code) mais strict sur l'essentiel.
 * @returns {{ok:boolean,error?:string}}
 */
function validateSnapshot(s) {
  if (!isPlainObject(s)) return { ok: false, error: 'instantané absent' };
  if (!isPlainObject(s.server)) return { ok: false, error: 'server manquant' };
  if (!isPlainObject(s.session)) return { ok: false, error: 'session manquante' };
  if (!Array.isArray(s.cars)) return { ok: false, error: 'cars doit être un tableau' };
  if (s.cars.length > 200) return { ok: false, error: 'trop de voitures' };
  for (const c of s.cars) {
    // carId n'existe pas pour les sources HTTP (pas d'identifiant de voiture) :
    // seule l'identité du pilote est obligatoire.
    if (!isPlainObject(c) || typeof c.name !== 'string') {
      return { ok: false, error: 'voiture invalide' };
    }
    if (c.carId != null && typeof c.carId !== 'number') {
      return { ok: false, error: 'carId invalide' };
    }
  }
  if (s.events != null && !Array.isArray(s.events)) return { ok: false, error: 'events doit être un tableau' };
  if (s.bestLaps != null && !Array.isArray(s.bestLaps)) return { ok: false, error: 'bestLaps doit être un tableau' };
  return { ok: true };
}

/** Réécrit l'état pour qu'il reflète la réception côté site. */
function decorate(snapshot, receivedAt, ttlMs) {
  const ageMs = Math.max(0, Date.now() - receivedAt);
  const fresh = ageMs <= ttlMs;
  const original = isPlainObject(snapshot.status) ? snapshot.status : {};
  // On conserve le mode d'origine quand l'agent relaie une source HTTP
  // (« http-remote ») : la page garde ainsi son bandeau « lecture seule ».
  const mode = original.mode === 'http-remote' ? 'http-remote' : 'push';
  return {
    ...snapshot,
    status: {
      ...original,
      mode,
      pushed: true,
      status: fresh ? 'live' : 'stale',
      pushedFrom: original.host || null,
      receivedAt: new Date(receivedAt).toISOString(),
      receivedAgoMs: ageMs,
      fresh
    },
    servedAt: new Date().toISOString()
  };
}

class PushHub {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || MAX_AGE_MS);
    this.snapshot = null;
    this.receivedAt = 0;
  }

  publish(snapshot) {
    const check = validateSnapshot(snapshot);
    if (!check.ok) return { ok: false, error: check.error };
    this.snapshot = snapshot;
    this.receivedAt = Date.now();
    return { ok: true, at: this.receivedAt };
  }

  /** Instantané frais (ou récemment périmé), sinon null. */
  current(now = Date.now()) {
    if (!this.snapshot) return null;
    const ageMs = now - this.receivedAt;
    if (ageMs > MAX_STALE_KEEP_MS) return null;
    return decorate(this.snapshot, this.receivedAt, this.ttlMs);
  }

  ageMs(now = Date.now()) {
    return this.snapshot ? now - this.receivedAt : null;
  }

  clear() {
    this.snapshot = null;
    this.receivedAt = 0;
  }
}

module.exports = { PushHub, validateSnapshot, decorate, MAX_AGE_MS };

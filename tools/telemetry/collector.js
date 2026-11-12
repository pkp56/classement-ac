'use strict';
/*
 * Collecteur de télémétrie — écrit les tours dans le schéma `telemetry`.
 *
 * Deux sources, dans cet ordre :
 *  1. WRAPPER de l'agent live timing : on lui donne un instantané (celui déjà
 *     produit par tools/live-timing) et il en extrait les tours terminés ;
 *  2. API publique : `recordLap()` / `openSession()` pour un branchement
 *     manuel (script CSP, import CSV, tests).
 *
 * Ce qui n'est PAS mesuré reste `null` : le collecteur n'invente jamais un
 * carburant ou une usure. Un tour sans mesure de conso peut entrer dans le
 * calcul du tour médian (chrono fiable), mais pas dans celui du BoP carburant.
 */

const { openStore } = require('./store');

/** Identifie un tour de façon stable pour ne jamais le compter deux fois. */
function lapKey(lap) {
  // Quand la source fournit un numéro de tour, c'est lui qui identifie le tour :
  // un renvoi du même tour avec un temps arrondi différemment reste un doublon.
  // Sans numéro de tour, on ne peut se fier qu'au couple (voiture, temps).
  const numbered = lap.lapNumber != null;
  return [
    lap.sessionId != null ? lap.sessionId : lap.sessionKey || '',
    lap.driverGuid || lap.driver_guid || '',
    lap.car || '',
    numbered ? 'n' + lap.lapNumber : 't' + (lap.lapMs != null ? Math.round(lap.lapMs) : '')
  ].join('|');
}

class TelemetryCollector {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options;
    this.seen = new Set();
    this.currentSession = null;
    this.lapCounter = new Map(); // guid|car → dernier numéro de tour
    this.stats = { laps: 0, duplicates: 0, sessions: 0 };
  }

  /**
   * Ouvre une session de test. Le contexte (météo, grip, rates serveur) est
   * obligatoire : sans lui, deux sessions ne seraient pas comparables.
   */
  async openSession(info) {
    const row = {
      started_at: info.startedAt || new Date().toISOString(),
      server_name: info.serverName || null,
      track: info.track || null,
      track_config: info.trackConfig || null,
      session_type: info.sessionType || null,
      air_temp_c: numOrNull(info.airTempC),
      road_temp_c: numOrNull(info.roadTempC),
      grip: numOrNull(info.grip),
      weather: info.weather || null,
      fuel_rate: numOrNull(info.fuelRate),
      tyre_wear_rate: numOrNull(info.tyreWearRate),
      campaign: info.campaign || null,
      notes: info.notes || null
    };
    if (!row.track) throw new Error('une session de télémétrie doit préciser le circuit');
    const inserted = await this.store.insert('session', row);
    this.currentSession = inserted;
    this.stats.sessions += 1;
    return inserted;
  }

  /**
   * Enregistre un tour. Champs reconnus (snake_case ou camelCase) :
   * driverGuid, driverName, car, lapMs, lapNumber, cuts, fuelUsedL, fuelLoadedL,
   * tyreWearPct (+ par roue), tyreTempAvgC, speedMaxKmh, measured.
   */
  async recordLap(lap) {
    if (!this.currentSession) throw new Error('aucune session ouverte : appelle openSession() d\'abord');
    const lapMs = Number(lap.lapMs != null ? lap.lapMs : lap.lap_ms);
    if (!Number.isFinite(lapMs) || lapMs <= 0) throw new Error('tour invalide : LapTime manquant');
    if (!lap.driverGuid && !lap.driver_guid) throw new Error('tour invalide : identité pilote (guid) manquante');
    if (!lap.car) throw new Error('tour invalide : voiture manquante');

    const driverGuid = lap.driverGuid || lap.driver_guid;
    const counterKey = `${driverGuid}|${lap.car}`;
    const autoNumber = (this.lapCounter.get(counterKey) || 0) + 1;
    const lapNumber = lap.lapNumber != null ? Number(lap.lapNumber) : autoNumber;

    const row = {
      session_id: this.currentSession.id,
      stint_id: lap.stintId || null,
      driver_guid: driverGuid,
      driver_name: lap.driverName || null,
      car: lap.car,
      lap_number: lapNumber,
      lap_ms: Math.round(lapMs),
      cuts: lap.cuts != null ? Number(lap.cuts) : 0,
      fuel_used_l: numOrNull(lap.fuelUsedL != null ? lap.fuelUsedL : lap.fuelUsed),
      fuel_loaded_l: numOrNull(lap.fuelLoadedL),
      tyre_wear_pct: numOrNull(lap.tyreWearPct),
      tyre_wear_fl: numOrNull(lap.tyreWearFl),
      tyre_wear_fr: numOrNull(lap.tyreWearFr),
      tyre_wear_rl: numOrNull(lap.tyreWearRl),
      tyre_wear_rr: numOrNull(lap.tyreWearRr),
      tyre_temp_avg_c: numOrNull(lap.tyreTempAvgC),
      speed_max_kmh: lap.speedMaxKmh != null ? Math.round(Number(lap.speedMaxKmh)) : null,
      // `measured` par défaut : true si la conso ou l'usure est fournie, sinon
      // le chrono seul reste mesuré (on peut l'utiliser pour les temps).
      measured: lap.measured !== false
    };

    // Déduplication : on ne peut reconnaître un doublon que si la SOURCE fournit
    // le numéro de tour (cas des instantanés du live timing, ou d'un import).
    // Un numéro auto-incrémenté ne prouve rien : il ne doit jamais servir de clé.
    const sourceNumbered = lap.lapNumber != null;
    const key = lapKey({
      sessionId: this.currentSession.id,
      driverGuid,
      car: lap.car,
      lapNumber: sourceNumbered ? lapNumber : null,
      lapMs: row.lap_ms
    });
    if (this.seen.has(key)) { this.stats.duplicates += 1; return null; }
    this.seen.add(key);
    if (!sourceNumbered) this.lapCounter.set(counterKey, Math.max(lapNumber, autoNumber));

    const inserted = await this.store.insert('lap', row);
    this.stats.laps += 1;
    return inserted;
  }

  /**
   * Traduit un instantané du live timing en tours terminés.
   * Le live timing ne fournit que « dernier tour » et « nombre de tours » : on
   * enregistre donc un tour quand le compteur augmente. On ne réinvente pas de
   * conso ni d'usure ici : on ne les a pas (elles viendront du script CSP).
   */
  async ingestSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cars)) return { added: 0 };
    const track = snapshot.server && snapshot.server.track;
    if (!this.currentSession) {
      this.currentSession = await this.openSession({
        track: track || 'inconnu',
        trackConfig: snapshot.server && snapshot.server.trackConfig,
        sessionType: snapshot.session && (snapshot.session.type || snapshot.session.name),
        serverName: snapshot.server && snapshot.server.name,
        airTempC: snapshot.server && snapshot.server.ambientTemp,
        roadTempC: snapshot.server && snapshot.server.roadTemp
      });
    }
    let added = 0;
    for (const car of snapshot.cars) {
      if (!car || !car.connected) continue;
      if (car.lastLapMs == null) continue;
      if (car.guid == null && car.driverGuid == null) continue; // pas d'identité stable → on n'invente pas
      try {
        const row = await this.recordLap({
          driverGuid: car.guid || car.driverGuid,
          driverName: car.name,
          car: car.model || car.car || 'inconnue',
          lapMs: car.lastLapMs,
          lapNumber: car.laps != null ? Number(car.laps) : null,
          cuts: car.lastLapCuts,
          speedMaxKmh: car.speedKmh,
          measured: true
        });
        if (row) added += 1;
      } catch (e) {
        // Un tour inutilisable ne doit pas arrêter la collecte de tous les autres.
      }
    }
    return { added };
  }

  async close() {
    if (this.currentSession) {
      try { await this.store.insert('session', Object.assign({}, this.currentSession, { ended_at: new Date().toISOString() })); } catch (e) { /* best-effort */ }
    }
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function createCollector(options = {}) {
  const store = await openStore(options);
  return new TelemetryCollector(store, options);
}

module.exports = { TelemetryCollector, createCollector, lapKey, numOrNull };

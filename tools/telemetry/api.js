'use strict';
/*
 * Service de télémétrie — la partie « en ligne » de l'application séparée.
 *
 * Il reçoit les tours envoyés par le script CSP poussé aux pilotes
 * (`csp/gdsp_telemetry.lua` → POST /api/telemetry/push), les écrit dans le
 * schéma `telemetry`, et répond aux questions du panneau admin :
 *   - quelles voitures / quels circuits / quels pilotes j'ai déjà vus ;
 *   - le tour médian, la conso et l'usure par voiture, **filtrés** ;
 *   - le rapport BoP 20 / 30 / 45 minutes en CSV, Markdown et HTML.
 *
 * Règles héritées de `store.js` et `bop.js`, jamais contournées ici :
 *   1. ce qui n'est pas mesuré reste `null` (aucune valeur inventée) ;
 *   2. aucune requête ne sort du schéma `telemetry` : ce module ne connaît ni
 *      le championnat, ni les événements, ni les fiches pilotes.
 */

const crypto = require('node:crypto');
const { openStore } = require('./store');
const { carProfile, driverCarMatrix, field, plausibleCarId } = require('./aggregate');
const { buildReport } = require('./export');
const { lapStats, avg } = require('./bop');

const MAX_LAPS_PER_PUSH = 200;
const MEASUREMENT_CLIENT_TTL_MS = 15000;
const MEASUREMENT_CLIENT_RETENTION_MS = 6 * 60 * 60 * 1000;
const PIT_MEASUREMENT_TYPES = new Set(['tyre', 'refuel']);
const PIT_MEASUREMENT_PHASES = new Set([
  'before_lap', 'wait_pit_entry', 'pit_lane', 'service',
  'wait_pit_exit', 'after_lap', 'complete', 'failed'
]);

/** Nombre fini ou null (jamais 0 de complaisance). */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positive(v) {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/** Secteurs réellement mesurés en millisecondes ; les trous restent null. */
function sectorTimes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const out = value.map(v => {
    const ms = positive(v);
    return ms != null && ms <= 600000 ? Math.round(ms) : null;
  });
  return out.some(v => v != null) ? out : null;
}

function normalizeServerName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function normalizeTrackId(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '..');
  return String(parts[parts.length - 1] || value || '').trim().toLocaleLowerCase();
}

function normalizeCarId(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function mergeBestSectors(previous, current) {
  if (!current) return previous || null;
  if (!previous || previous.length !== current.length) return current;
  return current.map((ms, i) => {
    const old = previous[i];
    if (ms == null) return old == null ? null : old;
    if (old == null) return ms;
    return Math.min(ms, old);
  });
}

function sumSectors(sectors) {
  if (!Array.isArray(sectors) || !sectors.length || sectors.some(ms => !(ms > 0))) return null;
  return sectors.reduce((sum, ms) => sum + ms, 0);
}

/**
 * Valide un envoi du script CSP. Tolérant sur la forme (le script est le même
 * pour tous les serveurs, il peut évoluer), strict sur l'essentiel : sans
 * circuit, sans pilote et sans voiture, un tour n'est pas exploitable.
 * @returns {{ok:boolean,error?:string,clean?:object}}
 */
function validatePush(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'charge utile absente' };
  }
  // Ping de démarrage du script CSP : il n'apporte aucune mesure, il prouve
  // seulement que la chaîne script → réseau → jeton fonctionne. On l'accepte
  // sans rien stocker, sinon le diagnostic le plus utile du dispositif serait
  // celui qui renvoie une erreur.
  if (payload.kind === 'ping') {
    return {
      ok: true,
      ping: true,
      clean: {
        track: String(payload.track || '').trim(),
        car: String(payload.car || '').trim(),
        driverGuid: String((payload.driver && payload.driver.guid) || '').trim()
      }
    };
  }
  const track = String(payload.track || '').trim();
  if (!track) return { ok: false, error: 'circuit manquant' };
  const driver = payload.driver && typeof payload.driver === 'object' ? payload.driver : {};
  const driverGuid = String(driver.guid || payload.driverGuid || '').trim();
  const car = String(payload.car || driver.car || '').trim();
  const laps = Array.isArray(payload.laps) ? payload.laps : [];
  if (!laps.length) return { ok: false, error: 'aucun tour dans l\'envoi' };
  if (laps.length > MAX_LAPS_PER_PUSH) return { ok: false, error: 'trop de tours dans un envoi' };
  if (!driverGuid) return { ok: false, error: 'identité pilote (guid) manquante' };
  if (!car) return { ok: false, error: 'voiture manquante' };

  const clean = [];
  let skipped = 0;
  for (const raw of laps) {
    if (!raw || typeof raw !== 'object') continue;
    const lapMs = positive(field(raw, 'lapMs', 'lap_ms'));
    if (!lapMs) { skipped += 1; continue; }     // un tour sans temps n'existe pas
    // L'usure arrive par roue, en % consommé sur le tour (c'est ce que le
    // script envoie), ou sous forme scalaire.
    const wheels = Array.isArray(raw.wheels) ? raw.wheels.map(num)
      : Array.isArray(raw.tyreWearPct) ? raw.tyreWearPct.map(num) : null;
    const wheelAvg = wheels && wheels.every(v => v != null && v >= 0)
      ? wheels.reduce((a, b) => a + b, 0) / wheels.length
      : null;
    const wearPctField = num(field(raw, 'tyreWearPct', 'tyre_wear_pct', 'wearPct'));
    // Un scalaire peut être un pourcentage ou une fraction 0–1 d'origine
    // inconnue. Les deux domaines se recouvrent entre 0,3 et 1, mais un
    // pourcentage d'usure par tour y est courant alors qu'une fraction y serait
    // énorme (30 % à 100 % par tour). On ne convertit donc que sous 0,2 : une
    // fraction plausible (0,014 = 1,4 %) ne se confond jamais avec un
    // pourcentage. Au-delà, la valeur est déjà en pourcentage.
    const wearPct = wearPctField != null
      ? (wearPctField > 0 && wearPctField <= 0.2 ? wearPctField * 100 : wearPctField)
      : (wheelAvg != null ? wheelAvg : null);
    clean.push({
      lapNumber: num(field(raw, 'lapNumber', 'lap_number')),
      lapMs: Math.round(lapMs),
      cuts: Math.max(0, Math.round(num(field(raw, 'cuts')) || 0)),
      fuelUsedL: positive(field(raw, 'fuelUsedL', 'fuel_used_l', 'fuelUsed')),
      fuelLoadedL: positive(field(raw, 'fuelLoadedL', 'fuel_loaded_l', 'fuelLoaded')),
      tyreWearPct: wearPct != null && wearPct > 0 ? wearPct : null,
      // Les valeurs par roue ne sont conservées que si elles sont dans le même
      // domaine que la moyenne (mêmes unités), sinon elles induiraient en erreur.
      tyreWearFl: wheels && wearPctField == null ? num(wheels[0]) : null,
      tyreWearFr: wheels && wearPctField == null ? num(wheels[1]) : null,
      tyreWearRl: wheels && wearPctField == null ? num(wheels[2]) : null,
      tyreWearRr: wheels && wearPctField == null ? num(wheels[3]) : null,
      speedMaxKmh: num(field(raw, 'speedMaxKmh', 'speed_max_kmh')),
      // Durée mesurée par le script CSP entre le plateau du limiteur à 80 et
      // sa sortie. Pas de valeur par défaut : sans passage détecté, c'est null.
      pitLaneMs: (() => {
        const ms = positive(field(raw, 'pitLaneMs', 'pit_lane_ms'));
        return ms != null && ms <= 600000 ? Math.round(ms) : null;
      })(),
      bestLapMs: positive(field(raw, 'bestLapMs', 'best_lap_ms')),
      lastSectorsMs: sectorTimes(field(raw, 'lastSectorsMs', 'last_sectors_ms')),
      bestLapSectorsMs: sectorTimes(field(raw, 'bestLapSectorsMs', 'best_lap_sectors_ms')),
      bestSectorsMs: sectorTimes(field(raw, 'bestSectorsMs', 'best_sectors_ms')),
      measured: raw.measured !== false
    });
  }
  if (!clean.length) return { ok: false, error: 'aucun tour exploitable (temps manquant)' };

  return {
    ok: true,
    skipped,          // tours écartés (temps manquant) : le client l'affiche
    clean: {
      track,
      sessionKey: String(payload.sessionKey || '').trim().slice(0, 64) || null,
      trackConfig: payload.trackConfig || null,
      sessionType: payload.sessionType || null,
      serverName: String(payload.serverName || '').trim().slice(0, 120) || null,
      campaign: payload.campaign || null,
      airTempC: num(payload.airTempC),
      roadTempC: num(payload.roadTempC),
      grip: num(payload.grip),
      fuelRate: num(payload.fuelRate),
      tyreWearRate: num(payload.tyreWearRate),
      driverGuid,
      driverName: String(driver.name || payload.driverName || '').trim() || null,
      car,
      laps: clean
    }
  };
}

/**
 * Profil pit-lane indépendant de la voiture : les passages de tous les pilotes
 * et modèles du même circuit/configuration alimentent la médiane commune.
 */
function pitProfileFromRows(track, trackConfig, profiles, rows) {
  if (!track) return null;
  const candidates = profiles.filter(row => row.track === track);
  const exact = candidates.find(row => (row.track_config || null) === (trackConfig || null));
  const generic = candidates.find(row => !row.track_config);
  const row = exact || generic || null;
  const samples = rows.filter(lap => lap.track === track
    && (lap.track_config || null) === (trackConfig || null)
    && lap.measured !== false)
    .map(lap => num(lap.pit_lane_ms))
    .filter(ms => ms != null && ms > 0);
  const automaticPitLaneMs = lapStats(samples).median;
  const manualPitLaneMs = row ? positive(row.pit_lane_loss_ms) : null;
  const manualRefuelRateLps = row ? positive(row.refuel_rate_lps) : null;
  const automaticRefuelRateLps = row ? positive(row.automatic_refuel_rate_lps) : null;
  const manualTyreChangeMs = row ? positive(row.tyre_change_ms) : null;
  const automaticTyreChangeMs = row ? positive(row.automatic_tyre_change_ms) : null;
  if (!row && automaticPitLaneMs == null) return null;
  return {
    pit_lane_loss_ms: manualPitLaneMs != null ? manualPitLaneMs : automaticPitLaneMs,
    manual_pit_lane_loss_ms: manualPitLaneMs,
    automatic_pit_lane_loss_ms: automaticPitLaneMs,
    pit_lane_samples: samples.length,
    refuel_rate_lps: manualRefuelRateLps != null ? manualRefuelRateLps : automaticRefuelRateLps,
    manual_refuel_rate_lps: manualRefuelRateLps,
    automatic_refuel_rate_lps: automaticRefuelRateLps,
    tyre_change_ms: manualTyreChangeMs != null ? manualTyreChangeMs : automaticTyreChangeMs,
    manual_tyre_change_ms: manualTyreChangeMs,
    automatic_tyre_change_ms: automaticTyreChangeMs,
    source: manualPitLaneMs != null
      ? (row.source || 'mesure manuelle')
      : automaticPitLaneMs != null
        ? 'mesure automatique (limiteur 80 km/h)'
        : (row && row.source) || null
  };
}

/**
 * Service applicatif : un seul point d'entrée pour la route HTTP et les tests.
 */
class TelemetryService {
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now || (() => new Date());
    this.sessions = new Map();       // clé de session → ligne en base
    this.liveSectors = new Map();    // mémoire RAM par serveur/circuit/pilote/voiture
    this.measurementClients = new Map(); // CSP connectés, baux courts en mémoire
    this.pitMeasurements = new Map();    // procédures guidées en cours/récentes
    this.activePitMeasurementBySession = new Map();
    this.received = { pushes: 0, laps: 0, rejected: 0 };
  }

  rememberLiveSectors(info) {
    if (!info.serverName || !info.track || !info.driverName || !info.driverGuid || !info.car) return;
    const serverKey = normalizeServerName(info.serverName);
    const trackKey = normalizeTrackId(info.track);
    const carKey = normalizeCarId(info.car);
    // Mémoire par combo serveur/circuit/pilote/voiture : les courses suivantes
    // du même combo mettent à jour la même entrée, sans mélanger deux voitures.
    const key = JSON.stringify([serverKey, trackKey, info.driverGuid, carKey]);
    const now = Date.now();
    let record = this.liveSectors.get(key) || null;
    if (record && record.sessionKey !== info.sessionKey) {
      // Nouvelle séance pour ce combo : conserver les meilleurs temps mesurés,
      // mais ne pas présenter le dernier tour de la séance précédente comme
      // celui de la nouvelle.
      record = {
        ...record,
        serverName: info.serverName,
        track: info.track,
        sessionType: info.sessionType,
        sessionKey: info.sessionKey,
        driverName: info.driverName,
        car: info.car,
        lastLapMs: null,
        lastSectorsMs: null
      };
    }

    for (const lap of info.laps) {
      const previous = record;
      const previousBestLapMs = (previous && previous.bestLapMs) || null;
      let bestLapMs = previousBestLapMs;
      if (lap.bestLapMs) bestLapMs = bestLapMs ? Math.min(bestLapMs, lap.bestLapMs) : lap.bestLapMs;
      const lapIsBest = lap.cuts === 0 && (!bestLapMs || lap.lapMs < bestLapMs);
      if (lapIsBest) bestLapMs = lap.lapMs;
      const bestLapChanged = bestLapMs != null && (previousBestLapMs == null || bestLapMs < previousBestLapMs);
      let bestLapSectorsMs = (previous && previous.bestLapSectorsMs) || null;
      const bestLapSectorsMatch = !!lap.bestLapSectorsMs && (
        (lap.bestLapMs != null && lap.bestLapMs === bestLapMs) ||
        (lap.cuts === 0 && lap.lapMs === bestLapMs)
      );
      if (bestLapChanged) {
        // Le chrono record vient de changer : n'hériter des secteurs précédents
        // que s'ils accompagnent bien ce nouveau record.
        bestLapSectorsMs = bestLapSectorsMatch ? lap.bestLapSectorsMs : null;
        if (!bestLapSectorsMs && lap.cuts === 0 && lap.lastSectorsMs && lap.lapMs === bestLapMs) {
          bestLapSectorsMs = lap.lastSectorsMs;
        }
      } else if (!bestLapSectorsMs && bestLapSectorsMatch) {
        // Comble un secteur record jusque-là indisponible, sans remplacer un
        // meilleur tour historique par le meilleur d'une séance plus lente.
        bestLapSectorsMs = lap.bestLapSectorsMs;
      }
      record = {
        serverName: info.serverName,
        track: info.track,
        sessionType: info.sessionType,
        sessionKey: info.sessionKey,
        driverGuid: info.driverGuid,
        driverName: info.driverName,
        car: info.car,
        lastLapMs: lap.lapMs,
        lastSectorsMs: lap.lastSectorsMs || null,
        bestLapMs,
        bestLapSectorsMs,
        bestSectorsMs: mergeBestSectors(previous && previous.bestSectorsMs, lap.bestSectorsMs),
        receivedAt: now
      };
    }
    if (record) this.liveSectors.set(key, record);
  }

  liveSectorTimes(filters = {}) {
    const wantedServer = normalizeServerName(filters.serverName);
    const wantedTrack = normalizeTrackId(filters.track);
    const out = [];
    for (const entry of this.liveSectors.values()) {
      if (wantedServer && normalizeServerName(entry.serverName) !== wantedServer) continue;
      if (wantedTrack && normalizeTrackId(entry.track) !== wantedTrack) continue;
      out.push({
        serverName: entry.serverName,
        track: entry.track,
        sessionType: entry.sessionType,
        driverName: entry.driverName,
        car: entry.car,
        lastLapMs: entry.lastLapMs,
        lastSectorsMs: entry.lastSectorsMs,
        bestLapMs: entry.bestLapMs,
        bestLapSectorsMs: entry.bestLapSectorsMs,
        bestSectorsMs: entry.bestSectorsMs,
        potentialLapMs: sumSectors(entry.bestSectorsMs),
        updatedAt: new Date(entry.receivedAt).toISOString()
      });
    }
    return out.sort((a, b) => {
      const driverOrder = String(a.driverName).localeCompare(String(b.driverName), 'fr');
      return driverOrder || String(a.car).localeCompare(String(b.car), 'fr');
    });
  }

  /** Retrouve (ou ouvre) la session correspondant au contexte envoyé. */
  async ensureSession(info) {
    // Avec une clé de séance (fournie par le script CSP), chaque course est
    // une session à part : les tours 1-2-3 d'une NOUVELLE course ne sont pas
    // des doublons de la précédente. Sans clé (ancien script, ping), on
    // regroupe comme avant par circuit/config/type/campagne.
    const key = info.sessionKey
      ? 'key:' + info.sessionKey
      : [info.track, info.trackConfig || '', info.sessionType || '', info.campaign || ''].join('|');
    if (this.sessions.has(key)) return this.sessions.get(key);
    let existing = [];
    try {
      existing = info.sessionKey
        ? await this.store.select('session', { session_key: info.sessionKey })
        : await this.store.select('session', { track: info.track });
    } catch (e) { /* base vide */ }
    const match = existing
      .filter(row => info.sessionKey
        ? true
        : (row.track_config || null) === (info.trackConfig || null)
          && (row.session_type || null) === (info.sessionType || null)
          && (row.campaign || null) === (info.campaign || null))
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (match) {
      this.sessions.set(key, match);
      return match;
    }
    const row = {
      started_at: this.now().toISOString(),
      session_key: info.sessionKey || null,
      server_name: info.serverName,
      track: info.track,
      track_config: info.trackConfig,
      session_type: info.sessionType,
      air_temp_c: info.airTempC,
      road_temp_c: info.roadTempC,
      grip: info.grip,
      weather: null,
      fuel_rate: info.fuelRate,
      tyre_wear_rate: info.tyreWearRate,
      campaign: info.campaign,
      notes: null
    };
    const inserted = await this.store.insert('session', row);
    this.sessions.set(key, inserted);
    return inserted;
  }

  /**
   * Enregistre un envoi. Idempotent : le même tour renvoyé deux fois (le script
   * réessaie quand le réseau tombe) n'est compté qu'une fois, grâce au numéro
   * de tour fourni par la source.
   * @returns {Promise<{ok:boolean, added:number, duplicates:number, sessionId?:number, error?:string}>}
   */
  async ingest(payload) {
    const check = validatePush(payload);
    if (!check.ok) {
      this.received.rejected += 1;
      return { ok: false, error: check.error, added: 0, duplicates: 0 };
    }
    const info = check.clean;
    if (check.ping) {
      // Rien n'est écrit : un ping n'est pas une mesure. On le journalise pour
      // qu'il apparaisse dans les logs Render — c'est le point de repère qui
      // dit « le script tourne et le réseau passe ».
      console.log(`télémétrie: ping reçu — circuit=${info.track || '?'} voiture=${info.car || '?'} pilote=${info.driverGuid || '?'}`);
      return { ok: true, ping: true, added: 0, duplicates: 0, sessionId: null };
    }
    const session = await this.ensureSession(info);
    this.rememberLiveSectors(info);
    const stored = await this.store.select('lap', { session_id: session.id });
    const seen = new Set(stored.map(row => `${row.driver_guid}|${row.car}|${row.lap_number}`));

    let added = 0;
    let duplicates = 0;
    for (const lap of info.laps) {
      const lapNumber = lap.lapNumber;
      if (lapNumber != null) {
        const key = `${info.driverGuid}|${info.car}|${lapNumber}`;
        if (seen.has(key)) { duplicates += 1; continue; }
        seen.add(key);
      }
      await this.store.insert('lap', {
        session_id: session.id,
        stint_id: null,
        driver_guid: info.driverGuid,
        driver_name: info.driverName,
        car: info.car,
        lap_number: lapNumber,
        lap_ms: lap.lapMs,
        cuts: lap.cuts,
        fuel_used_l: lap.fuelUsedL,
        fuel_loaded_l: lap.fuelLoadedL,
        tyre_wear_pct: lap.tyreWearPct,
        tyre_wear_fl: lap.tyreWearFl,
        tyre_wear_fr: lap.tyreWearFr,
        tyre_wear_rl: lap.tyreWearRl,
        tyre_wear_rr: lap.tyreWearRr,
        tyre_temp_avg_c: null,
        speed_max_kmh: lap.speedMaxKmh != null ? Math.round(lap.speedMaxKmh) : null,
        pit_lane_ms: lap.pitLaneMs,
        measured: lap.measured
      });
      added += 1;
    }
    this.received.pushes += 1;
    this.received.laps += added;
    return { ok: true, added, duplicates, skipped: check.skipped || 0, sessionId: session.id };
  }

  /** Toutes les lignes (sessions + tours), jointes en mémoire. */
  async rows(filters = {}) {
    const sessions = await this.store.select('session');
    const laps = await this.store.select('lap');
    const byId = new Map(sessions.map(s => [s.id, s]));
    const out = [];
    for (const lap of laps) {
      const session = byId.get(lap.session_id);
      if (!session) continue;
      out.push({
        ...lap,
        track: session.track,
        track_config: session.track_config,
        session_type: session.session_type,
        campaign: session.campaign,
        fuel_rate: session.fuel_rate,
        tyre_wear_rate: session.tyre_wear_rate,
        started_at: session.started_at
      });
    }
    return filterRows(out, filters);
  }

  /** Valeurs réellement présentes, pour construire les listes déroulantes. */
  async catalog() {
    const rows = await this.rows();
    const uniq = key => [...new Set(rows.map(r => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'fr'));
    return {
      tracks: uniq('track'),
      cars: uniq('car'),
      drivers: uniq('driver_guid'),
      driverNames: Object.fromEntries(rows.filter(r => r.driver_guid).map(r => [r.driver_guid, r.driver_name || r.driver_guid])),
      campaigns: uniq('campaign'),
      sessions: [...new Set(rows.map(r => `${r.track}|${r.session_type || ''}|${r.started_at}`))]
    };
  }

  /**
   * Agrégat par voiture × circuit × layout (et par pilote quand demandé).
   * Les valeurs non mesurées restent `null` : la page affiche « — ».
   */
  async summary(filters = {}) {
    const rows = await this.rows(filters);
    const groups = new Map();
    for (const row of rows) {
      // Une voiture ne doit jamais agréger des tours de circuits ou layouts
      // différents : sinon la médiane, la consommation et l'usure deviennent
      // des mélanges impossibles à interpréter.
      const key = JSON.stringify([
        row.car || '', row.track || '', row.track_config || null,
        filters.byDriver ? (row.driver_guid || '') : null
      ]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Le pit-lane est un temps du circuit/layout, pas de la voiture. Mesures
    // automatiques de toutes les voitures et profil manuel sont donc partagés
    // par chaque ligne de voiture du même contexte.
    const pitContexts = new Map();
    for (const laps of groups.values()) {
      const { track, track_config: trackConfig } = laps[0];
      const key = JSON.stringify([track || '', trackConfig || null]);
      if (!pitContexts.has(key)) pitContexts.set(key, { track, trackConfig: trackConfig || null });
    }
    let pitProfiles = new Map();
    if (pitContexts.size) {
      // Une lecture globale suffit même si l'écran agrège plusieurs voitures :
      // les filtres voiture/pilote/campagne ne doivent pas réduire les passages
      // qui servent au profil partagé du circuit.
      const pitRowsPromise = filters.car || filters.driver || filters.campaign
        ? this.rows()
        : Promise.resolve(rows);
      const [storedProfiles, pitRows] = await Promise.all([
        this.store.select('circuit_profile'), pitRowsPromise
      ]);
      pitProfiles = new Map([...pitContexts].map(([key, context]) => [
        key, pitProfileFromRows(context.track, context.trackConfig, storedProfiles, pitRows)
      ]));
    }

    const cars = [];
    const loaded = rows.map(r => num(r.fuel_loaded_l)).filter(v => v != null && v > 0);
    for (const [key, laps] of groups) {
      const [car, track, trackConfig, driver] = JSON.parse(key);
      const profile = carProfile({ car, track, trackConfig }, laps);
      const stats = lapStats(laps.map(l => ({ ms: Number(l.lap_ms) })));
      const pit = pitProfiles.get(JSON.stringify([track || '', trackConfig || null]));
      // Capacité : le plus gros plein vu, pas une valeur devinée.
      const fuelLoadedMax = Math.max(0, ...laps.map(l => num(l.fuel_loaded_l) || 0));
      const wear = laps.map(l => num(l.tyre_wear_pct)).filter(v => v != null && v > 0);
      cars.push({
        car,
        unidentified: !plausibleCarId(car),
        driver,
        driverName: driver ? (laps[0].driver_name || driver) : null,
        track,
        trackConfig,
        campaign: laps[0].campaign || null,
        laps: stats.count,
        bestLapMs: stats.best,
        medianLapMs: stats.median,
        stdevMs: stats.stdev,
        fuelPerLap: profile.fuelPerLap,
        tyreWearPerLap: avg(wear),
        fuelCapacity: fuelLoadedMax > 0 ? fuelLoadedMax : null,
        speedMaxKmh: profile.maxSpeedKmh,
        pitLaneLossMs: pit ? pit.pit_lane_loss_ms : null,
        pitLaneSamples: pit ? pit.pit_lane_samples : 0,
        pitLaneSource: pit ? pit.source : null,
        measuredLaps: laps.filter(l => l.measured !== false).length,
        cuts: laps.reduce((a, l) => a + (num(l.cuts) || 0), 0),
        lastLapAt: laps.map(l => l.recorded_at).filter(Boolean).sort().pop() || null
      });
    }
    cars.sort((a, b) => {
      // Le classement se fait sur le tour médian : c'est la seule colonne
      // toujours disponible, même sans mesure de conso.
      const ma = a.medianLapMs == null ? Infinity : a.medianLapMs;
      const mb = b.medianLapMs == null ? Infinity : b.medianLapMs;
      if (ma !== mb) return ma - mb;
      const carOrder = String(a.car).localeCompare(String(b.car), 'fr');
      if (carOrder) return carOrder;
      const trackOrder = String(a.track).localeCompare(String(b.track), 'fr');
      return trackOrder || String(a.trackConfig || '').localeCompare(String(b.trackConfig || ''), 'fr');
    });
    return {
      filters,
      rows: rows.length,
      cars,
      loadedFuelMax: loaded.length ? Math.max(...loaded) : null,
      contextRates: [...new Set(rows.map(r => `${r.fuel_rate == null ? '—' : r.fuel_rate}/${r.tyre_wear_rate == null ? '—' : r.tyre_wear_rate}`))]
    };
  }

  /**
   * Profil pit-lane : une saisie admin garde la priorité ; à défaut, la médiane
   * des passages réellement détectés au limiteur 80 km/h sert de mesure auto.
   */
  async pitProfile(track, trackConfig = null) {
    if (!track) return null;
    const [profiles, rows] = await Promise.all([
      this.store.select('circuit_profile', { track }),
      this.rows({ track })
    ]);
    return pitProfileFromRows(track, trackConfig, profiles, rows);
  }

  /** Renseigne (ou remplace) les mesures pit-lane d'un circuit. */
  async savePitProfile(track, profile) {
    const trackConfig = String(profile.trackConfig || '').trim() || null;
    const profiles = await this.store.select('circuit_profile', { track });
    const existing = profiles.find(row => (row.track_config || null) === trackConfig);
    const row = {
      track,
      track_config: trackConfig,
      pit_lane_loss_ms: positive(profile.pitLaneLossMs),
      refuel_rate_lps: positive(profile.refuelRateLps),
      tyre_change_ms: positive(profile.tyreChangeMs),
      source: profile.source || 'mesure manuelle'
    };
    // Les deux backends savent remplacer une ligne : on corrige la mesure au
    // lieu d'en empiler une deuxième (le schéma interdit de toute façon le
    // doublon circuit × configuration).
    if (existing) return this.store.update('circuit_profile', existing.id, row);
    try {
      return await this.store.insert('circuit_profile', row);
    } catch (e) {
      // Deux admins qui enregistrent en même temps : le second met à jour.
      const again = await this.store.select('circuit_profile', { track });
      const duplicate = again.find(item => (item.track_config || null) === trackConfig);
      if (duplicate) return this.store.update('circuit_profile', duplicate.id, row);
      throw e;
    }
  }

  _measurementNow() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  _measurementNowMs() {
    const value = this._measurementNow().getTime();
    return Number.isFinite(value) ? value : Date.now();
  }

  _expireStalePitMeasurements(now = this._measurementNowMs()) {
    for (const run of this.pitMeasurements.values()) {
      if (!['queued', 'running'].includes(run.status)) continue;
      const client = this.measurementClients.get(run.sessionKey);
      if (client && now - client.lastSeenAt <= MEASUREMENT_CLIENT_TTL_MS) continue;
      run.status = 'failed';
      run.phase = 'failed';
      run.error = 'La session CSP est déconnectée; aucune nouvelle mesure ne sera enregistrée.';
      run.updatedAt = this._measurementNow().toISOString();
      this.activePitMeasurementBySession.delete(run.sessionKey);
    }
  }

  _cleanPitMeasurement(run) {
    if (!run) return null;
    return {
      id: run.id,
      type: run.type,
      requestedLiters: run.requestedLiters,
      status: run.status,
      phase: run.phase,
      track: run.track,
      trackConfig: run.trackConfig,
      serverName: run.serverName,
      driverName: run.driverName,
      car: run.car,
      preLaps: run.preLaps,
      postLaps: run.postLaps,
      serviceDurationMs: run.serviceDurationMs,
      pitLaneDurationMs: run.pitLaneDurationMs || null,
      fuelAddedL: run.fuelAddedL,
      refuelRateLps: run.refuelRateLps,
      tyreReset: run.tyreReset,
      result: run.result || null,
      error: run.error || null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    };
  }

  /** Liste les scripts CSP qui ont battu un cœur récemment (bail 15 s). */
  measurementClientList() {
    const now = this._measurementNowMs();
    this._expireStalePitMeasurements(now);
    const clients = [];
    for (const [sessionKey, client] of this.measurementClients) {
      if (now - client.lastSeenAt > MEASUREMENT_CLIENT_RETENTION_MS) {
        this.measurementClients.delete(sessionKey);
        continue;
      }
      if (!client.authenticated || now - client.lastSeenAt > MEASUREMENT_CLIENT_TTL_MS) continue;
      clients.push({
        sessionKey,
        serverName: client.serverName,
        track: client.track,
        trackConfig: client.trackConfig,
        driverGuid: client.driverGuid,
        driverName: client.driverName,
        car: client.car,
        lastSeenAt: new Date(client.lastSeenAt).toISOString()
      });
    }
    return clients.sort((a, b) => {
      const trackOrder = String(a.track).localeCompare(String(b.track), 'fr');
      if (trackOrder) return trackOrder;
      const driverOrder = String(a.driverName || a.driverGuid || '').localeCompare(
        String(b.driverName || b.driverGuid || ''), 'fr'
      );
      return driverOrder || String(a.car || '').localeCompare(String(b.car || ''), 'fr');
    });
  }

  /**
   * Battement CSP + retour de commande. La clé de session n'est jamais fournie
   * par la page : seul le script connecté, authentifié par TELEMETRY_TOKEN,
   * peut recevoir une procédure, et celle-ci ne part qu'au client ciblé.
   */
  async pollPitMeasurement(payload) {
    const sessionKey = String(payload && payload.sessionKey || '').trim().slice(0, 64);
    const track = String(payload && payload.track || '').trim().slice(0, 160);
    if (!/^[a-zA-Z0-9:_-]{3,64}$/.test(sessionKey) || !track) {
      throw new Error('session CSP ou circuit manquant');
    }
    const now = this._measurementNowMs();
    const driver = payload.driver && typeof payload.driver === 'object' ? payload.driver : {};
    const details = {
      sessionKey,
      serverName: String(payload.serverName || '').trim().slice(0, 120),
      track,
      trackConfig: String(payload.trackConfig || '').trim().slice(0, 80) || null,
      driverGuid: String(driver.guid || '').trim().slice(0, 64),
      driverName: String(driver.name || '').trim().slice(0, 100),
      car: String(payload.car || '').trim().slice(0, 120),
      lastSeenAt: now
    };
    const suppliedSecret = String(payload.clientSecret || '').trim().toLowerCase();
    const existingClient = this.measurementClients.get(sessionKey);
    let client;
    if (!existingClient) {
      // Le serveur remet une capacité aléatoire au CSP. Elle n'est jamais
      // renvoyée à la page admin; le jeton global seul ne permet donc pas de
      // se faire passer pour une autre session active.
      const secret = /^[a-f0-9]{48}$/.test(suppliedSecret)
        ? suppliedSecret : crypto.randomBytes(24).toString('hex');
      client = { ...details, clientSecret: secret, authenticated: /^[a-f0-9]{48}$/.test(suppliedSecret) };
      this.measurementClients.set(sessionKey, client);
      if (!client.authenticated) return `REGISTER|${secret}`;
    } else {
      if (!existingClient.authenticated && suppliedSecret !== existingClient.clientSecret) {
        // Si la réponse REGISTER a été perdue, renvoyer la même capacité jusqu'à
        // ce que le CSP la présente; sinon cette session resterait invisible.
        return `REGISTER|${existingClient.clientSecret}`;
      }
      if (!suppliedSecret || suppliedSecret !== existingClient.clientSecret) return 'NONE';
      client = { ...existingClient, ...details, authenticated: true };
      this.measurementClients.set(sessionKey, client);
    }

    const update = payload.measurement && typeof payload.measurement === 'object'
      ? payload.measurement : null;
    const measurementId = this.activePitMeasurementBySession.get(sessionKey);
    const run = measurementId && this.pitMeasurements.get(measurementId);
    if (!run) {
      const reported = update && this.pitMeasurements.get(String(update.id || ''));
      if (reported && reported.sessionKey === sessionKey
          && ['failed', 'cancelled'].includes(reported.status) && !reported.abortDelivered) {
        reported.abortDelivered = true;
        return `ABORT|${reported.id}`;
      }
      if (update && update.id && update.phase !== 'complete' && update.phase !== 'failed') {
        // Après un redémarrage du site, une procédure volatile ne peut pas être
        // finalisée : le script le sait et l'arrête au lieu d'afficher un faux succès.
        return `ABORT|${String(update.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)}`;
      }
      return 'NONE';
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      if (update && String(update.id || '') === run.id
          && ['failed', 'cancelled'].includes(run.status) && !run.abortDelivered) {
        run.abortDelivered = true;
        return `ABORT|${run.id}`;
      }
      return 'NONE';
    }
    if (run.track !== client.track || (run.trackConfig || null) !== (client.trackConfig || null)) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = 'Le circuit ou sa configuration a changé pendant la mesure.';
      run.updatedAt = this._measurementNow().toISOString();
      this.activePitMeasurementBySession.delete(sessionKey);
      run.abortDelivered = true;
      return `ABORT|${run.id}`;
    }

    if (update && String(update.id || '') === run.id) {
      await this._applyPitMeasurementUpdate(run, update);
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      run.abortDelivered = true;
      return `ABORT|${run.id}`;
    }
    if (run.status === 'queued') {
      const liters = run.requestedLiters == null ? 0 : run.requestedLiters;
      return `START|${run.id}|${run.type}|${liters}`;
    }
    return 'NONE';
  }

  /** Arme une mesure uniquement pour un script CSP actuellement connecté. */
  startPitMeasurement({ sessionKey, type, liters } = {}) {
    this._expireStalePitMeasurements();
    const key = String(sessionKey || '').trim().slice(0, 64);
    const kind = String(type || '').trim();
    if (!/^[a-zA-Z0-9:_-]{3,64}$/.test(key)) return { ok: false, error: 'Sélectionne une session de jeu connectée.' };
    if (!PIT_MEASUREMENT_TYPES.has(kind)) return { ok: false, error: 'Type de mesure inconnu.' };
    const client = this.measurementClients.get(key);
    if (!client || !client.authenticated || this._measurementNowMs() - client.lastSeenAt > MEASUREMENT_CLIENT_TTL_MS) {
      return { ok: false, error: 'Cette session CSP n’est plus connectée. Actualise la liste et réessaie.' };
    }
    const requestedLiters = kind === 'refuel' ? positive(liters) : null;
    if (kind === 'refuel' && (requestedLiters == null || requestedLiters < 0.1 || requestedLiters > 200)) {
      return { ok: false, error: 'Indique un volume de ravitaillement entre 0,1 et 200 L.' };
    }
    const currentId = this.activePitMeasurementBySession.get(key);
    const current = currentId && this.pitMeasurements.get(currentId);
    if (current && ['queued', 'running'].includes(current.status)) {
      return { ok: false, error: 'Une mesure est déjà en cours sur cette session.' };
    }
    for (const active of this.pitMeasurements.values()) {
      if (['queued', 'running'].includes(active.status)
          && active.track === client.track
          && (active.trackConfig || null) === (client.trackConfig || null)) {
        return { ok: false, error: 'Une mesure est déjà en cours pour ce circuit/configuration.' };
      }
    }
    const now = this._measurementNow();
    const id = crypto.randomBytes(12).toString('hex');
    const run = {
      id,
      sessionKey: key,
      type: kind,
      requestedLiters,
      track: client.track,
      trackConfig: client.trackConfig,
      serverName: client.serverName,
      driverGuid: client.driverGuid,
      driverName: client.driverName,
      car: client.car,
      status: 'queued',
      phase: 'queued',
      phaseRank: 0,
      preLaps: 0,
      postLaps: 0,
      serviceDurationMs: null,
      fuelAddedL: null,
      refuelRateLps: null,
      tyreReset: false,
      result: null,
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.pitMeasurements.set(id, run);
    this.activePitMeasurementBySession.set(key, id);
    return { ok: true, measurement: this._cleanPitMeasurement(run) };
  }

  async _applyPitMeasurementUpdate(run, update) {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    const phase = String(update.phase || '');
    if (!PIT_MEASUREMENT_PHASES.has(phase)) return;
    const rank = {
      before_lap: 1, wait_pit_entry: 2, pit_lane: 3, service: 4,
      wait_pit_exit: 5, after_lap: 6, complete: 7, failed: 8
    }[phase];
    if (phase !== 'failed' && rank < run.phaseRank) return;
    run.phase = phase;
    run.phaseRank = Math.max(run.phaseRank, rank);
    run.status = 'running';
    const preLaps = Number(update.preLaps);
    const postLaps = Number(update.postLaps);
    if (Number.isFinite(preLaps)) run.preLaps = Math.max(run.preLaps, Math.min(100, Math.floor(preLaps)));
    if (Number.isFinite(postLaps)) run.postLaps = Math.max(run.postLaps, Math.min(100, Math.floor(postLaps)));
    const duration = positive(update.serviceDurationMs);
    if (duration != null && duration <= 600000) run.serviceDurationMs = Math.round(duration);
    const pitLaneDuration = positive(update.pitLaneDurationMs);
    if (pitLaneDuration != null && pitLaneDuration <= 3600000) run.pitLaneDurationMs = Math.round(pitLaneDuration);
    const added = positive(update.fuelAddedL);
    if (added != null && added <= 200) run.fuelAddedL = added;
    run.tyreReset = update.tyreReset === true;
    if (typeof update.error === 'string') run.error = update.error.trim().slice(0, 240);
    run.updatedAt = this._measurementNow().toISOString();

    if (phase === 'failed') {
      run.status = 'failed';
      run.error = run.error || 'La procédure CSP n’a pas pu confirmer le service demandé.';
      this.activePitMeasurementBySession.delete(run.sessionKey);
      return;
    }
    if (phase !== 'complete') return;
    if (run.preLaps < 1 || run.postLaps < 1) {
      run.status = 'failed';
      run.error = 'La procédure doit contenir un tour avant et un tour après le passage aux stands.';
      this.activePitMeasurementBySession.delete(run.sessionKey);
      return;
    }
    if (run.serviceDurationMs == null) {
      run.status = 'failed';
      run.error = 'Aucune durée de service valide n’a été transmise.';
      this.activePitMeasurementBySession.delete(run.sessionKey);
      return;
    }
    if (run.pitLaneDurationMs == null) {
      run.status = 'failed';
      run.error = 'Le roulage pit-lane n’a pas été mesuré séparément du service.';
      this.activePitMeasurementBySession.delete(run.sessionKey);
      return;
    }

    let profileMeasurement;
    if (run.type === 'tyre') {
      if (!run.tyreReset) {
        run.status = 'failed';
        run.error = 'Le CSP n’a pas confirmé le remplacement des pneus (usure non remise à neuf).';
        this.activePitMeasurementBySession.delete(run.sessionKey);
        return;
      }
      profileMeasurement = { type: 'tyre', tyreChangeMs: run.serviceDurationMs };
      run.result = {
        tyreChangeMs: run.serviceDurationMs,
        serviceDurationMs: run.serviceDurationMs,
        pitLaneDurationMs: run.pitLaneDurationMs
      };
    } else {
      const requested = run.requestedLiters;
      const addedLiters = run.fuelAddedL;
      if (requested == null || addedLiters == null) {
        run.status = 'failed';
        run.error = 'Le niveau de carburant n’a pas confirmé le volume ajouté.';
        this.activePitMeasurementBySession.delete(run.sessionKey);
        return;
      }
      const tolerance = Math.max(0.05, requested * 0.1);
      if (Math.abs(addedLiters - requested) > tolerance) {
        run.status = 'failed';
        run.error = `Volume détecté ${addedLiters.toFixed(2)} L, différent des ${requested.toFixed(2)} L demandés.`;
        this.activePitMeasurementBySession.delete(run.sessionKey);
        return;
      }
      const rate = addedLiters / (run.serviceDurationMs / 1000);
      if (!Number.isFinite(rate) || rate < 0.05 || rate > 50) {
        run.status = 'failed';
        run.error = 'Le débit calculé sort de la plage mesurable; aucune valeur n’a été enregistrée.';
        this.activePitMeasurementBySession.delete(run.sessionKey);
        return;
      }
      run.refuelRateLps = Math.round(rate * 1000) / 1000;
      profileMeasurement = { type: 'refuel', refuelRateLps: run.refuelRateLps };
      run.result = {
        fuelAddedL: Math.round(addedLiters * 1000) / 1000,
        serviceDurationMs: run.serviceDurationMs,
        pitLaneDurationMs: run.pitLaneDurationMs,
        refuelRateLps: run.refuelRateLps
      };
    }
    try {
      await this.saveAutomaticPitMeasurement(run.track, run.trackConfig, profileMeasurement);
      run.status = 'completed';
      run.phase = 'complete';
      run.error = null;
    } catch (error) {
      run.status = 'failed';
      run.error = `Mesure validée, mais profil non enregistré : ${String(error.message || error).slice(0, 170)}`;
    }
    run.updatedAt = this._measurementNow().toISOString();
    this.activePitMeasurementBySession.delete(run.sessionKey);
  }

  /** Enregistre une mesure CSP séparément des valeurs saisies manuellement. */
  async saveAutomaticPitMeasurement(track, trackConfig, measurement) {
    const cleanTrack = String(track || '').trim().slice(0, 160);
    if (!cleanTrack) throw new Error('circuit manquant');
    const config = String(trackConfig || '').trim().slice(0, 80) || null;
    const type = String(measurement && measurement.type || '');
    if (!PIT_MEASUREMENT_TYPES.has(type)) throw new Error('type de service inconnu');
    const profiles = await this.store.select('circuit_profile', { track: cleanTrack });
    const existing = profiles.find(row => (row.track_config || null) === config);
    const row = {
      track: cleanTrack,
      track_config: config,
      // Une mesure CSP n’écrase jamais une saisie de direction de course.
      pit_lane_loss_ms: existing ? existing.pit_lane_loss_ms : null,
      refuel_rate_lps: existing ? existing.refuel_rate_lps : null,
      tyre_change_ms: existing ? existing.tyre_change_ms : null,
      automatic_refuel_rate_lps: existing ? existing.automatic_refuel_rate_lps : null,
      automatic_tyre_change_ms: existing ? existing.automatic_tyre_change_ms : null,
      measured_at: this._measurementNow().toISOString(),
      source: existing && existing.source ? existing.source : 'mesure automatique CSP'
    };
    if (type === 'refuel') {
      const rate = positive(measurement.refuelRateLps);
      if (rate == null || rate > 50) throw new Error('débit de ravitaillement invalide');
      row.automatic_refuel_rate_lps = Math.round(rate * 1000) / 1000;
    } else {
      const duration = positive(measurement.tyreChangeMs);
      if (duration == null || duration > 600000) throw new Error('durée de pneus invalide');
      row.automatic_tyre_change_ms = Math.round(duration);
    }
    if (existing) return this.store.update('circuit_profile', existing.id, row);
    try {
      return await this.store.insert('circuit_profile', row);
    } catch (error) {
      const again = await this.store.select('circuit_profile', { track: cleanTrack });
      const duplicate = again.find(item => (item.track_config || null) === config);
      if (duplicate) return this.store.update('circuit_profile', duplicate.id, row);
      throw error;
    }
  }

  pitMeasurement(id) {
    const run = this.pitMeasurements.get(String(id || ''));
    if (!run) return null;
    if (['queued', 'running'].includes(run.status)) {
      const client = this.measurementClients.get(run.sessionKey);
      if (!client || this._measurementNowMs() - client.lastSeenAt > MEASUREMENT_CLIENT_TTL_MS) {
        run.status = 'failed';
        run.phase = 'failed';
        run.error = 'La session CSP est déconnectée; aucune nouvelle mesure ne sera enregistrée.';
        run.updatedAt = this._measurementNow().toISOString();
        this.activePitMeasurementBySession.delete(run.sessionKey);
      }
    }
    return this._cleanPitMeasurement(run);
  }

  // --- gestion des données (page /telemetry, admin) -------------------------
  //
  // Le mauvais circuit enregistré (config périmée avant la lecture jeu) ne
  // se corrige pas en attendant : la page permet de MODIFIER la séance ou de
  // la SUPPRIMER. Rien n'est inventé — on édite ce qui est stocké, champs
  // nommés, valeurs validées.

  /** Liste les séances avec leur activité, la plus récente d'abord. */
  async listSessions() {
    const sessions = await this.store.select('session');
    const laps = await this.store.select('lap');
    const bySession = new Map();
    for (const lap of laps) {
      if (!bySession.has(lap.session_id)) bySession.set(lap.session_id, []);
      bySession.get(lap.session_id).push(lap);
    }
    return sessions
      .map(row => {
        const group = bySession.get(row.id) || [];
        return {
          id: row.id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          serverName: row.server_name,
          track: row.track,
          trackConfig: row.track_config,
          sessionType: row.session_type,
          campaign: row.campaign,
          sessionKey: row.session_key,
          notes: row.notes,
          laps: group.length,
          drivers: [...new Set(group.map(l => l.driver_guid))].length,
          cars: [...new Set(group.map(l => l.car))].length,
          lastLapAt: group.map(l => l.recorded_at).filter(Boolean).sort().pop() || null
        };
      })
      .sort((a, b) => {
        const time = value => {
          const parsed = value instanceof Date ? value.getTime() : Date.parse(value || '');
          return Number.isFinite(parsed) ? parsed : 0;
        };
        return time(b.startedAt) - time(a.startedAt);
      });
  }

  /** Champs modifiables d'une séance : tout sauf les mesures elles-mêmes. */
  async updateSession(id, patch = {}) {
    const clean = {};
    const str = (v) => String(v == null ? '' : v).trim().slice(0, 120);
    if ('track' in patch) {
      const track = str(patch.track);
      if (!track) return { ok: false, error: 'circuit manquant' };
      clean.track = track;
    }
    for (const [key, column] of [
      ['trackConfig', 'track_config'], ['sessionType', 'session_type'],
      ['campaign', 'campaign'], ['serverName', 'server_name'], ['notes', 'notes']
    ]) {
      if (key in patch) {
        const v = str(patch[key]);
        clean[column] = v || null;
      }
    }
    if (!Object.keys(clean).length) return { ok: false, error: 'rien à modifier' };
    const row = await this.store.update('session', Number(id), clean);
    if (!row) return { ok: false, error: 'séance inconnue' };
    return { ok: true, session: row };
  }

  /** Supprime une séance ET ses tours/relais : les orphelins ne servent rien. */
  async deleteSession(id) {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return { ok: false, error: 'séance inconnue' };
    const sessions = await this.store.select('session', { id: numeric });
    if (!sessions.length) return { ok: false, error: 'séance inconnue' };
    await this.store.deleteWhere('lap', { session_id: numeric });
    await this.store.deleteWhere('stint', { session_id: numeric });
    await this.store.delete('session', numeric);
    // Cache mémoire : une entrée groupée ou à clé qui pointe vers la séance
    // supprimée ferait « ressusciter » un id inexistant au prochain envoi.
    for (const [k, v] of this.sessions) {
      if (v && v.id === numeric) this.sessions.delete(k);
    }
    return { ok: true, deleted: numeric };
  }

  /**
   * Rapport BoP sur les données RÉELLEMENT stockées. Les voitures dont une
   * mesure manque (conso, usure, pit-lane) sortent « incomplètes » : le rapport
   * dit ce qui manque au lieu de combler au hasard.
   */
  async report(filters = {}, options = {}) {
    const summary = await this.summary(filters);
    // La matrice pilote × voiture fait partie du rapport : avant, la route ne
    // passait aucune matrice et la section affichait « aucun pilote n'a roulé
    // dans toutes les voitures » même sans avoir essayé de la calculer.
    const contexts = new Map();
    for (const row of summary.cars) {
      const key = JSON.stringify([row.track || '', row.trackConfig || null]);
      if (!contexts.has(key)) contexts.set(key, { track: row.track, trackConfig: row.trackConfig || null });
    }
    const pitEntries = await Promise.all([...contexts].map(async ([key, context]) => [
      key, await this.pitProfile(context.track, context.trackConfig)
    ]));
    const pitByContext = new Map(pitEntries);
    const cars = summary.cars.map(row => {
      const pit = pitByContext.get(JSON.stringify([row.track || '', row.trackConfig || null]));
      return {
        car: row.car,
        circuit: row.track,
        circuitConfig: row.trackConfig,
        driver: row.driverName || row.driver || null,
        medianLapMs: row.medianLapMs,
        fuelPerLap: row.fuelPerLap,
        fuelCapacity: row.fuelCapacity,
        tyreWearPerLap: row.tyreWearPerLap,
        pitLaneLossMs: pit ? pit.pit_lane_loss_ms : row.pitLaneLossMs,
        refuelRateLps: pit ? pit.refuel_rate_lps : null,
        tyreChangeMs: pit ? pit.tyre_change_ms : null
      };
    });

    // Une matrice n'est comparable que sur un seul circuit/layout. Ne jamais
    // réunir par erreur des chronos de Zolder et d'Österreichring dans un delta.
    const allRows = await this.rows(filters);
    const onlyContext = contexts.size <= 1 ? [...contexts.values()][0] : null;
    const matrixRows = onlyContext
      ? allRows.filter(row => row.track === onlyContext.track
        && (row.track_config || null) === (onlyContext.trackConfig || null))
      : [];
    const matrix = options.matrix || (contexts.size <= 1 ? driverCarMatrix(matrixRows) : null);

    let pit = null;
    if (filters.track) {
      const context = [...contexts.values()].find(item => item.track === filters.track);
      pit = await this.pitProfile(filters.track, filters.trackConfig || (context && context.trackConfig));
    } else if (contexts.size === 1) {
      pit = pitByContext.values().next().value || null;
    }
    // Le nom de campagne ne doit pas être inventé : on prend celui demandé, ou
    // celui des tours retenus s'ils n'en portent qu'un.
    const campaigns = [...new Set(summary.cars.map(r => r.campaign).filter(Boolean))];
    const report = buildReport(cars, {
      campaign: options.campaign || filters.campaign || (campaigns.length === 1 ? campaigns[0] : 'telemetrie'),
      matrix,
      bestLaps: Object.fromEntries(summary.cars.map(row => [
        JSON.stringify([row.car, row.track || null, row.trackConfig || null]), row.bestLapMs
      ]))
    });
    const missingPitProfile = cars.length === 0 || cars.some(row => row.pitLaneLossMs == null
      || row.refuelRateLps == null || row.tyreChangeMs == null);
    return {
      ...report,
      matrix,
      pitProfile: pit,
      missingPitProfile,
      cars: cars.length,
      laps: summary.rows
    };
  }
}

/** Applique les filtres voiture / circuit / pilote (et campagne, session). */
function filterRows(rows, filters = {}) {
  const car = filters.car ? String(filters.car) : null;
  const track = filters.track ? String(filters.track) : null;
  const trackConfig = filters.trackConfig ? String(filters.trackConfig) : null;
  const driver = filters.driver ? String(filters.driver) : null;
  const campaign = filters.campaign ? String(filters.campaign) : null;
  return rows.filter(row => {
    if (car && row.car !== car) return false;
    if (track && row.track !== track) return false;
    if (trackConfig && (row.track_config || null) !== trackConfig) return false;
    if (driver && row.driver_guid !== driver) return false;
    if (campaign && row.campaign !== campaign) return false;
    return true;
  });
}

/**
 * Ouvre le service (PostgreSQL/Neon si configuré, sinon fichier local).
 * L'ouverture est bornée dans le temps : une base muette doit produire une
 * erreur exploitable, pas une promesse qui ne se résout jamais. Sans cette
 * borne, la route POST restait pendante à vie et le script CSP voyait
 * « aucune réponse » — alors que le réseau allait parfaitement bien.
 */
async function createTelemetryService(options = {}) {
  let store;
  if (options.store) {
    store = options.store;
  } else {
    const timeoutMs = options.openTimeoutMs != null ? options.openTimeoutMs : 10000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `ouverture de la base de télémétrie sans réponse après ${timeoutMs} ms (base endormie ou injoignable ?)`);
        err.code = 'GDSP_TELEMETRY_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });
    try {
      store = await Promise.race([openStore(options), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  return new TelemetryService(store, options);
}

module.exports = {
  TelemetryService,
  createTelemetryService,
  validatePush,
  filterRows,
  MAX_LAPS_PER_PUSH
};

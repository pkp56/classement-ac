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

const { openStore } = require('./store');
const { carProfile, driverCarMatrix, field, plausibleCarId } = require('./aggregate');
const { buildReport } = require('./export');
const { lapStats, avg } = require('./bop');

const MAX_LAPS_PER_PUSH = 200;

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
 * Service applicatif : un seul point d'entrée pour la route HTTP et les tests.
 */
class TelemetryService {
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now || (() => new Date());
    this.sessions = new Map();       // clé de session → ligne en base
    this.liveSectors = new Map();    // mémoire RAM par serveur/circuit/pilote/voiture
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
   * Agrégat par voiture (et par pilote quand demandé), filtrable.
   * Les valeurs non mesurées restent `null` : la page affiche « — ».
   */
  async summary(filters = {}) {
    const rows = await this.rows(filters);
    const groups = new Map();
    for (const row of rows) {
      const key = filters.byDriver
        ? `${row.car}|${row.driver_guid}`
        : row.car;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const cars = [];
    const loaded = rows.map(r => num(r.fuel_loaded_l)).filter(v => v != null && v > 0);
    for (const [key, laps] of groups) {
      const [car, driver] = filters.byDriver ? key.split('|') : [key, null];
      const profile = carProfile({ car, track: laps[0].track, trackConfig: laps[0].track_config }, laps);
      const stats = lapStats(laps.map(l => ({ ms: Number(l.lap_ms) })));
      // Capacité : le plus gros plein vu, pas une valeur devinée.
      const fuelLoadedMax = Math.max(0, ...laps.map(l => num(l.fuel_loaded_l) || 0));
      const wear = laps.map(l => num(l.tyre_wear_pct)).filter(v => v != null && v > 0);
      cars.push({
        car,
        unidentified: !plausibleCarId(car),
        driver,
        driverName: driver ? (laps[0].driver_name || driver) : null,
        track: laps[0].track,
        campaign: laps[0].campaign || null,
        laps: stats.count,
        bestLapMs: stats.best,
        medianLapMs: stats.median,
        stdevMs: stats.stdev,
        fuelPerLap: profile.fuelPerLap,
        tyreWearPerLap: avg(wear),
        fuelCapacity: fuelLoadedMax > 0 ? fuelLoadedMax : null,
        speedMaxKmh: profile.maxSpeedKmh,
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
      return String(a.car).localeCompare(String(b.car), 'fr');
    });
    return {
      filters,
      rows: rows.length,
      cars,
      loadedFuelMax: loaded.length ? Math.max(...loaded) : null,
      contextRates: [...new Set(rows.map(r => `${r.fuel_rate == null ? '—' : r.fuel_rate}/${r.tyre_wear_rate == null ? '—' : r.tyre_wear_rate}`))]
    };
  }

  /** Profil pit-lane du circuit, s'il a été mesuré (jour 4 de la campagne). */
  async pitProfile(track) {
    const rows = await this.store.select('circuit_profile', { track });
    const row = rows[0];
    if (!row) return null;
    return {
      pit_lane_loss_ms: num(row.pit_lane_loss_ms),
      refuel_rate_lps: num(row.refuel_rate_lps),
      tyre_change_ms: num(row.tyre_change_ms),
      source: row.source || null
    };
  }

  /** Renseigne (ou remplace) les mesures pit-lane d'un circuit. */
  async savePitProfile(track, profile) {
    const existing = await this.store.select('circuit_profile', { track });
    const row = {
      track,
      track_config: null,
      pit_lane_loss_ms: positive(profile.pitLaneLossMs),
      refuel_rate_lps: positive(profile.refuelRateLps),
      tyre_change_ms: positive(profile.tyreChangeMs),
      source: profile.source || 'mesure manuelle'
    };
    // Les deux backends savent remplacer une ligne : on corrige la mesure au
    // lieu d'en empiler une deuxième (le schéma interdit de toute façon le
    // doublon circuit × configuration).
    if (existing[0]) return this.store.update('circuit_profile', existing[0].id, row);
    try {
      return await this.store.insert('circuit_profile', row);
    } catch (e) {
      // Deux admins qui enregistrent en même temps : le second met à jour.
      const again = await this.store.select('circuit_profile', { track });
      if (again[0]) return this.store.update('circuit_profile', again[0].id, row);
      throw e;
    }
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
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
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
    const matrix = options.matrix || driverCarMatrix(await this.rows(filters));
    const pit = await this.pitProfile(filters.track || (summary.cars[0] && summary.cars[0].track));
    const cars = summary.cars.map(row => ({
      car: row.car,
      circuit: row.track,
      driver: row.driverName || row.driver || null,
      medianLapMs: row.medianLapMs,
      fuelPerLap: row.fuelPerLap,
      fuelCapacity: row.fuelCapacity,
      tyreWearPerLap: row.tyreWearPerLap,
      pitLaneLossMs: pit ? pit.pit_lane_loss_ms : null,
      refuelRateLps: pit ? pit.refuel_rate_lps : null,
      tyreChangeMs: pit ? pit.tyre_change_ms : null
    }));
    // Le nom de campagne ne doit pas être inventé : on prend celui demandé, ou
    // celui des tours retenus s'ils n'en portent qu'un.
    const campaigns = [...new Set(summary.cars.map(r => r.campaign).filter(Boolean))];
    const report = buildReport(cars, {
      campaign: options.campaign || filters.campaign || (campaigns.length === 1 ? campaigns[0] : 'telemetrie'),
      matrix,
      bestLaps: Object.fromEntries(summary.cars.map(r => [r.car, r.bestLapMs]))
    });
    return {
      ...report,
      matrix,
      pitProfile: pit,
      missingPitProfile: !pit,
      cars: cars.length,
      laps: summary.rows
    };
  }
}

/** Applique les filtres voiture / circuit / pilote (et campagne, session). */
function filterRows(rows, filters = {}) {
  const car = filters.car ? String(filters.car) : null;
  const track = filters.track ? String(filters.track) : null;
  const driver = filters.driver ? String(filters.driver) : null;
  const campaign = filters.campaign ? String(filters.campaign) : null;
  return rows.filter(row => {
    if (car && row.car !== car) return false;
    if (track && row.track !== track) return false;
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

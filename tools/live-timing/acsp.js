'use strict';
/*
 * ACSP v4 — protocole UDP du plugin acServer (Assetto Corsa).
 *
 * C'est le même canal que celui utilisé par stracker / ptracker / sTracker :
 *   server_cfg.ini
 *     UDP_PLUGIN_ADDRESS   = 127.0.0.1:12000   <- où le serveur ENVOIE les événements
 *     UDP_PLUGIN_LOCAL_PORT= 12001             <- où le serveur ÉCOUTE nos requêtes
 *
 * Chaque datagramme commence par un octet d'identifiant, puis la charge utile.
 * Les entiers sont little-endian ; les "wstring" sont des chaînes UTF-32LE
 * précédées d'un octet donnant le nombre de caractères.
 *
 * Références : doc officielle Kunos "ACServer plugin protocol" et
 * docs/06-udp-plugin-api.md du projet acserver-rs (protocole v4, 2026).
 */

const EVENT = {
  NEW_SESSION: 0x32,
  NEW_CONNECTION: 0x33,
  CLOSED_CONNECTION: 0x34,
  CAR_UPDATE: 0x35,
  CAR_INFO: 0x36,
  END_SESSION: 0x37,
  VERSION: 0x38,
  CHAT: 0x39,
  CLIENT_LOADED: 0x3a,
  SESSION_INFO: 0x3b,
  ERROR: 0x3c,
  LAP_COMPLETED: 0x49,
  CLIENT_EVENT: 0x82
};

const REQUEST = {
  SET_REALTIME_INTERVAL: 0xc8,
  GET_CAR_INFO: 0xc9,
  SEND_CHAT: 0xca,
  BROADCAST_CHAT: 0xcb,
  GET_SESSION_INFO: 0xcc,
  KICK_USER: 0xce,
  NEXT_SESSION: 0xcf,
  RESTART_SESSION: 0xd0,
  ADMIN_COMMAND: 0xd1
};

const SESSION_TYPE = { 0: 'booking', 1: 'practice', 2: 'qualify', 3: 'race' };

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.o = 0;
  }
  need(n) {
    if (this.o + n > this.buf.length) throw new Error('paquet tronqué (il manque ' + (this.o + n - this.buf.length) + ' octets)');
  }
  u8() { this.need(1); const v = this.buf.readUInt8(this.o); this.o += 1; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.o); this.o += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.o); this.o += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.o); this.o += 4; return v; }
  vec3() { return { x: this.f32(), y: this.f32(), z: this.f32() }; }
  str() {
    const n = this.u8();
    this.need(n);
    const s = this.buf.toString('utf8', this.o, this.o + n);
    this.o += n;
    return s;
  }
  wstr() {
    const n = this.u8();
    this.need(n * 4);
    let out = '';
    for (let i = 0; i < n; i++) {
      const cp = this.buf.readUInt32LE(this.o + i * 4);
      if (cp > 0) out += String.fromCodePoint(cp);
    }
    this.o += n * 4;
    return out;
  }
}

function decodeVersion(r) {
  return { protocolVersion: r.u8() };
}

function decodeSession(r) {
  return {
    protocolVersion: r.u8(),
    sessionIndex: r.u8(),
    currentSessionIndex: r.u8(),
    sessionCount: r.u8(),
    serverName: r.wstr(),
    track: r.str(),
    trackConfig: r.str(),
    name: r.str(),
    type: r.u8(),
    timeMinutes: r.u16(),
    laps: r.u16(),
    waitTimeMinutes: r.u16(),
    ambientTemp: r.u8(),
    roadTemp: r.u8(),
    weather: r.str(),
    elapsedMs: r.i32()
  };
}

function decodeConnection(r) {
  return {
    driverName: r.wstr(),
    driverGuid: r.wstr(),
    carId: r.u8(),
    model: r.str(),
    skin: r.str()
  };
}

function decodeCarUpdate(r) {
  return {
    carId: r.u8(),
    pos: r.vec3(),
    velocity: r.vec3(),
    gear: r.u8(),
    engineRpm: r.u16(),
    spline: r.f32()
  };
}

function decodeCarInfo(r) {
  return {
    carId: r.u8(),
    isConnected: r.u8() !== 0,
    model: r.wstr(),
    skin: r.wstr(),
    driverName: r.wstr(),
    team: r.wstr(),
    driverGuid: r.wstr()
  };
}

function decodeLapCompleted(r) {
  const carId = r.u8();
  const lapTimeMs = r.u32();
  const cuts = r.u8();
  const carsCount = r.u8();
  const cars = [];
  for (let i = 0; i < carsCount; i++) {
    cars.push({
      carId: r.u8(),
      lapTimeMs: r.u32(),
      laps: r.u16(),
      completed: r.u8() !== 0
    });
  }
  return { carId, lapTimeMs, cuts, cars };
}

function decodeClientEvent(r) {
  const kind = r.u8();
  if (kind === 0x0a) {
    return {
      kind: 'car', carId: r.u8(), targetCarId: r.u8(),
      speedKmh: r.f32(), worldPos: r.vec3(), relPos: r.vec3()
    };
  }
  return {
    kind: 'env', carId: r.u8(),
    speedKmh: r.f32(), worldPos: r.vec3(), relPos: r.vec3()
  };
}

/**
 * Décode un datagramme ACSP.
 * @returns {{type:number,typeName:string,payload:object}}
 */
function parsePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) throw new Error('datagramme vide');
  const type = buf.readUInt8(0);
  const r = new Reader(buf.subarray(1));
  switch (type) {
    case EVENT.VERSION: return { type, typeName: 'version', payload: decodeVersion(r) };
    case EVENT.NEW_SESSION:
    case EVENT.SESSION_INFO: {
      const s = decodeSession(r);
      return { type, typeName: type === EVENT.NEW_SESSION ? 'new_session' : 'session_info', payload: s };
    }
    case EVENT.NEW_CONNECTION:
    case EVENT.CLOSED_CONNECTION: {
      const c = decodeConnection(r);
      return { type, typeName: type === EVENT.NEW_CONNECTION ? 'new_connection' : 'closed_connection', payload: c };
    }
    case EVENT.CAR_UPDATE: return { type, typeName: 'car_update', payload: decodeCarUpdate(r) };
    case EVENT.CAR_INFO: return { type, typeName: 'car_info', payload: decodeCarInfo(r) };
    case EVENT.LAP_COMPLETED: return { type, typeName: 'lap_completed', payload: decodeLapCompleted(r) };
    case EVENT.CHAT: return { type, typeName: 'chat', payload: { carId: r.u8(), message: r.wstr() } };
    case EVENT.CLIENT_LOADED: return { type, typeName: 'client_loaded', payload: { carId: r.u8() } };
    case EVENT.END_SESSION: return { type, typeName: 'end_session', payload: { reportFile: r.wstr() } };
    case EVENT.ERROR: return { type, typeName: 'error', payload: { message: r.wstr() } };
    case EVENT.CLIENT_EVENT: return { type, typeName: 'client_event', payload: decodeClientEvent(r) };
    default:
      return { type, typeName: 'unknown', payload: { bytes: buf.length } };
  }
}

function writeWString(s) {
  const chars = Array.from(String(s));
  const out = Buffer.alloc(1 + chars.length * 4);
  out.writeUInt8(chars.length, 0);
  chars.forEach((ch, i) => out.writeUInt32LE(ch.codePointAt(0), 1 + i * 4));
  return out;
}

const encode = {
  setRealtimeInterval(ms) {
    const b = Buffer.alloc(3);
    b.writeUInt8(REQUEST.SET_REALTIME_INTERVAL, 0);
    b.writeUInt16LE(ms, 1);
    return b;
  },
  getCarInfo(carId) {
    const b = Buffer.alloc(2);
    b.writeUInt8(REQUEST.GET_CAR_INFO, 0);
    b.writeUInt8(carId & 0xff, 1);
    return b;
  },
  getSessionInfo(sessionIndex = -1) {
    const b = Buffer.alloc(3);
    b.writeUInt8(REQUEST.GET_SESSION_INFO, 0);
    b.writeInt16LE(sessionIndex, 1);
    return b;
  },
  broadcastChat(message) {
    return Buffer.concat([Buffer.from([REQUEST.BROADCAST_CHAT]), writeWString(message)]);
  },
  sendChat(carId, message) {
    return Buffer.concat([Buffer.from([REQUEST.SEND_CHAT, carId & 0xff]), writeWString(message)]);
  },
  kickUser(carId) {
    return Buffer.from([REQUEST.KICK_USER, carId & 0xff]);
  },
  nextSession() { return Buffer.from([REQUEST.NEXT_SESSION]); },
  restartSession() { return Buffer.from([REQUEST.RESTART_SESSION]); },
  adminCommand(command) {
    return Buffer.concat([Buffer.from([REQUEST.ADMIN_COMMAND]), writeWString(command)]);
  }
};

module.exports = { EVENT, REQUEST, SESSION_TYPE, parsePacket, encode, Reader, writeWString };

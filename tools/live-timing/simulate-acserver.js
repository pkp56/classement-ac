'use strict';
/*
 * Générateur de trafic ACSP pour tester la page live-timing sans serveur AC.
 * Il écoute les requêtes du collecteur et lui envoie des paquets comme le ferait
 * acServer : version, session, connexions, tours et positions temps réel.
 *
 *   node tools/live-timing/simulate-acserver.js
 *
 * Le collecteur doit tourner avec les mêmes ports (12000 en écoute, 12001 pour
 * envoyer). Vitesse réglable par SIM_SPEED (défaut 25 : 1 s simulée = 40 ms).
 */

const dgram = require('dgram');
const { encode } = require('./acsp');

const LISTEN_PORT = Number(process.env.SIM_LISTEN_PORT || process.env.AC_PLUGIN_PORT || 12001);
const TARGET_PORT = Number(process.env.SIM_TARGET_PORT || process.env.AC_LISTEN_PORT || 12000);
const TARGET_HOST = process.env.SIM_TARGET_HOST || '127.0.0.1';
const SPEED = Number(process.env.SIM_SPEED || 25);
const TICK_MS = 100;
const TRACK_LENGTH_KM = 5.9;

const PACKET = {
  NEW_SESSION: 0x32, NEW_CONNECTION: 0x33, CAR_UPDATE: 0x35, CAR_INFO: 0x36,
  VERSION: 0x38, CLIENT_LOADED: 0x3a, LAP_COMPLETED: 0x49
};

function wstr(s) {
  const chars = Array.from(String(s));
  const b = Buffer.alloc(1 + chars.length * 4);
  b.writeUInt8(chars.length, 0);
  chars.forEach((ch, i) => b.writeUInt32LE(ch.codePointAt(0), 1 + i * 4));
  return b;
}
function str(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([Buffer.from([b.length]), b]);
}
function u8(...v) { return Buffer.from(v); }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; }
function vec3(x, y, z) { return Buffer.concat([f32(x), f32(y), f32(z)]); }

const drivers = [
  { id: 0, name: 'Kami_Kaze31', team: 'Scuderia Tolosa', model: 'actk_lola_t290', base: 118907, skill: 1.0, spline: 0.00, lap: 1 },
  { id: 1, name: 'TofuSan21', team: 'ECURIE GDSP #2', model: 'actk_lola_t290', base: 118995, skill: 0.985, spline: 0.03, lap: 1 },
  { id: 2, name: 'Jim Zplouch8', team: 'Gitane Maïs', model: 'actk_lola_t290', base: 119126, skill: 0.972, spline: 0.06, lap: 1 },
  { id: 3, name: 'Kimy Hoyer7', team: 'Ecurie GDSP #1', model: 'actk_lola_t290', base: 119963, skill: 0.958, spline: 0.09, lap: 1 },
  { id: 4, name: 'fmherrou10', team: 'FK Racing', model: 'actk_lola_t290', base: 120080, skill: 0.945, spline: 0.12, lap: 1 },
  { id: 5, name: 'pikoupok23', team: 'Indépendant #1', model: 'actk_lola_t290', base: 120307, skill: 0.932, spline: 0.15, lap: 1 },
  { id: 6, name: 'SuperSlipos42', team: 'Les Bananes Flambées', model: 'actk_lola_t290', base: 120448, skill: 0.92, spline: 0.18, lap: 1 },
  { id: 7, name: 'Elouan27', team: 'Erminig Gwenn', model: 'actk_lola_t290', base: 120939, skill: 0.905, spline: 0.21, lap: 1 }
];

const sessionStart = Date.now();
const state = {
  serverName: 'GDSP · Simulateur local',
  track: 'oesterreichring1979',
  trackConfig: 'chicane',
  socket: null,
  ticks: 0,
  cars: new Map()
};

drivers.forEach(d => {
  let best = Infinity, last = null, lapsDone = 0;
  for (let i = 0; i < 4; i++) {
    const t = Math.round(d.base * (0.985 + Math.random() * 0.03));
    if (t < best) best = t;
  }
  state.cars.set(d.id, { ...d, bestLap: best, lastLap: last, lapsDone, lapProgress: 0, lapStart: 0, nextLapMs: Math.round(d.base * (0.985 + Math.random() * 0.03)) });
});

function send(buf) {
  state.socket.send(buf, 0, buf.length, TARGET_PORT, TARGET_HOST);
}

function sendVersion() {
  send(Buffer.concat([Buffer.from([PACKET.VERSION]), u8(4)]));
}

function sendSession() {
  const elapsed = Date.now() - sessionStart;
  const b = Buffer.concat([
    Buffer.from([PACKET.NEW_SESSION]),
    u8(4, 0, 0, 2),            // protocole, index session, index courant, nb sessions
    wstr(state.serverName),
    str(state.track), str(state.trackConfig), str('Practice'),
    u8(1),                     // type : practice
    u16(60), u16(0), u16(0),   // minutes, tours, attente
    u8(26), u8(34),            // températures air / piste
    str('Sol 02 Few Clouds'),
    i32(elapsed)
  ]);
  send(b);
}

function sendConnection(d, connected = true) {
  const b = Buffer.concat([
    Buffer.from([connected ? PACKET.NEW_CONNECTION : 0x34]),
    wstr(d.name), wstr('7656119' + String(8000000 + d.id * 137)),
    u8(d.id), str(d.model), str('00_gdsp')
  ]);
  send(b);
}

function sendCarInfo(d) {
  const b = Buffer.concat([
    Buffer.from([PACKET.CAR_INFO]),
    u8(d.id, 1),
    wstr(d.model), wstr('00_gdsp'), wstr(d.name), wstr(d.team), wstr('7656119' + String(8000000 + d.id * 137))
  ]);
  send(b);
}

function sendCarUpdate(car, now) {
  const d = state.cars.get(car.id);
  const v = (TRACK_LENGTH_KM * 1000) / (d.nextLapMs / 1000); // m/s
  const b = Buffer.concat([
    Buffer.from([PACKET.CAR_UPDATE]),
    u8(d.id),
    vec3(Math.sin(car.lapProgress * 6.28) * 400, 20, Math.cos(car.lapProgress * 6.28) * 700),
    vec3(v * 0.75, 0, v),
    u8(4), u16(9200), f32(car.lapProgress)
  ]);
  send(b);
  void now;
}

function sendLapCompleted(d, lapMs, cuts) {
  const cars = drivers.map(dr => {
    const c = state.cars.get(dr.id);
    return Buffer.concat([u8(dr.id), u32(c.bestLap), u16(c.lapsDone), u8(0)]);
  });
  const b = Buffer.concat([
    Buffer.from([PACKET.LAP_COMPLETED]),
    u8(d.id), u32(lapMs), u8(cuts), u8(drivers.length),
    ...cars
  ]);
  send(b);
}

const socket = dgram.createSocket('udp4');
state.socket = socket;
socket.on('message', buf => {
  const id = buf.readUInt8(0);
  if (id === 0xcc) sendSession();                 // GetSessionInfo
  if (id === 0x38) sendVersion();                 // Version
  if (id === 0xc9 && buf.length > 1) sendCarInfo(state.cars.get(buf.readUInt8(1)) || drivers[0]);
  if (id === 0xc8) state.realtimeMs = buf.readUInt16LE(1);
  if (id === 0xcb) console.log('[sim] chat broadcast:', buf.subarray(2).toString('utf8'));
  if (id === 0xce && buf.length > 1) console.log('[sim] kick demandé pour la voiture', buf.readUInt8(1));
});
socket.bind(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[sim] acServer simulé sur UDP ${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT} (vitesse x${SPEED})`);
  sendVersion();
  sendSession();
  drivers.forEach(d => sendConnection(d));
  drivers.forEach(d => sendCarInfo(d));
});

const timer = setInterval(() => {
  state.ticks += 1;
  const now = Date.now();
  const dtMs = TICK_MS * SPEED;
  for (const d of drivers) {
    const car = state.cars.get(d.id);
    car.lapProgress += dtMs / car.nextLapMs;
    if (car.lapProgress >= 1) {
      car.lapProgress -= 1;
      const variance = 0.985 + Math.random() * 0.04;
      const lapMs = Math.round(d.base * variance);
      car.lastLap = lapMs;
      car.lapsDone += 1;
      if (lapMs < car.bestLap) car.bestLap = lapMs;
      car.nextLapMs = Math.round(d.base * (0.985 + Math.random() * 0.04));
      sendLapCompleted(d, lapMs, Math.random() < 0.05 ? 1 : 0);
    }
    sendCarUpdate(car, now);
  }
  // Le serveur rappelle régulièrement sa version (comme au démarrage).
  if (state.ticks % 300 === 0) sendSession();
}, TICK_MS);

process.on('SIGINT', () => { clearInterval(timer); socket.close(); process.exit(0); });
void encode;

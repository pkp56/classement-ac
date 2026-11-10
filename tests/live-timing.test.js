'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePacket, encode, EVENT } = require('../tools/live-timing/acsp');
const { LiveTimingCollector, computeStandings, fmtMs } = require('../tools/live-timing/collector');

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
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; }
function f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; }

function sessionPacket(elapsedMs = 5000) {
  return Buffer.concat([
    u8(EVENT.NEW_SESSION), u8(4, 0, 0, 2),
    wstr('GDSP #1'), str('oesterreichring1979'), str('chicane'), str('Practice'),
    u8(1), u16(60), u16(0), u16(0), u8(26), u8(34), str('Sol 02 Few Clouds'),
    i32(elapsedMs)
  ]);
}
function carUpdate(carId, spline, speedMs) {
  return Buffer.concat([
    u8(EVENT.CAR_UPDATE), u8(carId),
    f32(10), f32(2), f32(-30), f32(1), f32(0), f32(speedMs),
    u8(4), u16(9000), f32(spline)
  ]);
}
function lapCompleted(carId, lapMs, cuts, cars) {
  return Buffer.concat([
    u8(EVENT.LAP_COMPLETED), u8(carId), u32(lapMs), u8(cuts), u8(cars.length),
    ...cars.map(c => Buffer.concat([u8(c.id), u32(c.lapMs), u16(c.laps), u8(0)]))
  ]);
}
function connection(carId, name, team) {
  return Buffer.concat([
    u8(EVENT.NEW_CONNECTION), wstr(name), wstr('76561198000' + carId), u8(carId),
    str('actk_lola_t290'), str('00_gdsp')
  ]);
}

test('Décode une session ACSP (chaînes UTF-32, températures, temps écoulé)', () => {
  const p = parsePacket(sessionPacket(9000));
  assert.equal(p.typeName, 'new_session');
  assert.equal(p.payload.serverName, 'GDSP #1');
  assert.equal(p.payload.track, 'oesterreichring1979');
  assert.equal(p.payload.type, 1);
  assert.equal(p.payload.timeMinutes, 60);
  assert.equal(p.payload.ambientTemp, 26);
  assert.equal(p.payload.roadTemp, 34);
  assert.equal(p.payload.weather, 'Sol 02 Few Clouds');
  assert.equal(p.payload.elapsedMs, 9000);
});

test('Décode une mise à jour de position temps réel', () => {
  const p = parsePacket(carUpdate(2, 0.42, 69.5));
  assert.equal(p.typeName, 'car_update');
  assert.equal(p.payload.carId, 2);
  assert.equal(p.payload.gear, 4);
  assert.equal(p.payload.engineRpm, 9000);
  assert.ok(Math.abs(p.payload.spline - 0.42) < 1e-6);
  assert.ok(Math.abs(p.payload.velocity.z - 69.5) < 1e-3);
});

test('Décode un tour bouclé avec le classement complet', () => {
  const p = parsePacket(lapCompleted(1, 118907, 0, [{ id: 1, lapMs: 118907, laps: 3 }, { id: 2, lapMs: 119500, laps: 2 }]));
  assert.equal(p.typeName, 'lap_completed');
  assert.equal(p.payload.lapTimeMs, 118907);
  assert.equal(p.payload.cuts, 0);
  assert.equal(p.payload.cars.length, 2);
  assert.equal(p.payload.cars[1].laps, 2);
});

test('Les trames tronquées sont rejetées proprement', () => {
  assert.throws(() => parsePacket(Buffer.from([EVENT.NEW_CONNECTION, 5, 65])));
  assert.throws(() => parsePacket(Buffer.alloc(0)));
});

test('Encode les requêtes plugin (intervalle, chat, kick)', () => {
  const interval = encode.setRealtimeInterval(500);
  assert.equal(interval.readUInt8(0), 0xc8);
  assert.equal(interval.readUInt16LE(1), 500);
  const chat = encode.broadcastChat('AB');
  assert.equal(chat.readUInt8(0), 0xcb);
  assert.equal(chat.readUInt8(1), 2);
  assert.equal(chat.readUInt32LE(2), 'A'.codePointAt(0));
  const kick = encode.kickUser(4);
  assert.deepEqual([...kick], [0xce, 4]);
});

test('Un échange complet remplit le classement, les écarts et les meilleurs tours', () => {
  const collector = new LiveTimingCollector({ autoStart: false });
  collector.socket = { send() { return true; } }; // pas de réseau dans le test
  const feed = buf => collector.handleDatagram(buf, { address: '127.0.0.1' });
  feed(connection(0, 'Kami_Kaze31', 'Scuderia Tolosa'));
  feed(connection(1, 'TofuSan21', 'ECURIE GDSP #2'));
  feed(sessionPacket(1000));
  feed(carUpdate(0, 0.50, 69));
  feed(carUpdate(1, 0.47, 68));
  feed(lapCompleted(0, 118907, 0, [{ id: 0, lapMs: 118907, laps: 2 }, { id: 1, lapMs: 119995, laps: 2 }]));
  const snap = collector.snapshot();
  assert.equal(snap.status.status, 'live');
  assert.equal(snap.server.name, 'GDSP #1');
  assert.equal(snap.session.type, 'practice');
  assert.equal(snap.cars.length, 2);
  const leader = snap.cars[0];
  assert.equal(leader.name, 'Kami_Kaze31');
  assert.equal(leader.bestLap, '1:58.907');
  assert.equal(leader.gap, 'leader');
  const second = snap.cars[1];
  assert.match(second.gap, /^\+/);
  assert.equal(second.bestLap, null);
  assert.equal(snap.bestLaps.length, 1);
  assert.ok(snap.events.some(e => e.kind === 'driver'));
  assert.ok(snap.events.some(e => e.kind === 'lap'));
});

test('Un tour avec coupures ne devient pas meilleur tour', () => {
  const collector = new LiveTimingCollector({ autoStart: false });
  collector.socket = { send() { return true; } };
  collector.handleDatagram(connection(0, 'Pilote', 'Team'), {});
  collector.handleDatagram(lapCompleted(0, 120000, 0, [{ id: 0, lapMs: 120000, laps: 1 }]), {});
  collector.handleDatagram(lapCompleted(0, 117000, 2, [{ id: 0, lapMs: 117000, laps: 2 }]), {});
  const car = collector.snapshot().cars[0];
  assert.equal(car.bestLapMs, 120000);
  assert.equal(car.lastLapMs, 117000);
  assert.equal(car.lastLapCuts, 2);
});

test('Le classement privilégie la progression puis le meilleur tour estimé', () => {
  const now = Date.now();
  const state = {
    cars: new Map([
      [0, { carId: 0, name: 'A', connected: true, laps: 5, spline: 0.2, bestLapMs: 120000 }],
      [1, { carId: 1, name: 'B', connected: true, laps: 5, spline: 0.9, bestLapMs: 121000 }],
      [2, { carId: 2, name: 'C', connected: false, laps: 9, spline: 0.5, bestLapMs: 118000 }]
    ])
  };
  const { rows } = computeStandings(state, now);
  assert.deepEqual(rows.map(r => r.name), ['B', 'A', 'C']);
  assert.equal(rows[0].gap, 'leader');
  assert.equal(rows[1].gap, '+1:24.000'); // 0,7 tour × 120 s
});

test('Formate les temps de tour et signale les valeurs absentes', () => {
  assert.equal(fmtMs(118907), '1:58.907');
  assert.equal(fmtMs(4321), '4.321');
  assert.equal(fmtMs(0), null);
  assert.equal(fmtMs(null), null);
});

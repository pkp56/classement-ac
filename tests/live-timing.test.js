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

test('autoStart démarre la collecte sans appel explicite (agent distant)', async () => {
  const { EventEmitter } = require('node:events');
  const collector = new LiveTimingCollector({ autoStart: true, listenPort: 0 });
  // socket réel en écoute ; on vérifie simplement que start() a été déclenché.
  await new Promise(r => setTimeout(r, 250));
  assert.ok(collector.socket, 'la socket UDP doit être ouverte sans start() manuel');
  assert.equal(collector.bindState, 'listening');
  collector.stop();
  assert.equal(collector.socket, null);
  assert.ok(collector instanceof EventEmitter);
});


test('La sonde ACSP interroge aussi un serveur silencieux encore considéré en ligne', () => {
  const collector = new LiveTimingCollector({ autoStart: false });
  let requests = 0;
  collector.requestSessionInfo = () => { requests++; };
  collector.lastPacketAt = Date.now() - 5000;
  assert.equal(collector.statusSnapshot().status, 'live');
  collector.heartbeat();
  assert.equal(requests, 1);
  collector.lastPacketAt = Date.now() - 9000;
  collector.heartbeat();
  assert.equal(requests, 2);
  assert.equal(collector.statusSnapshot().status, 'waiting');
});

test('Les informations périodiques ne remettent pas les tours à zéro, mais une nouvelle session oui',()=>{
 const collector=new LiveTimingCollector({autoStart:false});collector.socket={send(){return true;}};
 const feed=buf=>collector.handleDatagram(buf,{address:'127.0.0.1'});
 const info=(elapsed,index=0)=>{const packet=sessionPacket(elapsed);packet[0]=EVENT.SESSION_INFO;packet[2]=index;return packet;};
 feed(connection(0,'Pilote',''));feed(sessionPacket(5000));
 feed(lapCompleted(0,80000,0,[{id:0,lapMs:80000,laps:1}]));
 feed(info(10000));feed(info(15000));
 let snap=collector.snapshot();assert.equal(snap.cars[0].laps,1);assert.equal(snap.cars[0].bestLapMs,80000);assert.equal(snap.events.filter(e=>e.kind==='session').length,1);
 feed(info(1000));snap=collector.snapshot();assert.equal(snap.cars[0].laps,0);assert.equal(snap.cars[0].bestLapMs,null);assert.equal(snap.events.filter(e=>e.kind==='session').length,2);
 feed(lapCompleted(0,81000,0,[{id:0,lapMs:81000,laps:1}]));feed(info(3000,1));snap=collector.snapshot();assert.equal(snap.cars[0].laps,0);assert.equal(snap.cars[0].bestLapMs,null);
});
test('Le collecteur capture la dernière photo avant de remettre les données à zéro',()=>{
 const c=new LiveTimingCollector({autoStart:false});c.socket={send(){}};const snapshots=[];
 c.on('beforeSessionChange',snap=>snapshots.push(snap));
 c.handleDatagram(connection(0,'Pilote',''),{});c.handleDatagram(sessionPacket(50000),{});
 c.handleDatagram(lapCompleted(0,80000,0,[{id:0,lapMs:80000,laps:1}]),{});
 const next=sessionPacket(1000);next[0]=EVENT.SESSION_INFO;c.handleDatagram(next,{});
 assert.equal(snapshots.length,1);assert.equal(snapshots[0].cars[0].laps,1);assert.equal(snapshots[0].cars[0].bestLapMs,80000);assert.equal(c.snapshot().cars[0].laps,0);
});

test('Archives des deux collecteurs : sources isolées et boucle conservée',async t=>{
 const dgram=require('node:dgram'),http=require('node:http'),{once}=require('node:events'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 async function freeUdp(){const s=dgram.createSocket('udp4');s.bind(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
 const p1=await freeUdp();let p2=await freeUdp();while(p2===p1)p2=await freeUdp();
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gdsp-two-history-'));const child=spawn(process.execPath,['app.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),LIVE_TIMING_ENABLED:'1',LIVE_HISTORY_FILE:path.join(dir,'history.json'),DATABASE_URL:'',LIVE_MIRROR_FILE:'off',AC_LISTEN_PORT:String(p1),AC_PLUGIN_PORT:'1',AC_SECOND_LISTEN_PORT:String(p2),AC_SECOND_PLUGIN_PORT:'2',AC_SECOND_HTTP_URL:''}});
 t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Démarrage trop long')),15000);child.stdout.on('data',v=>{if(String(v).includes('démarré')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Serveur arrêté'));});});
 const udp=dgram.createSocket('udp4');t.after(()=>udp.close());const send=(buf,port)=>new Promise((resolve,reject)=>udp.send(buf,port,'127.0.0.1',e=>e?reject(e):resolve()));
 await send(sessionPacket(50000),p1);await send(sessionPacket(50000),p2);await send(connection(1,'Pilote CM2',''),p2);
 await send(connection(0,'Pilote',''),p1);await send(lapCompleted(0,80000,0,[{id:0,lapMs:80000,laps:1}]),p1);
 const next=sessionPacket(1000);next[0]=EVENT.SESSION_INFO;await send(next,p1);
 let rows=[];const deadline=Date.now()+5000;
 while(Date.now()<deadline){rows=(await (await fetch(`http://127.0.0.1:${port}/api/live/sessions?limit=50`)).json()).sessions;if(rows.length>=3)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(rows.filter(r=>r.snapshot?.archiveSource==='local1').length,2);assert.equal(rows.filter(r=>r.snapshot?.archiveSource==='local2').length,1);
 const previous=rows.find(r=>r.snapshot?.archiveSource==='local1'&&r.ended_at);assert.ok(previous);assert.equal(previous.classification[0].laps,1);
});

test('Les temps restent distincts après déconnexion, réutilisation de place et boucle de séance',()=>{
 const c=new LiveTimingCollector({autoStart:false});c.socket={send(){}};const feed=buf=>c.handleDatagram(buf,{});
 const conn=(type,id,name,guid,model)=>Buffer.concat([u8(type),wstr(name),wstr(guid),u8(id),str(model),str('skin')]);
 feed(sessionPacket(50000));feed(conn(EVENT.NEW_CONNECTION,0,'Alice','111111','lola'));feed(carUpdate(0,0.5,50));
 const lap=lapCompleted(0,90000,0,[{id:0,lapMs:90000,laps:1}]);feed(lap);feed(lap);
 feed(conn(EVENT.CLOSED_CONNECTION,0,'Alice','111111','lola'));
 let rows=c.snapshot().storedTimes;assert.equal(rows.length,1);assert.equal(rows[0].name,'Alice');assert.equal(rows[0].laps,1);assert.equal(rows[0].connected,false);assert.equal(rows[0].topSpeedKmh,180);
 feed(conn(EVENT.NEW_CONNECTION,0,'Bob','222222','lola'));feed(lapCompleted(0,88000,0,[{id:0,lapMs:88000,laps:1}]));
 rows=c.snapshot().storedTimes;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.name==='Alice').bestLapMs,90000);assert.equal(rows.find(r=>r.name==='Bob').connected,true);assert.equal(c.snapshot().cars[0].name,'Bob');
 const again=sessionPacket(1000);again[0]=EVENT.SESSION_INFO;feed(again);feed(lapCompleted(0,87000,0,[{id:0,lapMs:87000,laps:1}]));
 rows=c.snapshot().storedTimes;assert.equal(rows.find(r=>r.name==='Bob').laps,2);assert.equal(rows.find(r=>r.name==='Bob').bestLapMs,87000);assert.doesNotMatch(JSON.stringify(c.snapshot()),/111111|222222/);
});
test('Sans GUID, des noms identiques ne sont pas fusionnés lors de la réutilisation de place',()=>{
 const c=new LiveTimingCollector({autoStart:false});c.socket={send(){}};const feed=buf=>c.handleDatagram(buf,{});
 const conn=type=>Buffer.concat([u8(type),wstr('Pilote'),wstr(''),u8(0),str('lola'),str('')]);
 feed(sessionPacket());feed(conn(EVENT.NEW_CONNECTION));feed(lapCompleted(0,90000,0,[{id:0,lapMs:90000,laps:1}]));feed(conn(EVENT.CLOSED_CONNECTION));feed(conn(EVENT.NEW_CONNECTION));feed(lapCompleted(0,91000,0,[{id:0,lapMs:91000,laps:1}]));
 const rows=c.snapshot().storedTimes;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.identityUncertain));assert.equal(rows.filter(r=>!r.connected).length,1);
});
test('Un pilote identifiable qui revient dans une autre place conserve ses temps',()=>{
 const c=new LiveTimingCollector({autoStart:false});c.socket={send(){}};const feed=buf=>c.handleDatagram(buf,{});
 const conn=(type,id)=>Buffer.concat([u8(type),wstr('Alice'),wstr('123456'),u8(id),str('lola'),str('')]);
 feed(sessionPacket());feed(conn(EVENT.NEW_CONNECTION,0));feed(lapCompleted(0,90000,0,[{id:0,lapMs:90000,laps:1}]));feed(conn(EVENT.CLOSED_CONNECTION,0));
 feed(conn(EVENT.NEW_CONNECTION,1));feed(lapCompleted(1,88000,0,[{id:1,lapMs:88000,laps:1}]));
 const rows=c.snapshot().storedTimes;assert.equal(rows.length,1);assert.equal(rows[0].laps,2);assert.equal(rows[0].bestLapMs,88000);assert.equal(rows[0].connected,true);
});

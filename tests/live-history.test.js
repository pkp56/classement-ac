'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveHistoryRecorder, FileLiveHistory, sessionSignature } = require('../tools/live-timing/history');

function tmpHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-live-hist-'));
  return new FileLiveHistory(path.join(dir, 'history.json'));
}
function snap(overrides = {}) {
  return {
    server: { name: 'GDSP #1', track: 'oesterreichring1979', trackConfig: null },
    session: { type: 'race', index: 2 },
    cars: [
      { position: 1, name: 'A', model: 'lola', laps: 4, bestLap: '2:06.177', gap: 'leader', connected: true },
      { position: 2, name: 'B', model: 'alfa', laps: 3, bestLap: '2:08.257', gap: '+1:00.0', connected: true }
    ],
    bestLaps: [{ name: 'A', bestLap: '2:06.177' }],
    events: [{ kind: 'lap', text: 'A boucle 2:06.177', at: '2026-11-14T20:00:00Z' }],
    status: { mode: 'push', status: 'live' },
    ...overrides
  };
}

test('une séance s\'ouvre, se met à jour, se ferme au changement de séance', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  await rec.record(snap(), t0);
  await rec.record(snap(), t0 + 5000);
  let list = await store.list();
  assert.equal(list.length, 1, 'une seule séance, mise à jour sur place');
  assert.equal(list[0].track, 'oesterreichring1979');
  assert.equal(list[0].session_type, 'race');
  assert.equal(list[0].drivers, 2);
  assert.equal(list[0].ended_at, null, 'en cours tant qu\'elle est vue');

  // Le serveur passe en qualify : la course se ferme, une nouvelle séance s'ouvre.
  const raceId = list[0].id;
  await rec.record(snap({ session: { type: 'qualify', index: 3 } }), t0 + 60000);
  list = await store.list();
  assert.equal(list.length, 2);
  const closed = list.find(r => r.id === raceId);
  assert.ok(closed.ended_at, 'la course est fermée');
  assert.equal(closed.classification.length, 2);
  assert.equal(closed.classification[0].name, 'A');
  assert.equal(list.find(r => r.id !== raceId).session_type, 'qualify');
});

test('la dernière photo est écrite à la fermeture (la ligne d\'arrivée compte)', async () => {
  const store = tmpHistory();
  // writeIntervalMs énorme : aucune écriture intermédiaire ne doit passer —
  // seule la photo de fermeture peut sauver le dernier tour.
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 60 * 60 * 1000 });
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  await rec.record(snap(), t0);
  // Le dernier instantané de la course : le leader a bouclé un tour de plus.
  const finish = snap();
  finish.cars[0].laps = 5;
  await rec.record(finish, t0 + 500);
  // Puis le serveur passe en practice : la course se ferme.
  await rec.record(snap({ session: { type: 'practice', index: 4 } }), t0 + 1000);
  const list = await store.list();
  const race = list.find(r => r.session_type === 'race');
  assert.equal(race.classification[0].laps, 5, 'le dernier instantané avant fermeture est conservé');
});

test('une capture rejouée (miroir) n\'entre jamais dans l\'historique', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  await rec.record(snap({ status: { mode: 'mirror', status: 'mirror' } }));
  assert.equal((await store.list()).length, 0);
});

test('un instantané vide n\'ouvre pas de séance', async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  await rec.record({ server: {}, session: {}, cars: [] });
  await rec.record(null);
  assert.equal((await store.list()).length, 0);
});

test('la signature distingue deux courses du même soir', () => {
  const a = sessionSignature(snap());
  const b = sessionSignature(snap({ session: { type: 'qualify', index: 5 } }));
  const c = sessionSignature(snap({ server: { name: 'GDSP #1', track: 'shuto' } }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, sessionSignature(snap()));
});

// --- routes : l'historique se remplit par le push et se lit publiquement ------

test('routes : un push entre dans l\'historique, lisible par /api/live/sessions', async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsp-live-routes-'));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_PUSH_TOKEN: 'jeton-test',
      LIVE_TIMING_ENABLED: '1',
      AC_LISTEN_PORT: '0',
      LIVE_MIRROR_FILE: 'off',
      // Historique en fichier temporaire : le test ne touche ni base ni dépôt.
      LIVE_HISTORY_FILE: path.join(dir, 'history.json'),
      DATABASE_URL: '',
      EVENTS_DATABASE_URL: ''
    }
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error('Server exited ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // Vide au départ.
  const empty = await (await fetch(`${base}/api/live/sessions`)).json();
  assert.equal(empty.history, true);
  assert.equal(empty.sessions.length, 0);

  // Deux pushes de la même séance : une seule ligne, mise à jour.
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/live/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-live-token': 'jeton-test' },
      body: JSON.stringify(snap())
    });
    assert.equal(r.status, 200);
  }
  const list = await (await fetch(`${base}/api/live/sessions`)).json();
  assert.equal(list.sessions.length, 1, 'une seule séance, pas une par push');
  const row = list.sessions[0];
  assert.equal(row.track, 'oesterreichring1979');
  assert.equal(row.session_type, 'race');
  assert.equal(row.server_name, 'GDSP #1');

  // Détail : le classement complet est là.
  const detail = await (await fetch(`${base}/api/live/sessions?id=${row.id}`)).json();
  assert.equal(detail.session.id, row.id);
  assert.equal(detail.session.classification[0].name, 'A');
  assert.equal(detail.session.snapshot.server.name, 'GDSP #1');

  // Séance inconnue : 404, pas de page fantôme.
  const missing = await fetch(`${base}/api/live/sessions?id=999`);
  assert.equal(missing.status, 404);
});

test("l'amorçage de l'agent (rien reçu d'acServer) n'ouvre pas de séance fantôme", async () => {
  const store = tmpHistory();
  const rec = new LiveHistoryRecorder(store, { writeIntervalMs: 0 });
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  // Premier envoi : label par défaut, ni circuit, ni type, ni pilote.
  await rec.record({
    server: { name: 'Serveur Assetto Corsa', track: null },
    session: { type: null }, cars: [], events: [],
    status: { mode: 'push', status: 'live' }
  }, t0);
  assert.equal((await store.list()).length, 0, 'pas de séance fantôme');
  // Puis la vraie séance arrive : une seule ligne, la bonne.
  await rec.record(snap(), t0 + 1000);
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].track, 'oesterreichring1979');
});

test('Deux boucles identiques dans la même minute créent des archives distinctes avec leurs voitures',async()=>{
 const store=tmpHistory(),rec=new LiveHistoryRecorder(store,{writeIntervalMs:0});
 const t=Date.parse('2026-11-14T20:00:00Z');
 await rec.record(snap({session:{type:'race',index:2,elapsedMs:50000}}),t);
 await rec.record(snap({session:{type:'race',index:2,elapsedMs:55000},cars:[{name:'B',model:'alfa',laps:3,connected:true}]}),t+5000);
 await rec.record(snap({session:{type:'race',index:2,elapsedMs:1000}}),t+6000);
 const list=await store.list();assert.equal(list.length,2);const first=list.find(r=>r.ended_at);assert.ok(first);assert.deepEqual(first.snapshot.archiveModels,['alfa','lola']);assert.equal(first.classification[0].model,'alfa');assert.notEqual(list[0].session_key,list[1].session_key);
});
test('Un instantané hors ligne ne réécrit pas les dernières données reçues',async()=>{
 const store=tmpHistory(),rec=new LiveHistoryRecorder(store,{writeIntervalMs:0});const t=Date.now();
 await rec.record(snap(),t);await rec.record(snap({status:{mode:'offline',status:'waiting'},cars:[]}),t+20000);
 const row=(await store.list())[0];assert.equal(row.classification.length,2);assert.equal(row.last_seen_at,new Date(t).toISOString());
});
test('Un historique fichier illisible ne doit jamais être écrasé',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gdsp-live-corrupt-')),file=path.join(dir,'history.json');fs.writeFileSync(file,'{corrompu');
 assert.throws(()=>new FileLiveHistory(file),/illisible/);assert.equal(fs.readFileSync(file,'utf8'),'{corrompu');fs.rmSync(dir,{recursive:true,force:true});
});
test('PostgreSQL reçoit les champs JSON sous forme JSON et expose les modèles dans la liste',async()=>{
 const {PgLiveHistory}=require('../tools/live-timing/history'),queries=[];
 const pg=new PgLiveHistory({async query(sql,args){queries.push({sql,args});return {rows:[{id:1}]};}});
 await pg.upsert({session_key:'a',snapshot:{archiveModels:['lola']},classification:[{model:'lola'}],best_laps:[],events:[]});
 assert.equal(queries[0].args[1],'{"archiveModels":["lola"]}');assert.equal(queries[0].args[2],'[{"model":"lola"}]');
 await pg.update(1,{classification:[{model:'car'}]});assert.equal(queries[1].args[0],'[{"model":"car"}]');
 await pg.list(500);assert.match(queries[2].sql,/archive_models/);assert.match(queries[2].sql,/archive_source/);
});
test('Les archives anciennes restent accessibles par pagination',async()=>{
 const store=tmpHistory();for(let i=0;i<5;i++)await store.upsert({session_key:String(i),last_seen_at:new Date(1000+i).toISOString()});
 const page1=await store.list(2,0),page2=await store.list(2,2),page3=await store.list(2,4);
 assert.deepEqual(page1.map(r=>r.session_key),['4','3']);assert.deepEqual(page2.map(r=>r.session_key),['2','1']);assert.equal(page3[0].session_key,'0');
});
test('Une archive récente conserve uniquement les temps, y compris les pilotes encore connectés',async()=>{
 const store=tmpHistory(),rec=new LiveHistoryRecorder(store,{writeIntervalMs:0});
 const data=snap({storedTimes:[{name:'A',model:'lola',laps:3,bestLap:'1:30.000',averageLapMs:94000,connected:true},{name:'B',model:'alfa',laps:1,connected:false}]});
 await rec.record(data);const row=(await store.list())[0];
 assert.equal(row.snapshot.cars.length,0);assert.equal(row.snapshot.events.length,0);assert.equal(row.snapshot.storedTimes.length,2);assert.equal(row.snapshot.storedTimes[0].averageLapMs,94000);assert.ok(row.snapshot.storedTimes.every(r=>!r.connected));assert.deepEqual(row.classification.map(r=>r.name),['A','B']);
});
test('Une session sans pilote connecté identifiable ne crée pas d’archive',async()=>{
 const store=tmpHistory(),rec=new LiveHistoryRecorder(store,{writeIntervalMs:0});const t=Date.parse('2026-01-01T12:00:00Z');
 const empty=snap({cars:[],session:{type:'practice',index:0,elapsedMs:20000},storedTimes:[{name:'Ancien',model:'lola',laps:2,connected:false}]});
 await rec.record(empty,t);
 await rec.record({...empty,cars:[{name:'Voiture #0',driverIdentified:false,connected:true}]},t+1000);
 await rec.record({...empty,cars:[{name:'Ancien',connected:false}]},t+2000);
 assert.equal((await store.list()).length,0);
 await rec.record({...empty,cars:[{name:'Alice',driverIdentified:true,connected:true}]},t+3000);
 await rec.record({...empty,cars:[{name:'Alice',driverIdentified:true,connected:false}]},t+4000);
 await rec.record({...empty,session:{type:'qualify',index:1,elapsedMs:0}},t+5000);
 const rows=await store.list();assert.equal(rows.length,1);assert.ok(rows[0].ended_at);
 await rec.record({...empty,session:{type:'qualify',index:1,elapsedMs:5000}},t+10000);assert.equal((await store.list()).length,1);
});

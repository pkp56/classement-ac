'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FileLiveHistory,PgLiveHistory}=require('../tools/live-timing/history');
const {noLapArchive,preview,remove}=require('../tools/live-timing/history-cleanup');
function row(id){return {id,ended_at:'2026-01-01T00:10:00Z',snapshot:{cars:[],storedTimes:[],bestLaps:[],events:[]},classification:[],best_laps:[],events:[]};}
test('Les séances closes sans tour connu sont distinguées des résultats et des données ambiguës',()=>{
 assert.equal(noLapArchive(row(1)),true);
 const legacy=row(2);delete legacy.snapshot.storedTimes;legacy.snapshot.cars=[{name:'A',laps:0,bestLap:null}];legacy.classification=[{name:'A',laps:0}];legacy.events=[{kind:'session'}];assert.equal(noLapArchive(legacy),true);
 const active=row(3);active.ended_at=null;assert.equal(noLapArchive(active),false);
 for(const field of ['bestLapMs','lastLapMs','totalMs','bestLap']){const r=row(4);r.classification=[{laps:0,[field]:field==='bestLap'?'1:20.000':80000}];assert.equal(noLapArchive(r),false);}
 const lap=row(5);lap.snapshot.storedTimes=[{laps:1}];assert.equal(noLapArchive(lap),false);
 const uncertain=row(6);uncertain.classification=[{name:'A'}];assert.equal(noLapArchive(uncertain),false);
 const event=row(7);event.events=[{kind:'lap'}];assert.equal(noLapArchive(event),false);
});
test('Suppression sur fichier : aperçu, sélection périmée refusée, sauvegarde et conservation des autres',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-clean-ui-'));try{
 const site=path.join(dir,'site'),back=path.join(dir,'private');fs.mkdirSync(site);fs.mkdirSync(back);
 const store=new FileLiveHistory(path.join(site,'history.json'));for(const r of [row(1),row(2),row(3)])await store.upsert({...r,session_key:'s'+r.id});
 store.rows[1].snapshot.storedTimes=[{laps:1,lastLapMs:90000}];store.rows[2].ended_at=null;store._persist();
 const p=await preview(store);assert.equal(p.count,1);assert.equal(p.items[0].id,'1');
 store.rows[0].snapshot.cars.push({name:'P',laps:0});await assert.rejects(remove(store,p.items,back,site),/changé/);assert.equal(store.rows.length,3);
 const fresh=await preview(store);await assert.rejects(remove(store,fresh.items,site,site),/hors du site/);assert.equal(store.rows.length,3);
 const result=await remove(store,fresh.items,back,site);assert.equal(result.deleted,1);assert.equal(JSON.parse(fs.readFileSync(path.join(back,result.backup)))[0].id,1);assert.deepEqual(store.rows.map(r=>r.id),[2,3]);assert.equal((await store.get(1)),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('PostgreSQL verrouille et annule si la sélection a changé',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-pg-clean-'));try{
 const site=path.join(dir,'site'),back=path.join(dir,'back');fs.mkdirSync(site);fs.mkdirSync(back);const queries=[];const r=row('7');
 const client={async query(sql){queries.push(sql);if(sql.startsWith('SELECT'))return {rows:[r]};return {rowCount:1,rows:[]};},release(){queries.push('release');}};
 const store=new PgLiveHistory({connect:async()=>client,query:async()=>({rows:[r]})});
 const p=await preview(store);r.snapshot.storedTimes=[{laps:1}];await assert.rejects(remove(store,p.items,back,site),/changé/);assert.ok(queries.includes('ROLLBACK'));assert.ok(!queries.some(q=>q.startsWith('DELETE')));
 r.snapshot.storedTimes=[];const result=await remove(store,(await preview(store)).items,back,site);assert.equal(result.deleted,1);assert.ok(queries.some(q=>q.includes('ACCESS EXCLUSIVE')));assert.ok(queries.includes('COMMIT'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Routes de nettoyage : authentification et CSRF exigés, puis sauvegarde et suppression confirmée',async t=>{
 const http=require('node:http'),{once}=require('node:events'),{spawn}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-clean-http-'));const backup=path.join(dir,'backup');fs.mkdirSync(backup);
 const file=path.join(dir,'history.json');fs.writeFileSync(file,JSON.stringify([{...row(1),session_key:'one'}]));
 const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 const child=spawn(process.execPath,['app.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),EVENTS_SOURCE:'local',ADMIN_USERNAME:'staff',ADMIN_PASSWORD:'test-password-only',JWT_SECRET:'test-secret-local-with-enough-characters',LIVE_TIMING_ENABLED:'0',LIVE_HISTORY_FILE:file,DATABASE_URL:'',LIVE_DATABASE_URL:'',EVENTS_DATABASE_URL:'',GDSP_AC_BACKUP_ROOT:backup},stdio:['ignore','pipe','pipe']});
 t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Démarrage trop long')),15000);child.stdout.on('data',b=>{if(String(b).includes('démarré')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Serveur arrêté'));});});
 const base='http://127.0.0.1:'+port;
 assert.equal((await fetch(base+'/api/live/empty-archives')).status,401);
 const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json','x-gdsp-session':'cookie'},body:JSON.stringify({username:'staff',password:'test-password-only'})});assert.equal(login.status,200);const auth=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
 const h={cookie,'content-type':'application/json'};const p=await (await fetch(base+'/api/live/empty-archives',{headers:h})).json();assert.equal(p.count,1);
 const body=JSON.stringify({items:p.items});assert.equal((await fetch(base+'/api/live/empty-archives',{method:'POST',headers:h,body})).status,403);assert.equal(JSON.parse(fs.readFileSync(file)).length,1);
 const removed=await fetch(base+'/api/live/empty-archives',{method:'POST',headers:{...h,'x-gdsp-csrf':auth.csrfToken},body});assert.equal(removed.status,200);assert.equal((await removed.json()).deleted,1);assert.equal(JSON.parse(fs.readFileSync(file)).length,0);assert.equal(fs.readdirSync(backup).length,1);
});

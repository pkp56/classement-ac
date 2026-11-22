'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FileLiveHistory,PgLiveHistory}=require('../tools/live-timing/history');
const {findGroups,preview,remove}=require('../tools/live-timing/history-duplicates');
function row(id,from,to,source='local2'){
 const start=new Date(1760000000000+from).toISOString(),end=new Date(1760000000000+to).toISOString();
 return {id,session_key:'s'+id,started_at:start,last_seen_at:end,ended_at:end,server_name:'test',track:'monza',track_config:'junior',session_type:'race',drivers:0,
 snapshot:{archiveSource:source,archiveModels:['alfa'],cars:[],events:[],collisions:[],bestLaps:[],session:{index:2,name:'Course',laps:5,timeMinutes:0,count:3},storedTimes:[{name:'Alice',model:'alfa',laps:4,bestLapMs:79186,lastLapMs:118059}]},classification:[{name:'Alice',model:'alfa',laps:4,bestLap:'1:19.186'}],best_laps:[],events:[]};
}
test('seules les archives closes contiguës courtes et aux résultats identiques sont proposées',()=>{
 const rows=[row(1,0,10000),row(2,10000,20000),row(3,20000,30000),row(4,30000,40000,'local1'),row(5,40000,50000)];
 assert.deepEqual(findGroups(rows).map(g=>g.map(r=>r.id)),[[1,2,3]]);
 for(const mutate of [r=>r.snapshot.storedTimes[0].bestLapMs++,r=>r.ended_at=null,r=>r.snapshot.events.push({kind:'lap'}),r=>r.snapshot.archiveSource=null,r=>r.classification[0].laps++,r=>r.snapshot.storedTimes=[],r=>r.track_config='autre']){
  const a=row(1,0,10000),b=row(2,10000,20000);mutate(b);assert.equal(findGroups([a,b]).length,0);
 }
 assert.equal(findGroups([row(1,0,40000),row(2,40000,50000)]).length,0);
 assert.equal(findGroups([row(1,0,10000),row(2,15000,25000)]).length,0);
});
test('aperçu, vérification du conservé, sauvegarde et suppression ciblée',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gdsp-duplicates-'));try{
 const site=path.join(dir,'site'),back=path.join(dir,'back');fs.mkdirSync(site);fs.mkdirSync(back);
 const store=new FileLiveHistory(path.join(site,'history.json'));for(const r of [row(1,0,10000),row(2,10000,20000),row(3,20000,30000),row(4,90000,100000)])await store.upsert(r);
 const p=await preview(store);assert.equal(p.count,2);assert.equal(p.groups[0].keep.id,'1');assert.deepEqual(p.groups[0].remove.map(x=>x.id),['2','3']);
 store.rows[0].snapshot.storedTimes[0].bestLapMs++;await assert.rejects(remove(store,p.groups,back,site),/changé/);assert.equal(store.rows.length,4);
 store.rows[0].snapshot.storedTimes[0].bestLapMs--;const fresh=await preview(store);await assert.rejects(remove(store,fresh.groups,site,site),/hors du site/);
 const res=await remove(store,fresh.groups,back,site);assert.equal(res.deleted,2);assert.deepEqual(store.rows.map(r=>r.id),[1,4]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(back,res.backup))).map(r=>r.id),[1,2,3]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('PostgreSQL verrouille et refuse une archive modifiée',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gdsp-dupe-pg-'));try{const site=path.join(dir,'site'),back=path.join(dir,'back');fs.mkdirSync(site);fs.mkdirSync(back);
 const rows=[row('1',0,10000),row('2',10000,20000)],queries=[];
 const client={async query(sql){queries.push(sql);if(sql.startsWith('SELECT'))return {rows};return {rowCount:1};},release(){}};
 const store=new PgLiveHistory({query:async()=>({rows}),connect:async()=>client});let p=await preview(store);rows[1].classification[0].laps++;
 await assert.rejects(remove(store,p.groups,back,site),/changé/);assert.ok(queries.includes('ROLLBACK'));assert.ok(!queries.some(s=>s.startsWith('DELETE')));
 rows[1].classification[0].laps--;p=await preview(store);const result=await remove(store,p.groups,back,site);assert.equal(result.deleted,1);assert.ok(queries.some(s=>s.includes('ACCESS EXCLUSIVE')));assert.ok(queries.includes('COMMIT'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('API doublons : apercu protege, CSRF et sauvegarde avant suppression',async t=>{
 const http=require('node:http'),{once}=require('node:events'),{spawn}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-dupes-http-')),back=path.join(dir,'back');fs.mkdirSync(back);
 const file=path.join(dir,'history.json');fs.writeFileSync(file,JSON.stringify([row(1,0,10000),row(2,10000,20000)]));
 const socket=http.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['app.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),EVENTS_SOURCE:'local',ADMIN_USERNAME:'staff',ADMIN_PASSWORD:'test-password-only',JWT_SECRET:'test-secret-local-with-enough-characters',LIVE_TIMING_ENABLED:'0',LIVE_HISTORY_FILE:file,DATABASE_URL:'',LIVE_DATABASE_URL:'',EVENTS_DATABASE_URL:'',GDSP_AC_BACKUP_ROOT:back},stdio:['ignore','pipe','pipe']});
 t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Demarrage trop long')),15000);child.stdout.on('data',b=>{if(String(b).includes('démarré')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Serveur arrete'));});});
 const base='http://127.0.0.1:'+port;assert.equal((await fetch(base+'/api/live/duplicate-archives')).status,401);
 const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json','x-gdsp-session':'cookie'},body:JSON.stringify({username:'staff',password:'test-password-only'})});
 assert.equal(login.status,200);const auth=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={cookie,'content-type':'application/json'};const p=await (await fetch(base+'/api/live/duplicate-archives',{headers})).json();assert.equal(p.count,1);
 const body=JSON.stringify({groups:p.groups});assert.equal((await fetch(base+'/api/live/duplicate-archives',{method:'POST',headers,body})).status,403);
 const response=await fetch(base+'/api/live/duplicate-archives',{method:'POST',headers:{...headers,'x-gdsp-csrf':auth.csrfToken},body});assert.equal(response.status,200);assert.equal((await response.json()).deleted,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)).map(r=>r.id),[1]);assert.equal(fs.readdirSync(back).length,1);
});

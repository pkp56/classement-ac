const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const ROOT=path.resolve(__dirname,'..');
async function server(t,env={}){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-safety-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const exclusions=path.join(temp,'exclusions.json');
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,['app.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),EVENTS_SOURCE:'local',DATABASE_URL:'',EVENTS_DATABASE_URL:'',ADMIN_USERNAME:'staff',ADMIN_PASSWORD:'test-password-only',JWT_SECRET:'test-secret-local-with-enough-characters',GLOBAL_EXCLUSIONS_FILE:exclusions,LIVE_TIMING_ENABLED:'0',LIVE_MIRROR_FILE:'off',TELEMETRY_ENABLED:'0',...env}});
  t.after(()=>{child.kill()});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('startup timeout')),10000);
    child.on('exit',code=>{clearTimeout(timer);reject(Error('exit '+code))});
    child.stdout.on('data',s=>{if(String(s).includes('démarré')){clearTimeout(timer);resolve()}});
  });
  const url='http://127.0.0.1:'+port;
  const call=(p,opts={})=>fetch(url+p,opts);
  const login=async()=>{
    const r=await call('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'staff',password:'test-password-only'})});
    assert.equal(r.status,200);return (await r.json()).token;
  };
  return {call,login,exclusions,url};
}
test('local : exclusions lisibles, écriture authentifiée atomique et erreur de fichier visible',async t=>{
  const {call,login,exclusions}=await server(t);
  let r=await call('/api/global-exclusions');assert.equal(r.status,200);assert.deepEqual((await r.json()).ids,{});
  assert.equal((await call('/api/global-exclusions',{method:'PUT',headers:{'content-type':'application/json'},body:'{"ids":{"p1":true}}'})).status,401);
  const token=await login();const headers={'content-type':'application/json',authorization:'Bearer '+token};
  assert.equal((await call('/api/global-exclusions',{method:'PUT',headers,body:'{"ids":{"p1":true,"notbool":"true"}}'})).status,200);
  assert.deepEqual((await (await call('/api/global-exclusions')).json()).ids,{p1:true});
  assert.equal((await call('/api/global-exclusions',{method:'PUT',headers,body:'{"ids":{"p2":true}}'})).status,200);
  assert.deepEqual(JSON.parse(await fs.readFile(exclusions+'.bak','utf8')).ids,{p1:true});
  await fs.writeFile(exclusions,'broken json');
  r=await call('/api/global-exclusions');assert.equal(r.status,503);assert.equal((await r.json()).code,'exclusions-unavailable');
});
test('local : aucun proxy implicite, routes retirées explicites et readiness distincte du live',async t=>{
  let requests=0;const backend=http.createServer((req,res)=>{requests++;res.end('Service Suspended')});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>backend.close());
  const {call}=await server(t,{BACKEND_URL:'http://127.0.0.1:'+backend.address().port});
  for(const p of ['/api/events','/api/championship','/api/health']){
    const r=await call(p);assert.equal(r.status,503,p);assert.match(r.headers.get('content-type'),/json/);
  }
  assert.equal((await call('/api/state')).status,410);
  const state=await call('/api/live/state');assert.equal(state.status,200);assert.equal((await state.json()).enabled,false);
  assert.equal((await call('/api/save-championship')).status,405);
  for(const p of ['/health','/healthz']){const r=await call(p);assert.equal(r.status,200);assert.equal((await r.json()).backend,undefined);}
  assert.equal(requests,0,'pas de retour au backend suspendu');
});
test('proxy AssettoHosting : les trois routes rejettent les origines forgées sans requête sortante',async t=>{
  const {call,url}=await server(t);
  const target='http://fr2.assettohosting.com@127.0.0.1:'+new URL(url).port+'/healthz';
  let r=await call('/api/ah-fetch?url='+encodeURIComponent(target));
  assert.equal(r.status,400);assert.match((await r.json()).error,/non autorisée/);
  const params=new URLSearchParams({server:target,uuid:'a'.repeat(36),eventId:'ev1',rawType:'RACE'});
  for(const route of ['/api/ah-championship-sessions','/api/ah-championship-session-json']){
    r=await call(route+'?'+params);assert.equal(r.status,400,route);assert.match((await r.json()).error,/non autorisé/);
  }
});
test('écritures locales refusées sans authentification, y compris reset, import et API inconnue',async t=>{
  const {call,login}=await server(t);
  const writes=[['POST','/api/save-championship'],['POST','/api/events'],['POST','/api/events/test-cup/data'],['PUT','/api/events/test-cup'],['DELETE','/api/events/test-cup'],['POST','/api/admin/reset'],['POST','/api/admin/circuits/import'],['POST','/api/admin/circuits/import-local'],['POST','/api/admin/local-mods/scan'],['POST','/api/results']];
  for(const [method,p] of writes){const r=await call(p,{method,headers:{'content-type':'application/json',authorization:'Bearer forged'},body:'{"confirmation":"REINIT_CHAMPIONNAT"}'});assert.equal(r.status,401,method+' '+p);}
  const token=await login(),headers={'content-type':'application/json',authorization:'Bearer '+token};
  assert.equal((await call('/api/admin/reset',{method:'POST',headers,body:'{}'})).status,400);
  assert.equal((await call('/api/admin/reset',{method:'POST',headers,body:'{"confirmation":"REINIT_CHAMPIONNAT"}'})).status,503);
  assert.equal((await call('/api/events',{method:'POST',headers,body:'{"slug":"test-cup","name":"Test"}'})).status,503);
});
test('headers compatibles inline, PDF stable, fichiers internes interdits et erreurs JSON',async t=>{
  const {call}=await server(t);
  const r=await call('/');assert.equal(r.status,503); // pas de DB dans ce scénario de test
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('x-powered-by'),null);
  assert.equal(r.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  const csp=r.headers.get('content-security-policy');assert.match(csp,/object-src 'none'/);assert.doesNotMatch(csp,/script-src/);
  assert.equal(r.headers.get('strict-transport-security'),null);
  const https=await call('/healthz',{headers:{'x-forwarded-proto':'https'}});assert.equal(https.headers.get('strict-transport-security'),'max-age=86400');
  for(const p of ['/tools/events/api.js','/%74ools/events/api.js','/assets/..%2ftools/events/api.js','/data/%67lobal-exclusions.json','/tools/lib/local-mods.js','/app.js','/.git/config','/data/global-exclusions.json','/data/telemetry-store.json','/data/live-history.json'])assert.equal((await call(p)).status,404,p);
  const pdf=await call('/docs/reglement-piste-gdsp-v2024-12.pdf');assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  const bad=await call('/api/events',{method:'POST',headers:{'content-type':'application/json'},body:'{invalid'});assert.equal(bad.status,400);assert.equal((await bad.json()).code,'request-error');
});
test('mode backend explicite : login reste possible et 503 distant est normalisé',async t=>{
  const backend=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/api/admin/login')return res.end('{"token":"example"}');
      if(req.url==='/api/admin/verify')return res.end('{"ok":true}');
      res.statusCode=503;res.setHeader('content-type','text/html');res.end('Service Suspended by owner');
    });
  });backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>backend.close());
  const {call}=await server(t,{EVENTS_SOURCE:'backend',BACKEND_URL:'http://127.0.0.1:'+backend.address().port});
  const login=await call('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(login.status,200);assert.equal((await login.json()).token,'example');
  const response=await call('/api/events');assert.equal(response.status,503);assert.equal((await response.json()).code,'upstream-unavailable');
});

test('reset local : sauvegarde obligatoire avant écriture, métadonnées conservées',async()=>{
  const {resetWithBackup}=require('../tools/events/reset');
  const calls=[],previous={slug:'cup',data:{sessions:[1],penMap:{x:1},posterImage:'image',modSelection:{cars:[{id:'car'}]}}};
  const store={get:async()=>previous,saveData:async(slug,data,user)=>{calls.push('write');assert.equal(data.sessions.length,0);assert.deepEqual(data.penMap,{});assert.equal(data.posterImage,'image');assert.equal(data.modSelection.cars[0].id,'car');return {updated_at:'now'};}};
  await resetWithBackup({store,slug:'cup',user:'admin',backup:async data=>{assert.equal(data,previous);calls.push('backup')}});
  assert.deepEqual(calls,['backup','write']);
  calls.length=0;
  await assert.rejects(resetWithBackup({store,slug:'cup',user:'admin',backup:async()=>{throw Error('disk full')}}),/disk full/);
  assert.deepEqual(calls,[]);
});

test('session navigateur réelle : login HTTPS, exclusions protégées CSRF et lecture télémétrie',async t=>{
  const {call}=await server(t);
  const login=await call('/api/admin/login',{method:'POST',headers:{'content-type':'application/json','x-gdsp-session':'cookie','x-forwarded-proto':'https'},body:'{"username":"staff","password":"test-password-only"}'});
  assert.equal(login.status,200);const j=await login.json();assert.equal(j.token,undefined);assert.equal(j.authenticated,true);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,'x-forwarded-proto':'https','content-type':'application/json'};
  const body='{"ids":{"test-pilot":true}}';
  const blocked=await call('/api/global-exclusions',{method:'PUT',headers,body});assert.equal(blocked.status,403);
  assert.deepEqual((await(await call('/api/global-exclusions')).json()).ids,{});
  const saved=await call('/api/global-exclusions',{method:'PUT',headers:{...headers,'x-gdsp-csrf':j.csrfToken},body});assert.equal(saved.status,200);
  assert.deepEqual((await(await call('/api/global-exclusions')).json()).ids,{'test-pilot':true});
  const verified=await call('/api/admin/verify',{headers});assert.equal(verified.status,200);assert.equal((await verified.json()).user,'staff');
  const telemetry=await call('/api/telemetry/catalog',{headers});assert.notEqual(telemetry.status,401);assert.notEqual(telemetry.status,403);
  const noCsrf=await call('/api/admin/reset',{method:'POST',headers,body:'{"confirmation":"REINIT_CHAMPIONNAT"}'});assert.equal(noCsrf.status,403);
});

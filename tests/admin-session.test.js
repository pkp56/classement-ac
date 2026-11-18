'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {once}=require('node:events');
const {mountAdminSession}=require('../tools/lib/admin-session');
const auth=require('../tools/events/api');
const fs=require('node:fs');
const vm=require('node:vm');

async function harness(t,options={}){
  const env={ADMIN_USERNAME:'staff',ADMIN_PASSWORD:'local-test-only',JWT_SECRET:'session-tests-with-a-long-secret'};
  const previous={};
  for(const [k,v] of Object.entries(env)){previous[k]=process.env[k];process.env[k]=v;}
  t.after(()=>{for(const [k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const app=express();app.set('trust proxy','loopback');
  app.use(require('../tools/lib/web-security').securityHeaders);
  app.use(express.json());
  mountAdminSession(app,options);
  app.post('/api/admin/login',(req,res)=>res.json({legacy:true}));
  app.all('/api/protected',(req,res)=>{
    const check=auth.verifyAdminToken(req.headers.authorization);
    if(!check.ok)return res.status(401).json({ok:false});
    res.json({ok:true,user:check.user});
  });
  app.post('/api/agent-push',(req,res)=>res.json({ok:req.get('X-Agent-Token')==='agent-secret'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(p,opts={})=>fetch(base+p,opts);
  const login=(headers={},body={username:'staff',password:'local-test-only'})=>call('/api/admin/login',{method:'POST',headers:{'content-type':'application/json','x-gdsp-session':'cookie',...headers},body:JSON.stringify(body)});
  return {call,login,base};
}
function cookieOf(response){return response.headers.get('set-cookie').split(';')[0];}

test('HTTPS : cookie HttpOnly Secure SameSite strict, sans JWT dans le JSON ; session et écriture CSRF',async t=>{
  const {call,login,base}=await harness(t);
  const forwarded={'x-forwarded-proto':'https'};
  const r=await login(forwarded);assert.equal(r.status,200);
  const setCookie=r.headers.get('set-cookie');
  assert.match(setCookie,/^__Host-gdsp_admin=/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Path=\//);assert.doesNotMatch(setCookie,/Domain=/);
  const j=await r.json();assert.equal(j.authenticated,true);assert.equal(j.token,undefined);assert.match(j.csrfToken,/^[a-f0-9]{64}$/);
  const cookie=cookieOf(r),headers={...forwarded,cookie};
  const state=await call('/api/admin/session',{headers});assert.equal(state.status,200);assert.equal((await state.json()).csrfToken,j.csrfToken);assert.equal(state.headers.get('cache-control'),'no-store');
  assert.equal((await call('/api/protected',{headers})).status,200);
  for(const method of ['POST','PUT','DELETE','PATCH']){
    assert.equal((await call('/api/protected',{method,headers})).status,403);
    assert.equal((await call('/api/protected',{method,headers:{...headers,'x-gdsp-csrf':'forged'}})).status,403);
    assert.equal((await call('/api/protected',{method,headers:{...headers,'x-gdsp-csrf':j.csrfToken,origin:base.replace('http:','https:')}})).status,200);
  }
  // L'ajout d'un Bearer ne désactive pas la protection d'une session cookie.
  assert.equal((await call('/api/protected',{method:'POST',headers:{...headers,authorization:'Bearer arbitrary'}})).status,403);
  assert.equal((await call('/api/protected',{method:'POST',headers:{...headers,'x-gdsp-csrf':j.csrfToken,origin:'https://evil.example'}})).status,403);
  assert.equal((await call('/api/admin/logout',{method:'POST',headers})).status,403);
  const logout=await call('/api/admin/logout',{method:'POST',headers:{...headers,'x-gdsp-csrf':j.csrfToken}});
  assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/__Host-gdsp_admin=;/);assert.match(logout.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
  assert.equal((await call('/api/admin/session')).status,401);
});

test('HTTP uniquement sur loopback : cookie de développement séparé ; domaine public exige HTTPS',async t=>{
  const {login,call}=await harness(t);
  const local=await login();assert.equal(local.status,200);assert.match(local.headers.get('set-cookie'),/^gdsp_dev_admin=/);assert.doesNotMatch(local.headers.get('set-cookie'),/; Secure/);
  assert.equal((await call('/api/admin/session',{headers:{cookie:cookieOf(local)}})).status,200);
  const publicHttp=await login({'x-forwarded-host':'gdsp.duckdns.org'});assert.equal(publicHttp.status,400);assert.equal((await publicHttp.json()).code,'https-required');assert.equal(publicHttp.headers.get('set-cookie'),null);
  assert.equal((await call('/api/admin/session',{headers:{'x-forwarded-proto':'https',cookie:cookieOf(local)}})).status,401,'le cookie dev ne fonctionne pas en HTTPS');
});

test('login : origines étrangères refusées, échecs sans cookie, expiration et signatures invalides',async t=>{
  const {call,login}=await harness(t);
  assert.equal((await login({origin:'https://evil.example'})).status,403);
  assert.equal((await login({'sec-fetch-site':'cross-site'})).status,403);
  const bad=await login({}, {username:'staff',password:'wrong'});assert.equal(bad.status,401);assert.equal(bad.headers.get('set-cookie'),null);
  for(const token of ['invalid','%bad',require('jsonwebtoken').sign({sub:'staff'},process.env.JWT_SECRET,{expiresIn:-1})]){
    assert.equal((await call('/api/admin/session',{headers:{cookie:'gdsp_dev_admin='+token}})).status,401);
  }
  const duplicate=await login();
  assert.equal((await call('/api/admin/session',{headers:{cookie:cookieOf(duplicate)+'; '+cookieOf(duplicate)}})).status,401);
});

test('limite par IP avant authentification, délai Retry-After et reprise après fenêtre',async t=>{
  let time=0;
  const {login,call}=await harness(t,{now:()=>time});
  for(let i=0;i<10;i++)assert.equal((await login({}, {username:'staff',password:'wrong'})).status,401);
  const limited=await login();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'900');
  // L'en-tête X-Forwarded-For provient ici du proxy loopback de confiance.
  assert.equal((await login({'x-forwarded-for':'198.51.100.2','x-forwarded-proto':'https'})).status,200);
  assert.equal((await call('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,429,'la limite couvre aussi le login Bearer historique');
  time+=900001;assert.equal((await login()).status,200);
});

test('les clients API Bearer et les agents sans cookie restent utilisables sans CSRF',async t=>{
  const {call}=await harness(t);
  const token=auth.signAdminToken('staff');
  assert.equal((await call('/api/protected',{method:'POST',headers:{authorization:'Bearer '+token}})).status,200);
  assert.equal((await call('/api/protected',{method:'POST'})).status,401);
  const push=await call('/api/agent-push',{method:'POST',headers:{'X-Agent-Token':'agent-secret'}});assert.deepEqual(await push.json(),{ok:true});
});

test('mode backend : refus explicite de la session navigateur, pas de JWT exposé par inadvertance',async t=>{
  const {login,call}=await harness(t,{source:()=> 'backend'});
  const r=await login();assert.equal(r.status,503);assert.equal((await r.json()).token,undefined);
  const legacy=await call('/api/admin/login',{method:'POST'});assert.equal((await legacy.json()).legacy,true);
});

function browser(){
  const calls=[],removed=[];
  const sandbox={URL,Headers,Promise,localStorage:{removeItem:k=>removed.push(k)},sessionStorage:{removeItem:k=>removed.push(k)}};
  sandbox.window=sandbox;sandbox.location={href:'https://gdsp.duckdns.org/',origin:'https://gdsp.duckdns.org'};
  sandbox.fetch=async(input,opts)=>{
    calls.push({input,opts});
    const body=input==='/api/admin/session'?{authenticated:true,csrfToken:'csrf-123'}:input==='/api/admin/login'?{authenticated:true,csrfToken:'csrf-new'}:{ok:true};
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../assets/admin-session.js'),'utf8'),sandbox);
  return {sandbox,calls,removed};
}

test('client navigateur : nonce mémoire, cookies same-origin et aucun Bearer ni stockage de jeton',async()=>{
  const {sandbox,calls,removed}=browser();
  await sandbox.gdspAuth.fetch('/api/events/test/data',{method:'POST',headers:{Authorization:'Bearer old','Content-Type':'application/json'},body:'{}'});
  assert.equal(calls[0].input,'/api/admin/session');
  const write=calls[1];assert.equal(write.opts.headers.get('authorization'),null);assert.equal(write.opts.headers.get('x-gdsp-csrf'),'csrf-123');assert.equal(write.opts.credentials,'same-origin');
  assert.equal(removed.length,2);
  await sandbox.gdspAuth.fetch('/api/admin/login',{method:'POST'});
  assert.equal(calls.at(-1).opts.headers.get('x-gdsp-session'),'cookie');
  await sandbox.gdspAuth.fetch('/api/events/test',{method:'DELETE'});assert.equal(calls.at(-1).opts.headers.get('x-gdsp-csrf'),'csrf-new');
  await sandbox.gdspAuth.fetch('https://external.example/api/test',{method:'POST'});
  assert.equal(calls.at(-1).opts.headers,undefined);assert.equal(calls.at(-1).opts.credentials,undefined);
  await sandbox.gdspAuth.fetch('/api/admin/logout',{method:'POST'});
  const count=calls.length;
  await sandbox.gdspAuth.fetch('/api/events',{method:'POST'});
  assert.equal(calls[count].input,'/api/admin/session','le nonce est relu après logout');
});

test('un ancien cookie invalide ne bloque pas une nouvelle connexion',async t=>{
  const {login}=await harness(t);
  const r=await login({cookie:'gdsp_dev_admin=ancienne-signature-invalide'});
  assert.equal(r.status,200);assert.equal((await r.json()).authenticated,true);
});

test('JWT : seuls les jetons admin HS256 avec expiration sont acceptés',()=>{
  const jwt=require('jsonwebtoken'),env={JWT_SECRET:'secret-long-for-tests-no-defaults'};
  for(const [claims,options] of [
    [{sub:'staff',role:'user'},{expiresIn:3600}],
    [{sub:'staff',role:'admin'},{}],
    [{sub:'staff',role:'admin'},{expiresIn:3600,algorithm:'HS384'}]
  ])assert.equal(auth.verifyAdminToken('Bearer '+jwt.sign(claims,env.JWT_SECRET,options),env).ok,false);
});

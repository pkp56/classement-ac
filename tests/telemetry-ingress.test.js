'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRateLimiter,rateLimitFromEnv,validateEnvelope}=require('../tools/telemetry/ingress-guard');

function invoke(middleware,ip,method='POST') {
  const state={status:200,headers:{},body:null,next:false};
  const req={method,ip,socket:{remoteAddress:'fallback'}};
  const res={set(k,v){state.headers[k]=v;return this},status(code){state.status=code;return this},json(body){state.body=body;return this}};
  middleware(req,res,()=>{state.next=true});
  return state;
}

test('quota par IP, expiration, en-tête de reprise, mémoire bornée',()=>{
  let time=1000;
  const limiter=createRateLimiter({limit:2,maxClients:2,now:()=>time});
  assert.equal(invoke(limiter,'a').next,true);
  assert.equal(invoke(limiter,'a').next,true);
  let result=invoke(limiter,'a');assert.equal(result.status,429);assert.equal(result.headers['Retry-After'],'60');assert.equal(result.body.code,'telemetry-rate-limited');
  assert.equal(invoke(limiter,'b').next,true);
  assert.equal(invoke(limiter,'c').status,429);
  assert.equal(invoke(limiter,'c','GET').next,true);
  time+=60000;
  assert.equal(invoke(limiter,'c').next,true);
  assert.equal(invoke(limiter,'a').next,true);
});

test('une configuration invalide ne désactive pas le quota',()=>{
  for(const value of [undefined,'','0','-1','NaN','10.5','10001']) assert.equal(rateLimitFromEnv(value),1200);
  assert.equal(rateLimitFromEnv('42'),42);
});

test('enveloppes valides et malformées pour ping, tour et mesure',()=>{
  assert.equal(validateEnvelope({kind:'ping',track:'circuit',driver:{guid:'123',name:'Pilote'},car:'voiture'}),null);
  assert.equal(validateEnvelope({kind:'measurement-poll',sessionKey:'t:123',measurement:{phase:'service'}}),null);
  assert.equal(validateEnvelope({track:'circuit',laps:[{lapMs:60000}]}),null);
  for(const value of [null,[],{}, {track:'x'.repeat(161)}, {serverName:'a\nb'}, {driver:'pilote'}, {driver:{name:'a'.repeat(101)}}, {laps:Array(201).fill({})}, {measurement:[]}]){
    if(value && !Array.isArray(value) && Object.keys(value).length===0) {assert.equal(validateEnvelope(value),null);continue}
    assert.ok(validateEnvelope(value),JSON.stringify(value));
  }
});

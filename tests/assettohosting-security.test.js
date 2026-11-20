'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {DEFAULT_SERVERS,configuredServers,createAssettoHostingFetcher}=require('../tools/lib/assettohosting-fetch');

const fr2='https://fr2.assettohosting.com:50648';
const fr5='https://fr5.assettohosting.com:50145';
const servers=configuredServers(DEFAULT_SERVERS);
const publicDns=async()=>[{address:'8.8.8.8',family:4}];

test('origines explicites, sans sous-domaines, identifiants, ports arbitraires ni chemins de serveur',()=>{
  const client=createAssettoHostingFetcher(servers);
  assert.equal(client.authorize(fr2+'/results/download/file.json').hostname,'fr2.assettohosting.com');
  assert.equal(client.authorize(fr5,true).origin,fr5);
  for(const value of [
    'http://fr2.assettohosting.com@127.0.0.1:10000/healthz',
    'https://fr2.assettohosting.com.evil.example/results',
    'https://fr2.assettohosting.com@evil.example/results',
    'https://user:secret@fr2.assettohosting.com:50648/results',
    'https://fr2.assettohosting.com:1/results',
    'http://fr2.assettohosting.com:50648/results',
    'https://fr5.assettohosting.com:50648/results',
    'file://fr2.assettohosting.com/results',
    fr2+'/results#fragment'
  ]) assert.throws(()=>client.authorize(value), /non autorisée/,value);
  for(const value of [fr2+'/path',fr2+'/?x=1']) assert.throws(()=>client.authorize(value,true));
  assert.throws(()=>configuredServers('https://fr2.assettohosting.com.evil.example:50648'));
  assert.throws(()=>configuredServers(fr2+'/path'));
  // Un nouveau serveur ou port doit être explicitement configuré par l'exploitant.
  assert.equal(createAssettoHostingFetcher([fr2,'https://fr5.assettohosting.com:50648']).authorize('https://fr5.assettohosting.com:50648').port,'50648');
});

test('DNS privé, mixte et IPv6 refusés avant toute connexion',async()=>{
  for(const records of [
    [{address:'127.0.0.1',family:4}], [{address:'10.1.2.3',family:4}],
    [{address:'169.254.169.254',family:4}], [{address:'192.168.1.5',family:4}],
    [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],
    [{address:'::1',family:6}], []
  ]) {
    let calls=0;
    const client=createAssettoHostingFetcher(servers,{resolve:async()=>records,get:()=>{calls++;throw Error('connexion interdite')}});
    await assert.rejects(client.fetch(fr2+'/results'),/Adresse AssettoHosting non autorisée/);
    assert.equal(calls,0);
  }
});

async function fixture(t,handler,options={}){
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const calls=[];
  const client=createAssettoHostingFetcher(servers,{
    resolve:options.resolve||publicDns,
    maxBody:options.maxBody,
    maxRedirects:options.maxRedirects,
    get:(url,opts,callback)=>{
      // La connexion réelle est redirigée uniquement vers ce serveur de test.
      // On vérifie auparavant que la fonction lookup du client fige l'IP validée.
      opts.lookup(url.hostname,{},(err,address,family)=>{assert.ifError(err);assert.equal(address,'8.8.8.8');assert.equal(family,4)});
      calls.push(url.toString());
      return http.get({...opts,protocol:'http:',hostname:'127.0.0.1',port:server.address().port,lookup:undefined},callback);
    }
  });
  return {client,calls};
}

test('requête normale et redirection relative autorisée utilisent une IP figée',async t=>{
  const {client,calls}=await fixture(t,(req,res)=>{
    if(req.url==='/results') {res.writeHead(302,{location:'/results/download/test.json'});return res.end()}
    res.setHeader('content-type','application/json');res.end('{"ok":true}');
  });
  const result=await client.fetch(fr2+'/results');
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body),{ok:true});
  assert.deepEqual(calls,[fr2+'/results',fr2+'/results/download/test.json']);
});

test('redirections externes, internes ou trop nombreuses refusées avant la requête suivante',async t=>{
  for(const location of ['http://127.0.0.1:1234/internal','https://fr2.assettohosting.com.evil.example/x','https://fr2.assettohosting.com:1/x']){
    const {client,calls}=await fixture(t,(_req,res)=>{res.writeHead(302,{location});res.end()});
    await assert.rejects(client.fetch(fr2+'/results'),/non autorisée/);
    assert.equal(calls.length,1);
  }
  const {client,calls}=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'/loop'});res.end()},{maxRedirects:2});
  await assert.rejects(client.fetch(fr2+'/loop'),/Trop de redirections/);
  assert.equal(calls.length,3);
});

test('DNS est revérifié à chaque redirection et une réponse trop grande est refusée',async t=>{
  let resolutions=0;
  const {client,calls}=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'/next'});res.end()},
    {resolve:async()=>++resolutions===1?publicDns():[{address:'127.0.0.1',family:4}]});
  await assert.rejects(client.fetch(fr2+'/start'),/Adresse AssettoHosting non autorisée/);
  assert.equal(calls.length,1);
  const big=await fixture(t,(_req,res)=>res.end('123456789'),{maxBody:4});
  await assert.rejects(big.client.fetch(fr2+'/large'),/trop volumineuse/);
});

test('une redirection ne peut pas dégrader HTTPS vers HTTP, même si les deux origines sont configurées',async t=>{
  const server=http.createServer((_req,res)=>{res.writeHead(302,{location:'http://fr2.assettohosting.com:50648/results'});res.end()});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  let calls=0;
  const client=createAssettoHostingFetcher([fr2,'http://fr2.assettohosting.com:50648'],{
    resolve:publicDns,
    get:(_url,opts,callback)=>{calls++;return http.get({...opts,protocol:'http:',hostname:'127.0.0.1',port:server.address().port,lookup:undefined},callback)}
  });
  await assert.rejects(client.fetch(fr2+'/results'),/HTTPS non sécurisée/);
  assert.equal(calls,1);
});

test('le délai global couvre aussi le DNS',async()=>{
  const client=createAssettoHostingFetcher(servers,{resolve:()=>new Promise(()=>{}),get:()=>{throw Error('ne doit pas connecter')}});
  await assert.rejects(client.fetch(fr2+'/results',30),/Délai AssettoHosting dépassé/);
});

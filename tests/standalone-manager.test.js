'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const {handler}=require('../standalone-manager/server');
test('Gestionnaire autonome sert uniquement ses fichiers locaux et refuse les écritures',async()=>{
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 async function request(path,host,method='GET'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers:{host}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end();});}
 try{
  const page=await request('/',`127.0.0.1:${port}`);assert.equal(page.status,200);assert.match(page.body,/Aucun serveur n’est connecté/);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await request('/',`evil.example:${port}`)).status,403);
  assert.equal((await request('/',`localhost:${port}`,'POST')).status,405);
  assert.equal((await request('/../../package.json',`localhost:${port}`)).status,404);
  assert.equal((await request('/app.js',`localhost:${port}`)).status,200);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Proposition de grille inverse explicitement Result sans calculer de pénalités',()=>{
 const {prepare}=require('../standalone-manager/public/grid');
 const result={Type:'RACE',Date:'2026-12-03',TrackName:'ks_monza66',TrackConfig:'junior',Cars:[{CarId:0,Driver:{Name:'Alice',Guid:'111'}},{CarId:1,Driver:{Name:'Bob',Guid:'222'}},{CarId:2,Driver:{Name:'Chloé'}}],Result:[{CarId:0,PenaltyTime:999},{CarId:1},{CarId:2,Disqualified:true}]};
 const plan=prepare(result);assert.deepEqual(plan.grid.map(p=>p.name),['Chloé','Bob','Alice']);assert.deepEqual(plan.grid.map(p=>p.sourcePosition),[3,2,1]);assert.equal(plan.grid[0].guid,null);assert.equal(result.Result[0].PenaltyTime,999);
});
test('Refuse les résultats incomplets et les identités ambiguës',()=>{
 const {prepare}=require('../standalone-manager/public/grid');
 const make=()=>({Type:'RACE',Cars:[{CarId:0,Driver:{Name:'Alice',Guid:'x'}},{CarId:1,Driver:{Name:'Bob',Guid:'y'}}],Result:[{CarId:0},{CarId:1}]});
 for(const modify of [x=>x.Type='QUALIFY',x=>x.Result=[],x=>x.Result.push({CarId:0}),x=>x.Cars.pop(),x=>x.Cars[1].Driver.Guid='x',x=>x.Cars[0].Driver.Name='',x=>x.Result[0].CarId='0']){const input=make();modify(input);assert.throws(()=>prepare(input));}
});

test('Aperçu course 2 en lecture seule : durée et sessions, sans secrets',()=>{
 const {inspect}=require('../standalone-manager/public/race-preview');
 const config='[SERVER]\r\nTRACK=ks_monza66\r\nCONFIG_TRACK=junior\r\nPASSWORD=secret\r\nUDP_PORT=9601\r\nREVERSED_GRID_RACE_POSITIONS=-1\r\n[QUALIFY]\r\nTIME=10\r\n[RACE]\r\nLAPS=0\r\nTIME=15\r\n';
 const preview=inspect(config,'25');assert.equal(preview.beforeMinutes,15);assert.equal(preview.afterMinutes,25);assert.equal(preview.nativeReverse,'-1');assert.deepEqual(preview.otherActiveSessions,['QUALIFY']);assert.doesNotMatch(JSON.stringify(preview),/secret|9601/);assert.match(config,/TIME=15/);
});
test('Aperçu refuse les INI et durées ambigus, sans forcer un changement de mode',()=>{
 const {inspect}=require('../standalone-manager/public/race-preview');const text='[SERVER]\nTRACK=monza\n[RACE]\nLAPS=0\nTIME=15\n';
 for(const invalid of ['0','25.5','-1','1441','25\nPASSWORD=x'])assert.throws(()=>inspect(text,invalid));
 for(const invalid of [text+'[RACE]\nTIME=2\n',text.replace('LAPS=0','LAPS=5'),text.replace('[RACE]','[__CM_RACE_OFF]'),text.replace('TIME=15','TIME=15\nTIME=5'),text.replace('[SERVER]','[SERVER]\nREVERSED_GRID_RACE_POSITIONS=bad')])assert.throws(()=>inspect(invalid,25));
});

test('Copie de test : change seulement la durée et neutralise la seconde course native',()=>{
 const {createCopy}=require('../standalone-manager/public/race-preview');
 const original='[SERVER]\r\nPASSWORD=secret\r\nUDP_PORT=9601\r\nREVERSED_GRID_RACE_POSITIONS=-1\r\n[QUALIFY]\r\nTIME=10\r\n[RACE]\r\nLAPS=0\r\nTIME=15\r\n[OTHER]\r\nSCRIPT=keep\r\n';
 const result=createCopy(original,'25');
 assert.equal(result.text,original.replace('REVERSED_GRID_RACE_POSITIONS=-1','REVERSED_GRID_RACE_POSITIONS=0').replace('TIME=15','TIME=25'));
 assert.equal(result.plan.beforeMinutes,15);assert.match(original,/TIME=15/);
});
test('Copie de test : ajoute la désactivation native si absente et refuse les configurations ambiguës',()=>{
 const {createCopy}=require('../standalone-manager/public/race-preview');
 const config='[SERVER]\nUDP_PORT=9600\n[RACE]\nLAPS=0\nTIME=15';
 assert.equal(createCopy(config,25).text,'[SERVER]\nREVERSED_GRID_RACE_POSITIONS=0\nUDP_PORT=9600\n[RACE]\nLAPS=0\nTIME=25');
 assert.throws(()=>createCopy(config+'\nTIME=4',25));
 assert.throws(()=>createCopy(config.replace('LAPS=0','LAPS=1'),25));
 assert.throws(()=>createCopy(config,1441));
});

test('Associe les blocs réservés par GUID et conserve skins et options avec les pilotes',()=>{
 const {prepare}=require('../standalone-manager/public/entry-preview');
 const text='; header\r\n[CAR_0]\r\nMODEL=alfa\r\nSKIN=red/opts\r\nGUID=111\r\nBALLAST=3\r\n[CAR_1]\r\nMODEL=alfa\r\nSKIN=blue\r\nGUID=222\r\n[CAR_2]\r\nMODEL=alfa\r\nSKIN=free\r\nGUID=\r\n';
 const grid=[{gridPosition:1,name:'Bob',guid:'222'},{gridPosition:2,name:'Alice',guid:'111'}];
 const out=prepare(text,grid);assert.match(out.text,/\[CAR_0\]\r\nMODEL=alfa\r\nSKIN=blue\r\nGUID=222/);assert.match(out.text,/\[CAR_1\]\r\nMODEL=alfa\r\nSKIN=red\/opts\r\nGUID=111\r\nBALLAST=3/);assert.match(out.text,/\[CAR_2\][\s\S]*GUID=/);assert.equal(out.unreserved,1);assert.equal(out.mapping[0].oldSlot,1);
});
test('Association refuse GUID absents, réservations non incluses et sections ambiguës',()=>{
 const {prepare}=require('../standalone-manager/public/entry-preview');
 const text='[CAR_0]\nMODEL=a\nSKIN=x\nGUID=1\n[CAR_1]\nMODEL=a\nSKIN=y\nGUID=2\n';
 const valid=[{gridPosition:1,name:'A',guid:'1'},{gridPosition:2,name:'B',guid:'2'}];
 for(const grid of [[{gridPosition:1,name:'A',guid:null}],valid.slice(0,1),[{gridPosition:1,guid:'1'},{gridPosition:2,guid:'1'}],[{gridPosition:2,guid:'1'}]])assert.throws(()=>prepare(text,grid));
 for(const source of [text.replace('GUID=2','GUID=1'),text.replace('[CAR_1]','[CAR_4]'),text+'[OTHER]\nFOO=x\n',text.replace('SKIN=x\n','')])assert.throws(()=>prepare(source,valid));
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const dgram=require('node:dgram');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function wstr(s){const b=Buffer.alloc(1+s.length*4);b[0]=s.length;[...s].forEach((c,i)=>b.writeUInt32LE(c.codePointAt(0),1+i*4));return b;}
function str(s){const b=Buffer.from(s);return Buffer.concat([Buffer.from([b.length]),b]);}
function u16(n){const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;}
function packet(name,track){return Buffer.concat([Buffer.from([0x32,4,0,0,2]),wstr(name),str(track),str(''),str('Practice'),Buffer.from([1]),u16(60),u16(0),u16(0),Buffer.from([26,34]),str('clear'),Buffer.alloc(4)]);}
async function port(type){const s=type==='udp'?dgram.createSocket('udp4'):net.createServer();if(type==='udp'){s.bind(0,'127.0.0.1');await once(s,'listening');}else{s.listen(0,'127.0.0.1');await once(s,'listening');}const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('Deux collecteurs UDP gardent les serveurs distincts et une source inconnue reste vide',async t=>{
  const ports=new Set();while(ports.size<5)ports.add(await port('udp'));
  const [listen1,plugin1,listen2,plugin2]=[...ports];
  const httpPort=await port('tcp');
  const child=spawn(process.execPath,['app.js'],{cwd:root,env:{...process.env,PORT:String(httpPort),LIVE_MIRROR_FILE:'off',LIVE_HTTP_SOURCES:'',LIVE_PUSH_TOKEN:'',AC_LISTEN_PORT:String(listen1),AC_PLUGIN_PORT:String(plugin1),AC_SECOND_LISTEN_PORT:String(listen2),AC_SECOND_PLUGIN_PORT:String(plugin2),AC_SERVER_LABEL:'CM 1',AC_SECOND_LABEL:'CM 2'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('démarrage trop long')),15000);child.stdout.on('data',d=>{if(String(d).includes('démarré')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(Error('serveur arrêté'));});});
  const sender=dgram.createSocket('udp4');t.after(()=>sender.close());
  const url=`http://127.0.0.1:${httpPort}`;
  let a,b;
  for(let i=0;i<30;i++){
    await new Promise((resolve,reject)=>sender.send(packet('CM 1','sugo'),listen1,'127.0.0.1',e=>e?reject(e):resolve()));
    await new Promise((resolve,reject)=>sender.send(packet('CM 2','charade'),listen2,'127.0.0.1',e=>e?reject(e):resolve()));
    await new Promise(r=>setTimeout(r,100));
    a=await (await fetch(url+'/api/live/status?source=local1')).json();
    b=await (await fetch(url+'/api/live/status?source=local2')).json();
    if(a.server.name==='CM 1'&&b.server.name==='CM 2')break;
  }
  assert.equal(a.server.track,'sugo');assert.equal(b.server.track,'charade');
  const cfg=await (await fetch(url+'/api/live/config')).json();
  assert.deepEqual(cfg.localSources.map(x=>x.id),['local1','local2']);
  const unknown=await (await fetch(url+'/api/live/status?source=nonexistent')).json();
  assert.equal(unknown.server.name,undefined);assert.match(unknown.status.error,/Source inconnue/);
});

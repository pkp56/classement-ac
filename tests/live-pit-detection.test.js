'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {loadPitGeometry,updatePit}=require('../tools/live-timing/pit-detection');
function lane(points){const b=Buffer.alloc(16+points.length*20);b.writeInt32LE(7,0);b.writeInt32LE(points.length,4);points.forEach((p,i)=>p.forEach((n,j)=>b.writeFloatLE(n,16+i*20+j*4)));return b;}
const geometry={fast:[{x:0,y:0,z:0},{x:100,y:0,z:0},{x:100,y:0,z:100},{x:0,y:0,z:100}],pit:[{x:0,y:0,z:15},{x:100,y:0,z:15},{x:110,y:0,z:15}]};
for(const speed of [80,120]) test(`PIT estimé : plateau ${speed}, passage, arrêt et sortie`,()=>{
 const c={}; let t=1000;const update=(x,z,v)=>{t+=500;return updatePit(c,geometry,{x,y:0,z},v,t);};
 for(let i=0;i<6;i++)assert.equal(update(20+i*5,15,speed),false);
 assert.equal(c.pitState,'lane');assert.equal(c.inPit,true);
 for(let i=0;i<8;i++)assert.equal(update(60,16,0),false);
 assert.equal(update(60,16,0),true);assert.equal(c.pitState,'stopped');
 update(60,16,10);for(let i=0;i<10;i++)assert.equal(update(60,16,0),false);
 update(90,0,100);assert.equal(c.pitState,'unknown');assert.equal(c.inPit,false);
});
test('Un arrêt ou un plateau sur la piste et position indisponible ne deviennent pas PIT',()=>{
 const c={}; for(let i=0;i<20;i++) updatePit(c,geometry,{x:50,y:0,z:0},i<8?80:0,i*500+1);
 assert.equal(c.inPit,false);assert.equal(c.pitState,'unknown');
 updatePit(c,null,{x:50,y:0,z:15},80,20000);assert.equal(c.inPit,false);
 updatePit(c,geometry,{x:50,y:10,z:15},80,20500);assert.equal(c.pitState,'unknown');
});
test('Après interruption de données, le plateau doit être reconfirmé',()=>{
 const c={};for(let i=0;i<6;i++)updatePit(c,geometry,{x:50,y:0,z:15},80,1000+i*500);
 assert.equal(c.inPit,true);updatePit(c,geometry,{x:50,y:0,z:15},0,10000);assert.equal(c.inPit,false);
});
test('Lecture stricte de la variante et refus des sources multiples',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-pit-')); const other=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-pit-'));t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(other,{recursive:true,force:true})]));
 for(const r of [root,other]){let dir=path.join(r,'tracks','test','gp','ai');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fast_lane.ai'),lane([[0,0,0],[10,0,0],[10,0,10]]));await fs.writeFile(path.join(dir,'pit_lane.ai'),lane([[0,0,10],[10,0,10],[20,0,10]]));}
 assert.equal((await loadPitGeometry([root],'test','gp')).pit.length,3);
 await assert.rejects(loadPitGeometry([root],'test','autre'));
 await assert.rejects(loadPitGeometry([root,other],'test','gp'));
 await assert.rejects(loadPitGeometry([root],'../../test','gp'));
});

test('Collecteur : sans géométrie pas de PIT, puis arrêt uniquement après plateau',()=>{
 const {LiveTimingCollector}=require('../tools/live-timing/collector');
 const collector=new LiveTimingCollector({autoStart:false});
 let now=1000; const realNow=Date.now;Date.now=()=>now;
 const send=(pos,speed)=>{now+=500;collector.apply({typeName:'car_update',payload:{carId:1,pos,velocity:{x:speed/3.6,y:0,z:0},spline:0.5}});};
 try {
   for(let i=0;i<12;i++)send({x:50,y:0,z:0},0);
   assert.equal(collector.snapshot().cars[0].inPit,false);
   assert.equal(collector.snapshot().cars[0].pitStops,null);
   collector.pitGeometry=geometry;
   for(let i=0;i<6;i++)send({x:50,y:0,z:15},120);
   assert.equal(collector.snapshot().cars[0].pitState,'lane');
   for(let i=0;i<9;i++)send({x:50,y:0,z:15},0);
   assert.equal(collector.snapshot().cars[0].pitState,'stopped');
   assert.equal(collector.snapshot().cars[0].pitStops,1);
   send({x:50,y:0,z:0},0);
   assert.equal(collector.snapshot().cars[0].inPit,false);
 } finally {Date.now=realNow;}
});

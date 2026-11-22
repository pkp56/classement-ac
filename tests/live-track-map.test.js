'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {trackMap}=require('../tools/live-timing/track-map');
function lane(){const pts=[[0,0,0],[100,0,0],[100,0,100],[0,0,100]];const b=Buffer.alloc(16+pts.length*20);b.writeInt32LE(7,0);b.writeInt32LE(pts.length,4);pts.forEach((p,i)=>p.forEach((v,j)=>b.writeFloatLE(v,16+i*20+j*4)));return b;}
test('Carte : géométrie de la variante exacte et projection coordonnées réelles',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-map-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'tracks','monza','junior','ai');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fast_lane.ai'),lane());
 const map=await trackMap([root],'csp/2144/../monza','junior');assert.equal(map.track,'monza');assert.equal(map.layout,'junior');assert.match(map.path,/^M/);
 const p=map.projection;assert.ok(p.originX>=0&&p.originX<=1000);assert.ok(p.originY>=0&&p.originY<=560);assert.ok(p.originX+100*p.scale<=1000);assert.ok(p.originY+100*p.scale<=560);
 await assert.rejects(trackMap([root],'monza','other'),/indisponible/);await assert.rejects(trackMap([root],'../../secret',''),/non reconnu/);
});
test('Carte : plusieurs sources ambiguës ou sortie par lien symbolique refusées',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-map-safe-')),other=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-map-other-'));t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(other,{recursive:true,force:true})]));
 for(const r of [root,other]){const dir=path.join(r,'tracks','test','ai');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fast_lane.ai'),lane());}
 await assert.rejects(trackMap([root,other],'test',''),/ambigu|Plusieurs/);
 const dir=path.join(root,'tracks','link','ai');await fs.mkdir(dir,{recursive:true});try{await fs.symlink(path.join(other,'tracks','test','ai','fast_lane.ai'),path.join(dir,'fast_lane.ai'));}catch(e){if(e.code==='EPERM')return;throw e;}
 await assert.rejects(trackMap([root],'link',''),/hors contenu/);
});
test('Carte refusée si une racine configurée est indisponible',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-map-root-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'tracks','test','ai');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fast_lane.ai'),lane());
 await assert.rejects(trackMap([root,path.join(root,'absent')],'test',''));
});

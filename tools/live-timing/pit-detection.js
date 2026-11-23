'use strict';
// Détection conservatrice et expérimentale : les lignes AI ne sont pas des limites de voie.
const fs = require('node:fs/promises');
const path = require('node:path');
const {decodeFastLane} = require('../lib/drive-circuits');
const {trackParts} = require('../server-manager/ini');
const VALID = /^[a-zA-Z0-9_-]{1,120}$/;
function inside(root, file) { const r=path.relative(root,file); return !!r && r!=='..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r); }
async function loadPitGeometry(roots, track, layout) {
  const id=trackParts(String(track||''))?.id;
  if(!id || !VALID.test(id) || (layout && !VALID.test(layout))) throw Error('Circuit ou variante invalide');
  const pairs=[];
  for(const root of roots.filter(Boolean)) {
    if(!path.isAbsolute(root)) throw Error('Racine invalide');
    const realRoot=await fs.realpath(root);
    const base=path.join(realRoot,'tracks',id);
    const dirs=layout?[path.join(base,layout,'ai'),path.join(base,'ai',layout)]:[path.join(base,'ai')];
    for(const dir of dirs) {
      let fast,pit;
      try { fast=await fs.realpath(path.join(dir,'fast_lane.ai')); pit=await fs.realpath(path.join(dir,'pit_lane.ai')); }
      catch(e) { if(e.code==='ENOENT'||e.code==='ENOTDIR') continue; throw e; }
      if(!inside(realRoot,fast)||!inside(realRoot,pit)) throw Error('Chemin hors contenu');
      pairs.push([fast,pit]);
    }
  }
  if(pairs.length!==1) throw Error('Géométrie de stands absente ou ambiguë');
  const result=[];
  for(const file of pairs[0]) {
    const st=await fs.stat(file); if(!st.isFile()||st.size<16||st.size>16*1024*1024) throw Error('Ligne AI invalide');
    const buf=await fs.readFile(file); const n=buf.readInt32LE(4);
    if(n<3||n>200000||buf.length<16+n*20) throw Error('Ligne AI invalide');
    const points=decodeFastLane(buf).points;
    if(points.some(p=>![p.x,p.y,p.z].every(Number.isFinite))) throw Error('Ligne AI invalide');
    result.push(points);
  }
  return {fast:result[0],pit:result[1]};
}
function distance(pos, points, closed) {
  let best=Infinity;
  for(let i=0;i<points.length-(closed?0:1);i++) {
    const a=points[i],b=points[(i+1)%points.length],dx=b.x-a.x,dz=b.z-a.z,dy=b.y-a.y;
    const l=dx*dx+dz*dz; const t=l?Math.max(0,Math.min(1,((pos.x-a.x)*dx+(pos.z-a.z)*dz)/l)):0;
    if(Math.abs(pos.y-(a.y+t*dy))>5) continue;
    best=Math.min(best,Math.hypot(pos.x-a.x-t*dx,pos.z-a.z-t*dz));
  }
  return best;
}
function updatePit(car, geometry, pos, speed, now) {
  if(!geometry || !pos || ![pos.x,pos.y,pos.z,speed,now].every(Number.isFinite)) { car.pitState='unknown'; car.inPit=false; car.pitCandidate=null; car.slowSince=null;car.pitStopRecorded=false; return false; }
  if(car.pitLast && (now-car.pitLast>3000 || now<car.pitLast)) { car.pitState='unknown';car.pitCandidate=null;car.slowSince=null; }
  car.pitLast=now;
  const dp=distance(pos,geometry.pit,false),df=distance(pos,geometry.fast,true);
  // Refuser les positions qui pourraient se trouver sur la piste ; zone élargie pour les boxes.
  const confident=dp<=20 && df>=8 && df>=dp+3;
  if(!confident) { car.pitState='unknown';car.inPit=false;car.pitCandidate=null;car.slowSince=null;car.pitStopRecorded=false;return false; }
  if(car.pitState!=='lane' && car.pitState!=='stopped') {
    const limit=Math.abs(speed-80)<=2?80:Math.abs(speed-120)<=2?120:null;
    if(!limit) {car.pitCandidate=null;car.pitState='unknown';car.inPit=false;return false;}
    if(!car.pitCandidate||car.pitCandidate.limit!==limit) car.pitCandidate={limit,since:now};
    if(now-car.pitCandidate.since<2500) {car.pitState='unknown';car.inPit=false;return false;}
    car.pitState='lane';car.pitCandidate=null;
  }
  car.inPit=true;
  if(speed<3) {
    if(car.slowSince==null) car.slowSince=now;
    if(car.pitState!=='stopped' && now-car.slowSince>=4000) {car.pitState='stopped';if(!car.pitStopRecorded){car.pitStopRecorded=true;return true;}}
  } else {car.slowSince=null;car.pitState='lane';}
  return false;
}
module.exports={loadPitGeometry,updatePit,distance};

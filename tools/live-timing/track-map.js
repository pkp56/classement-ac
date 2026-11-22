'use strict';
// Géométrie locale de la ligne AI, jamais de fichier choisi librement via HTTP.
const fs=require('node:fs/promises');
const path=require('node:path');
const {decodeFastLane}=require('../lib/drive-circuits');
const {buildOutline}=require('../lib/circuit-round');
const {trackParts}=require('../server-manager/ini');
const VALID=/^[a-zA-Z0-9_-]{1,120}$/;
function within(parent,child){const rel=path.relative(parent,child);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
async function trackMap(roots,trackRaw,layoutRaw){
 const id=trackParts(String(trackRaw||''))?.id,layout=String(layoutRaw||'');
 if(!id||!VALID.test(id)||(layout&&!VALID.test(layout)))throw Error('Circuit ou variante non reconnu');
 const found=new Set();
 for(const configured of roots){
  if(!configured)continue;
  if(!path.isAbsolute(configured))throw Error('Racine de contenu invalide');
  const root=await fs.realpath(configured); // Une racine manquante rend la sélection ambiguë.
  const base=path.join(root,'tracks',id);
  // Avec variante, ne jamais utiliser la ligne principale d'un autre tracé.
  const candidates=layout?[path.join(base,layout,'ai','fast_lane.ai'),path.join(base,'ai',layout,'fast_lane.ai')]:[path.join(base,'ai','fast_lane.ai')];
  for(const file of candidates){
   try{const real=await fs.realpath(file);if(!within(root,real))throw Error('Chemin hors contenu');const stat=await fs.stat(real);if(stat.isFile())found.add(real);}
   catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
  }
 }
 if(found.size!==1)throw Error(found.size?'Plusieurs tracés possibles : carte non confirmée':'Géométrie de la variante indisponible');
 const file=[...found][0],stat=await fs.stat(file);if(stat.size>16*1024*1024||stat.size<16)throw Error('Géométrie invalide');
 const buf=await fs.readFile(file),count=buf.readInt32LE(4);if(count<3||count>200000)throw Error('Géométrie invalide');
 const track=decodeFastLane(buf);if(track.points.some(p=>![p.x,p.y,p.z].every(Number.isFinite))||!Number.isFinite(track.lengthM)||track.lengthM<10)throw Error('Géométrie invalide');
 const outline=buildOutline(track);
 return {track:id,layout,path:outline.path,viewBox:outline.viewBox,projection:outline.worldProjection};
}
module.exports={trackMap};

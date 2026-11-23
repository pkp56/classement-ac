'use strict';
// Inventaire local : aucun téléchargement ni modification de contenu.
const fs=require('node:fs/promises');
const path=require('node:path');
const VALID=/^[a-zA-Z0-9_-]{1,120}$/;
const LIMIT=5000;
async function directories(parent){
 let items;
 try{items=await fs.readdir(parent,{withFileTypes:true});}
 catch(e){if(e.code==='ENOENT')return [];throw e;}
 return items.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&VALID.test(e.name)).map(e=>e.name).sort((a,b)=>a.localeCompare(b,'fr')).slice(0,LIMIT);
}
async function directory(parent,name){
 const p=path.join(parent,name);
 try{const s=await fs.lstat(p);return s.isDirectory()&&!s.isSymbolicLink()?p:null;}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function scan(contentRoot,requireBoth=false){
 if(typeof contentRoot!=='string'||!path.isAbsolute(contentRoot))throw new Error('Chemin contenu non configuré');
 const root=await fs.realpath(contentRoot),carsRoot=await directory(root,'cars'),tracksRoot=await directory(root,'tracks');
 if(requireBoth&&(!carsRoot||!tracksRoot))throw new Error('Dossiers cars ou tracks indisponibles dans le contenu complémentaire');
 const cars=[];
 if(carsRoot){
  for(const id of await directories(carsRoot)){
    const carDir=await directory(carsRoot,id);if(!carDir)continue;
    const skinsDir=await directory(carDir,'skins');
    cars.push({id,skins:skinsDir?await directories(skinsDir):[]});
  }
 }
 const tracks=[];
 if(tracksRoot){
  for(const id of await directories(tracksRoot)){
    const trackDir=await directory(tracksRoot,id);if(!trackDir)continue;
    // Un layout est retenu seulement quand son fichier modèles existe. Les
    // autres dossiers (textures, data, ui...) ne sont pas des configurations.
    const entries=await fs.readdir(trackDir,{withFileTypes:true});
    const layouts=entries.filter(e=>e.isFile()&&!e.isSymbolicLink()&&/^models_[a-zA-Z0-9_-]+\.ini$/i.test(e.name))
      .map(e=>e.name.slice(7,-4)).sort((a,b)=>a.localeCompare(b,'fr'));
    tracks.push({id,layouts:[...new Set(layouts)]});
  }
 }
 return {cars,tracks};
}
async function inventory(contentRoot,extraRoot=''){
 const first=await scan(contentRoot);
 if(!extraRoot)return first;
 const second=await scan(extraRoot,true);
 function merge(a,b,field){
  const items=new Map();
  for(const item of [...a,...b]){
   const prior=items.get(item.id);
   if(prior)prior[field]=[...new Set([...prior[field],...item[field]])].sort((x,y)=>x.localeCompare(y,'fr'));
   else items.set(item.id,{...item,[field]:[...item[field]]});
  }
  return [...items.values()].sort((x,y)=>x.id.localeCompare(y.id,'fr'));
 }
 return {cars:merge(first.cars,second.cars,'skins'),tracks:merge(first.tracks,second.tracks,'layouts')};
}
module.exports={inventory};

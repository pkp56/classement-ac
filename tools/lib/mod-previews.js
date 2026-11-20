'use strict';
// Copy only bounded, recognised raster previews. Events reference a digest, never a PC path.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {within} = require('./local-mods');
const {safeTrackText} = require('./track-text');
const cache = path.resolve(__dirname, '../../assets/mod-previews');
const MAX_IMAGE = 3 * 1024 * 1024;
async function inside(root, candidate) {
  const file = await fs.realpath(candidate).catch(()=>null);
  return file && within(file, root) ? file : null;
}
async function boundedRead(root, candidate, max) {
  const file = await inside(root, candidate);
  if (!file) return null;
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size || stat.size > max) return null;
  return fs.readFile(file);
}
async function cachePreview(root, candidates, destination=cache) {
  for (const candidate of candidates) {
    const bytes = await boundedRead(root, candidate, MAX_IMAGE).catch(()=>null);
    if (!bytes || bytes.length > MAX_IMAGE) continue;
    const ext = bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? 'png'
      : bytes.subarray(0,3).equals(Buffer.from([255,216,255])) ? 'jpg' : null;
    if (!ext) continue;
    const name=createHash('sha256').update(bytes).digest('hex')+'.'+ext;
    await fs.mkdir(destination,{recursive:true});
    try { await fs.writeFile(path.join(destination,name),bytes,{flag:'wx'}); }
    catch(error){if(error.code!=='EEXIST')throw error;}
    return 'assets/mod-previews/'+name;
  }
  return null;
}
async function importLiveries(roots,id,destination=cache){
  const {safeSegment}=require('./local-circuits');
  if(!safeSegment(id))throw new Error('Identifiant de voiture invalide');
  const allowed=(await Promise.all(roots.map(p=>fs.realpath(p).catch(()=>null)))).filter(Boolean);
  for(const root of allowed){
    const car=await fs.realpath(path.join(root,'cars',id)).catch(()=>null);
    if(!car||!allowed.some(r=>within(car,r)))continue;
    const skins=await inside(car,path.join(car,'skins'));
    const entries=skins?await fs.readdir(skins,{withFileTypes:true}):[];
    const liveries=[];
    for(const entry of entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,80)){
      const dir=path.join(skins,entry.name);
      const image=await cachePreview(car,['preview.jpg','preview.png','preview.jpeg','livery.png','livery.jpg'].map(n=>path.join(dir,n)),destination);
      if(!image)continue;
      let ui;
      try{ui=JSON.parse((await boundedRead(car,path.join(dir,'ui_skin.json'),65536)).toString('utf8').replace(/^\uFEFF/,''));}catch{}
      const isPlaceholderNumber=String(ui?.number??'')==='0'&&!safeTrackText(ui?.skinname,120)&&!safeTrackText(ui?.team,120)&&!safeTrackText(ui?.drivername,120);
      liveries.push({image,name:safeTrackText(ui?.skinname||entry.name,120),number:isPlaceholderNumber?'':safeTrackText(ui?.number,16),team:safeTrackText(ui?.team,120)});
    }
    return liveries;
  }
  return null; // Mod débranché : conserver la sélection historique.
}
async function importCarLogo(roots,id,destination=cache){
  const {safeSegment}=require('./local-circuits');
  if(!safeSegment(id))throw new Error('Identifiant de voiture invalide');
  const allowed=(await Promise.all(roots.map(p=>fs.realpath(p).catch(()=>null)))).filter(Boolean);
  for(const root of allowed){
    const car=await fs.realpath(path.join(root,'cars',id)).catch(()=>null);
    if(!car||!allowed.some(r=>within(car,r)))continue;
    return cachePreview(car,['logo.png','logo.jpg','logo.jpeg',path.join('ui','badge.png')].map(n=>path.join(car,n)),destination);
  }
  return null;
}
module.exports={cachePreview,importLiveries,importCarLogo};

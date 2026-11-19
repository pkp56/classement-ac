'use strict';
// Catalogue en lecture seule. Aucun fichier du jeu n'est publié ou déplacé.
const fs=require('node:fs/promises');
const path=require('node:path');
const DEFAULT_ROOTS=Object.freeze([
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa\\content',
  'D:\\content',
  'E:\\content'
]);
function configuredRoots(env=process.env){
  return env.AC_CONTENT_ROOTS===undefined?[...DEFAULT_ROOTS]:env.AC_CONTENT_ROOTS.split(';').map(s=>s.trim()).filter(Boolean);
}
function decodeHtmlEntities(value){
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi,(entity,token)=>{
    if(token[0]==='#'){
      const hex=token[1].toLowerCase()==='x';
      const code=Number.parseInt(token.slice(hex?2:1),hex?16:10);
      if(Number.isInteger(code)&&code>=0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff))return String.fromCodePoint(code);
      return entity;
    }
    const key=token.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named,key)?named[key]:entity;
  });
}
const text=(v,max=300,multiline=false)=>{
  if(typeof v!=='string'&&typeof v!=='number')return '';
  const linebreak=multiline?'\n':' ';
  const plain=String(v)
    .replace(/<br\s*\/?>/gi,linebreak)
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi,linebreak)
    .replace(/<[^>]*>/g,'');
  const clean=decodeHtmlEntities(plain)
    .replace(/\r\n?/g,'\n')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g,' ')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  return (multiline?clean:clean.replace(/\n/g,' ')).slice(0,max);
};
const CAR_SPEC_FIELDS=Object.freeze([
  ['bhp','Puissance',['bhp','power']],
  ['torque','Couple',['torque']],
  ['weight','Poids',['weight']],
  ['topspeed','Vitesse maximale',['topspeed','topSpeed','top_speed']],
  ['acceleration','Accélération',['acceleration']],
  ['pwratio','Rapport poids / puissance',['pwratio','powerWeight','power_to_weight']],
  ['range','Autonomie',['range']]
]);
function carCurve(value,metric){
  if(!Array.isArray(value))return [];
  return value.slice(0,120).map(point=>{
    const rpm=Array.isArray(point)?point[0]:point&&typeof point==='object'?point.rpm:undefined;
    const reading=Array.isArray(point)?point[1]:point&&typeof point==='object'
      ?(point.value??point[metric]??point.power??point.torque??point.bhp)
      :undefined;
    const x=typeof rpm==='number'?rpm:(typeof rpm==='string'&&rpm.trim()?Number(rpm):NaN);
    const y=typeof reading==='number'?reading:(typeof reading==='string'&&reading.trim()?Number(reading):NaN);
    return Number.isFinite(x)&&x>=0&&x<=20000&&Number.isFinite(y)&&y>=0&&y<=10000
      ?{rpm:x,value:y}
      :null;
  }).filter(Boolean);
}
function carUrl(value){
  const url=text(value,500);
  return /^https?:\/\/[^\s"'<>]+$/i.test(url)?url:'';
}
function carMetadata(meta,id){
  const rawSpecs=meta&&meta.specs&&typeof meta.specs==='object'&&!Array.isArray(meta.specs)?meta.specs:{};
  const specs={};
  for(const [key,_label,aliases] of CAR_SPEC_FIELDS){
    const value=aliases.map(alias=>text(rawSpecs[alias],100)).find(Boolean);
    if(value)specs[key]=value;
  }
  const tags=Array.isArray(meta&&meta.tags)?meta.tags.slice(0,12).map(tag=>text(tag,80)).filter(Boolean):[];
  return {
    id,
    name:text(meta&&meta.name)||id,
    brand:text(meta&&meta.brand),
    category:text(meta&&(meta.class||meta.category)),
    year:text(meta&&meta.year,32),
    country:text(meta&&meta.country,120),
    author:text(meta&&meta.author),
    version:text(meta&&meta.version,80),
    url:carUrl(meta&&meta.url),
    description:text(meta&&meta.description,4000,true),
    tags,
    specs,
    powerCurve:carCurve(meta&&meta.powerCurve,'power'),
    torqueCurve:carCurve(meta&&meta.torqueCurve,'torque'),
    source:'local',
    metadataAvailable:!!meta
  };
}
function within(file,root){const relative=path.relative(root,file);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}
async function scanCatalog(roots,{maxEntries=10000}={}){
  const sources=[],allowed=[],warnings=[],cars=new Map(),tracks=new Map();
  const warn=message=>{if(warnings.length<100)warnings.push(message);};
  for(let i=0;i<roots.length;i++){
    const source={id:'source-'+(i+1),path:roots[i],status:'missing'};
    sources.push(source);
    try{const real=await fs.realpath(roots[i]);if(!(await fs.stat(real)).isDirectory())throw Error('not-directory');source.status='available';source.real=real;allowed.push(real);}
    catch(e){source.status=['ENOENT','ENOTDIR'].includes(e.code)?'missing':'unreadable';}
  }
  async function safe(file){const real=await fs.realpath(file);if(!allowed.some(root=>within(real,root)))throw Object.assign(Error('outside-roots'),{code:'OUTSIDE_ROOTS'});return real;}
  async function dirs(dir){
    try{const real=await safe(dir);return (await fs.readdir(real,{withFileTypes:true})).filter(e=>!e.name.startsWith('.')&&(e.isDirectory()||e.isSymbolicLink())).map(e=>e.name).sort();}
    catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))warn('Dossier inaccessible ou jonction hors des racines autorisées : '+path.basename(dir));return [];}
  }
  async function json(file){
    try{
      const real=await safe(file),stat=await fs.stat(real);
      if(!stat.isFile()||stat.size>1024*1024)throw Error('metadata-too-large');
      const raw=await fs.readFile(real,'utf8');
      const data=JSON.parse(raw.replace(/^\uFEFF/,''));
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('metadata-invalid');
      return data;
    }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))warn('Métadonnées ignorées : '+path.basename(file));return null;}
  }
  let visited=0;
  for(const source of sources){
    if(source.status!=='available')continue;
    for(const id of await dirs(path.join(source.real,'cars'))){
      if(++visited>maxEntries)break;
      try{if(!(await fs.stat(await safe(path.join(source.real,'cars',id)))).isDirectory())continue;}catch{warn('Voiture ignorée : '+id);continue;}
      const meta=await json(path.join(source.real,'cars',id,'ui','ui_car.json'));
      const key=id.toLowerCase();
      if(cars.has(key)){cars.get(key).alsoAvailableIn.push(source.id);continue;}
      cars.set(key,{...carMetadata(meta,id),source:source.id,alsoAvailableIn:[]});
    }
    for(const trackId of await dirs(path.join(source.real,'tracks'))){
      if(++visited>maxEntries)break;
      try{if(!(await fs.stat(await safe(path.join(source.real,'tracks',trackId)))).isDirectory())continue;}catch{warn('Circuit ignoré : '+trackId);continue;}
      const ui=path.join(source.real,'tracks',trackId,'ui');
      const base=await json(path.join(ui,'ui_track.json'));
      const layouts=[];
      if(base)layouts.push({layoutId:'',meta:base});
      for(const layoutId of await dirs(ui)){
        if(++visited>maxEntries)break;
        const meta=await json(path.join(ui,layoutId,'ui_track.json'));
        if(meta)layouts.push({layoutId,meta});
      }
      if(!layouts.length)layouts.push({layoutId:'',meta:null});
      for(const {layoutId,meta} of layouts){
        const id=trackId+(layoutId?'/'+layoutId:''),key=id.toLowerCase();
        if(tracks.has(key)){tracks.get(key).alsoAvailableIn.push(source.id);continue;}
        tracks.set(key,{id,trackId,layoutId,name:text(meta?.name)||trackId+(layoutId?' · '+layoutId:''),country:text(meta?.country),length:text(meta?.length),source:source.id,alsoAvailableIn:[],metadataAvailable:!!meta});
      }
    }
  }
  if(visited>maxEntries)warn('Limite du catalogue atteinte ; scan partiel.');
  const sort=(a,b)=>a.name.localeCompare(b.name,'fr')||a.id.localeCompare(b.id);
  return {scannedAt:new Date().toISOString(),sources:sources.map(({real,...s})=>s),cars:[...cars.values()].sort(sort),tracks:[...tracks.values()].sort(sort),warnings};
}
function mountLocalMods(app,{roots=configuredRoots(),authorize}){
  let catalog=null,pending=null;
  app.get('/api/admin/local-mods',async(req,res)=>{
    res.set('Cache-Control','no-store');if(!await authorize(req,res))return;
    res.json(catalog||{scannedAt:null,sources:roots.map((p,i)=>({id:'source-'+(i+1),path:p,status:'not-scanned'})),cars:[],tracks:[],warnings:[]});
  });
  app.post('/api/admin/local-mods/scan',async(req,res)=>{
    res.set('Cache-Control','no-store');if(!await authorize(req,res))return;
    // Aucun chemin du corps de requête n'est accepté. Config serveur uniquement.
    try{
      if(!pending)pending=scanCatalog(roots).then(result=>(catalog=result)).finally(()=>{pending=null;});
      res.json(await pending);
    }catch(e){res.status(500).json({error:'Impossible de lire le catalogue local.'});}
  });
}
module.exports={DEFAULT_ROOTS,configuredRoots,scanCatalog,mountLocalMods,within};

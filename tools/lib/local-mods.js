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
const KUNOS_BRANDS=Object.freeze({
  alfa:{brand:'Alfa Romeo',country:'Italie'},
  alfa_romeo:{brand:'Alfa Romeo',country:'Italie'},
  alfaromeo:{brand:'Alfa Romeo',country:'Italie'},
  abarth:{brand:'Abarth',country:'Italie'},
  aston:{brand:'Aston Martin',country:'Grande-Bretagne'},
  aston_martin:{brand:'Aston Martin',country:'Grande-Bretagne'},
  audi:{brand:'Audi',country:'Allemagne'},
  bmw:{brand:'BMW',country:'Allemagne'},
  caterham:{brand:'Caterham',country:'Grande-Bretagne'},
  chevrolet:{brand:'Chevrolet',country:'États-Unis'},
  corvette:{brand:'Chevrolet',country:'États-Unis'},
  ferrari:{brand:'Ferrari',country:'Italie'},
  fiat:{brand:'Fiat',country:'Italie'},
  ford:{brand:'Ford',country:'États-Unis'},
  glickenhaus:{brand:'Scuderia Cameron Glickenhaus',country:'États-Unis'},
  scg:{brand:'Scuderia Cameron Glickenhaus',country:'États-Unis'},
  honda:{brand:'Honda',country:'Japon'},
  jaguar:{brand:'Jaguar',country:'Grande-Bretagne'},
  ktm:{brand:'KTM',country:'Autriche'},
  lamborghini:{brand:'Lamborghini',country:'Italie'},
  lancia:{brand:'Lancia',country:'Italie'},
  lotus:{brand:'Lotus',country:'Grande-Bretagne'},
  maserati:{brand:'Maserati',country:'Italie'},
  mazda:{brand:'Mazda',country:'Japon'},
  mclaren:{brand:'McLaren',country:'Grande-Bretagne'},
  mercedes:{brand:'Mercedes-Benz',country:'Allemagne'},
  mercedes_benz:{brand:'Mercedes-Benz',country:'Allemagne'},
  mercedes_amg:{brand:'Mercedes-Benz',country:'Allemagne'},
  mini:{brand:'MINI',country:'Grande-Bretagne'},
  nissan:{brand:'Nissan',country:'Japon'},
  pagani:{brand:'Pagani',country:'Italie'},
  porsche:{brand:'Porsche',country:'Allemagne'},
  praga:{brand:'Praga',country:'République tchèque'},
  renault:{brand:'Renault',country:'France'},
  alpine:{brand:'Alpine',country:'France'},
  ruf:{brand:'RUF',country:'Allemagne'},
  shelby:{brand:'Shelby',country:'États-Unis'},
  subaru:{brand:'Subaru',country:'Japon'},
  tatuus:{brand:'Tatuus',country:'Italie'},
  toyota:{brand:'Toyota',country:'Japon'}
});
const KUNOS_ACRONYMS=new Set(['GT','GTA','GTAM','GTR','GTE','GT2','GT3','GT4','GTO','LM','LMP1','LMP2','DTM','F1','F2','F3','RS','RSR','SRS','V8','V10','V12','TDI','TSI','EVO','SV','LP','SCG','KTM','BMW','RUF','AMG','SLS','SL','SS','ZL1','Z06','MX5','RX7','NSX','R34','S1','S2','S3','TCR','WTCR','R1','M1','M3','M4','M6','C7R','C9','Z4','R8']);
function isKunosId(id){
  return /^ks(?:[_-]|(?=[A-Z0-9]))/i.test(String(id||''));
}
function lookupKunosBrand(token){
  const clean=String(token||'').trim().replace(/^[\\/]+/,'').toLowerCase().replace(/[\s-]+/g,'_');
  if(!clean)return null;
  if(Object.prototype.hasOwnProperty.call(KUNOS_BRANDS,clean))return KUNOS_BRANDS[clean];
  const parts=clean.split('_').filter(Boolean);
  if(parts.length>=2&&Object.prototype.hasOwnProperty.call(KUNOS_BRANDS,parts[0]+'_'+parts[1]))return KUNOS_BRANDS[parts[0]+'_'+parts[1]];
  if(parts.length>=1&&Object.prototype.hasOwnProperty.call(KUNOS_BRANDS,parts[0]))return KUNOS_BRANDS[parts[0]];
  return null;
}
function formatKunosCarName(id){
  const stripped=String(id||'').replace(/^ks[_-]+/i,'').trim();
  if(!stripped)return String(id||'');
  return stripped.split(/[_-]+/).filter(Boolean).map(part=>{
    const upper=part.toUpperCase();
    if(KUNOS_ACRONYMS.has(upper)||/^\d+[a-z]?$/i.test(part))return upper;
    return part[0].toUpperCase()+part.slice(1).toLowerCase();
  }).join(' ');
}
function inferKunosCategory(id){
  const lower=String(id||'').toLowerCase();
  if(/(?:^|_)gt3(?:_|$)/.test(lower))return 'GT3';
  if(/(?:^|_)gt2(?:_|$)/.test(lower))return 'GT2';
  if(/(?:^|_)gt4(?:_|$)/.test(lower))return 'GT4';
  if(/(?:^|_)gte(?:_|$)/.test(lower))return 'GTE';
  if(/(?:^|_)dtm(?:_|$)/.test(lower))return 'DTM';
  if(/(?:^|_)lmp1(?:_|$)/.test(lower))return 'LMP1';
  if(/(?:^|_)lmp2(?:_|$)/.test(lower))return 'LMP2';
  if(/(?:^|_)cup(?:_|$)/.test(lower))return 'Cup';
  return '';
}
function parseIni(raw){
  const sections={};
  let current='';
  for(const line of String(raw||'').replace(/^\uFEFF/,'').split(/\r?\n/)){
    const stripped=line.replace(/\s*;.*$/,'').replace(/^\s*;.*$/,'').trim();
    if(!stripped)continue;
    const sec=stripped.match(/^\[([^\]]+)\]$/);
    if(sec){current=sec[1].trim().toUpperCase();if(!sections[current])sections[current]={};continue;}
    const eq=stripped.indexOf('=');
    if(eq<=0)continue;
    const key=stripped.slice(0,eq).trim().toUpperCase();
    const val=stripped.slice(eq+1).trim();
    if(!sections[current])sections[current]={};
    sections[current][key]=val;
  }
  return sections;
}
function parseLut(raw){
  const points=[];
  for(const line of String(raw||'').replace(/^\uFEFF/,'').split(/\r?\n/)){
    const clean=line.replace(/;.*$/,'').trim();
    if(!clean||!clean.includes('|'))continue;
    const [rawX,rawY]=clean.split('|');
    const rpm=Number(rawX),value=Number(rawY);
    if(Number.isFinite(rpm)&&rpm>=0&&rpm<=20000&&Number.isFinite(value)&&value>=0&&value<=10000){
      points.push({rpm,value});
    }
  }
  points.sort((a,b)=>a.rpm-b.rpm);
  if(points.length<=120)return points;
  const sampled=[];
  for(let i=0;i<119;i++)sampled.push(points[Math.floor(i*(points.length-1)/119)]);
  sampled.push(points[points.length-1]);
  return sampled;
}
function parseDriverEra(sections){
  const decades={'60':'Années 1960','70':'Années 1970','80':'Années 1980','90':'Années 1990','00':'Années 2000','10':'Années 2010'};
  for(const name of Object.keys(sections||{})){
    const m=name.match(/^DRIVER_(\d{2})$/);
    if(m&&decades[m[1]])return decades[m[1]];
  }
  return '';
}
function carMetadata(meta,id,extras={}){
  const rawSpecs=meta&&meta.specs&&typeof meta.specs==='object'&&!Array.isArray(meta.specs)?meta.specs:{};
  const specs={};
  for(const [key,_label,aliases] of CAR_SPEC_FIELDS){
    const value=aliases.map(alias=>text(rawSpecs[alias],100)).find(Boolean);
    if(value)specs[key]=value;
  }
  if(!specs.weight&&extras.weight)specs.weight=text(extras.weight,100);
  if(!specs.bhp&&extras.bhp)specs.bhp=text(extras.bhp,100);
  if(!specs.torque&&extras.torque)specs.torque=text(extras.torque,100);
  let tags=Array.isArray(meta&&meta.tags)?meta.tags.slice(0,12).map(tag=>text(tag,80)).filter(Boolean):[];
  if(!tags.length&&extras.drivetrain)tags=[text(extras.drivetrain,40)];
  const kunos=isKunosId(id);
  const cleanIdBody=String(id||'').replace(/^ks[_-]+/i,'');
  const brandInfo=lookupKunosBrand(extras.skinBrand)||(kunos?lookupKunosBrand(cleanIdBody):null);
  const brand=text(meta&&meta.brand)||text(brandInfo&&brandInfo.brand);
  const countryInfo=brandInfo||lookupKunosBrand(brand);
  const idYear=(kunos&&String(id||'').match(/(?:^|_)(19\d\d|20[0-2]\d)(?:_|$)/)?.[1])||'';
  const year=text(meta&&meta.year,32)||text(idYear,32)||text(extras.skinEra,32);
  const country=text(meta&&meta.country,120)||((kunos||extras.skinBrand)&&countryInfo?countryInfo.country:'');
  const author=text(meta&&meta.author)||(kunos?'Kunos Simulazioni':'');
  const category=text(meta&&(meta.class||meta.category))||(kunos?inferKunosCategory(id):'');
  const name=text(meta&&meta.name)||text(extras.screenName)||(kunos?formatKunosCarName(id):id);
  const powerCurve=carCurve(meta&&meta.powerCurve,'power');
  const torqueCurve=carCurve(meta&&meta.torqueCurve,'torque');
  const finalPowerCurve=powerCurve.length?powerCurve:(extras.powerCurve||[]);
  const finalTorqueCurve=torqueCurve.length?torqueCurve:(extras.torqueCurve||[]);
  const hasData=Boolean(extras.screenName||extras.weight||extras.bhp||extras.torque||extras.drivetrain||finalPowerCurve.length||finalTorqueCurve.length);
  const hasSkins=Boolean(extras.skinBrand||extras.skinEra||extras.skinCount>0);
  const hasLogo=Boolean(extras.hasLogo);
  const metadataSource=meta?'ui_car':hasData?'data':(hasSkins||hasLogo)?'skins':kunos?'kunos':'';
  return {
    id,
    name,
    brand,
    category,
    year,
    country,
    author,
    version:text(meta&&meta.version,80),
    url:carUrl(meta&&meta.url),
    description:text(meta&&meta.description,4000,true),
    tags,
    specs,
    powerCurve:finalPowerCurve,
    torqueCurve:finalTorqueCurve,
    hasLogo,
    source:'local',
    metadataSource,
    metadataAvailable:Boolean(meta||hasData||hasSkins||hasLogo||kunos)
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
  async function readText(file,maxBytes=262144){
    try{
      const real=await safe(file),stat=await fs.stat(real);
      if(!stat.isFile()||stat.size>maxBytes)return null;
      return await fs.readFile(real,'utf8');
    }catch(e){
      if(!['ENOENT','ENOTDIR'].includes(e.code))warn('Fichier ignoré : '+path.basename(file));
      return null;
    }
  }
  async function hasBoundedImage(file){
    try{
      const real=await safe(file),stat=await fs.stat(real);
      return stat.isFile()&&stat.size>0&&stat.size<=3*1024*1024;
    }catch{return false;}
  }
  async function readCarExtras(carDir,hasUiCar){
    const extras={};
    for(const candidate of ['logo.png','logo.jpg','logo.jpeg',path.join('ui','badge.png')]){
      if(await hasBoundedImage(path.join(carDir,candidate))){extras.hasLogo=true;break;}
    }
    const carIniRaw=await readText(path.join(carDir,'data','car.ini'));
    if(carIniRaw){
      const carIni=parseIni(carIniRaw);
      const screenName=text(carIni.INFO&&carIni.INFO.SCREEN_NAME,200);
      if(screenName)extras.screenName=screenName;
      const mass=Number(carIni.BASIC&&carIni.BASIC.TOTALMASS);
      if(Number.isFinite(mass)&&mass>100&&mass<10000)extras.weight=Math.round(mass)+' kg';
    }
    if(!hasUiCar){
      const engineIniRaw=await readText(path.join(carDir,'data','engine.ini'));
      const engineIni=engineIniRaw?parseIni(engineIniRaw):null;
      const lutName=String(engineIni?.ENGINE_DATA?.TORQUE_CURVE||'power.lut').trim();
      if(lutName&&!/[\\/]|\.\./.test(lutName)){
        const lutRaw=await readText(path.join(carDir,'data',lutName));
        if(lutRaw){
          const torqueCurve=parseLut(lutRaw);
          if(torqueCurve.length>=2){
            extras.torqueCurve=torqueCurve;
            extras.powerCurve=torqueCurve.map(p=>({rpm:p.rpm,value:Math.round((p.value*p.rpm/7127)*100)/100}));
            const maxTorque=torqueCurve.reduce((m,p)=>Math.max(m,p.value),0);
            const maxBhp=extras.powerCurve.reduce((m,p)=>Math.max(m,p.value),0);
            if(maxTorque>0)extras.torque=Math.round(maxTorque)+' Nm';
            if(maxBhp>0)extras.bhp=Math.round(maxBhp)+' bhp';
          }
        }
      }
      const dtIniRaw=await readText(path.join(carDir,'data','drivetrain.ini'));
      if(dtIniRaw){
        const dtIni=parseIni(dtIniRaw);
        const traction=text(dtIni.TRACTION&&dtIni.TRACTION.TYPE,20);
        if(/^(RWD|FWD|AWD|4WD)$/i.test(traction))extras.drivetrain=traction.toLowerCase();
      }
    }
    const skinDirs=await dirs(path.join(carDir,'skins'));
    extras.skinCount=skinDirs.length;
    for(const skinId of skinDirs.slice(0,40)){
      const skinIniRaw=await readText(path.join(carDir,'skins',skinId,'skin.ini'),65536);
      if(skinIniRaw){
        const skinIni=parseIni(skinIniRaw);
        const crewBrand=text(skinIni.CREW&&skinIni.CREW.BRAND,80);
        if(crewBrand&&!extras.skinBrand)extras.skinBrand=crewBrand;
        const era=parseDriverEra(skinIni);
        if(era&&!extras.skinEra)extras.skinEra=era;
      }
      if(extras.skinBrand&&extras.skinEra)break;
    }
    return extras;
  }
  let visited=0;
  for(const source of sources){
    if(source.status!=='available')continue;
    for(const id of await dirs(path.join(source.real,'cars'))){
      if(++visited>maxEntries)break;
      const carDir=path.join(source.real,'cars',id);
      try{if(!(await fs.stat(await safe(carDir))).isDirectory())continue;}catch{warn('Voiture ignorée : '+id);continue;}
      const key=id.toLowerCase();
      if(cars.has(key)){cars.get(key).alsoAvailableIn.push(source.id);continue;}
      const meta=await json(path.join(carDir,'ui','ui_car.json'));
      const extras=await readCarExtras(carDir,!!meta);
      cars.set(key,{...carMetadata(meta,id,extras),source:source.id,alsoAvailableIn:[]});
    }
    for(const trackId of await dirs(path.join(source.real,'tracks'))){
      if(++visited>maxEntries)break;
      const trackDir=path.join(source.real,'tracks',trackId);
      try{if(!(await fs.stat(await safe(trackDir))).isDirectory())continue;}catch{warn('Circuit ignoré : '+trackId);continue;}
      const ui=path.join(trackDir,'ui');
      const base=await json(path.join(ui,'ui_track.json'));
      const layouts=[];
      if(base)layouts.push({layoutId:'',meta:base});
      for(const layoutId of await dirs(ui)){
        if(++visited>maxEntries)break;
        const meta=await json(path.join(ui,layoutId,'ui_track.json'));
        if(meta)layouts.push({layoutId,meta});
      }
      let trackExtras=null;
      if(!layouts.length){
        const rootEntries=await fs.readdir(await safe(trackDir),{withFileTypes:true}).catch(()=>[]);
        const modelLayouts=rootEntries
          .filter(e=>e.isFile()&&/^models_(.+)\.ini$/i.test(e.name))
          .map(e=>e.name.match(/^models_(.+)\.ini$/i)[1])
          .sort();
        const extRaw=await readText(path.join(trackDir,'extension','ext_config.ini'),131072)
          ||await readText(path.join(trackDir,'ext_config.ini'),131072);
        const camRaw=await readText(path.join(trackDir,'data','cameras.ini'),131072)
          ||await readText(path.join(trackDir,'cameras.ini'),131072);
        const hasTech=Boolean(extRaw||camRaw||modelLayouts.length
          ||await readText(path.join(trackDir,'data','surfaces.ini'),4096)
          ||await readText(path.join(trackDir,'data','ai_hints.ini'),4096)
          ||await readText(path.join(trackDir,'data','audio_sources.ini'),4096));
        if(hasTech){
          const extIni=extRaw?parseIni(extRaw):{};
          const placeMap={prague:'République tchèque',spa:'Belgique',monza:'Italie',imola:'Italie',mugello:'Italie',silverstone:'Grande-Bretagne',nurburgring:'Allemagne',nordschleife:'Allemagne',zandvoort:'Pays-Bas',brands_hatch:'Grande-Bretagne',laguna_seca:'États-Unis',red_bull_ring:'Autriche',spielberg:'Autriche',barcelona:'Espagne',vallelunga:'Italie',magione:'Italie'};
          const cleanId=trackId.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
          const placeCountry=placeMap[cleanId]||Object.entries(placeMap).find(([k])=>cleanId.includes(k))?.[1]||'';
          const formatLabel=v=>String(v||'').replace(/[_-]+/g,' ').trim().split(/\s+/).filter(Boolean).map(w=>/^(gp|gt|f1)$/i.test(w)?w.toUpperCase():/^rev$/i.test(w)?'Reverse':w[0].toUpperCase()+w.slice(1)).join(' ');
          trackExtras={hasTech:true,country:placeCountry,author:text(extIni.ABOUT&&extIni.ABOUT.AUTHOR,120),formatLabel};
        }
        if(modelLayouts.length){
          for(const variant of modelLayouts){
            const isBase=variant.toLowerCase()===trackId.toLowerCase();
            layouts.push({layoutId:isBase?'':variant,meta:null});
          }
        }
      }
      if(!layouts.length)layouts.push({layoutId:'',meta:null});
      for(const {layoutId,meta} of layouts){
        const id=trackId+(layoutId?'/'+layoutId:''),key=id.toLowerCase();
        if(tracks.has(key)){tracks.get(key).alsoAvailableIn.push(source.id);continue;}
        const fallbackName=trackExtras
          ?(layoutId&&!layoutId.toLowerCase().startsWith(trackId.toLowerCase())?`${trackExtras.formatLabel(trackId)} · ${trackExtras.formatLabel(layoutId)}`:trackExtras.formatLabel(layoutId||trackId))
          :(trackId+(layoutId?' · '+layoutId:''));
        tracks.set(key,{
          id,trackId,layoutId,
          name:text(meta?.name)||fallbackName,
          country:text(meta?.country)||(trackExtras?trackExtras.country:''),
          length:text(meta?.length),
          ...(trackExtras?.author&&!meta?.author?{author:trackExtras.author}:{}),
          source:source.id,alsoAvailableIn:[],
          metadataAvailable:Boolean(meta||trackExtras?.hasTech)
        });
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
module.exports={DEFAULT_ROOTS,configuredRoots,scanCatalog,mountLocalMods,within,parseIni,parseLut,isKunosId,lookupKunosBrand,formatKunosCarName};

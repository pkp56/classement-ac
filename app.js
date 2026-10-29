// Serveur GDSP frontend — statique + proxy API vers le backend Render/Neon.
// Pas de variable d'environnement obligatoire : l'URL du backend est celle du
// dépôt gdsp-render-backend déployé, mais elle peut être surchargée par BACKEND_URL
// (ou GDSP_API_URL) si tu redéploies le backend ailleurs.

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 10000);
const BACKEND_URL = (process.env.BACKEND_URL || process.env.GDSP_API_URL || 'https://gdsp-render-backend.onrender.com').replace(/\/+$/,'');
const ROOT = __dirname;

// Fichiers interdits au public
const FORBIDDEN = /(^|\/)(?:\.env|node_modules|\.git|\.github|package\.json|package-lock\.json|README\.md|render\.yaml|\.gitignore|\.gitattributes|app\.js|tests?\/|backups?\/)/i;
app.use((req, res, next) => {
  if (FORBIDDEN.test(req.path)) return res.sendStatus(404);
  next();
});

// --- PROXY API générique ---
function proxyRequest(req, res, opts = {}) {
  let target;
  try { target = new URL(opts.path || req.url, BACKEND_URL); } catch(e) { return res.status(400).end('URL invalide'); }
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  if (opts.method) headers['content-length'] = Buffer.byteLength(opts.body||'');
  const chunks = [];
  const send = (body) => {
    if (body && body.length) headers['content-length'] = body.length;
    const proto = target.protocol === 'https:' ? https : http;
    const upstream = proto.request(target, {
      method: opts.method || req.method,
      headers,
      timeout: 25000,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      console.error('proxy error:', opts.method||req.method, opts.path||req.url, '->', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Backend indisponible', detail: e.message });
      else res.end();
    });
    if (body) upstream.write(body);
    upstream.end();
  };
  if (opts.method) { send(opts.body); return; }
  req.on('data', c => chunks.push(c));
  req.on('end', () => send(chunks.length ? Buffer.concat(chunks) : null));
  req.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
}

function proxyJson(opts, cb) {
  const target = new URL(opts.path, BACKEND_URL);
  const headers = Object.assign({}, opts.headers||{});
  headers['content-type']='application/json';
  headers['content-length']=Buffer.byteLength(opts.body||'{}');
  const proto = target.protocol==='https:'?https:http;
  const up = proto.request(target,{method:opts.method,headers,timeout:60000},(upRes)=>{
    const buf=[];upRes.on('data',c=>buf.push(c));upRes.on('end',()=>{cb(upRes.statusCode, Buffer.concat(buf).toString('utf8'), upRes.headers)});
  });
  up.on('error',e=>cb(0,'',{}));
  up.write(opts.body||'{}');up.end();
}

app.all('/health',(req,res)=>proxyRequest(req,res));

// --- PROXY AssettoHosting pour import automatique ---
const AH_SERVERS = (process.env.AH_SERVERS||'https://fr2.assettohosting.com:50648,https://fr5.assettohosting.com:50145')
  .split(',').map(s=>s.trim()).filter(Boolean);

function ahFetch(url, timeoutMs=15000){
  return new Promise((resolve,reject)=>{
    let u;try{u=new URL(url)}catch(e){return reject(new Error('URL invalide'))}
    const proto=u.protocol==='https:'?https:http;
    const req=proto.get({hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),path:u.pathname+u.search,headers:{'User-Agent':'GDSP-Importer/1.0','Accept':'application/json,*/*'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
        return ahFetch(new URL(res.headers.location,url).toString(),timeoutMs).then(resolve,reject);
      }
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.setTimeout(timeoutMs,()=>req.destroy(new Error('timeout')));
    req.on('error',reject);
  });
}

async function ahListResults(serverUrl){
  const r=await ahFetch(serverUrl.replace(/\/+$/,'')+'/results');
  if(r.status!==200)throw new Error('HTTP '+r.status);
  const html=r.body.toString('utf8');
  // Extract href="/results/download/XXXX.json"
  const re=/href="\/results\/download\/([^"]+\.json)"/g;
  const out=[];let m;
  while((m=re.exec(html))!==null){
    const filename=m[1];
    const parts=filename.replace(/\.json$/,'').split('_');
    if(parts.length<5)continue;
    const [y,mo,d,h,mi,...rest]=parts;
    const type=rest.pop().toUpperCase();
    const serverName=rest.join('_');
    const dObj=new Date(+y,+mo-1,+d,+h,+mi);
    out.push({filename,url:serverUrl.replace(/\/+$/,'')+'/results/download/'+filename,type,date:dObj.toISOString(),sessionName:serverName});
  }
  return out;
}

app.get('/api/ah-scan', async(req,res)=>{
  try{
    let all=[];
    for(const srv of AH_SERVERS){
      try{
        const items=(await ahListResults(srv)).map(x=>({server:srv,...x}));
        all=all.concat(items);
      }catch(e){all.push({server:srv,error:e.message})}
    }
    res.json({servers:AH_SERVERS,items:all.filter(x=>!x.error),errors:all.filter(x=>x.error)});
  }catch(e){res.status(502).json({error:e.message})}
});

app.get('/api/ah-fetch', async(req,res)=>{
  const url=String(req.query.url||'');
  if(!/^https?:\/\/(fr2|fr5)\.assettohosting\.com/i.test(url)){
    return res.status(400).json({error:'URL non autorisée.'});
  }
  try{
    const r=await ahFetch(url,20000);
    res.set('Cache-Control','public, max-age=300');
    res.set('Content-Type','application/json');
    res.status(r.status).send(r.body);
  }catch(e){res.status(502).json({error:e.message})}
});

async function ahListChampionships(serverUrl){
  const r=await ahFetch(serverUrl.replace(/\/+$/,'')+'/championships');
  if(r.status!==200)throw new Error('HTTP '+r.status+' /championships');
  const html=r.body.toString('utf8');
  const re=/href="(\/championship\/[0-9a-f-]+)(?:\/export)?"/g;
  const uuids=new Set();let m;
  while((m=re.exec(html))!==null){
    const path=m[1];
    if(/export/.test(m[0]))continue;
    const uuid=path.split('/').pop();
    if(/^[0-9a-f-]{36}$/.test(uuid))uuids.add(uuid);
  }
  return [...uuids];
}

async function ahFetchChampionship(serverUrl,uuid){
  const r=await ahFetch(serverUrl.replace(/\/+$/,'')+'/championship/'+uuid+'/export');
  if(r.status!==200)throw new Error('HTTP '+r.status);
  return JSON.parse(r.body.toString('utf8'));
}

// Liste tous les championnats sur les serveurs, avec méta + barème + sessions connues
app.get('/api/ah-championships', async(req,res)=>{
  try{
    const out=[];
    for(const srv of AH_SERVERS){
      try{
        const uuids=await ahListChampionships(srv);
        for(const uuid of uuids){
          try{
            const j=await ahFetchChampionship(srv,uuid);
            const name=(j.Name||'').trim();
            const lname=name.toLowerCase();
            // Filtres: test/duplicate/practice servers
            if(/\btest\b|ser.?test|duplicate/i.test(name))continue;
            if(j.IsInactive)continue;
            const pts=((j.Classes||[])[0]||{}).Points||{};
            const scale=(pts.Places||[]).map(x=>+x||0).filter(x=>x>0);
            const events=(j.Events||{});
            // AH stores sessions in an object keyed by type? Actually dict of event ID -> event, events contain .Sessions object
            let eventList=[];
            if(typeof events==='object'){
              for(const k in events){const ev=events[k];if(ev&&ev.ID)eventList.push(ev)}
            }
            // Lister résultats /results/download correspondant aux dates des events (on ne télécharge pas ici, on calcule juste le nombre)
            let qual=0, race=0;
            eventList.forEach(ev=>{
              const sess=ev.Sessions||{};
              if(typeof sess==='object'){
                if(sess.QUALIFY)qual++;
                ['RACE','RACEx2','RACE2','RACE_2'].forEach(k=>{if(sess[k])race++});
                // Ignore PRACTICE
              }
            });
            out.push({
              server:srv,uuid,name,
              progress:j.Stats?.Progress||0,
              numEvents:j.Stats?.NumEvents||0,
              numEntrants:j.Stats?.NumEntrants||0,
              kind:/open/i.test(name)?'open':'championship',
              pointsScale:scale,
              polePoints: +pts.PolePosition||0,
              bestLapPoints: +pts.BestLap||0,
              mostLapsLedPoints: +pts.MostLapsLed||0,
              secondRaceMultiplier: +pts.SecondRaceMultiplier||1,
              minDistancePct: +pts.RequiredRaceTimePercentage||0,
              ignoreWorst: +j.IgnoreXWorstEvents||0,
              qualSessions:qual, raceSessions:race,
              created:j.Created, updated:j.Updated,
              // Suggested slug
              slug:suggestSlug(name,j.Created)
            });
          }catch(e){}
        }
      }catch(e){out.push({server:srv,error:e.message})}
    }
    res.json({servers:AH_SERVERS,items:out.filter(x=>!x.error),errors:out.filter(x=>x.error)});
  }catch(e){res.status(502).json({error:e.message})}
});

function suggestSlug(name,created){
  const y=(created||'').slice(0,4);
  const base=name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
    .replace(/-gdup?-?/g,'-')
    .replace(/^open-?/,'')
    .replace(/^international-series-/,'')
    .replace(/^championnat-/,'')
    .slice(0,50);
  return (base+'-'+y).replace(/-+/g,'-').replace(/^-+|-+$/g,'');
}

// Liste des JSON de résultats appartenant spécifiquement à un championnat (filtre par fenêtre de dates des Events + type)
// Liste les sessions d'un championnat en lisant directement l'export /championship/<uuid>/export.
// L'export AH contient les résultats complets (Cars/Result/Laps/Events) pour TOUTES les sessions
// passées, y compris les championnats archivés dont les JSON /results/download ont été purgés.
app.get('/api/ah-championship-sessions', async(req,res)=>{
  const server=String(req.query.server||'').replace(/\/+$/,'');
  const uuid=String(req.query.uuid||'');
  if(!/^https?:\/\/(fr2|fr5)\.assettohosting\.com/i.test(server))return res.status(400).json({error:'Serveur non autorisé.'});
  if(!/^[0-9a-f-]{36}$/i.test(uuid))return res.status(400).json({error:'UUID invalide.'});
  try{
    const champ=await ahFetchChampionship(server,uuid);
    const items=[];
    const events=champ.Events||{};
    for(const evId in events){
      const ev=events[evId];if(!ev)continue;
      const sess=ev.Sessions||{};
      const ordered=['QUALIFY','RACE','RACEx2'];
      for(const rawType of ordered){
        const s=sess[rawType];if(!s)continue;
        const rObj=s.Results||{};
        const hasFull=Array.isArray(rObj.Result) && rObj.Result.length>0;
        const date=(rObj.Date)||s.StartedTime||s.CompletedTime||ev.StartedTime||null;
        const track=rObj.TrackName||(ev.RaceSetup&&ev.RaceSetup.Track)||null;
        items.push({
          source: hasFull?'export':'url',
          eventId:evId,eventName:ev.Name||champ.Name||'',
          rawType,
          sessionType:(rawType==='QUALIFY')?'QUALIFY':'RACE',
          date:date?new Date(date).toISOString():null,
          track,
          server,url:null,filename:null
        });
      }
    }
    // Complète les 'url' avec /results pour les sessions en cours non encore dans l'export
    const needUrl=items.filter(x=>x.source==='url'&&x.date);
    if(needUrl.length){
      try{
        const allResults=await ahListResults(server);
        const pool=allResults.filter(x=>x.type!=='PRACTICE'&&!/test/i.test((x.sessionName||'')+' '+(x.filename||'')));
        for(const it of needUrl){
          const needType=(it.sessionType==='QUALIFY')?'QUALIFY':'RACE';
          const base=new Date(it.date).getTime();
          let best=null,bestDt=Infinity;
          for(const r of pool){
            if(r.type!==needType)continue;
            const t=new Date(r.date).getTime();
            const dt=Math.abs(t-base);
            if(dt<bestDt && dt<=15*60*1000){best=r;bestDt=dt}
          }
          if(best){it.url=best.url;it.filename=best.filename}
          else{it.source='missing'}
        }
      }catch(e){}
    }
    const final=items.filter(x=>x.rawType!=='PRACTICE' && x.source!=='missing');
    res.json({server,uuid,championship:champ.Name,events:Object.keys(events).length,items:final});
  }catch(e){res.status(502).json({error:e.message})}
});

// Récupère les résultats d'une session directement depuis l'export AH (même format que /results/download/*.json)
app.get('/api/ah-championship-session-json', async(req,res)=>{
  const server=String(req.query.server||'').replace(/\/+$/,'');
  const uuid=String(req.query.uuid||'');
  const eventId=String(req.query.eventId||'');
  const rawType=String(req.query.rawType||'');
  if(!/^https?:\/\/(fr2|fr5)\.assettohosting\.com/i.test(server))return res.status(400).json({error:'Serveur non autorisé.'});
  if(!/^[0-9a-f-]{36}$/i.test(uuid))return res.status(400).json({error:'UUID invalide.'});
  if(!/^[0-9a-zA-Z_-]+$/.test(eventId))return res.status(400).json({error:'eventId invalide.'});
  if(!/^(QUALIFY|RACE|RACEx2)$/.test(rawType))return res.status(400).json({error:'rawType invalide.'});
  try{
    const champ=await ahFetchChampionship(server,uuid);
    const ev=champ.Events&&champ.Events[eventId];
    if(!ev)return res.status(404).json({error:'Event introuvable.'});
    const s=ev.Sessions&&ev.Sessions[rawType];
    if(!s||!s.Results)return res.status(404).json({error:'Session sans résultats dans l\'export.'});
    res.set('Cache-Control','public, max-age=300');
    res.set('Content-Type','application/json');
    res.send(JSON.stringify(s.Results));
  }catch(e){res.status(502).json({error:e.message})}
});

// Endpoint de réinitialisation TOTALE (doit être déclaré AVANT le générique /api/*) :
// 1) sauvegarde un championnat VIDE mais valide (avec une clé _reset pour satisfaire isNonEmptyObject) ;
// 2) efface aussi l'ancienne table drivers/penalties via PUT /api/results ;
// 3) renvoie le résultat agrégé au frontend.
app.all('/api/admin/reset', (req, res) => {
  const chunks=[];
  req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
    let body={};
    try{body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}}catch{}
    if(body.confirmation!=='REINIT_CHAMPIONNAT')return res.status(400).json({error:'Confirmation manquante.'});
    const auth=req.headers.authorization||'';
    if(!auth.startsWith('Bearer '))return res.status(401).json({error:'Connexion administrateur requise.'});
    const hdrs={'Authorization':auth,'Content-Type':'application/json'};
    // If the new backend supports /api/events/:slug/data, the frontend will reset that way.
    // For legacy backend (no /api/events), we keep the old behavior.
    const eventSlug=typeof body.slug==='string'?body.slug:null;
    if(eventSlug){
      const champ={sessions:[],penMap:{},manualDrivers:null,customCalendar:null};
      proxyJson({method:'POST',path:'/api/events/'+encodeURIComponent(eventSlug)+'/data',headers:hdrs,body:JSON.stringify(champ)},(s,data)=>{
        res.json({status:'ok', eventReset:{status:s,body:tryParse(data)}});
      });
      return;
    }
    let champ={ _reset:true, sessions:[], penMap:{}, manualDrivers:null, customCalendar:null, warnings:{}, meta:{ resetAt:new Date().toISOString(), resetBy:'admin', note:'Championnat entièrement réinitialisé.' } };
    proxyJson({method:'POST',path:'/api/save-championship',headers:hdrs,body:JSON.stringify(champ)},(s1,data1)=>{
      if(s1<200||s1>=300){return res.status(502).json({error:'Échec reset championnat',step1:{status:s1,body:data1}})}
      proxyJson({method:'PUT',path:'/api/results',headers:hdrs,body:JSON.stringify({drivers:[],penalties:[]})},(s2,data2)=>{
        res.json({status:'ok', championship:{status:s1,body:tryParse(data1)}, results:{status:s2,body:tryParse(data2)}});
      });
    });
  });
});
app.all('/api/*', (req,res)=>proxyRequest(req,res));

function tryParse(s){try{return JSON.parse(s)}catch(e){return s}}

// Point d'entrée HTML
const INDEX_PATH = path.join(ROOT, 'index.html');
let _indexCache = null;
function getIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8')
    .replace(/window\.GDSP_API_URL\s*=\s*window\.GDSP_API_URL\s*\|\|\s*"[^"]*"/g,
             `window.GDSP_API_URL=window.GDSP_API_URL||""`);
}
app.get('/', (_req, res) => {
  if (!_indexCache || process.env.NODE_ENV !== 'production') _indexCache = getIndex();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(_indexCache);
});
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control','no-store');
  res.status(200).json({ ok:true, service:'gdsp-frontend', backend:BACKEND_URL });
});
app.use(express.static(ROOT,{dotfiles:'deny',etag:true,maxAge:'1h',setHeaders(res,filePath){
  if(/data\.json$/i.test(filePath)||/\.html$/i.test(filePath))res.set('Cache-Control','no-cache');
}}));
app.get('*',(req,res,next)=>{if(path.extname(req.path))return next();res.sendFile(INDEX_PATH)});
app.listen(PORT,'0.0.0.0',()=>console.log(`GDSP frontend démarré sur le port ${PORT}. API proxifiée vers : ${BACKEND_URL}`));

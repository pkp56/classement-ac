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

async function ahList(serverUrl){
  const r=await ahFetch(serverUrl.replace(/\/+$/,'')+'/results');
  if(r.status!==200)throw new Error('HTTP '+r.status);
  const html=r.body.toString('utf8');
  // Extract href="/results/download/XXXX.json"
  const re=/href="\/results\/download\/([^"]+\.json)"/g;
  const out=[];let m;
  while((m=re.exec(html))!==null){
    const filename=m[1];
    // Parse filename: YYYY_MM_DD_H_M_TYPE.json
    const parts=filename.replace(/\.json$/,'').split('_');
    if(parts.length<5)continue;
    const [y,mo,d,h,mi,...rest]=parts;
    const type=rest.pop().toUpperCase(); // QUALIFY / RACE / PRACTICE
    const serverName=rest.join('_'); // possible session name if any
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
        const items=(await ahList(srv)).map(x=>({server:srv,...x}));
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

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
const FORBIDDEN = /(^|\/)(?:\.env|node_modules|\.git|\.github|package\.json|package-lock\.json|README\.md|render\.yaml|\.gitignore|\.gitattributes|app\.js|seo\.js|tests?\/|backups?\/)/i;
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  if (FORBIDDEN.test(req.path)) return res.sendStatus(404);
  next();
});

// --- PROXY API générique ---
function proxyRequest(req, res, opts = {}) {
  let target;
  try { target = new URL(opts.path || req.url, BACKEND_URL); } catch(e) { return res.status(400).end('URL invalide'); }
  const headers = Object.assign({}, req.headers);
  // Nettoyer les headers qui ne doivent pas être relayés
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  delete headers['accept-encoding']; // évite les problèmes de décompression
  headers.host = target.host; // important pour HTTPS / Cloudflare
  const chunks = [];
  const send = (body) => {
    if (body && body.length) headers['content-length'] = Buffer.byteLength(body);
    else delete headers['content-length'];
    const method=(opts.method||req.method||'GET').toUpperCase();
    const proto = target.protocol === 'https:' ? https : http;
    const upTimeout=(method==='GET'||method==='HEAD')?25000:90000;
    const upstream = proto.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: target.pathname + target.search,
      method,
      headers,
      timeout: upTimeout,
      rejectUnauthorized: true,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      console.error('proxy error:', method, opts.path||req.url, '->', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Backend indisponible', detail: e.message });
      else if (!res.writableEnded) res.end();
    });
    if (body) upstream.write(body);
    upstream.end();
  };
  if (opts.method) { send(opts.body); return; }
  // Si le body a déjà été parsé par express.json() (pour nos endpoints POST locaux),
  // rawBody est disponible sur req. Sinon on lit le flux.
  if (req.rawBody && req.rawBody.length) { send(req.rawBody); return; }
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length && !req._bodyConsumed) {
    // body parsé: le resérialiser pour le relayer
    send(JSON.stringify(req.body));
    return;
  }
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
    if(!isFinite(dObj))continue;
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
            function countSession(s){
              const nm=((s&&s.Results&&s.Results.Type)||(s&&s.SessionConfig&&s.SessionConfig.name)||'').toUpperCase();
              if(/PRACTICE/i.test(nm))return;
              if(/QUALIF|QUALIFY/i.test(nm)){qual++;return;}
              race++;
            }
            eventList.forEach(ev=>{
              const sess=ev.Sessions||{};
              if(typeof sess==='object'){
                if(sess.QUALIFY)qual++;
                ['RACE','RACEx2','RACE2','RACE_2','RACE3','RACE_3'].forEach(k=>{if(sess[k])race++});
              }
              // Parcourir aussi RaceWeekend.Sessions (format ACSR open)
              const rw=ev.RaceWeekend;
              if(rw&&Array.isArray(rw.Sessions)){
                rw.Sessions.forEach(s=>countSession(s));
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
    const diagnostics={ignored:[],missing:[]};
    const events=champ.Events||[];
    const evList=Array.isArray(events)?events:Object.values(events);
    const DATE_WINDOW_MS=45*60*1000; // fenêtre de correspondance portée à 45 minutes
    // Type → sessionType
    function toSessionType(rawType,sess){
      const name=((sess&&sess.SessionConfig&&sess.SessionConfig.name)||rawType||'').toUpperCase();
      if(/QUALIF|QUALIFY|Q$/i.test(name))return 'QUALIFY';
      if(/PRACTICE/i.test(name))return 'PRACTICE';
      return 'RACE';
    }
    function rawLabel(sess,fallback){
      const n=(sess&&sess.SessionConfig&&sess.SessionConfig.name)||fallback||'';
      return n;
    }
    function safeIso(d){
      if(!d)return null;
      const t=new Date(d);
      return isFinite(t)?t.toISOString():null;
    }
    function pushSession(ev,evId,sess,rawType){
      if(!sess)return;
      const rObj=sess.Results||{};
      const hasFull=Array.isArray(rObj.Result) && rObj.Result.length>0;
      const date=(rObj.Date)||sess.StartedTime||sess.CompletedTime||ev.StartedTime||null;
      const track=rObj.TrackName||(ev.RaceSetup&&ev.RaceSetup.Track)||null;
      const sessionType=toSessionType(rawType,sess);
      const iso=safeIso(date);
      if(!iso && !hasFull){return;} // pas de date et pas de résultats → rien à matcher
      const item={
        source: hasFull?'export':'url',
        eventId:evId,eventName:ev.Name||champ.Name||'',
        rawType,
        sessionType,
        rawLabel:rawLabel(sess,rawType),
        date:iso,
        track,
        server,url:null,filename:null
      };
      if(sessionType==='PRACTICE'){diagnostics.ignored.push({reason:'practice',item});return;}
      items.push(item);
    }
    evList.forEach(ev=>{
      const evId=ev.ID||'';
      // 1) Sessions au format simple : ev.Sessions.{QUALIFY,RACE,RACEx2,RACE2,RACE_2,RACE3}
      const sess=ev.Sessions||{};
      ['QUALIFY','RACE','RACEx2','RACE2','RACE_2','RACE3','RACE_3'].forEach(rt=>{
        pushSession(ev,evId,sess[rt],rt);
      });
      // 2) Sessions au format RaceWeekend (week-end ACSR : ev.RaceWeekend.Sessions[i])
      const rw=ev.RaceWeekend;
      if(rw&&Array.isArray(rw.Sessions)){
        rw.Sessions.forEach((s,i)=>{
          // Utiliser un rawType spécial "RW:<i>" pour pointer directement dans RaceWeekend.Sessions[i]
          const rawType='RW:'+i;
          // Déterminer le nom d'affichage (SessionConfig.name ou Results.Type)
          const lbl=(s.Results&&s.Results.Type)||(s.SessionConfig&&s.SessionConfig.name)||('Session '+(i+1));
          // Stocker aussi le nom pour affichage
          const fakeSess={...s,__rwIndex:i,SessionConfig:{name:lbl}};
          const rObj=s.Results||{};
          const hasFull=Array.isArray(rObj.Result) && rObj.Result.length>0;
          const date=(rObj.Date)||s.StartedTime||s.CompletedTime||ev.StartedTime||null;
          const track=rObj.TrackName||(ev.RaceSetup&&ev.RaceSetup.Track)||null;
          const sessionType=(/QUALIF|QUALIFY/i.test(lbl))?'QUALIFY':(/PRACTICE/i.test(lbl)?'PRACTICE':'RACE');
          if(sessionType==='PRACTICE'){diagnostics.ignored.push({reason:'practice (rw)',rawType});return;}
          const iso=safeIso(date);
          if(!iso && !hasFull){return;}
          items.push({
            source: hasFull?'export':'url',
            eventId:evId, eventName:ev.Name||champ.Name||'',
            rawType, sessionType,
            rawLabel:lbl,
            rwIndex:i,
            date:iso,
            track,server,url:null,filename:null
          });
        });
      }
    });
    // Complète les 'url' avec /results pour les sessions en cours non encore dans l'export
    const needUrl=items.filter(x=>x.source==='url'&&x.date);
    if(needUrl.length){
      try{
        const allResults=await ahListResults(server);
        // Filtre "test" moins agressif : ignorer seulement si le nom entier est "test" ou commence par "test "
        const pool=allResults.filter(x=>{
          if(x.type==='PRACTICE')return false;
          const full=((x.sessionName||'')+' '+(x.filename||'')).trim().toLowerCase();
          const base=full.replace(/^.*[\\/]/,'');
          if(/^test(\b|[-_])/i.test(base))return false;
          if(/\bduplicate\b/i.test(full))return false;
          return true;
        });
        for(const it of needUrl){
          const needType=it.sessionType;
          const baseTs=new Date(it.date).getTime();
          if(!isFinite(baseTs)){diagnostics.missing.push(it);continue;}
          const base=baseTs;
          let best=null,bestDt=Infinity;
          for(const r of pool){
            // type AC brut peut être 'RACE','QUALIFY','PRACTICE', parfois 'RACE2' etc.
            const rt=(r.type||'').toUpperCase();
            const matchType=(needType==='QUALIFY')? rt.startsWith('QUALIF')||rt==='QUALIFY'
                           : rt.startsWith('RACE');
            if(!matchType)continue;
            const t=new Date(r.date).getTime();
            const dt=Math.abs(t-base);
            if(dt<bestDt && dt<=DATE_WINDOW_MS){best=r;bestDt=dt}
          }
          if(best){it.url=best.url;it.filename=best.filename}
          else{it.source='missing';diagnostics.missing.push(it);}
        }
      }catch(e){}
    }
    const final=items.filter(x=>x.source!=='missing');
    res.json({server,uuid,championship:champ.Name,events:evList.length,items:final,diagnostics});
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
  // Accepter QUALIFY/RACE/RACEx2/RACE2/RACE_2/RACE3/RW:<index>
  if(!/^(QUALIFY|RACE|RACEx2|RACE2|RACE_2|RACE3|RACE_3|RW:\d+)$/.test(rawType))return res.status(400).json({error:'rawType invalide.'});
  try{
    const champ=await ahFetchChampionship(server,uuid);
    const evObj=champ.Events&&(champ.Events[eventId]||(Array.isArray(champ.Events)?champ.Events.find(e=>e&&e.ID===eventId):null));
    if(!evObj)return res.status(404).json({error:'Event introuvable.'});
    let s=null;
    if(rawType.startsWith('RW:')){
      const idx=parseInt(rawType.slice(3),10);
      const rw=evObj.RaceWeekend;
      if(rw&&Array.isArray(rw.Sessions)&&rw.Sessions[idx])s=rw.Sessions[idx];
    }else{
      s=evObj.Sessions&&evObj.Sessions[rawType];
    }
    if(!s)return res.status(404).json({error:'Session introuvable (ni simple, ni RaceWeekend).'});
    const rObj=s.Results;
    if(!rObj||!Array.isArray(rObj.Result))return res.status(404).json({error:'Session sans résultats dans l\'export.'});
    res.set('Cache-Control','public, max-age=300');
    res.set('Content-Type','application/json');
    res.send(JSON.stringify(rObj));
  }catch(e){res.status(502).json({error:e.message})}
});

// Endpoint de réinitialisation TOTALE (doit être déclaré AVANT le générique /api/*) :
// 1) sauvegarde un championnat VIDE mais valide (avec une clé _reset pour satisfaire isNonEmptyObject) ;
// 2) efface aussi l'ancienne table drivers/penalties via PUT /api/results ;
// 3) renvoie le résultat agrégé au frontend.
// ---------- GLOBAL EXCLUSIONS (partagées entre tous les admins/navigateurs) ----------
// Les exclusions du Classement GLOBAL sont stockées dans un fichier JSON sur le serveur
// (pas uniquement dans localStorage du navigateur de l'admin).
const GLOBAL_EXC_PATH = path.join(ROOT, 'data', 'global-exclusions.json');
function readGlobalExc(){
  try{
    const raw=fs.readFileSync(GLOBAL_EXC_PATH,'utf8');
    const j=JSON.parse(raw);
    // Format accepté : { ids: { "<id>": true } } ou bien tableau d'ids
    if(j && typeof j==='object' && j.ids && typeof j.ids==='object') return j.ids;
    if(Array.isArray(j)){const o={};j.forEach(id=>{if(typeof id==='string')o[id]=true});return o}
    return {};
  }catch(e){return {}}
}
function writeGlobalExc(ids){
  const payload={ids, updated_at:new Date().toISOString(), updated_by:process.env.ADMIN_USERNAME||'admin'};
  fs.mkdirSync(path.dirname(GLOBAL_EXC_PATH),{recursive:true});
  fs.writeFileSync(GLOBAL_EXC_PATH, JSON.stringify(payload,null,2),'utf8');
}
function checkAdminAuth(req){
  // Vérifie le Bearer token : mot de passe admin en clair (simple, pour MVP interne).
  // Le frontend envoie adminToken qui est le mot de passe saisi (cf adminLogin).
  const hdr=req.headers.authorization||'';
  if(!hdr.startsWith('Bearer '))return false;
  const token=hdr.slice(7);
  const expected=(process.env.ADMIN_PASSWORD||'').trim();
  if(!expected) return false; // pas d'admin configuré → endpoint protégé
  // timing-safe compare
  if(token.length!==expected.length) return false;
  let diff=0; for(let i=0;i<token.length;i++) diff|=token.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}
// Login admin : relaie systématiquement vers le backend Render.
// Si le backend ne répond pas (timeout/erreur réseau), on retombe sur les identifiants
// locaux (ADMIN_USERNAME/ADMIN_PASSWORD) mais AVEC UN AVERTISSEMENT : le token local ne
// sera PAS accepté par le backend pour les écritures (POST/PUT), donc la création
// d'événement / sauvegarde échouera tant que le backend est injoignable.
app.post('/api/admin/login', (req,res)=>{
  const body=JSON.stringify(req.body||{});
  const hdrs={'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
  const target=new URL('/api/admin/login', BACKEND_URL);
  const proto=target.protocol==='https:'?https:http;
  // Timeout long (60s) : les deux services sont sur Render free tier et peuvent
  // chacun avoir un cold start de 20-30s au premier appel.
  const up=proto.request({method:'POST',hostname:target.hostname,port:target.port,path:target.pathname+target.search,headers:hdrs,timeout:60000},(upRes)=>{
    const buf=[];upRes.on('data',c=>buf.push(c));upRes.on('end',()=>{
      const payload=Buffer.concat(buf).toString('utf8');
      // Relaye tel quel TOUTES les réponses du backend (y compris 401/5xx) :
      // on ne retombe en fallback local QUE sur erreur réseau/timeout (ci-dessous).
      res.writeHead(upRes.statusCode,{'Content-Type':'application/json'});
      res.end(payload);
    });
  });
  // Fallback local UNIQUEMENT si le backend ne répond pas (réseau/timeout),
  // PAS si le backend répond 401 (identifiants incorrects).
  up.on('timeout',()=>{up.destroy();if(!res.headersSent)fallbackLocal(req,res,true)||res.status(504).json({error:'Backend indisponible (timeout).'})});
  up.on('error',()=>{if(!res.headersSent)fallbackLocal(req,res,true)||res.status(502).json({error:'Backend indisponible.'})});
  up.write(body);up.end();
});
function fallbackLocal(req,res,warn){
  const {username, password} = req.body||{};
  const expectedUser=(process.env.ADMIN_USERNAME||'admin').trim();
  const expectedPass=(process.env.ADMIN_PASSWORD||'').trim();
  if(!expectedPass)return false;
  if(username!==expectedUser||password!==expectedPass)return false;
  res.set('X-Admin-Source','local-fallback');
  res.json({
    token: expectedPass,
    user: expectedUser,
    warning: warn ? 'Connecté en mode local (backend indisponible). Les sauvegardes et créations sur le serveur ne fonctionneront pas tant que la connexion au backend n\'est pas rétablie.' : undefined
  });
  return true;
}

// Vérification du token admin au démarrage : accepte le secret local de secours
// ou relaie la vérification vers le backend (tokens de production).
app.get('/api/admin/verify', async (req,res)=>{
  res.set('Cache-Control','no-store');
  if(!(await verifyAdmin(req)))return res.status(401).json({ok:false});
  res.json({ok:true,user:process.env.ADMIN_USERNAME||'Direction de course'});
});

// Lecture publique (utilisée par la page Classement GLOBAL pour tout visiteur)
app.get('/api/global-exclusions', (_req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ ids: readGlobalExc() });
});
// Mise à jour (admin seulement). Vérifie soit avec le mot de passe local (MVP),
// soit en relayant la requête vers le backend (/api/admin/verify).
async function verifyAdmin(req){
  if(checkAdminAuth(req)) return true;
  try{
    const {status} = await new Promise((resolve,reject)=>{
      const target=new URL('/api/admin/verify', BACKEND_URL);
      const hdrs=Object.assign({}, req.headers);
      delete hdrs.host;delete hdrs.connection;delete hdrs.origin;delete hdrs.referer;delete hdrs['content-length'];
      const proto=target.protocol==='https:'?https:http;
      const up=proto.request({method:'GET',hostname:target.hostname,port:target.port,path:target.pathname+target.search,headers:hdrs,timeout:8000},(upRes)=>{
        // consume body
        upRes.on('data',()=>{});
        upRes.on('end',()=>resolve({status:upRes.statusCode||0}));
      });
      up.on('timeout',()=>up.destroy(new Error('timeout')));
      up.on('error',reject);
      up.end();
    });
    if(status>=200&&status<300)return true;
  }catch(e){/* backend indisponible → échec silencieux, renverra 401 */}
  return false;
}
app.put('/api/global-exclusions', async (req,res)=>{
  if(!(await verifyAdmin(req))) return res.status(401).json({error:'Connexion administrateur requise.'});
  const body=req.body||{};
  const ids=body.ids;
  if(!ids || typeof ids!=='object') return res.status(400).json({error:'ids doit être un objet { id: true }.'});
  // Valider que toutes les clés sont des chaînes courtes et que les valeurs sont booléennes
  const clean={};
  for(const k of Object.keys(ids)){
    if(typeof k!=='string'||k.length>120) continue;
    if(ids[k]) clean[k]=true;
  }
  writeGlobalExc(clean);
  res.json({ok:true, count:Object.keys(clean).length, updated_at:new Date().toISOString(), source:'local'});
});

// Endpoint de réinitialisation TOTALE (doit être déclaré AVANT le générique /api/*) :
// 1) sauvegarde un championnat VIDE mais valide (avec une clé _reset pour satisfaire isNonEmptyObject) ;
// 2) efface aussi l'ancienne table drivers/penalties via PUT /api/results ;
// 3) renvoie le résultat agrégé au frontend.
app.all('/api/admin/reset', (req, res) => {
  let body=req.body||{};
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
// --- IMPORT DE CIRCUIT DEPUIS UN DOSSIER DRIVE PARTAGÉ PAR LIEN ---
// Protégé par le mot de passe admin (même Bearer que le reste de l'admin).
// Le dossier doit être partagé « tout le monde disposant du lien » : aucune
// clé API Google n'est nécessaire.
let driveImportModule = null;
function driveImport() {
  if (!driveImportModule) driveImportModule = require('./tools/lib/drive-circuits');
  return driveImportModule;
}
app.post('/api/admin/circuits/import', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!(await verifyAdmin(req))) return res.status(401).json({ error: 'Connexion administrateur requise.' });
  const { driveUrl, name, round } = req.body || {};
  if (!driveUrl || typeof driveUrl !== 'string') {
    return res.status(400).json({ error: "Indiquez l'URL ou l'identifiant du dossier Google Drive." });
  }
  try {
    const mod = driveImport();
    const result = await mod.importFromDrive(driveUrl, {
      name: typeof name === 'string' ? name.trim() : undefined,
      round: Number.isFinite(Number(round)) ? Number(round) : undefined
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    const status = error.status === 400 || error.status === 403 || error.status === 422 ? error.status : 502;
    res.status(status).json({ error: error.message || 'Import du circuit impossible.' });
  }
});

// --- LIVE TIMING (serveur AC dédié) ---
// Deux modes, la page /live-timing est la même :
//  • local : le serveur AC tourne sur la même machine que le site, on lit son
//    interface de plugin en UDP (ACSP v4) — voir tools/live-timing/collector.js ;
//  • push  : le serveur AC tourne sur un PC distant, tools/live-timing/agent.js
//    pousse un instantané par seconde vers POST /api/live/push (simple HTTP,
//    aucun port entrant à ouvrir sur le PC).
// Doc : tools/live-timing/README.md. Réglage : LIVE_PUSH_TOKEN.
let liveTiming = null;
let livePush = null;
let liveHttpSources = null;
const liveClients = new Set();
// Sources HTTP distantes : serveurs AC publics qu'on ne possède pas, lus via
// leur port HTTP (/INFO + /ENTRY). Une URL, un « ip:port » ou un lien acstuff
// séparés par des virgules. Ex. LIVE_HTTP_SOURCES=http://82.66.165.242:16835
function normalizeLiveSource(raw){
  let v=String(raw||'').trim();
  if(!v)return null;
  const acstuff=/[?&]ip=([^&]+)(?:[^#]*?[?&]httpPort=(\d+))?/i.exec(v);
  if(acstuff){
    const ip=decodeURIComponent(acstuff[1]);
    const port=acstuff[2];
    v=`http://${ip}${port?':'+port:''}`;
  }
  // Autre schéma (ftp:, ws:…) : ce n'est pas un serveur AC. Sinon « ftp://x »
  // devenait « http://ftp » et passait pour une adresse valide.
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(v)&&!/^https?:\/\//i.test(v))return null;
  if(!/^https?:\/\//i.test(v))v='http://'+v;
  try{
    const u=new URL(v);
    if(!/^https?:$/.test(u.protocol))return null;
    return u.origin.replace(/\/+$/,'');
  }catch(e){return null;}
}
// Capture enregistrée d'un serveur que le site ne peut pas joindre directement
// (filtrage d'IP côté serveur AC). Rejouée à l'identique, signalée comme telle.
function liveMirrorFile(){
  const p=require('path');
  const f=String(process.env.LIVE_MIRROR_FILE||'').trim();
  // « off » désactive explicitement la capture (utile pour n'afficher que du direct).
  if(/^(off|0|none|false)$/i.test(f))return null;
  if(f)return p.resolve(f);
  // Par défaut : la capture livrée dans le dépôt, si elle existe. Cela permet
  // au site publié d'afficher un serveur sans aucune variable d'environnement.
  const def=p.join(__dirname,'data','live-mirror.json');
  try{require('fs').accessSync(def);return def}catch(e){return null}
}
let liveMirrorSource=null,liveMirrorMtime=0;
function getLiveMirror(){
  const file=liveMirrorFile();
  if(!file)return null;
  try{
    const mtime=require('fs').statSync(file).mtimeMs;
    if(!liveMirrorSource||mtime!==liveMirrorMtime){
      const {MirrorHttpSource}=require('./tools/live-timing/http-source');
      liveMirrorSource=new MirrorHttpSource({file,label:'Capture'});
      liveMirrorMtime=mtime;
      console.log('live-timing: capture chargée —',file);
    }
  }catch(e){
    if(!liveMirrorSource){
      console.error('live-timing: capture illisible —',e.message);
      return null;
    }
  }
  return liveMirrorSource;
}
function liveMirrorConfig(){
  const m=getLiveMirror();
  if(!m)return {enabled:false};
  return {enabled:true,file:liveMirrorFile(),sourceUrl:m.url||null,capturedAt:m.capturedAt?new Date(m.capturedAt).toISOString():null};
}
function liveSourceUrls(){
  return String(process.env.LIVE_HTTP_SOURCES||'')
    .split(',')
    .map(normalizeLiveSource)
    .filter(Boolean)
    .slice(0,5);
}
function getLiveHttpSources(){
  if(!liveHttpSources){
    const {RemoteHttpSource}=require('./tools/live-timing/http-source');
    liveHttpSources=liveSourceUrls().map((url,i)=>new RemoteHttpSource({url,intervalMs:Number(process.env.LIVE_HTTP_INTERVAL_MS||3000),label:'Serveur '+(i+1)}));
    for(const src of liveHttpSources){
      try{src.start()}catch(e){console.error('live-timing: source distante',src.url,'—',e.message)}
    }
  }
  return liveHttpSources;
}
if(liveTimingEnabled()&&liveSourceUrls().length){
  try{getLiveHttpSources()}catch(e){console.error('live-timing: sources HTTP indisponibles —',e.message)}
}
function liveTimingEnabled(){
  return String(process.env.LIVE_TIMING_ENABLED||'1') !== '0';
}
function livePushToken(){return String(process.env.LIVE_PUSH_TOKEN||'').trim()}
function getLivePush(){
  if(!livePush){
    const {PushHub}=require('./tools/live-timing/push-hub');
    livePush=new PushHub();
  }
  return livePush;
}
function getLiveTiming(){
  if(!liveTiming){
    const {LiveTimingCollector}=require('./tools/live-timing/collector');
    liveTiming=new LiveTimingCollector();
    liveTiming.on('event',entry=>broadcastLive('log',entry));
    liveTiming.start();
  }
  return liveTiming;
}
function broadcastLive(event,payload){
  const frame='event: '+event+'\ndata: '+JSON.stringify(payload)+'\n\n';
  for(const res of liveClients){try{res.write(frame)}catch(e){/* client parti */}}
}
// Priorité : source HTTP demandée > agent qui pousse > écoute UDP locale.
function resolveLiveSource(param){
  const list=getLiveHttpSources();
  if(!list.length)return null;
  const raw=param==null?'' : String(param);
  if(!raw)return list[0];
  if(/^\d+$/.test(raw)){
    const i=Number(raw);
    return list[i]||null;
  }
  const wanted=normalizeLiveSource(raw);
  return list.find(src=>src.url===wanted)||null;
}
// Priorité : source explicitement demandée (?source=) > agent qui pousse >
// source HTTP configurée > écoute UDP locale. L'agent a la priorité sur les
// sources HTTP : c'est lui qui voit le serveur quand l'hébergeur est filtré.
function liveSnapshot(sourceIndex){
  if(sourceIndex!=null&&sourceIndex!==''){
    const remote=resolveLiveSource(sourceIndex);
    if(remote)return remote.snapshot();
  }
  const pushed=getLivePush().current();
  if(pushed)return pushed;
  const mirror=getLiveMirror();
  if(mirror)return mirror.snapshot();
  const list=getLiveHttpSources();
  if(list.length)return list[0].snapshot();
  try{return getLiveTiming().snapshot()}catch(e){
    return {status:{status:'offline',mode:'error',error:e.message},server:{},session:{},cars:[],events:[]};
  }
}
if(liveTimingEnabled()){
  try{getLiveTiming()}catch(e){console.error('live-timing: démarrage impossible —',e.message)}
}
function safeEqual(a,b){
  const A=Buffer.from(String(a||'')),B=Buffer.from(String(b||''));
  if(!A.length||A.length!==B.length)return false;
  let diff=0;for(let i=0;i<A.length;i++)diff|=A[i]^B[i];
  return diff===0;
}
app.get('/api/live/config',(req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({
    enabled:liveTimingEnabled(),
    push:{enabled:!!livePushToken(),endpoint:'/api/live/push'},
    udp:{listenPort:Number(process.env.AC_LISTEN_PORT||12000),serverPort:Number(process.env.AC_PLUGIN_PORT||12001)},
    httpSources:liveSourceUrls().map((url,i)=>({index:i,url,name:'Serveur '+(i+1)})),
    mirror:liveMirrorConfig()
  });
});
app.get('/api/live/status',(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!liveTimingEnabled())return res.json({enabled:false,status:{status:'offline',mode:'disabled'},server:{},session:{},cars:[]});
  res.json({enabled:true,...liveSnapshot(req.query.source)});
});
app.get('/api/live/snapshot',(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!liveTimingEnabled())return res.status(503).json({error:'Live timing désactivé.'});
  res.json(liveSnapshot(req.query.source));
});
// Réception des instantanés poussés par un agent (PC distant).
// Auth : en-tête X-Live-Token (ou ?token=) comparé à LIVE_PUSH_TOKEN.
app.post('/api/live/push',(req,res)=>{
  res.set('Cache-Control','no-store');
  const expected=livePushToken();
  if(!expected)return res.status(503).json({error:'Le mode push n\'est pas activé sur ce site (LIVE_PUSH_TOKEN manquant).'});
  const given=(req.get('X-Live-Token')||req.query.token||'').trim()||((req.get('Authorization')||'').replace(/^Bearer\s+/i,''));
  if(!safeEqual(given,expected))return res.status(401).json({error:'Jeton invalide.'});
  const result=getLivePush().publish(req.body);
  if(!result.ok)return res.status(400).json({error:result.error});
  broadcastLive('snapshot',getLivePush().current());
  res.json({ok:true,at:new Date(result.at).toISOString()});
});
app.get('/api/live/stream',(req,res)=>{
  if(!liveTimingEnabled())return res.status(503).end();
  res.writeHead(200,{
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-store',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no'
  });
  res.write('retry: 3000\n\n');
  const push=()=>{try{res.write('event: snapshot\ndata: '+JSON.stringify(liveSnapshot(req.query.source))+'\n\n')}catch(e){/* client parti */}};
  push();
  const timer=setInterval(push,1000);
  liveClients.add(res);
  req.on('close',()=>{clearInterval(timer);liveClients.delete(res)});
});
// Commandes admin (chat, kick, changement de session) : mêmes règles d'auth que le reste.
// En mode push elles sont impossibles : le PC n'est pas joignable depuis le site.
app.post('/api/live/command',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!liveTimingEnabled())return res.status(503).json({error:'Live timing désactivé.'});
  if(!(await verifyAdmin(req)))return res.status(401).json({error:'Connexion administrateur requise.'});
  if(resolveLiveSource(req.query.source||req.body&&req.body.source))return res.status(409).json({error:'Serveur public consulté en lecture seule : aucune commande possible.'});
  if(getLivePush().current())return res.status(409).json({error:'Serveur distant : les commandes doivent être envoyées depuis le PC qui héberge acServer.'});
  const {action,message,carId}=req.body||{};
  const allowed=['chat','kick','next-session','restart-session'];
  if(!allowed.includes(action))return res.status(400).json({error:'Action inconnue.'});
  try{
    const ok=getLiveTiming().command(action,{message,carId});
    res.json({ok});
  }catch(e){res.status(502).json({error:e.message})}
});
app.get('/live-timing',(req,res)=>res.sendFile(path.join(ROOT,'live-timing.html')));
app.get('/live-timing.html',(req,res)=>res.sendFile(path.join(ROOT,'live-timing.html')));

app.all('/api/*', (req,res)=>proxyRequest(req,res));

function tryParse(s){try{return JSON.parse(s)}catch(e){return s}}

// Point d'entrée HTML
const INDEX_PATH = path.join(ROOT, 'index.html');
function getIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8')
    .replace(/window\.GDSP_API_URL\s*=\s*window\.GDSP_API_URL\s*\|\|\s*"[^"]*"/g,
             `window.GDSP_API_URL=window.GDSP_API_URL||""`);
}
const seo = require('./seo');
// Production origin; PUBLIC_SITE_URL can override it when migrating to a custom domain.
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://classement-ac-1.onrender.com').replace(/\/$/, '');
const publicJsonCache = new Map();
async function publicJson(apiPath) {
  const cached = publicJsonCache.get(apiPath);
  if (cached && cached.until > Date.now()) return cached.value;
  const url = new URL(apiPath, BACKEND_URL);
  const value = await new Promise((resolve,reject) => {
    const req = (url.protocol==='https:'?https:http).get(url,{timeout:10000},response=>{
      const parts=[];
      response.on('data',part=>parts.push(part));
      response.on('error',reject);
      response.on('end',()=>{
        if(response.statusCode===404){const err=new Error('Not found');err.status=404;return reject(err)}
        if(response.statusCode!==200)return reject(new Error('Backend unavailable'));
        try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))}catch(err){reject(err)}
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Backend timeout')));
    req.on('error',reject);
  });
  publicJsonCache.set(apiPath,{value,until:Date.now()+60000});
  return value;
}
function sendPublicPage(res, options) {
  res.set('Cache-Control','no-cache');
  res.type('html').send(seo.renderPage(getIndex(), options));
}
function publicFailure(res,error) {
  const status=error.status===404?404:503;
  res.set('Cache-Control','no-store');
  if(status===503)res.set('Retry-After','60');
  res.status(status).type('html').send(seo.renderPage(getIndex(),{
    title:status===404?'Événement introuvable | GDSP':'GDSP — temporairement indisponible',
    description:'Gentleman Drivers Project',
    content:`<div class="panel"><h1>${status===404?'Événement introuvable':'Chargement temporairement indisponible'}</h1><p>Réessayez dans quelques instants.</p><a href="/">Accueil GDSP</a></div>`
  }));
}
app.get('/', async (_req,res)=>{
  try {
    const result=await publicJson('/api/events');
    const events=Array.isArray(result.events)?result.events:[];
    sendPublicPage(res,{title:'GDSP — Open et championnat Assetto Corsa historique & vintage',description:'GDSP : open et championnat Assetto Corsa, simracing historique et vintage. Retrouvez les calendriers, résultats et classements.',content:seo.homeContent(events),canonical:PUBLIC_SITE_URL?PUBLIC_SITE_URL+'/':null});
  }catch(error){publicFailure(res,error)}
});
app.get('/evenements/:slug',async(req,res)=>{
  try {
    const ev=await publicJson('/api/events/'+encodeURIComponent(req.params.slug));
    if(!ev.slug||!ev.name)throw new Error('Invalid event data');
    sendPublicPage(res,{title:ev.name+' | GDSP Assetto Corsa',description:String(ev.data?.eventInfo?.briefing||'Calendrier et présentation de '+ev.name+' — Gentleman Drivers Project.').slice(0,180),content:seo.eventContent(ev),canonical:PUBLIC_SITE_URL?PUBLIC_SITE_URL+seo.eventPath(ev.slug):null});
  }catch(error){publicFailure(res,error)}
});
app.get('/robots.txt',(_req,res)=>res.type('text').send('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n'+(PUBLIC_SITE_URL?'Sitemap: '+PUBLIC_SITE_URL+'/sitemap.xml\n':'')));
let lastSitemapEventPaths=[];
app.get('/sitemap.xml',async(_req,res)=>{
  if(!PUBLIC_SITE_URL)return res.status(503).type('text').send('PUBLIC_SITE_URL must be configured.');
  try {
    const result=await publicJson('/api/events');
    if(!Array.isArray(result.events))throw new Error('Invalid event catalog');
    lastSitemapEventPaths=[...new Set(result.events.filter(ev=>ev&&typeof ev.slug==='string'&&ev.slug).map(ev=>seo.eventPath(ev.slug)))];
  }catch(error){
    // A sleeping/unavailable backend must not prevent Google from reading the sitemap.
    // Retain the last successful list, or the home URL alone on a fresh server.
    console.warn('Sitemap: using fallback URL list because the event catalog is unavailable.');
  }
  const paths=['/',...lastSitemapEventPaths];
  res.set('Cache-Control','no-cache');
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+paths.map(p=>'<url><loc>'+seo.escapeHtml(PUBLIC_SITE_URL+p)+'</loc></url>').join('')+'</urlset>');
});
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control','no-store');
  res.status(200).json({ ok:true, service:'gdsp-frontend', backend:BACKEND_URL });
});
app.use(express.static(ROOT,{dotfiles:'deny',etag:true,maxAge:'1h',setHeaders(res,filePath){
  if(/data\.json$/i.test(filePath)||/\.(?:html|js)$/i.test(filePath))res.set('Cache-Control','no-cache');
}}));
app.get('*',(req,res,next)=>{if(path.extname(req.path))return next();res.sendFile(INDEX_PATH)});
app.listen(PORT,'0.0.0.0',()=>console.log(`GDSP frontend démarré sur le port ${PORT}. API proxifiée vers : ${BACKEND_URL}`));

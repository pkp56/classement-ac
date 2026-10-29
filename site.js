/* GDSP front — multi-championnat avec rétrocompatibilité backend legacy.
 * Si le backend expose /api/events → mode multi avec hub et sélecteur d'événement.
 * Sinon (backend actuel en ligne) → mode legacy, exactement comme avant. */

// ---------- Global state ----------
const LEGACY_DEFAULT_SLUG = 'lola-t290-2026';
let backendMulti = null;          // null=pending, true=multi, false=legacy
let events = [];                  // liste des événements (multi seulement)
let currentSlug = LEGACY_DEFAULT_SLUG;
let eventContext = null;          // {slug,name,kind,pointsConfig,data}
let page='accueil', ranktab='pilotes', eventtab='resultats', round=0, sessionIndex=1, driverId='', compareA='', compareB='';
let sessions=[], penMap={}, manualDrivers=null, customCalendar=null;
let adminAuth=false, adminUser='', adminTab='import', selectedRaceAdj=null;
let adminToken=localStorage.getItem('gdsp_admin_token')||null;
const app=document.getElementById('app');

// ---------- Points config par défaut (Lola T290 2026) ----------
const DEFAULT_POINTS = {
  pointsScale: [41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],
  polePoints: 1,
  doubleLongRaces: true,
  longRaceMinutes: 60,
  minPercentDistance: 0.75,
  jokerCount: 5,
  globalCoef: 1.0
};
function pointsConfig(){
  if(eventContext&&eventContext.pointsConfig)return Object.assign({},DEFAULT_POINTS,eventContext.pointsConfig);
  return Object.assign({},DEFAULT_POINTS);
}

// ---------- Helpers génériques ----------
const labelsLegacy={accueil:'Accueil',classement:'Classements',manches:'Résultats',pilotes:'Pilotes',admin:'Administration'};
const labelsHub={hub:'Accueil',global:'Global',classement:'Classements',manches:'Résultats',pilotes:'Pilotes',admin:'Administration'};
function labels(){return backendMulti?labelsHub:labelsLegacy}
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=x=>new Date(x).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
function track(x){return ({'mt-tremblant_69':'Mont-Tremblant','riverside':'Riverside','sebring_90s':'Sebring','mid_ohio':'Mid-Ohio'})[x]||x}

function nav(){
  // Hide event-specific tabs (classement/manches/pilotes) if no event is selected
  let navLabels={...labels()};
  if(backendMulti&&!eventContext){
    delete navLabels.classement;delete navLabels.manches;delete navLabels.pilotes;
  }
  const crumb = backendMulti && page!=='hub' && currentSlug
    ? `<div class="subcrumb" style="padding:6px 0 0 0"><a onclick="goHome()">← Tous les championnats</a></div>`
    : '';
  document.getElementById('nav').innerHTML =
    Object.entries(navLabels).map(([k,v])=>`<button class="${page===k?'active':''}" onclick="go('${k}')">${v.toUpperCase()}</button>`).join('');
  renderEventSwitcher();
}
function go(x){page=x;render();window.scrollTo(0,0)}
function goHome(){currentSlug=null;eventContext=null;sessions.length=0;penMap={};manualDrivers=null;customCalendar=null;go('hub')}

function renderEventSwitcher(){
  const sw=document.getElementById('event-switcher');
  const tr=document.getElementById('topRight');
  if(!backendMulti){sw.innerHTML='';tr.textContent='INTERNATIONAL SERIES · LOLA T290';return}
  if(!events.length){sw.innerHTML='';tr.textContent='GDSP';return}
  if(events.length===1&&!eventContext){
    // Un seul événement: on charge directement l'événement sans passer par le hub
    // (fait en async au boot, via bootstrap)
    sw.innerHTML='';tr.textContent=events[0].name.toUpperCase();return
  }
  if(page==='hub'||page==='global'){sw.innerHTML='';tr.textContent='GENTLEMAN DRIVERS PROJECT';return}
  const champOpts=events.filter(e=>e.kind==='championship');
  const openOpts=events.filter(e=>e.kind==='open');
  const archOpts=events.filter(e=>e.kind==='archive');
  const grp=(label,arr)=>arr.length?`<optgroup label="${label}">${arr.map(e=>`<option value="${esc(e.slug)}" ${e.slug===currentSlug?'selected':''}>${esc(e.name)}</option>`).join('')}</optgroup>`:'';
  sw.innerHTML=`<select onchange="switchEvent(this.value)"><option value="">— Tous les championnats —</option>${grp('Championnats',champOpts)}${grp('Opens',openOpts)}${grp('Archives',archOpts)}</select>`;
  const ev=events.find(e=>e.slug===currentSlug);
  tr.textContent=ev?ev.name.toUpperCase():'GDSP';
}

async function switchEvent(slug){
  if(!slug){goHome();return}
  await loadEvent(slug);
  page='classement';
  round=0;sessionIndex=1;driverId='';compareA='';compareB='';ranktab='pilotes';
  render();window.scrollTo(0,0);
}

// ---------- API helpers ----------
async function apiGet(path){const r=await fetch(path,{cache:'no-store',headers:adminToken?{Authorization:'Bearer '+adminToken}:{}});return r}
async function apiPost(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...(adminToken?{Authorization:'Bearer '+adminToken}:{})},body:body?JSON.stringify(body):undefined});
  if(r.status===401){adminToken=null;adminAuth=false;localStorage.removeItem('gdsp_admin_token');render()}
  return r;
}

async function detectBackend(){
  try{
    const r=await fetch('/api/events',{cache:'no-store'});
    if(r.ok){
      const j=await r.json();
      events=Array.isArray(j.events)?j.events:[];
      backendMulti=true;
      return;
    }
  }catch(e){}
  backendMulti=false;
}

async function loadEvent(slug){
  if(!backendMulti){
    // Legacy: charge /api/championship dans sessions+penMap (comme avant)
    return loadRemoteLegacy();
  }
  try{
    const r=await apiGet('/api/events/'+encodeURIComponent(slug));
    if(!r.ok)return null;
    const ev=await r.json();
    eventContext={slug:ev.slug,name:ev.name,kind:ev.kind,pointsConfig:ev.points_config||{},data:ev.data||{}};
    currentSlug=ev.slug;
    localStorage.setItem('gdsp_last_event',ev.slug);
    const d=ev.data||{};
    sessions.length=0;
    if(Array.isArray(d.sessions))sessions.push(...d.sessions);
    penMap=(d.penMap&&typeof d.penMap==='object')?d.penMap:{};
    manualDrivers=d.manualDrivers||null;
    customCalendar=d.customCalendar||null;
    return ev;
  }catch(e){console.warn('loadEvent failed',e);return null}
}

// Legacy loader (keep working with old backend)
async function loadRemoteLegacy(){
  try{
    const r=await apiGet('/api/championship');
    if(!r.ok)return null;
    const j=await r.json();
    const c=j.championship||{};
    if(Array.isArray(c.sessions)){
      sessions.length=0;
      if(c.sessions.length)sessions.push(...c.sessions);
      else{penMap={};manualDrivers=null;customCalendar=null}
    }
    if(c.penMap&&typeof c.penMap==='object')penMap=c.penMap;else penMap={};
    if('manualDrivers' in c)manualDrivers=c.manualDrivers;
    if('customCalendar' in c)customCalendar=c.customCalendar;
    eventContext={slug:LEGACY_DEFAULT_SLUG,name:'International Series Lola T290 — 2026',kind:'championship',pointsConfig:DEFAULT_POINTS,data:c};
    currentSlug=LEGACY_DEFAULT_SLUG;
    return j;
  }catch(e){console.warn('legacy load failed',e);return null}
}

// ---------- Navigation / rounds / drivers ----------
function rounds(){let m={};sessions.forEach(s=>(m[s.date.slice(0,10)]??=[]).push(s));return Object.entries(m).sort().map(([d,s],i)=>({date:d,sessions:s,track:track(s[0].track),number:i+1}))}
function allDrivers(){let map=new Map;for(const s of sessions)for(const r of s.results){if(!map.has(r.id))map.set(r.id,{...r});}return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name))}
function info(){return ''}
function head(k,t,desc=''){
  const prefix = backendMulti && eventContext ? eventContext.kind.toUpperCase()+' · '+eventContext.name : '';
  const eye = prefix ? prefix : 'GDSP / '+k;
  return `<div class="eyebrow">${esc(eye)}</div><h1>${t}</h1>${desc?`<p class="note">${desc}</p>`:''}`;
}
function table(headers,rows){return `<div class="table-wrap"><table><thead><tr>${headers.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')||'<tr><td colspan="8">Aucune donnée disponible.</td></tr>'}</tbody></table></div>`}
function fmt(t){if(!t||t<0||t>99999999)return '—';let m=Math.floor(t/60000),s=((t%60000)/1000).toFixed(3);return `${m}:${s.padStart(6,'0')}`}

// ---------- Pénalités / tri ----------
function findSessionIdx(sess){const rs=rounds();for(let i=0;i<rs.length;i++){const j=rs[i].sessions.indexOf(sess);if(j>=0)return [i,j]}return [-1,-1]}
function applyCommissionToArr(arr,sess,rIdx,sIdx){
  arr.forEach(y=>{y.comTimeAdd=0;y.comDQ=false;y.comWarning=false});
  const rk=rIdx>=0?rIdx+':'+sIdx+':':null;
  for(const k in penMap){
    if(rk&&!k.startsWith(rk))continue;
    const [rj,sj,did]=k.split(':');
    if(rk&&(rj!=rIdx||sj!=sIdx))continue;
    const rs2=rounds();
    if(!rk){const r=rs2[+rj];if(!r||r.sessions[+sj]!==sess)continue}
    const y=arr.find(x=>x.id===did);if(!y)continue;
    const adj=penMap[k];
    if(adj.dq)y.comDQ=true;
    else if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0)y.comTimeAdd=(y.comTimeAdd||0)+adj.timeAdd*1000;
    if(adj.warning)y.comWarning=true;
  }
  return arr;
}
function sortSession(sess){
  if(!sess)return [];
  const [rIdx,sIdx]=findSessionIdx(sess);
  let arr=sess.results.map(x=>{
    let y=({...x});
    let base=y.time;if(!Number.isFinite(base))base=10**18;
    let serverNs=Number(y.penaltyTime)||0;
    let et=base+serverNs/1e6;
    if(y.lapPenalty)et=10**18;
    if(Number.isFinite(y.efftime))et=y.efftime;
    y._eff=et;return y;
  });
  applyCommissionToArr(arr,sess,rIdx,sIdx);
  function effDQ(x){return x.disqualified||x.comDQ}
  if(sess.type==='QUALIFY'){
    arr.sort((a,b)=>{
      const ab=Number.isFinite(a.best)&&a.best>0?a.best:10**18;
      const bb=Number.isFinite(b.best)&&b.best>0?b.best:10**18;
      return ab-bb;
    });return arr;
  }
  arr.forEach(x=>{x._t=x._eff+(x.comTimeAdd||0);x._dq=effDQ(x)});
  arr.sort((a,b)=>(a._dq?1:0)-(b._dq?1:0)||b.laps-a.laps||a._t-b._t);
  return arr;
}
function tabs(items,active,fn){return `<div class="tabs">${items.map(([id,label])=>`<button class="${id===active?'active':''}" onclick="${fn}('${id}')">${label}</button>`).join('')}</div>`}
function showrank(x){ranktab=x;render()}function showevent(x){eventtab=x;render()}

// ---------- Pages ----------
// Hub page (only shown in multi mode)
function hub(){
  const byKind=(k)=>events.filter(e=>e.kind===k);
  const champs=byKind('championship'), opens=byKind('open'), archives=byKind('archive');
  function card(e){
    const tag = e.kind==='championship'?'<span class="tag live">CHAMPIONNAT</span>':e.kind==='open'?'<span class="tag open">OPEN</span>':'<span class="tag archive">ARCHIVE</span>';
    const coef = (e.points_config&&e.points_config.globalCoef!=null)?`<span class="coef">coeff ${e.points_config.globalCoef}</span>`:'';
    return `<div class="event-card" onclick="switchEvent('${esc(e.slug)}')">${coef}${tag}<h3>${esc(e.name)}</h3><p class="note">Mis à jour le ${new Date(e.updated_at).toLocaleDateString('fr-FR')}</p><span class="label">Ouvrir →</span></div>`;
  }
  const section=(title,arr)=>arr.length?`<div class="section-head"><div><div class="eyebrow">${title}</div><h2>${arr.length} événement${arr.length>1?'s':''}</h2></div></div><div class="cardlist">${arr.map(card).join('')}</div>`:'';
  const hero=`<div class="hero"><div class="hero-text"><div class="eyebrow" style="color:#d7a347">● &nbsp; GENTLEMAN DRIVERS PROJECT</div><h1>Portail des<br>Championnats <em>communautaires</em></h1><p>Championnats historiques, opens et week-ends de course. Retrouve tes pilotes, tes classements et toute l'actualité de la ligue GDSP.</p><button class="btn" onclick="go('global')">Classement GLOBAL Discord &nbsp; ↗</button></div><div class="hero-image"></div></div>`;
  const stats=`<div class="stats"><div class="stat"><span class="label">Championnats</span><strong>${String(champs.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Opens en cours/à venir</span><strong>${String(opens.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Archives</span><strong>${String(archives.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Pilotes Discord répertoriés</span><strong>—</strong></div></div>`;
  return `${hero}${stats}<div id="hub-sections">${section('Championnats en cours',champs)}${section('Opens & week-ends',opens)}${section('Saisons archivées',archives)}${(!events.length)?'<p class="note">Aucun événement configuré pour l\'instant.</p>':''}</div>`;
}

// Global ranking across all events — shown only in multi mode, built on demand
async function globalRanking(){return globalRankingSync()}
function globalRankingSync(){
  // Legacy: redirect to classement
  if(!backendMulti)return ranking();
  const agg=new Map(); // id -> {id,name,team,points:0,events:0,victories:0,podiums:0,best:[]}
  // We need to load each event and compute its points in memory
  for(const ev of events){
    const data=ev.data||{};
    const s_=Array.isArray(data.sessions)?data.sessions.slice():[];
    const p_=(data.penMap&&typeof data.penMap==='object')?data.penMap:{};
    // Compute points in this event using its points config
    const cfg=Object.assign({},DEFAULT_POINTS,ev.points_config||{});
    const evResult=computeEventStandings(s_,p_,cfg);
    for(const drv of evResult){
      const key=drv.id;
      if(!agg.has(key))agg.set(key,{id:key,name:drv.name,team:drv.team||'',points:0,events:0,victories:0,podiums:0});
      const a=agg.get(key);
      a.points+=drv.eventTotal*(cfg.globalCoef||1);
      a.events++;
      if(drv.wins)a.victories+=drv.wins;
      if(drv.podiums)a.podiums+=drv.podiums;
    }
  }
  const arr=[...agg.values()].sort((a,b)=>b.points-a.points||a.name.localeCompare(b.name));
  const rows=arr.map((d,i)=>`<tr><td class="pos">${i+1}</td><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td><td>${d.events}</td><td>${d.victories}</td><td>${d.podiums}</td><td><b>${d.points.toFixed(1)}</b></td></tr>`);
  return `${head('global','Classement GLOBAL Discord','Cumul de tous les championnats et opens, pondérés par leur coefficient (×1 championnats, ×0,5 opens par défaut).')}<div class="panel"><h2>Classement inter-événements</h2><p class="note">Le classement est calculé en direct à partir des données de chaque événement. Les pénalités de commission sont appliquées. Les pilotes sans équipe sont regroupés sous leur nom.</p>${table(['Pos.','Pilote','Épreuves','Victoires','Podiums','Points (coeff.)'],rows)}</div>`;
}

// Compute standings for an event without touching global sessions/penMap
function computeEventStandings(sArr,penMapArg,cfg){
  const sess=sArr.map(s=>({...s,results:s.results.map(r=>({...r}))}));
  // Group rounds by date
  const rMap={};sess.forEach(s=>(rMap[s.date.slice(0,10)]??=[]).push(s));
  const rs=Object.entries(rMap).sort().map(([d,s],i)=>({date:d,sessions:s,track:s[0].track,number:i+1}));
  const scale=cfg.pointsScale||DEFAULT_POINTS.pointsScale;
  const minPct=cfg.minPercentDistance??0.75;
  const doubleLong=cfg.doubleLongRaces!==false;
  const longMin=cfg.longRaceMinutes||60;
  const pole=cfg.polePoints||0;
  const map=new Map();
  for(const s of sess)for(const r of s.results){if(!map.has(r.id))map.set(r.id,{id:r.id,name:r.name,team:r.team||'',eventTotal:0,wins:0,podiums:0,rounds:[]})}
  // Apply penalties
  function applyPens(sessObj,rIdx,sIdx){
    sessObj.results.forEach(y=>{y.comTimeAdd=0;y.comDQ=false});
    for(const k in penMapArg){
      const [rj,sj,did]=k.split(':');
      if(+rj!==rIdx||+sj!==sIdx)continue;
      const y=sessObj.results.find(x=>x.id===did);if(!y)continue;
      const adj=penMapArg[k];
      if(adj.dq)y.comDQ=true;
      else if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0)y.comTimeAdd=(y.comTimeAdd||0)+adj.timeAdd*1000;
    }
  }
  for(let j=0;j<rs.length;j++){
    const r=rs[j];
    const races=r.sessions.filter(s=>s.type==='RACE');
    // Heuristic: 1 race = endurance/double points
    const isLong=races.length===1&&doubleLong;
    const mult=isLong?2:1;
    for(let si=0;si<r.sessions.length;si++){
      const s=r.sessions[si];
      applyPens(s,j,si);
      if(s.type==='RACE'){
        // Sort
        const arr=s.results.map(x=>{
          let base=Number.isFinite(x.time)?x.time:10**18;
          let sn=Number(x.penaltyTime)||0;let et=base+sn/1e6;
          if(x.lapPenalty)et=10**18;
          return {...x,_eff:et};
        });
        arr.forEach(x=>{x._t=x._eff+(x.comTimeAdd||0);x._dq=x.disqualified||x.comDQ});
        arr.sort((a,b)=>(a._dq?1:0)-(b._dq?1:0)||b.laps-a.laps||a._t-b._t);
        const win=arr.find(p=>!p._dq&&Number.isFinite(p._t));
        let cls=0;let poleGiven=false;
        arr.forEach((p,i)=>{
          const d=map.get(p.id);if(!d)return;
          let pts=0;
          const finished=!p._dq&&win&&Number.isFinite(p._t)&&p._t>=win._t&&p.laps>=win.laps*minPct;
          if(finished){
            cls++;
            pts=(scale[cls-1]||0)*mult;
            if(cls===1)d.wins++;
            if(cls<=3)d.podiums++;
          }
          if(!poleGiven&&p.grid===1&&pts>0){pts+=pole*mult;poleGiven=true}
          d.eventTotal+=pts;
          if(d.rounds.length<=j)d.rounds.push(0);
          d.rounds[j]+=pts;
        });
      }
    }
  }
  return [...map.values()];
}

// Home for legacy mode OR when an event is loaded (becomes that event's "home")
function home(){
  if(backendMulti&&!eventContext)return hub();
  let rs=rounds(),last=rs.at(-1);
  const isLola=!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG;
  // Hero original Lola T290
  if(isLola){
    return `<div class="hero"><div class="hero-text"><div class="eyebrow" style="color:#d7a347">● &nbsp; LE CHAMPIONNAT HISTORIQUE GDSP</div><h1>International<br>Series <em>Lola T290</em></h1><p>Six manches, une voiture de légende et l’esprit gentleman driver. Revivez le championnat comme si vous y étiez.</p><button class="btn" onclick="go('manches')">Explorer les résultats &nbsp; ↗</button></div><div class="hero-image"></div></div><div class="stats"><div class="stat"><span class="label">Manches prévues</span><strong>06</strong></div><div class="stat"><span class="label">Manches importées</span><strong>${String(rs.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Pilotes dans les fichiers</span><strong>${allDrivers().length}</strong></div><div class="stat"><span class="label">Voitures sur le serveur</span><strong>30 max.</strong></div></div>${info()}<div class="section-head"><div><div class="eyebrow">Le carnet de course</div><h2>Au cœur de la saison</h2></div></div><div class="grid"><div class="panel"><div class="eyebrow">Dernière manche importée</div><h2>${last?esc(last.track):'—'}</h2><p class="note">${last?`${date(last.date)} · ${last.sessions.length-1} course(s) · Manche ${last.number}`:'Aucune session importée.'}</p>${last?`<button class="btn secondary" onclick="round=${rs.length-1};sessionIndex=1;go('manches')">Voir les résultats →</button>`:''}</div><div class="panel"><div class="eyebrow">La formule</div><h2>Un retour aux années 70</h2><p class="note">Quatre manches en 2 × 25 minutes, deux manches d’une heure, un calendrier évolutif et une seule ambition : faire vivre la compétition historique.</p><span class="tag">ASSETTO CORSA</span> &nbsp; <span class="tag">LOLA T290</span></div></div>`;
  }
  // Hero générique pour les autres événements (opens, autres championnats)
  const evName=eventContext.name;
  return `<div class="hero"><div class="hero-text"><div class="eyebrow" style="color:#d7a347">● &nbsp; ${esc(eventContext.kind.toUpperCase())} GDSP</div><h1>${esc(evName)}</h1><p>Saison en cours, classements, résultats course par course et profils pilotes.</p><button class="btn" onclick="go('manches')">Explorer les résultats &nbsp; ↗</button></div><div class="hero-image"></div></div><div class="stats"><div class="stat"><span class="label">Manches importées</span><strong>${String(rs.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Pilotes</span><strong>${allDrivers().length}</strong></div><div class="stat"><span class="label">Coefficient global</span><strong>×${(pointsConfig().globalCoef||1).toFixed(1)}</strong></div><div class="stat"><span class="label">Type</span><strong>${esc(eventContext.kind)}</strong></div></div><div class="section-head"><div><div class="eyebrow">Le carnet de course</div><h2>Au cœur de la saison</h2></div></div><div class="grid"><div class="panel"><div class="eyebrow">Dernière manche importée</div><h2>${last?esc(last.track):'—'}</h2><p class="note">${last?`${date(last.date)} · ${last.sessions.length-1} course(s) · Manche ${last.number}`:'Aucune session importée.'}</p>${last?`<button class="btn secondary" onclick="round=${rs.length-1};sessionIndex=1;go('manches')">Voir les résultats →</button>`:''}</div><div class="panel"><div class="eyebrow">Barème appliqué</div><h2>${(pointsConfig().pointsScale||[]).slice(0,5).join('/')}…</h2><p class="note">${pointsConfig().doubleLongRaces?'Points doublés pour les courses d’1h. ':''}+${pointsConfig().polePoints||0} pt pôle · ${Math.round((pointsConfig().minPercentDistance||0.75)*100)}% de distance · coeff ×${(pointsConfig().globalCoef||1).toFixed(1)}.</p><span class="tag">ASSETTO CORSA</span></div></div>`;
}

// Liveries (Lola T290 2026 — gardé en dur, d'autres championnats pourront avoir leurs propres visuels plus tard)
const liveries=[['pistol','pistol','01'],['kimy','kimy','07'],['zplouch','jim','08'],['streetbike','streetbike','09'],['fmherrou','fmherrou','10'],['lenain','lenain','11'],['ponge','thomas','13'],['yohana','yohana','14'],['tofusan','tofusan','21'],['holden','holden','23'],['assassin','assassins','25'],['elouan','elouan','27'],['harryth','harry','28'],['jenkweed','jenkweed','29'],['erwann','erwann','30'],['arthur maus','arthur','31'],['alexou','alexou','33'],['orthopedux','victor','35'],['superslipos','superslipos','42'],['51r gilles','gilles','55'],['51r sherman','sherman','56'],['richard','richard','66'],['cheucheu','cheucheu','69'],['karl74','karl','74'],['neutraliz','neutraliz','77'],['alan mc','alan','84'],['pierre','pierre','86'],['kant-1','kant','88']];
function livery(name){return liveries.find(x=>(name||'').toLocaleLowerCase('fr').includes(x[0]))}
function car(name){let l=livery(name);return l?`<img class="car-thumb" src="/assets/${l[1]}.jpg?v=6" alt="Voiture n° ${l[2]} de ${esc(name)}">`:'<span class="muted">Visuel à ajouter</span>'}
function number(name){let l=livery(name);return l?`<span class="race-number">${l[2]}</span>`:'—'}

// Per-event points helper using current pointsConfig()
function baseFull(place,multiplier){
  const sc=pointsConfig().pointsScale||DEFAULT_POINTS.pointsScale;
  return (sc[place-1]||0)*multiplier;
}

// ---------- Classements (adapté au barème courant) ----------
function calculate(){
  sessions.forEach(s=>s.results.forEach(r=>{
    delete r.comPenalty;delete r.comDQ;delete r.comWarning;delete r.adjustment;r.comTimeAdd=0;
  }));
  const warnCount=new Map();
  for(const k in penMap){const adj=penMap[k];const did=k.split(':')[2];if(adj.warning)warnCount.set(did,(warnCount.get(did)||0)+1)}
  sessions.forEach(race=>{
    if(race.type!=='RACE')return;
    race.results.forEach(p=>{
      let base;
      if(Number.isFinite(p._eff))base=p._eff;
      else{let serverNs=Number(p.penaltyTime)||0;let bt=Number.isFinite(p.time)?p.time:10**18;base=bt+serverNs/1e6;if(p.lapPenalty)base=10**18}
      p.finalTime=base+(p.comTimeAdd||0);p.finalDQ=p.disqualified||p.comDQ;
    });
  });
  let rs=rounds(),ds=allDrivers(),map=new Map(ds.map(d=>[d.id,{...d,rounds:Array(rs.length).fill(0),merit:Array(rs.length).fill(0),details:[],warnings:warnCount.get(d.id)||0}]));
  const cfg=pointsConfig();
  const sc=cfg.pointsScale||DEFAULT_POINTS.pointsScale;
  const polePts=cfg.polePoints||0;
  const doubleLong=cfg.doubleLongRaces!==false;
  const longMin=cfg.longRaceMinutes||60;
  const minPct=cfg.minPercentDistance||0.75;
  const jokerCount=cfg.jokerCount||0;
  function effDQ(p){return p.finalDQ||p.disqualified||p.comDQ}
  function raceTime(p){return p.finalTime!=null?p.finalTime:p.time}
  function raceWin(race){return race.results.find(r=>!effDQ(r)&&Number.isFinite(raceTime(r)))}
  function finishStatus(race,p){
    if(effDQ(p))return {full:false};
    let win=raceWin(race);if(!win)return {full:false};
    let wl=win.laps,winEff=raceTime(win),eff=raceTime(p);
    let finished=Number.isFinite(eff)&&Number.isFinite(winEff)&&eff>=winEff;
    return {full:finished&&p.laps>=wl*minPct};
  }
  function fastestOfRace(race){
    let b=Infinity,bid=null;
    race.results.forEach(p=>{let s=finishStatus(race,p);if(s.full&&Number.isFinite(p.best)&&p.best>0&&p.best<b){b=p.best;bid=p.id}});
    return bid;
  }
  for(let r of rs)for(let sess of r.sessions){if(sess.type==='RACE'||sess.type==='QUALIFY')sess.results=sortSession(sess)}
  for(let j=0;j<rs.length;j++){
    let r=rs[j],races=r.sessions.filter(s=>s.type==='RACE'),qual=r.sessions.find(s=>s.type==='QUALIFY'),multiplier=races.length===1&&doubleLong?2:1,poleGiven=false;
    for(let race of races){
      let clsIdx=0;
      race.results.forEach((p,i)=>{
        let d=map.get(p.id);if(!d)return;
        let s=finishStatus(race,p),pts=0,place=i+1;
        if(s.full){clsIdx++;pts=(sc[clsIdx-1]||0)*multiplier}
        if(effDQ(p))pts=0;
        if(!poleGiven&&p.grid===1&&pts>0){pts+=polePts*multiplier;poleGiven=true}
        d.rounds[j]+=pts;
        if(pts>0){
          let mm=2*multiplier;
          if(typeof p.grid==='number'&&p.grid>0){let gain=p.grid-place;if(gain>=6)mm+=3*multiplier;else if(gain>=4)mm+=2*multiplier;else if(gain>=2)mm+=1*multiplier}
          d.merit[j]+=mm;
        }
      });
    }
  }
  let before=new Map;map.forEach(d=>before.set(d.id,0));
  for(let j=0;j<rs.length;j++){
    let r=rs[j],races=r.sessions.filter(s=>s.type==='RACE'),multiplier=races.length===1&&doubleLong?2:1;
    let sorted=[...before.entries()].sort((a,b)=>b[1]-a[1]);
    sorted.forEach(([id])=>{let cur=before.get(id);before.set(id,sorted.findIndex(([,p])=>p===cur)+1)});
    let qBest={};const qual=r.sessions.find(s=>s.type==='QUALIFY');if(qual)qual.results.forEach(p=>{if(Number.isFinite(p.best)&&p.best>0)qBest[p.id]=p.best});
    for(let race of races){
      let fid=fastestOfRace(race);
      race.results.forEach((p,i)=>{
        let d=map.get(p.id);if(!d)return;let s=finishStatus(race,p);if(!s.full)return;
        if(p.id===fid)d.merit[j]+=1*multiplier;
        if(qBest[p.id]&&Number.isFinite(p.best)&&p.best<qBest[p.id])d.merit[j]+=1*multiplier;
        if(j>0){let prev=before.get(p.id);if(typeof prev==='number'){let better=prev-(i+1);if(better>3)d.merit[j]+=2*multiplier;else if(better>=3)d.merit[j]+=1*multiplier}}
        if(!p.hasPenalty&&!p.penaltyTime&&!p.lapPenalty&&!p.disqualified&&!p.comDQ&&!(p.comTimeAdd>0))d.merit[j]+=1*multiplier;
      });
    }
    map.forEach(d=>before.set(d.id,(before.get(d.id)||0)+d.rounds[j]));
  }
  return [...map.values()].map(d=>{
    const jokerRounds=jokerCount>0?[...d.rounds].sort((a,b)=>b-a).slice(0,jokerCount):d.rounds;
    return {...d,total:d.rounds.reduce((a,b)=>a+b,0),joker:jokerRounds.reduce((a,b)=>a+b,0),meritTotal:d.merit.reduce((a,b)=>a+b,0)};
  });
}
function meritRows(){let rs=rounds(),ds=calculate();ds.sort((a,b)=>b.meritTotal-a.meritTotal||a.name.localeCompare(b.name));return table(['Pos.','N°','Pilote','Voiture',...rs.map(x=>'M'+x.number),'Total mérite'],ds.map((d,i)=>`<tr><td class="pos">${i+1}</td><td>${number(d.name)}</td><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td><td>${car(d.name)}</td>${d.merit.map(p=>`<td>${p}</td>`).join('')}<td><b>${d.meritTotal}</b></td></tr>`))}
function ranking(){
  if(backendMulti&&!eventContext)return hub();
  let ds=calculate(),r=rounds(),value=ranktab==='joker'?'joker':'total';
  let tabshtml=tabs([['pilotes','Pilotes'],['joker',`Pilotes · ${pointsConfig().jokerCount||'toutes'} meilleures manches`],['equipes','Équipes'],['merite','Trophée du mérite']],ranktab,'showrank');
  if(ranktab==='merite')return `${head('classements','La course aux points','Pilotes, équipes et Trophée du mérite.')}${tabshtml}<div class="panel"><h2>Trophée du mérite</h2><p class="note">Course terminée, meilleur tour en course, meilleur temps en course qu'en qualification, progression depuis la grille, résultat meilleur que son classement général à partir de la manche 2, et absence de pénalité post-course. Les manches d'une heure rapportent le double.</p>${meritRows()}</div>`;
  let rows;
  if(ranktab==='equipes'){
    let teams=new Map;
    ds.forEach(d=>{let t=(d.team||'').trim();if(!t||/indépendant/i.test(t))return;let key=t.toLocaleLowerCase('fr');if(!teams.has(key))teams.set(key,{name:t,rounds:Array(r.length).fill(0),count:0});let team=teams.get(key);team.count++;for(let j=0;j<r.length;j++)team.rounds[j]+=d.rounds[j]});
    let arr=[...teams.values()].map(t=>({...t,total:t.rounds.reduce((a,b)=>a+b,0),joker:[...t.rounds].sort((a,b)=>b-a).slice(0,pointsConfig().jokerCount||0).reduce((a,b)=>a+b,0)})).sort((a,b)=>b.joker-a.joker);
    rows=table(['Pos.','Équipe issue des fichiers','Pilotes',...r.map(x=>'M'+x.number),'Total'],arr.map((t,i)=>`<tr><td class="pos">${i+1}</td><td><b>${esc(t.name)}</b></td><td>${t.count}</td>${t.rounds.map(p=>`<td>${p}</td>`).join('')}<td><b>${t.joker}</b></td></tr>`));
  }else{
    ds.sort((a,b)=>b[value]-a[value]||a.name.localeCompare(b.name));
    rows=table(['Pos.','N°','Pilote','Voiture',...r.map(x=>'M'+x.number),'Total'],ds.map((d,i)=>`<tr><td class="pos">${i+1}</td><td>${number(d.name)}</td><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td><td>${car(d.name)}</td>${d.rounds.map(p=>`<td>${p}</td>`).join('')}<td><b>${d[value]}</b></td></tr>`));
  }
  return `${head('classements','La course aux points','Pilotes et équipes selon le barème de cet événement.')}${tabshtml}<div class="panel"><h2>${({pilotes:'Classement général',joker:'Meilleures manches',equipes:'Classement équipes'})[ranktab]}</h2><p class="note">${ranktab==='equipes'?'Cumul des points des pilotes par manche.':ranktab==='joker'?`Les ${pointsConfig().jokerCount||'—'} meilleurs totaux de manche sont conservés.`:'Tous les résultats sont cumulés.'}</p>${rows}</div>`;
}

// ---------- Pages Manches / Pilotes ----------
function manche(){
  if(backendMulti&&!eventContext)return hub();
  let rs=rounds();if(round>=rs.length)round=0;let r=rs[round];if(!r)return `${head('résultats','Les manches','')}<p class="note">Aucune manche importée.</p>`;
  if(sessionIndex>=r.sessions.length)sessionIndex=0;let s=r.sessions[sessionIndex];let rows=sortSession(s);let winner=s.type==='RACE'?rows[0]:null;
  function eff(x){let t=x._t;if(Number.isFinite(t))return t;let base=x.finalTime!=null?x.finalTime:(x.efftime!=null?x.efftime:x.time);return Number.isFinite(base)?base+(x.comTimeAdd||0):null}
  function gapTo(a,b){let ta=eff(a),tb=eff(b);if(!ta||!tb||a.laps!==b.laps||a._dq||b._dq)return a.laps!==b.laps?(a.laps<b.laps?'+'+(b.laps-a.laps)+' t':'—'):'—';let d=(ta-tb)/1000;return d>0?'+'+d.toFixed(3)+' s':'—'}
  let resultrows;
  if(s.type==='QUALIFY'){
    resultrows=rows.map((x,i)=>`<tr><td class="pos">${String(i+1).padStart(2,'0')}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.team)||'—'}</td><td>${x.laps??'—'}</td><td>${fmt(x.best)}</td></tr>`);
  }else{
    resultrows=rows.map((x,i)=>{const prev=i>0?rows[i-1]:null;return `<tr><td class="pos">${String(i+1).padStart(2,'0')}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.team)||'—'}</td><td>${x.grid??'—'}</td><td>${x.laps??'—'}</td><td>${fmt(x.best)}</td><td>${i===0?'Tête':gapTo(x,winner)}</td><td>${i===0?'—':gapTo(x,prev)}</td></tr>`});
  }
  function raceClock(ts,start){if(typeof ts!=='number'||typeof start!=='number')return '—';let sec=Math.max(0,ts-start),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60),ms=Math.floor((sec%1)*10);return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
  let eventrows=(s.events||[]).filter(e=>e.a&&e.b).map((e,i)=>`<tr><td>${i+1}</td><td><b>${esc(e.a)}</b></td><td>${esc(e.b)}</td><td>${typeof e.speed==='number'?e.speed.toFixed(1)+' km/h':'—'}</td><td>${raceClock(e.timestamp,s.raceStart)}</td></tr>`);
  return `${head('résultats','Les manches','Toutes les sessions importées, regroupées par date.')}<div class="controls"><select onchange="round=+this.value;sessionIndex=0;eventtab='resultats';render()">${rs.map((x,i)=>`<option value="${i}" ${i===round?'selected':''}>Manche ${i+1} · ${esc(x.track)}</option>`).join('')}</select><select onchange="sessionIndex=+this.value;eventtab='resultats';render()">${r.sessions.map((x,i)=>`<option value="${i}" ${i===sessionIndex?'selected':''}>${x.type==='QUALIFY'?'Qualification':'Course '+r.sessions.slice(0,i+1).filter(y=>y.type==='RACE').length}</option>`).join('')}</select><span class="tag">${date(r.date)}</span></div>${tabs([['resultats','Résultats'],...(s.type==='RACE'?[['collisions','Collisions entre pilotes']]:[])],eventtab,'showevent')}<div class="panel">${eventtab==='collisions'?`<h2>Incidents enregistrés</h2><p class="note">Événements bruts entre voitures en course, sans attribution de responsabilité.</p>${table(['#','Pilote','Autre pilote','Vitesse','Temps de course'],eventrows)}`:`<h2>${esc(r.track)} · ${s.type==='QUALIFY'?'Qualification':'Course'}</h2><p class="note">Classement officiel : meilleur tour pour les qualifications, ordre d'arrivée (avec pénalités commission) pour les courses.</p>${s.type==='QUALIFY'?table(['Pos.','Pilote','Équipe','Tours','Meilleur tour'],resultrows):table(['Pos.','Pilote','Équipe','Grille','Tours','Meilleur tour','Écart / tête','Écart / préc.'],resultrows)}`}</div>`;
}

// Performance ratings (kept simple, unchanged logic)
function performanceRatings(){let pilots=new Map;const pct=(arr,id,key,lower=true)=>{let eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);if(!item||eligible.length<2)return null;let better=eligible.filter(x=>lower?x[key]<item[key]:x[key]>item[key]).length,equal=eligible.filter(x=>x[key]===item[key]).length;return 100*(1-(better+(equal-1)/2)/(eligible.length-1))};for(let race of sessions.filter(s=>s.type==='RACE')){let entries=race.results.map((r,i)=>{let laps=race.laps.filter(l=>l.id===r.id&&Number.isFinite(l.time)&&l.time>0&&l.time<600000),clean=laps.filter(l=>!(l.cuts>0)),avg=clean.reduce((a,l)=>a+l.time,0)/(clean.length||1),sd=clean.length>=3?Math.sqrt(clean.reduce((a,l)=>a+(l.time-avg)**2,0)/clean.length)/avg:null,name=(r.name||'').trim().toLowerCase(),collisions=(race.events||[]).filter(e=>[e.a,e.b].some(v=>String(v||'').trim().toLowerCase()===name)).length,cuts=laps.reduce((n,l)=>n+(Number.isFinite(l.cuts)?Math.max(0,l.cuts):0),0);return {id:r.id,regularity:sd,cleanliness:collisions+cuts,speed:Number.isFinite(r.best)&&r.best>0&&r.best<600000?r.best:null,result:i+1}});for(let e of entries){let v={regularite:pct(entries,e.id,'regularity'),proprete:pct(entries,e.id,'cleanliness'),vitesse:pct(entries,e.id,'speed'),resultats:pct(entries,e.id,'result')};if(Object.values(v).some(x=>x===null))continue;if(!pilots.has(e.id))pilots.set(e.id,[]);pilots.get(e.id).push(v)}}let out=[];for(let [id,items] of pilots){if(items.length<2)continue;let average=key=>items.reduce((a,x)=>a+x[key],0)/items.length,details={regularite:average('regularite'),proprete:average('proprete'),vitesse:average('vitesse'),resultats:average('resultats')},score=Object.values(details).reduce((a,b)=>a+b,0)/4;out.push({id,score,details,count:items.length})}out.sort((a,b)=>b.score-a.score);for(let i=0;i<out.length;i++){let rank=out.findIndex(x=>Math.abs(x.score-out[i].score)<1e-9);out[i].level=4-Math.min(3,Math.floor(rank*4/out.length))}return out}
function ratingCard(id){let ratings=performanceRatings(),r=ratings.find(x=>x.id===id);if(!r)return `<div class="panel"><div class="eyebrow">Évaluation de performance</div><h2>Niveau à déterminer</h2><p class="note">Au moins deux courses exploitables sont nécessaires.</p></div>`;let labels={regularite:'Régularité',proprete:'Propreté',vitesse:'Vitesse au tour',resultats:'Résultats'},bars=Object.entries(r.details).map(([k,v])=>`<div style="margin:14px 0"><div style="display:flex;justify-content:space-between;font-size:13px"><b>${labels[k]}</b><span>${v.toFixed(0)} / 100</span></div><div class="bar" style="margin-top:7px"><i style="width:${v.toFixed(1)}%"></i></div></div>`).join('');return `<div class="panel"><div class="eyebrow">Évaluation de performance · provisoire</div><h2>Niveau ${r.level} <span style="font-family:Arial;font-size:13px;color:#6d726c">/ 4</span></h2><p class="note">Score relatif : <b>${r.score.toFixed(1)} / 100</b> · ${r.count} course(s) exploitables · ${ratings.length} pilotes évalués</p>${bars}</div>`}
function plotHistory(metrics,mode){if(!metrics.length)return '<p class="note">Aucune course disponible.</p>';let w=700,h=190,left=42,right=20,top=16,bottom=42,vals=metrics.map(m=>mode==='position'?m.position:m.collisions),max=Math.max(mode==='position'?5:1,...vals),x=i=>left+(metrics.length===1?(w-left-right)/2:i*(w-left-right)/(metrics.length-1)),y=v=>mode==='position'?top+(v-1)*(h-top-bottom)/Math.max(max-1,1):top+(max-v)*(h-top-bottom)/max;let line=vals.map((v,i)=>`${x(i)},${y(v)}`).join(' '),ticks=[1,Math.ceil(max/2),max].filter((v,i,a)=>a.indexOf(v)===i);let grid=ticks.map(t=>`<line x1="${left}" y1="${y(t)}" x2="${w-right}" y2="${y(t)}" stroke="#d8cdbb"/><text x="${left-8}" y="${y(t)+4}" text-anchor="end" font-size="11" fill="#69756e">${t}</text>`).join('');let points=vals.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="5" fill="#9c3021"><title>${esc(track(metrics[i].race.track))} — ${date(metrics[i].race.date)} : ${v}</title></circle><text x="${x(i)}" y="${h-17}" text-anchor="middle" font-size="10" fill="#69756e">C${i+1}</text>`).join('');return `<svg viewBox="0 0 ${w} ${h}" role="img" style="width:100%;height:auto;display:block">${grid}<polyline fill="none" stroke="#a83729" stroke-width="2.5" points="${line}"/>${points}</svg><p class="note">${metrics.map((m,i)=>`C${i+1} : ${esc(track(m.race.track))} · ${date(m.race.date)}`).join(' &nbsp; / &nbsp; ')}</p>`}
function drivers(){
  if(backendMulti&&!eventContext)return hub();
  let ds=allDrivers();
  if(driverId){
    let d=ds.find(x=>x.id===driverId);if(!d){driverId='';return drivers()}
    let races=sessions.filter(s=>s.type==='RACE'&&s.results.some(x=>x.id===driverId));
    let metrics=races.map(s=>{let index=s.results.findIndex(x=>x.id===driverId),r=s.results[index],name=(r.name||'').trim().toLowerCase();let collisions=(s.events||[]).filter(e=>[e.a,e.b].some(x=>String(x||'').trim().toLowerCase()===name)).length;return {race:s,result:r,position:index+1,delta:typeof r.grid==='number'&&r.grid>0?r.grid-(index+1):null,collisions}});
    let known=metrics.filter(x=>x.delta!==null),avgDelta=known.length?known.reduce((n,x)=>n+x.delta,0)/known.length:null,avgColl=metrics.length?metrics.reduce((n,x)=>n+x.collisions,0)/metrics.length:null,avgPos=metrics.length?metrics.reduce((n,x)=>n+x.position,0)/metrics.length:null;
    let signed=x=>x===null?'—':`${x>0?'+':''}${x.toFixed(1)}`;
    let positives=[],weaknesses=[];
    if(known.length>=2){if(avgDelta>0.5)positives.push(`Progression moyenne de ${signed(avgDelta)} place(s) entre le départ et l'arrivée.`);else if(avgDelta<-.5)weaknesses.push(`Recul moyen de ${Math.abs(avgDelta).toFixed(1)} place(s) entre le départ et l'arrivée.`);else positives.push('Positions de départ globalement conservées en course.')}
    if(metrics.length>=2){if(avgColl<1)positives.push("Moins d'un événement de collision enregistré par course en moyenne.");else if(avgColl>=3)weaknesses.push("Plusieurs événements de collision enregistrés par course en moyenne.");if(avgPos<=5)positives.push('Position moyenne à l’arrivée dans les cinq premiers.')}
    let desc=arr=>arr.length?arr.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>Pas assez de données.</li>';
    let l=livery(d.name),largeCar=l?`<img class="driver-car" src="/assets/${l[1]}.jpg?v=6" alt="Voiture numéro ${l[2]} de ${esc(d.name)}">`:'<p class="note">Visuel de voiture à ajouter.</p>';
    let rows=races.map(s=>{let i=s.results.findIndex(x=>x.id===driverId),r=s.results[i];let times=s.laps.filter(x=>x.id===driverId&&x.time>0&&x.time<99999999);let mean=times.reduce((a,b)=>a+b.time,0)/(times.length||1),sd=Math.sqrt(times.reduce((a,b)=>a+(b.time-mean)**2,0)/(times.length||1));let m=metrics.find(x=>x.race===s);return `<tr><td>${date(s.date)}</td><td>${esc(track(s.track))}</td><td>${r.grid??'—'}</td><td class="pos">${i+1}</td><td>${m.delta===null?'—':(m.delta>0?'+':'')+m.delta}</td><td>${m.collisions}</td><td>${fmt(r.best)}</td><td>${times.length>1?(sd/1000).toFixed(2)+' s':'—'}</td></tr>`});
    return `${head('pilote',esc(d.name),esc(d.team)||'Pilote')}<button class="btn secondary" onclick="driverId='';render()">← Tous les pilotes</button><div class="profile-car" style="margin-top:15px"><span class="label">Voiture engagée</span> &nbsp; ${number(d.name)} ${largeCar}</div><div class="stats"><div class="stat"><span class="label">Courses enregistrées</span><strong>${races.length}</strong></div><div class="stat"><span class="label">Meilleur résultat brut</span><strong>${races.length?Math.min(...metrics.map(m=>m.position)):'—'}</strong></div><div class="stat"><span class="label">Places gagnées / course</span><strong>${signed(avgDelta)}</strong></div><div class="stat"><span class="label">Collisions / course</span><strong>${avgColl===null?'—':avgColl.toFixed(1)}</strong></div></div><p class="note">Delta : position de départ brute moins position d'arrivée ; positif = progression.</p><div class="section-head"><div><div class="eyebrow">Quatre critères · un niveau</div><h2>Profil de performance</h2></div></div>${ratingCard(driverId)}<div class="section-head"><div><div class="eyebrow">Analyse</div><h2>Portrait du pilote</h2></div></div><div class="grid"><div class="panel"><div class="eyebrow">Points forts</div><ul class="note">${desc(positives)}</ul></div><div class="panel"><div class="eyebrow">Axes de progression</div><ul class="note">${desc(weaknesses)}</ul></div></div><div class="section-head"><h2>Historique en course</h2></div><div class="panel">${table(['Date','Circuit','Départ','Arrivée','Delta','Collisions brutes','Meilleur tour','Écart-type'],rows)}</div>`;
  }
  return `${head('pilotes','Les engagés','Pilotes présents dans cet événement.')}<div class="panel"><div class="eyebrow">Face à face</div><h2>Comparer deux pilotes</h2><div class="controls"><select onchange="compareA=this.value;render()"><option value="">Choisir un pilote</option>${ds.map(d=>`<option value="${d.id}" ${compareA===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select><select onchange="compareB=this.value;render()"><option value="">Choisir un autre pilote</option>${ds.map(d=>`<option value="${d.id}" ${compareB===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>${comparison()}</div><div class="controls"><input id="search" placeholder="Rechercher un pilote..." oninput="filterDrivers(this.value)"></div><div class="cardlist" id="drivers">${ds.map(d=>`<div class="driver" data-name="${esc(d.name.toLowerCase())}" onclick="driverId='${d.id}';render()"><div class="eyebrow">Pilote engagé</div><strong>${esc(d.name)}</strong> &nbsp; ${number(d.name)}<div>${car(d.name)}</div><p class="muted">${esc(d.team)||'Équipe non renseignée'}</p><span class="label">Voir la fiche &nbsp; →</span></div>`).join('')}</div>`;
}
function comparison(){if(!compareA||!compareB)return '<p class="note">Sélectionnez deux pilotes.</p>';let list=calculate(),a=list.find(x=>x.id===compareA),b=list.find(x=>x.id===compareB);if(!a||!b)return '';function stats(x){let rr=sessions.filter(s=>s.type==='RACE').flatMap(s=>s.results.map((r,i)=>({r,i})).filter(y=>y.r.id===x.id));let valid=rr.filter(y=>typeof y.r.grid==='number'&&y.r.grid>0);let delta=valid.length?(valid.reduce((n,y)=>n+y.r.grid-(y.i+1),0)/valid.length).toFixed(1):'—';let collisions=sessions.filter(s=>s.type==='RACE').reduce((n,s)=>{let r=s.results.find(z=>z.id===x.id);if(!r)return n;let name=(r.name||'').trim().toLowerCase();return n+(s.events||[]).filter(e=>[e.a,e.b].some(v=>String(v||'').trim().toLowerCase()===name)).length},0);return {courses:rr.length,best:rr.length?Math.min(...rr.map(y=>y.i+1)):'—',avg:rr.length?(rr.reduce((n,y)=>n+y.i+1,0)/rr.length).toFixed(1):'—',delta,collisions:rr.length?(collisions/rr.length).toFixed(1):'—'}}let aa=stats(a),bb=stats(b);return table(['Indicateur',esc(a.name),esc(b.name)],[['Courses',aa.courses,bb.courses],['Meilleure position brute',aa.best,bb.best],['Position moyenne brute',aa.avg,bb.avg],['Delta moyen départ-arrivée',aa.delta,bb.delta],['Collisions brutes par course',aa.collisions,bb.collisions],['Points',a.total.toFixed?a.total.toFixed(0):a.total,b.total.toFixed?b.total.toFixed(0):b.total]].map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join('')}</tr>`))}
function filterDrivers(q){q=(q||'').toLowerCase();document.querySelectorAll('#drivers .driver').forEach(el=>{el.style.display=el.dataset.name.includes(q)?'':'none'})}

// ---------- Sauvegarde / admin ----------
function shaShort(input){let h=2166136261;for(let i=0;i<input.length;i++){h^=input.charCodeAt(i);h=Math.imul(h,16777619)}return ('00000000'+(h>>>0).toString(16)).slice(-8)+input.slice(0,4)}
function pseudonymizeGuid(guid){return shaShort(String(guid||''))}
function saveState(){
  localStorage.setItem('gdsp_sessions',JSON.stringify(sessions));
  localStorage.setItem('gdsp_penalties',JSON.stringify(penMap));
  if(manualDrivers)localStorage.setItem('gdsp_drivers',JSON.stringify(manualDrivers));
  if(customCalendar)localStorage.setItem('gdsp_calendar',JSON.stringify(customCalendar));
  if(adminToken)saveRemote().catch(e=>console.warn('auto-save failed',e));
}
async function adminLogin(){
  const u=(document.getElementById('adminuser')||{}).value||'gdspadmin';const p=document.getElementById('adminpass').value;
  try{const r=await apiPost('/api/admin/login',{username:u,password:p});const j=await r.json();if(!r.ok||!j.token){alert(j.error||j.message||'Identifiant ou mot de passe incorrect.');return}adminToken=j.token;localStorage.setItem('gdsp_admin_token',adminToken);adminAuth=true;adminUser='Direction de course';try{if(backendMulti){if(currentSlug)await loadEvent(currentSlug)}else await loadRemoteLegacy()}catch(e){}render()}catch(e){alert('Erreur de connexion : '+e.message)}
}
async function adminLogout(){adminToken=null;adminAuth=false;adminUser='';localStorage.removeItem('gdsp_admin_token');render()}
async function doSaveRemote(){
  const el=document.getElementById('save-status');
  function say(txt,c){if(el){el.textContent=txt;el.style.color=c||'#586260'}console.log('[save]',txt)}
  say('Envoi en cours…');
  try{const j=await saveRemote();say('✓ Sauvegarde envoyée au serveur ('+new Date(j.updatedAt||Date.now()).toLocaleString('fr-FR')+').','#3b6341')}
  catch(e){say('✗ Échec : '+e.message,'#9c3021');console.error(e)}
}
async function saveRemote(){
  if(!adminToken)throw new Error('Non connecté administrateur.');
  const payload={sessions,penMap,manualDrivers,customCalendar};
  let path;
  if(backendMulti&&currentSlug)path='/api/events/'+encodeURIComponent(currentSlug)+'/data';
  else path='/api/save-championship';
  const r=await apiPost(path,payload);
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok)throw new Error(j.error||j.message||('HTTP '+r.status));
  return j;
}

// Import JSON
function importSessionJson(text,fileName){
  try{let j=JSON.parse(text);
    function driverFrom(obj){const drv=obj.Driver||obj.driver||{};const guid=drv.Guid||obj.DriverGuid||obj.Guid||'';const name=clean(drv.Name||obj.DriverName||'').trim();return {id:pseudonymizeGuid(guid||name+'|'+obj.CarId),name,team:clean(drv.Team||obj.Team||'')||'',skin:clean(obj.Skin||name||''),model:obj.Model||obj.CarModel}}
    function clean(v){return String(v||'').replace(/7656119\d{10}/g,m=>pseudonymizeGuid(m))}
    const cars={};(j.Cars||[]).forEach(c=>cars[c.CarId]=driverFrom(c));
    const results=(j.Result||[]).map(r=>{const meta=cars[r.CarId]||driverFrom(r);return {id:meta.id,name:meta.name,team:meta.team||'',skin:meta.skin||'',grid:r.GridPosition,laps:r.NumLaps||0,best:r.BestLap,time:r.TotalTime,disqualified:!!r.Disqualified,hasPenalty:!!r.HasPenalty,penaltyTime:r.PenaltyTime||0,lapPenalty:r.LapPenalty||0}}).filter(r=>!(r.model==='dodge_monaco_police'||/broadcast/i.test(r.name)));
    const laps=(j.Laps||[]).map(l=>{const meta=cars[l.CarId];if(!meta)return null;return {id:meta.id,time:l.LapTime,cuts:l.Cuts||0,timestamp:l.Timestamp}}).filter(Boolean);
    const events=(j.Events||[]).filter(e=>e.Type==='COLLISION_WITH_CAR'&&j.Type==='RACE').map(e=>{const a=cars[e.CarId],b=cars[e.OtherCarId];if(!a||!b)return null;return {a:a.name,b:b.name,aid:a.id,bid:b.id,speed:e.ImpactSpeed,timestamp:e.Timestamp}}).filter(Boolean);
    let raceStart=null;
    if(j.Type==='RACE'){const c=[];laps.forEach(l=>{if(typeof l.timestamp==='number'&&typeof l.time==='number'&&40000<l.time<600000)c.push(l.timestamp-l.time/1000)});if(c.length)raceStart=Math.min(...c)}
    const sess={date:j.Date,track:j.TrackName,type:j.Type,results,laps,events,raceStart};
    const idx=sessions.findIndex(x=>x.date===j.Date&&x.type===j.Type);
    if(idx>=0)sessions[idx]=sess;else sessions.push(sess);
    sessions.sort((a,b)=>a.date.localeCompare(b.date));
    saveState();alert(`Import réussi : ${j.Type} du ${j.Date}.`);render();return true;
  }catch(err){alert('Erreur d\'import : '+err.message);return false}
}
function handleImport(ev){const f=ev.target.files[0];if(!f)return;const r=new FileReader();r.onload=e=>importSessionJson(e.target.result,f.name);r.readAsText(f)}
function bulkImport(ev){const fs=ev.target.files;let ok=0;for(const f of fs){const r=new FileReader();r.onload=e=>{if(importSessionJson(e.target.result,f.name)){ok++;if(ok===fs.length)render()}};r.readAsText(f)}}
function addAdjustment(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note){penMap[`${roundKey}:${sessionIdx}:${drvId}`]={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};saveState();render()}
function removeAdjustment(key){delete penMap[key];saveState();render()}
function addRound(){const d=prompt('Date (AAAA-MM-JJ) ?','2026-11-18');if(!d)return;const t=prompt('Circuit (ex: spa_1970) ?','spa_1970');if(!t)return;customCalendar=customCalendar||{};customCalendar[d]={track:t};saveState();render()}

async function resetChampionship(){
  if(!confirm("Réinitialiser TOUT cet événement ? Tous les résultats seront effacés."))return;
  const remote=confirm("Effacer aussi la sauvegarde sur le serveur ?");
  try{
    if(remote){
      if(!adminToken){alert("Connexion admin requise.");return}
      // Use event-aware reset via saving empty payload to event data
      const empty={sessions:[],penMap:{},manualDrivers:null,customCalendar:null};
      let path=backendMulti&&currentSlug?'/api/events/'+encodeURIComponent(currentSlug)+'/data':'/api/save-championship';
      const r=await apiPost(path,empty);
      if(!r.ok){const t=await r.text();alert('Échec reset : '+t);return}
    }
  }catch(e){alert('Erreur : '+e.message);return}
  sessions.length=0;penMap={};manualDrivers=null;customCalendar=null;selectedRaceAdj=null;driverId='';compareA='';compareB='';round=0;sessionIndex=0;
  localStorage.removeItem('gdsp_sessions');localStorage.removeItem('gdsp_penalties');localStorage.removeItem('gdsp_drivers');localStorage.removeItem('gdsp_calendar');
  localStorage.setItem('gdsp_reset','1');
  render();
}
function resetRound(n){if(!confirm(`Effacer la manche ${n+1} ?`))return;sessions=sessions.filter(s=>{const r=rounds().find(x=>x.sessions.includes(s));return !r||r.number!==n+1});saveState();render()}
function exportData(){const blob=new Blob([JSON.stringify(sessions,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(currentSlug||'gdsp')+'_export.json';a.click()}
function editDriver(id){const d=allDrivers().find(x=>x.id===id);if(!d)return;const name=prompt('Nom du pilote :',d.name);if(name===null)return;const team=prompt('Équipe :',d.team||'');if(team===null)return;manualDrivers=manualDrivers||{};manualDrivers[id]={name,team:team||''};sessions.forEach(s=>s.results.forEach(r=>{if(r.id===id){r.name=name;r.team=team||''}}));saveState();render()}
function adminTabs(x){adminTab=x;render()}

// Event creation (multi only)
async function createEventPrompt(){
  const name=prompt('Nom du championnat/open (ex: Open de Spa 2026) ?');if(!name)return;
  const kind=prompt('Type : "championship", "open" ou "archive" ?','open');if(!['championship','open','archive'].includes(kind))return alert('Type invalide.');
  const slugIn=prompt('Identifiant URL (lettres minuscules, chiffres, tirets, ex: open-spa-2026) ?',name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''));if(!slugIn)return;
  const coefS=prompt('Coefficient global (1 = championnat, 0.5 = open par défaut) ?',kind==='open'?'0.5':'1');
  const scaleS=prompt('Barème (points de la 1re à la 28e place, séparés par des virgules) ?','41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1');
  const scale=scaleS.split(',').map(x=>+x.trim()).filter(x=>Number.isFinite(x)&&x>=0);
  const long2=confirm('Les courses d\'1 heure (une seule course par manche) donnent-elles le double de points ? OK=oui');
  const joker=+prompt('Nombre de meilleures manches retenues pour le Joker (0 = toutes les manches) ?','5')||0;
  const cfg={pointsScale:scale,polePoints:1,doubleLongRaces:long2,longRaceMinutes:60,minPercentDistance:0.75,jokerCount:joker,globalCoef:+coefS||1};
  const r=await apiPost('/api/events',{slug:slugIn,name,kind,pointsConfig:cfg});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)return alert('Erreur : '+(j.error||r.status));
  // Reload events list
  const lst=await apiGet('/api/events');const lj=await lst.json().catch(()=>({}));events=Array.isArray(lj.events)?lj.events:events;
  await switchEvent(slugIn);
  alert('Événement créé. Tu peux maintenant importer ses JSON.');
}
async function deleteCurrentEvent(){
  if(!backendMulti||!currentSlug)return;
  if(!confirm(`Supprimer DÉFINITIVEMENT "${eventContext.name}" du serveur ? Cette action est irréversible.`))return;
  const r=await fetch('/api/events/'+encodeURIComponent(currentSlug),{method:'DELETE',headers:adminToken?{Authorization:'Bearer '+adminToken}:{}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)return alert('Erreur : '+(j.error||r.status));
  events=events.filter(e=>e.slug!==currentSlug);
  goHome();
}

function admin(){
  if(!adminAuth){return `${head('administration','Direction de course','Accès direction de course.')}<div class="panel"><h2>Connexion direction de course</h2><p class="note">Identifiant/mot de passe configurés sur le backend. Les classements restent consultables librement.</p><div style="display:flex;gap:10px;align-items:center;max-width:520px;flex-wrap:wrap"><input id="adminuser" type="text" placeholder="Identifiant" value="gdspadmin" class="admin-input"><input id="adminpass" type="password" placeholder="Mot de passe" style="flex:1;min-width:200px" class="admin-input"><button class="btn" onclick="adminLogin()">Entrer</button></div></div>`}
  const rs=rounds();
  const adjList=Object.entries(penMap).map(([k,v])=>{const [rj,sj,did]=k.split(':');const ri=+rj,si=+sj,r=rs[ri],s=r&&r.sessions[si];const drv=s&&s.results.find(x=>x.id===did);const raceCount=r?r.sessions.slice(0,si+1).filter(x=>x.type==='RACE').length:0;let label='';if(v.dq)label='DQ';else if(typeof v.timeAdd==='number'&&v.timeAdd!==0)label=(v.timeAdd>0?'+':'')+v.timeAdd+' s';else if(v.warning)label='Avertissement';return `<tr><td>${r?'M'+r.number:'—'}</td><td>${s?(s.type==='QUALIFY'?'Qualif':'Course '+raceCount):'—'}</td><td>${esc(drv?drv.name:'(pilote)')}</td><td>${label}</td><td>${esc(v.note||'')}</td><td><button class="btn secondary small" onclick="removeAdjustment('${k}')">Retirer</button></td></tr>`});
  const roundCards=rs.map((r,i)=>`<div class="admin-round"><b>Manche ${r.number} · ${esc(track(r.track))}</b><div class="muted">${date(r.date)} · ${r.sessions.length-1} course(s)</div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn secondary small" onclick="openAdj(${i})">Pénalités</button><button class="btn secondary small" onclick="resetRound(${i})">Effacer</button></div></div>`).join('');
  const multiAdmin = backendMulti?`
    <div class="panel" style="margin-top:16px"><h2>Gestion des championnats & opens</h2><p class="note">Crée un nouveau championnat ou open (week-end). Chaque événement possède son propre barème, son propre calendrier et ses propres résultats.</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" onclick="createEventPrompt()">+ Créer un événement (championnat/open/archive)</button>${currentSlug?`<button class="btn secondary" onclick="deleteCurrentEvent()">Supprimer l'événement courant</button>`:''}</div></div>`:'';
  if(backendMulti&&!eventContext&&adminTab==='import'){
    // Empêcher l'import si aucun événement sélectionné
    return `${head('administration','Direction de course','')}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px"><span class="tag">Connecté : ${esc(adminUser)}</span><button class="btn secondary small" onclick="adminLogout()">Déconnexion</button></div><div class="panel"><h2>Sélectionne d'abord un événement</h2><p class="note">Choisis un championnat/open dans le menu en haut à droite, ou retourne à l'accueil et clique sur une vignette, avant d'importer des résultats.</p><button class="btn secondary" onclick="goHome()">← Retour à l'accueil</button></div>${multiAdmin}`;
  }
  return `${head('administration','Direction de course','Gestion des imports, pénalités, calendrier et sauvegarde.')}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px"><span class="tag">Connecté : ${esc(adminUser)}</span><button class="btn secondary small" onclick="adminLogout()">Déconnexion</button></div><div class="tabs">${[['import','Imports'],['rounds','Manches'],['adjust','Commission'],['drivers','Pilotes'],['data','Données']].concat(backendMulti?[['ah','Serveurs AH']]:[]).map(([id,l])=>`<button class="${adminTab===id?'active':''}" onclick="adminTabs('${id}')">${l}</button>`).join('')}</div><div class="panel">${adminTab==='import'?`<h2>Importer des résultats</h2><p class="note">Import direct depuis les deux serveurs AssettoHosting GDSP (fr2 / fr5) : <b>PRACTICE ignorés</b>, sessions dont le nom contient « test » ignorées, doublons détectés automatiquement.</p><div style="margin:12px 0"><button class="btn" onclick="ahImport()">📥 Importer automatiquement les nouveaux résultats</button></div><div id="ah-result"></div><div class="grid" style="margin-top:16px"><div class="panel"><h3>Importer un fichier JSON</h3><p class="note">Import manuel si besoin (un ou plusieurs).</p><input type="file" accept=".json" onchange="handleImport(event)"><br><input type="file" accept=".json" multiple onchange="bulkImport(event)" style="margin-top:8px"></div><div class="panel"><h3>Règles de filtrage automatique</h3><ul class="note"><li>QUALIFY et RACE importés.</li><li>PRACTICE systématiquement ignorés.</li><li>Toute session dont le nom (serveur/piste) contient « test » est ignorée.</li><li>Une session déjà importée (même date/heure et type) n'est pas réimportée.</li></ul></div></div>${currentSlug?`<p class="note" style="margin-top:12px">Ces résultats iront dans <b>${esc(eventContext.name)}</b>.</p>`:''}`:adminTab==='rounds'?`<h2>Calendrier et manches</h2><p class="note">${rs.length} manches chargées.</p><div class="grid admin-grid">${roundCards}<div class="admin-round dashed"><button class="btn secondary" onclick="addRound()">+ Ajouter une manche au calendrier</button></div></div>`:adminTab==='adjust'?`<h2>Commission</h2><p class="note">Pénalités temps (positives ou négatives pour annuler une pénalité serveur abusive), DQ ou avertissements. Les pénalités temps reclashent automatiquement.</p>${selectedRaceAdj!==null?renderAdjPanel(rs[selectedRaceAdj]):`<p class="note">Choisis une manche depuis « Manches ».</p>`}${table(['Manche','Session','Pilote','Ajustement','Note',''],adjList)}`:adminTab==='drivers'?`<h2>Pilotes et équipes</h2><div class="driver-admin-list">${allDrivers().map(d=>`<div class="driver-admin-row"><span>${number(d.name)} <b>${esc(d.name)}</b> <span class="muted">${esc(d.team)}</span></span><button class="btn secondary small" onclick="editDriver('${d.id}')">Modifier</button></div>`).join('')}</div>`:adminTab==='ah'?`<h2>Découverte automatique depuis AssettoHosting</h2><p class="note">Scanne les deux serveurs GDSP (fr2:50648 et fr5:50145), récupère la liste des championnats/opens avec leur barème. Les PRACTICE et événements « test » sont filtrés. Clique sur « Créer » pour ajouter un événement dans le portail avec son barème, puis va sur l'onglet Imports de cet événement pour importer ses sessions.</p><div style="margin:12px 0"><button class="btn" onclick="ahScanChamps()">🔍 Scanner les serveurs AH</button></div><div id="ah-champs-result"><p class="note">Clique sur « Scanner » pour commencer.</p></div>`:`<h2>Données et sauvegarde</h2><p class="note">Les modifications sont sauvegardées en PostgreSQL (Render/Neon).</p><div id="save-status" class="note" style="margin:8px 0"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" onclick="exportData()">Exporter</button><button class="btn" onclick="doSaveRemote()">Enregistrer sur le serveur</button><button class="btn secondary" onclick="if(confirm('Recharger la dernière sauvegarde serveur ?')){(backendMulti&&currentSlug?loadEvent(currentSlug):loadRemoteLegacy()).then(()=>render())}">Recharger depuis le serveur</button><button class="btn secondary" onclick="resetChampionship()">Vider cet événement</button></div><p class="note" style="margin-top:12px">${currentSlug?`Événement courant : <b>${esc(eventContext.name)}</b> · `:''}Sessions chargées : ${sessions.length}.</p>`}</div>${multiAdmin}`;
}
function renderAdjPanel(r){let html=`<div class="controls"><select onchange="selectedRaceAdj=null;render()">${rounds().map((x,i)=>`<option value="${i}" ${i===rounds().indexOf(r)?'selected':''}>Manche ${x.number} · ${esc(track(x.track))}</option>`).join('')}</select></div><p class="note">Sélectionne un pilote.</p><div class="grid">`;r.sessions.forEach((s,sj)=>{if(s.type!=='RACE')return;html+=`<div class="panel"><h3>Course ${r.sessions.slice(0,sj+1).filter(x=>x.type==='RACE').length}</h3>${table(['Pos.','Pilote','Ajuster'],s.results.map((p,i)=>`<tr><td class="pos">${i+1}</td><td>${esc(p.name)}</td><td><button class="btn secondary small" onclick="openAdjForm(${r.number-1},${sj},'${p.id}')">Modifier</button></td></tr>`))}</div>`});return html+'</div>'}
function openAdj(roundIdx){selectedRaceAdj=roundIdx;adminTab='adjust';render()}
function openAdjForm(rj,sj,did){const ta=prompt('Ajustement temps en secondes (+10 / -10 pour annuler une pénalité serveur) ?','0');if(ta===null)return;const timeAdd=+ta||0;const dq=confirm('DQ (drapeau noir) ?');const warning=!dq&&confirm('Avertissement sans sanction ?');const note=prompt('Note / motif ?','')||'';addAdjustment(rj,sj,did,timeAdd,dq,warning,note)}

// ---------- AssettoHosting auto-import ----------
// ---------- AH championship discovery ----------
let ahChampsCache=null;
async function ahScanChamps(){
  const out=document.getElementById('ah-champs-result');
  if(out)out.innerHTML='<p class="note">Scan des serveurs AssettoHosting en cours…</p>';
  try{
    const r=await apiGet('/api/ah-championships');
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'HTTP '+r.status);
    ahChampsCache=j.items||[];
    renderAhChamps();
  }catch(e){if(out)out.innerHTML=`<p class="note" style="color:#9c3021">✗ ${esc(e.message)}</p>`}
}
function renderAhChamps(){
  const out=document.getElementById('ah-champs-result');if(!out||!ahChampsCache)return;
  if(!ahChampsCache.length){out.innerHTML='<p class="note">Aucun championnat trouvé.</p>';return}
  const existing=new Set(events.map(e=>e.slug));
  const rows=ahChampsCache.map(c=>{
    const exists=events.some(e=>e.slug===c.slug);
    const tag=c.kind==='open'?'<span class="tag open">OPEN</span>':'<span class="tag live">CHAMPIONNAT</span>';
    return `<tr>
      <td>${tag}</td>
      <td><b>${esc(c.name)}</b><br><span class="muted">${c.server.replace('https://','')}</span></td>
      <td>${c.progress.toFixed(0)}%</td>
      <td>${c.numEvents}</td>
      <td>${c.pointsScale.slice(0,5).join('/')}${c.pointsScale.length>5?'…':''}</td>
      <td>${exists?'<span class="tag archive">déjà présent</span>':`<button class="btn secondary small" onclick="ahCreateEvent('${c.server}','${c.uuid}','${c.slug}')">+ Créer</button>`}</td>
    </tr>`;
  }).join('');
  out.innerHTML=`<p class="note">${ahChampsCache.length} championnats/opens détectés. Les championnats de type « test » et doublons ont été filtrés. Clique sur « Créer » pour ajouter un événement dans le portail avec son barème.</p>${table(['','Nom','Progression','Manches','Barème (places)',''],rows)}`;
}
async function ahCreateEvent(server,uuid,slug){
  try{
    // 1. Créer l'event via le backend en récupérant le barème depuis le cache
    const c=ahChampsCache.find(x=>x.uuid===uuid);if(!c)return;
    const cfg={
      pointsScale:c.pointsScale,
      polePoints:c.polePoints,
      bestLapPoints:c.bestLapPoints,
      mostLapsLed:c.mostLapsLedPoints,
      doubleLongRaces:false,
      longRaceMinutes:60,
      minPercentDistance:(c.minDistancePct/100)||0.75,
      jokerCount:c.ignoreWorst>0?c.numEvents-c.ignoreWorst:c.numEvents,
      globalCoef:c.kind==='open'?0.5:1.0,
      secondRaceMultiplier:c.secondRaceMultiplier||1
    };
    const r=await apiPost('/api/events',{slug:c.slug,name:c.name,kind:c.kind,pointsConfig:cfg});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||'HTTP '+r.status);
    // Recharger events
    const lr=await apiGet('/api/events');const lj=await lr.json();events=Array.isArray(lj.events)?lj.events:events;
    alert('Événement créé : '+c.name+'. Tu peux maintenant le sélectionner dans le menu et y importer ses résultats (📥 Auto-import ou Import AH sessions à venir).');
    await switchEvent(c.slug);
    render();
  }catch(e){alert('Erreur : '+e.message)}
}

async function ahImport(){
  const out=document.getElementById('ah-result');
  if(out){out.innerHTML='<p class="note">Scan des serveurs AssettoHosting en cours…</p>'}
  try{
    const r=await apiGet('/api/ah-scan');
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    let items=j.items||[];
    // Filtres:
    // 1) Enlever PRACTICE
    items=items.filter(x=>x.type!=='PRACTICE');
    // 2) Enlever celles qui contiennent "test" dans le nom/serveur/url (insensible à la casse)
    const isTest=x=>/test/i.test((x.sessionName||'')+' '+(x.filename||'')+' '+(x.server||''));
    items=items.filter(x=>!isTest(x));
    // 3) Enlever celles déjà importées (même date+type)
    const existing=new Set(sessions.map(s=>`${new Date(s.date).toISOString().slice(0,16)}|${s.type}`));
    const pending=items.filter(x=>{
      const key=new Date(x.date).toISOString().slice(0,16)+'|'+x.type;
      return !existing.has(key);
    });
    if(!pending.length){
      if(out)out.innerHTML=`<p class="note">✅ Aucune nouvelle session QUALIFY/RACE à importer (${items.length} déjà connues, practice ignorées).</p>`;
      return;
    }
    if(out)out.innerHTML=`<p class="note">Récupération de ${pending.length} session(s) en cours…</p>`;
    let ok=0,err=0,details=[];
    for(const it of pending){
      try{
        const fr=await apiGet('/api/ah-fetch?url='+encodeURIComponent(it.url));
        if(!fr.ok)throw new Error('HTTP '+fr.status);
        const txt=await fr.text();
        // Reimport dans notre parser
        if(importSessionJson(txt,it.filename,{silent:true})){ok++;details.push(`+ ${it.type} ${it.filename}`)}
        else{err++;details.push(`✗ erreur parsing ${it.filename}`)}
      }catch(e){err++;details.push(`✗ ${it.filename}: ${e.message}`)}
    }
    if(ok>0)saveState();
    render();
    if(out)out.innerHTML=`<p class="note"><b>Import terminé :</b> ${ok} session(s) importée(s), ${err} erreur(s).</p><ul class="note" style="font-family:monospace;font-size:11px">${details.map(d=>'<li>'+esc(d)+'</li>').join('')}</ul>`;
  }catch(e){if(out)out.innerHTML=`<p class="note" style="color:#9c3021">✗ Erreur : ${esc(e.message)}</p>`}
}

// Patch importSessionJson to support silent mode
const _origImport=importSessionJson;
importSessionJson=function(text,fileName,opts){
  opts=opts||{};
  try{let j=JSON.parse(text);
    function driverFrom(obj){const drv=obj.Driver||obj.driver||{};const guid=drv.Guid||obj.DriverGuid||obj.Guid||'';const name=clean(drv.Name||obj.DriverName||'').trim();return {id:pseudonymizeGuid(guid||name+'|'+obj.CarId),name,team:clean(drv.Team||obj.Team||'')||'',skin:clean(obj.Skin||name||''),model:obj.Model||obj.CarModel}}
    function clean(v){return String(v||'').replace(/7656119\d{10}/g,m=>pseudonymizeGuid(m))}
    // Filtrer les sessions "test" par le nom du championnat/track si jamais ça passe (sécurité)
    const serverName=(j.ServerName||j.Name||''), track=(j.TrackName||'');
    if(/test/i.test(serverName+' '+track)){if(!opts.silent)alert('Session ignorée (nom contient "test").');return false}
    if(j.Type==='PRACTICE'){if(!opts.silent)alert('Les sessions PRACTICE ne sont pas importées.');return false}
    const cars={};(j.Cars||[]).forEach(c=>cars[c.CarId]=driverFrom(c));
    const results=(j.Result||[]).map(r=>{const meta=cars[r.CarId]||driverFrom(r);return {id:meta.id,name:meta.name,team:meta.team||'',skin:meta.skin||'',grid:r.GridPosition,laps:r.NumLaps||0,best:r.BestLap,time:r.TotalTime,disqualified:!!r.Disqualified,hasPenalty:!!r.HasPenalty,penaltyTime:r.PenaltyTime||0,lapPenalty:r.LapPenalty||0}}).filter(r=>!(r.model==='dodge_monaco_police'||/broadcast/i.test(r.name)));
    const laps=(j.Laps||[]).map(l=>{const meta=cars[l.CarId];if(!meta)return null;return {id:meta.id,time:l.LapTime,cuts:l.Cuts||0,timestamp:l.Timestamp}}).filter(Boolean);
    const events=(j.Events||[]).filter(e=>e.Type==='COLLISION_WITH_CAR'&&j.Type==='RACE').map(e=>{const a=cars[e.CarId],b=cars[e.OtherCarId];if(!a||!b)return null;return {a:a.name,b:b.name,aid:a.id,bid:b.id,speed:e.ImpactSpeed,timestamp:e.Timestamp}}).filter(Boolean);
    let raceStart=null;
    if(j.Type==='RACE'){const c=[];laps.forEach(l=>{if(typeof l.timestamp==='number'&&typeof l.time==='number'&&40000<l.time<600000)c.push(l.timestamp-l.time/1000)});if(c.length)raceStart=Math.min(...c)}
    const sess={date:j.Date,track:j.TrackName,type:j.Type,results,laps,events,raceStart};
    const idx=sessions.findIndex(x=>x.date===j.Date&&x.type===j.Type);
    if(idx>=0)sessions[idx]=sess;else sessions.push(sess);
    sessions.sort((a,b)=>a.date.localeCompare(b.date));
    if(!opts.silent){saveState();alert(`Import réussi : ${j.Type} du ${j.Date}.`);render()}
    return true;
  }catch(err){if(!opts.silent)alert('Erreur d\'import : '+err.message);return false}
};

function importSessionJson(text,fileName,opts){return importSessionJson(text,fileName,opts)}

// ---------- RENDER ----------
function render(){
  nav();
  if(page==='hub'&&backendMulti){app.innerHTML=hub();return}
  if(page==='global'&&backendMulti){app.innerHTML=globalRankingSync();return}
  const renderers={accueil:home,classement:ranking,manches:manche,pilotes:drivers,admin};
  app.innerHTML=(renderers[page]||home)();
}

// ---------- BOOTSTRAP ----------
(async()=>{
  // Migrate legacy penMap local storage
  let penMapRaw=JSON.parse(localStorage.getItem('gdsp_penalties')||'{}');
  for(const k in penMapRaw){if('pts' in penMapRaw[k]&&!('timeAdd' in penMapRaw[k])&&!('warning' in penMapRaw[k]))delete penMapRaw[k]}
  penMap=penMapRaw;
  manualDrivers=JSON.parse(localStorage.getItem('gdsp_drivers')||'null');
  customCalendar=JSON.parse(localStorage.getItem('gdsp_calendar')||'null');
  let storedSessions=JSON.parse(localStorage.getItem('gdsp_sessions')||'null');
  if(storedSessions&&Array.isArray(storedSessions)&&storedSessions.length)sessions=storedSessions;

  await detectBackend();

  if(backendMulti){
    // Multi mode
    try{
      const lr=await apiGet('/api/events');
      if(lr.ok){const j=await lr.json();events=Array.isArray(j.events)?j.events:[]}
    }catch(e){}
    if(events.length===1){
      // Un seul événement: on y entre directement (pas de hub vide)
      await loadEvent(events[0].slug);
      page='accueil';
    }else if(events.length>1){
      // Plusieurs événements: afficher le hub
      // Auto-load default Lola if present and no last-event stored
      const last=localStorage.getItem('gdsp_last_event');
      if(last&&events.find(e=>e.slug===last)){await loadEvent(last);page='accueil'}
      else page='hub';
    }else{
      page='hub';
    }
  }else{
    // Legacy mode: same behaviour as before
    page='accueil';
    const isReset=localStorage.getItem('gdsp_reset')==='1';
    try{
      if(isReset){
        sessions.length=0;
        try{const remote=await loadRemoteLegacy();const cs=remote&&remote.championship&&remote.championship.sessions;if(Array.isArray(cs)&&cs.length)localStorage.removeItem('gdsp_reset')}catch(e){}
      }else{
        if(!sessions.length){try{const r=await fetch('data/data.json',{cache:'no-store'});if(r.ok){const base=await r.json();if(Array.isArray(base)&&base.length)sessions.push(...base)}}catch(e){}}
        try{
          const remote=await loadRemoteLegacy();
          if(remote){
            const cs=(remote.championship&&remote.championship.sessions)||null;
            if(Array.isArray(cs)){
              if(cs.length===0){sessions.length=0;penMap={};manualDrivers=null;customCalendar=null;localStorage.setItem('gdsp_reset','1')}
              else{sessions.length=0;sessions.push(...cs);localStorage.setItem('gdsp_reset','')}
            }
          }
        }catch(e){console.warn('serveur indisponible',e)}
        if(manualDrivers)sessions.forEach(s=>s.results.forEach(r=>{if(manualDrivers[r.id]){r.name=manualDrivers[r.id].name;r.team=manualDrivers[r.id].team||''}}));
      }
      if(adminToken){try{const r=await apiGet('/health');if(!r.ok)throw new Error('bad health');adminAuth=true;adminUser='Direction de course'}catch(e){adminToken=null;localStorage.removeItem('gdsp_admin_token')}}
    }catch(e){app.innerHTML='Erreur de rendu : '+e.message}
  }
  render();
})();

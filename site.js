/* GDSP front — multi-championnat avec rétrocompatibilité backend legacy.
 * Si le backend expose /api/events → mode multi avec hub et sélecteur d'événement.
 * Sinon (backend actuel en ligne) → mode legacy, exactement comme avant. */

// ---------- Global state ----------
const LEGACY_DEFAULT_SLUG = 'lola-t290-2026';
const ACTIVE_LOLA_SLUG = 'lola-t290-gdsp-championnat-2026';
const GLOBAL_MIN_RACES = 5;           // nombre minimum de courses pour être classé au Global
let globalHidden = {};                // id -> true : pilote exclu du classement global par l'admin
let deletedEventSlugs = {};           // slug -> true : événements supprimés par l'admin
let backendError = '';
let backendMulti = null;          // null=pending, true=multi, false=legacy
let events = [];                  // liste des événements (multi seulement)
let currentSlug = null;
let eventContext = null;          // {slug,name,kind,pointsConfig,data}
let ahConfig = null;              // {server, uuid} when event is bound to an AH championship
let page='accueil', ranktab='pilotes', eventtab='resultats', round=0, sessionIndex=1, driverId='', globalDriverId='', compareA='', compareB='';
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
function shouldDropWorstJoker(){
  const slug=eventContext&&eventContext.slug;
  return slug==='lola-t290-gdsp-championnat-2026'||slug==='lola-t290-2026';
}
function jokerTotal(roundScores){
  const scores=Array.isArray(roundScores)?roundScores.filter(Number.isFinite):[];
  const configured=Number(pointsConfig().jokerCount)||0;
  const keep=shouldDropWorstJoker()
    ?(scores.length>1?scores.length-1:scores.length)
    :(configured>0?Math.min(configured,scores.length):scores.length);
  return [...scores].sort((a,b)=>b-a).slice(0,keep).reduce((sum,n)=>sum+n,0);
}
function jokerTabLabel(){
  if(shouldDropWorstJoker())return 'Pilotes · Joker';
  const count=Number(pointsConfig().jokerCount)||0;
  return `Pilotes · ${count||'toutes'} meilleures manches`;
}
function jokerDescription(){
  if(shouldDropWorstJoker())return 'Le plus faible total de manche est écarté du cumul Joker dès que deux manches sont disponibles ; toutes les manches restent affichées.';
  const count=Number(pointsConfig().jokerCount)||0;
  return count?`Les ${count} meilleurs totaux de manche sont conservés.`:'Toutes les manches sont conservées.';
}

// ---------- Helpers génériques ----------
const labelsLegacy={accueil:'Accueil',classement:'Classements',manches:'Résultats',pilotes:'Pilotes',admin:'Administration'};
const labelsHub={accueil:'Accueil',global:'Global',classement:'Classements',manches:'Résultats',pilotes:'Pilotes',admin:'Administration'};
function pageKey(){
  if(!backendMulti)return page;
  // 'accueil' et 'hub' désignent tous les deux la page d'accueil du championnat courant
  if(page==='accueil'||page==='hub')return 'accueil';
  return page;
}
function labels(){return backendMulti?labelsHub:labelsLegacy}
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=x=>new Date(x).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
function signed(x){return x===null||x===undefined||!isFinite(x)?'—':`${x>0?'+':''}${Number(x).toFixed(1)}`}
function track(x){return ({'mt-tremblant_69':'Mont-Tremblant','riverside':'Riverside','sebring_90s':'Sebring','mid_ohio':'Mid-Ohio'})[x]||x}
// Level badge images (circular pin style, one car per GDSP championship/open)
const LVL_BADGES={1:'/assets/lvl1-elite.png',2:'/assets/lvl2-confirme.png',3:'/assets/lvl3-inter.png',4:'/assets/lvl4-debut.png'};
function levelBadge(level,size){const src=LVL_BADGES[level];return src?`<img class="lvl-badge" src="${src}?v=26" alt="Niveau ${level}" width="${size}" height="${size}" loading="lazy" style="width:${size}px;height:${size}px;border-radius:50%;display:inline-block;vertical-align:middle">`:`<span class="tag lvl lvl-${level}">${level}</span>`}
const PROFILE_TIPS={
  regularite:`<b>Régularité (Race Consistency)</b><br>Écart moyen entre chaque tour et le <b>meilleur tour</b> du pilote sur la course (en secondes).<br>Le 1<sup>er</sup> tour et les tours aux stands / lents (&gt; 21 s plus lent que le meilleur tour) sont exclus.<br>Plus l'écart moyen est petit, plus le score est élevé.<br><i>Méthode iRacing — best minus average non-best.</i>`,
  regulariteGlobal:`<b>Rythme (Race Consistency)</b><br>Écart moyen entre chaque tour et le <b>meilleur tour</b> du pilote sur chaque course (1<sup>er</sup> tour et tours &gt; +21 s exclus), moyenné par week-end et comparé au plateau.<br>Plus l'écart moyen est petit, plus le score est élevé.<br>Pondération récente : demi-vie 90 jours.`,
  proprete:`<b>Propreté</b><br>Pénalités attribuées selon les contacts en course qui font <b>perdre du temps</b> à l'adversaire :<br>• Touchette sans conséquence (&lt; 1,5 s de perte pour l'autre) → 0<br>• Choc latéral / côte à côte (|Z| ≥ 1,0 m, bagarre) → 0 pour les deux<br>• Choc arrière clair (|X| ≥ 0,4 m, |Z| &lt; 1,0 m) → secondes perdues par la victime / 2, au pilote responsable<br>• Cuts de piste : +1 point par cut<br>100 = aucun contact responsable ni cut.`,
  vitesse:`<b>Vitesse au tour</b><br>Basé sur le <b>meilleur tour du week-end</b> (meilleur temps entre <b>Q</b>ualification et toutes les courses <b>R</b> de la manche).<br>Le badge <b>Q</b> ou <b>R</b> dans l'encadré Analyse du rythme indique où ce meilleur temps a été réalisé.<br>100 = pilote le plus rapide du plateau sur le week-end.`,
  resultats:`<b>Résultats</b><br>Basé sur la position finale après pénalités Commission :<br>• 1 pilote → 50 · 2 pilotes : 55 / 45<br>• Entre 2 et 28 pilotes : l'écart entre le 1<sup>er</sup> et le dernier augmente linéairement de 10 à 100 pts (milieu = 50)<br>• 28+ pilotes : 100 au vainqueur, 0 au dernier (linéaire)<br>• DNF / DNS / DQ → <b>0</b>.<br>Arrondi à 1 décimale.`,
  progression:`<b>Progression</b><br>Pente de régression linéaire du classement par week-end en fonction du temps, toutes compétitions confondues.<br>100 = plus forte amélioration ; 0 = plus forte régression.<br>Moins de 3 week-ends → 50 (neutre).`,
  scoreEvent:`<b>Score &amp; Niveau événement</b><br>Moyenne sur 100 des quatre critères (Régularité, Propreté, Vitesse au tour, Résultats) calculés par week-end sur cet événement.<br>Répartition en 4 niveaux par quartiles (Niveau 4 = top 25 % sur l'événement). Minimum 2 manches exploitables.`,
  niveauGlobal:`<b>Niveau GLOBAL Discord</b><br>Niveau selon le score GLOBAL arrondi : 0–40 Débutant · 41–60 Intermédiaire · 61–80 Confirmé · 81–100 Élite. Score établi sur la moyenne des 4 critères par week-end sur tous les championnats et opens.<br>Pondération récente (demi-vie 90 jours) · minimum 5 courses.`,
  courses:`<b>Courses disputées</b><br>Nombre de sessions de course (RACE) enregistrées pour ce pilote.`,
  bestPos:`<b>Meilleur résultat</b><br>Meilleure position obtenue à l'arrivée d'une course (après pénalités Commission).`,
  avgPos:`<b>Position moyenne</b><br>Moyenne des positions d'arrivée sur l'ensemble des courses disputées.`,
  delta:`<b>Places gagnées / course (Δ)</b><br>Écart entre la position sur la grille de départ et la position finale à l'arrivée (Grille − Arrivée).<br>Positif = places gagnées en course ; négatif = places perdues.`,
  collisions:`<b>Collisions</b><br>Contacts voiture-contre-voiture enregistrés par le serveur Assetto Corsa durant la course (donnée brute serveur).`,
  sigma:`<b>Δ rythme (Race Consistency)</b><br>Écart moyen au meilleur tour du pilote sur la course (en secondes), en excluant le 1<sup>er</sup> tour et les tours aux stands / lents (&gt; +21 s).<br>Plus cette valeur est petite, plus le rythme du pilote a été régulier.`,
  meilleurWE:`<b>Meilleur tour du week-end</b><br>Meilleur chrono absolu signé par le pilote sur la manche, entre la Qualification (badge vert <b>Q</b>) et les Courses (badge rouge <b>R</b>).`,
  pitExclu:`<b>Tours exclus (Pit / lents)</b><br>Nombre de tours écartés du calcul de régularité au-delà du 1<sup>er</sup> tour : passages aux stands ou grosses sorties (&gt; 21 s plus lent que le meilleur tour).`,
  quatreCriteres:`<b>4 critères (0–100)</b><br>De gauche à droite : <b>Rythme</b>, <b>Propreté</b>, <b>Vitesse</b> et <b>Résultats</b>.<br>Survole chaque mini-barre pour voir le détail du critère.`
};
function gdspTip(html,mod=''){return `<span class="gdsp-tip${mod?' '+mod:''}"><i class="gdsp-i">?</i><span class="gdsp-bubble">${html}</span></span>`}

function isEventPage(p){return p==='event'||p==='classement'||p==='manches'||p==='pilotes'||p==='circuit'}
function nav(){
  const activeTop=(page==='gpilote'||page==='global')?'global'
    :(page==='hub'||page==='accueil')?'accueil'
    :isEventPage(page)?'event'
    :page;
  const evObj=(eventContext&&eventContext.name?eventContext:null)
    ||events.find(e=>e.slug===currentSlug)
    ||events.find(e=>e.kind==='championship')
    ||events[0];
  const evTabName=(evObj&&evObj.name)?evObj.name:'International Series Lola T290';
  document.getElementById('nav').innerHTML=
    `<button class="${activeTop==='accueil'?'active':''}" onclick="go('accueil')">ACCUEIL</button>`
    +(backendMulti?`<button class="${activeTop==='global'?'active':''}" onclick="go('global')">GLOBAL</button>`:'')
    +`<button class="nav-event-tab ${activeTop==='event'?'active':''}" onclick="go('event')"><span class="nav-ev-kicker">Événement</span><span class="nav-ev-title">${esc(navEventTitle(evTabName))}</span></button>`
    +(hasLiveTiming?`<a class="nav-link nav-live" href="/live-timing" title="Suivi en direct d'un serveur Assetto Corsa"><span class="nav-live-dot"></span>LIVE</a>`:'')
    +`<button class="${activeTop==='admin'?'active':''}" onclick="go('admin')">ADMINISTRATION</button>`;
  renderEventSwitcher();
}
// Onglet LIVE : visible seulement si le serveur expose le live timing
// (/api/live/config répond). Sinon on n'encombre pas la navigation.
let hasLiveTiming=null;
async function detectLiveTiming(){
  if(hasLiveTiming!==null)return hasLiveTiming;
  try{
    // Certains hébergements statiques répondent 200 avec le HTML du site sur
    // toute URL : on n'accepte qu'une vraie réponse JSON.
    const r=await fetch('/api/live/config',{cache:'no-store',headers:{Accept:'application/json'}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const type=String(r.headers.get('content-type')||'');
    if(!/json/i.test(type))throw new Error('pas du JSON');
    const j=await r.json();
    hasLiveTiming=!!j&&j.enabled!==false;
  }catch(e){hasLiveTiming=false}
  return hasLiveTiming;
}
async function go(x){
  // Pré-charger un événement par défaut si on va sur une page événementielle (event/classement/manches/pilotes)
  // sans avoir d'eventContext (ex: on arrive sur un lien profond, ou on clique sur l'onglet Événement depuis le hub).
  const eventPages=['event','classement','manches','pilotes','circuit'];
  if(backendMulti && eventPages.includes(x) && !eventContext){
    const last=localStorage.getItem('gdsp_last_event');
    const target=events.find(e=>e.slug===last)||events.find(e=>e.kind==='championship')||events[0];
    if(target){
      app.innerHTML=`<div class="panel"><p class="note">Chargement du championnat…</p></div>`;
      nav();
      try{await loadEvent(target.slug)}catch(e){}
    }
  }
  if(x==='event'||x==='classement'||x==='manches'||x==='circuit')driverId='';
  page=x;window.scrollTo(0,0);
  // 'accueil' et 'hub' = la VRAIE page d'accueil GDSP (hero 65/35, Règlements, Stats, Discord) en mode multi
  if((x==='accueil'||x==='hub')&&backendMulti){page='hub';if(window.history&&window.location)window.history.pushState({},'', '/');render();return}
  if((x==='global'||x==='gpilote')&&backendMulti){
    app.innerHTML=`<div class="panel"><p class="note">Chargement des données de tous les événements…</p></div>`;
    nav();
    try{await globalRanking();render()}
    catch(e){
      console.error('go global error:',e);
      app.innerHTML=`<div class="panel"><p class="note" style="color:#9c3021">✗ Erreur de chargement : ${esc(e.message||e)}</p></div>`;
    }
    return;
  }
  render();
}
// Retour à la page d'accueil GDSP (appelé par le logo GDSP et le bouton Accueil)
function goHome(){go('accueil')}
function setEventSubTab(tab){
  if(!isEventPage(tab))return;
  // L'onglet Circuit est ouvert à tous les événements, mais reste masqué
  // tant qu'aucune manche n'existe (voir hasCircuitData).
  if(tab==='circuit'&&!hasCircuitData())return;
  if(tab!=='pilotes')driverId='';
  page=tab;
  render();
  if(tab==='circuit')syncCircuitHistory();
  else if(window.history&&window.location&&/\/circuit\/?$/.test(window.location.pathname)){
    const slug=(eventContext&&eventContext.slug)||currentSlug;
    if(slug)window.history.pushState({},'','/evenements/'+encodeURIComponent(slug));
  }
}
function openEventRoundResult(rIdx){
  const rs=rounds();
  round=(rIdx>=0&&rIdx<rs.length)?rIdx:0;
  sessionIndex=(rs[round]&&rs[round].sessions.length>1)?1:0;
  eventtab='resultats';
  driverId='';
  page='manches';
  render();
  window.scrollTo(0,0);
}
function openEventDriver(did){
  if(!did)return;
  driverId=did;
  page='pilotes';
  render();
  window.scrollTo(0,0);
}

function renderEventSwitcher(){
  const sw=document.getElementById('event-switcher');
  const tr=document.getElementById('topRight');
  if(!backendMulti){sw.innerHTML='';tr.textContent='INTERNATIONAL SERIES · LOLA T290';return}
  if(!events.length){sw.innerHTML='';tr.textContent='GDSP';return}
  // L'événement courant est affiché ; sur la page d'accueil hub → "GENTLEMAN DRIVERS PROJECT"
  const ev=events.find(e=>e.slug===currentSlug);
  if(page==='global'||page==='gpilote'){
    tr.textContent='CLASSEMENT GLOBAL';
  }else if(page==='hub'){
    tr.textContent='GENTLEMAN DRIVERS PROJECT';
  }else{
    const nameOf=x=>x&&typeof x.name==='string'?x.name:'';
    tr.textContent=ev?nameOf(ev).toUpperCase():(events[0]?nameOf(events[0]).toUpperCase():'GDSP');
  }
  // Sélecteur toujours visible pour pouvoir changer d'événement depuis n'importe quelle page
  const champOpts=events.filter(e=>e.kind==='championship');
  const openOpts=events.filter(e=>e.kind==='open');
  const archOpts=events.filter(e=>e.kind==='archive');
  const grp=(label,arr)=>arr.length?`<optgroup label="${label}">${arr.map(e=>`<option value="${esc(e.slug)}" ${e.slug===currentSlug?'selected':''}>${esc(e.name)}</option>`).join('')}</optgroup>`:'';
  // N'afficher le sélecteur que s'il y a plusieurs événements (ou au moins un + archives)
  const totalEvents=champOpts.length+openOpts.length+archOpts.length;
  if(totalEvents<2){sw.innerHTML='';return}
  sw.innerHTML=`<select onchange="switchEvent(this.value)"><option value="">— Changer de championnat/open —</option>${grp('Championnats',champOpts)}${grp('Opens',openOpts)}${grp('Archives',archOpts)}</select>`;
}

async function switchEvent(slug){
  if(!slug){goHome();return} // choix "— Changer…" vide → retour accueil GDSP
  await loadEvent(slug);
  if(window.history&&window.location)window.history.pushState({},'', '/evenements/'+encodeURIComponent(slug));
  page='event'; // ouvrir sur l'onglet Accueil de l'événement sélectionné
  round=0;sessionIndex=1;driverId='';compareA='';compareB='';ranktab='pilotes';
  render();window.scrollTo(0,0);
}

// ---------- API helpers ----------
async function apiGet(path,opts){const r=await fetch(path,Object.assign({cache:'no-store',headers:adminToken?{Authorization:'Bearer '+adminToken}:{}},opts||{}));return r}
async function apiPost(path,body){
  const headers={'Content-Type':'application/json'};
  if(adminToken)headers['Authorization']='Bearer '+adminToken;
  const r=await fetch(path,{method:'POST',headers,body:body?JSON.stringify(body):undefined});
  if(r.status===401){adminToken=null;adminAuth=false;localStorage.removeItem('gdsp_admin_token');sessionStorage.removeItem('gdsp_admin_token');render()}
  return r;
}
async function apiPut(path,body){
  const headers={'Content-Type':'application/json'};
  if(adminToken)headers['Authorization']='Bearer '+adminToken;
  const r=await fetch(path,{method:'PUT',headers,body:body?JSON.stringify(body):undefined});
  if(r.status===401){adminToken=null;adminAuth=false;localStorage.removeItem('gdsp_admin_token');sessionStorage.removeItem('gdsp_admin_token');render()}
  return r;
}

function isEventMarkedDeleted(ev){
  if(!ev||!ev.slug)return true;
  if(ev._deleted||ev.name==='[DELETED]')return true;
  if(ev.points_config&&ev.points_config._deleted)return true;
  if(ev.pointsConfig&&ev.pointsConfig._deleted)return true;
  if(ev.data&&ev.data._deleted)return true;
  if(deletedEventSlugs&&deletedEventSlugs[ev.slug])return true;
  return false;
}
function filterEventsList(rawList){
  const list=Array.isArray(rawList)?rawList:[];
  const hasActiveLola=list.some(e=>e&&e.slug===ACTIVE_LOLA_SLUG&&!isEventMarkedDeleted(e));
  return list.filter(e=>{
    if(isEventMarkedDeleted(e))return false;
    // Masquer le doublon historique auto-recréé par le backend ("International Series Lola T290 — 2026")
    // dès que le vrai championnat Lola T290 existe.
    if(hasActiveLola&&e.slug===LEGACY_DEFAULT_SLUG)return false;
    return true;
  });
}
function loadDeletedEventSlugs(){
  try{deletedEventSlugs=JSON.parse(localStorage.getItem('gdsp_deleted_events')||'{}')||{};}
  catch(e){deletedEventSlugs={};}
}
function markEventSlugDeleted(slug,deleted){
  if(!slug)return;
  if(deleted)deletedEventSlugs[slug]=true;
  else delete deletedEventSlugs[slug];
  try{localStorage.setItem('gdsp_deleted_events',JSON.stringify(deletedEventSlugs));}catch(e){}
}

async function detectBackend(){
  // Legacy mode must be explicitly requested; outages must never change the site.
  if(window.GDSP_LEGACY_MODE===true){backendMulti=false;backendError='';return}
  backendMulti=true;
  backendError='';
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r=await fetch('/api/events',{cache:'no-store'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const j=await r.json();
      if(!Array.isArray(j.events))throw new Error('Réponse événements invalide');
      events=filterEventsList(j.events);
      backendError='';
      return;
    }catch(error){backendError='Le serveur des événements est temporairement indisponible. Les données ne sont pas modifiées.'}
  }
}
async function retryBackend(){
  await detectBackend();
  await detectLiveTiming().catch(()=>{});
  if(!backendError){
    const match=window.location&&window.location.pathname.match(/^\/evenements\/([^/]+)\/?$/);
    const target=match?decodeURIComponent(match[1]):currentSlug;
    if(target){try{await loadEvent(target);if(match)page='event'}catch(error){backendError='Impossible de charger cet événement. Réessayez.'}}
  }
  render();
}

async function loadEvent(slug){
  if(!backendMulti){
    // Legacy: charge /api/championship dans sessions+penMap (comme avant)
    return loadRemoteLegacy();
  }
  if(!slug)return null;
  if(deletedEventSlugs&&deletedEventSlugs[slug])return null;
  if(slug===LEGACY_DEFAULT_SLUG&&events.some(e=>e.slug===ACTIVE_LOLA_SLUG))return null;
  try{
    const r=await apiGet('/api/events/'+encodeURIComponent(slug));
    if(!r.ok)return null;
    const ev=await r.json();
    if(!ev||!ev.slug||!ev.name||isEventMarkedDeleted(ev)){console.warn('loadEvent: event invalide ou supprimé',ev);return null}
    eventContext={slug:ev.slug,name:ev.name,kind:ev.kind||'championship',pointsConfig:ev.points_config||{},data:ev.data||{}};
    currentSlug=ev.slug;
    // Les manches importées vivent dans l'événement : on recharge le calendrier.
    circuitsCache=null;circuitsError='';
    const d=ev.data||{};
    let _ah=(d.ahServer&&d.ahUuid)?{server:d.ahServer,uuid:d.ahUuid}:null;
    if(!_ah){try{const m=JSON.parse(localStorage.getItem('gdsp_ah_map')||'{}');_ah=m[ev.slug]||null}catch(e){}}
    ahConfig=_ah;
    localStorage.setItem('gdsp_last_event',ev.slug);
    sessions.length=0;
    if(Array.isArray(d.sessions))sessions.push(...d.sessions);
    penMap=(d.penMap&&typeof d.penMap==='object')?d.penMap:{};
    manualDrivers=d.manualDrivers||null;
    customCalendar=d.customCalendar||null;
    if(manualDrivers)sessions.forEach(s=>(s.results||[]).forEach(r=>{
      const edit=manualDrivers[r.id];
      if(edit){r.name=edit.name;r.team=edit.team||'';}
    }));
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
function rounds(){
  const byDate=new Map();
  sessions.filter(s=>s&&s.date).forEach(s=>{
    const key=String(s.date).slice(0,10);
    if(!byDate.has(key))byDate.set(key,[]);
    byDate.get(key).push(s);
  });
  const typeOrder={QUALIFY:0,RACE:1,PRACTICE:2};
  return [...byDate.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([d,list],i)=>{
    list.sort((a,b)=>(typeOrder[a.type]??9)-(typeOrder[b.type]??9)||String(a.date||'').localeCompare(String(b.date||'')));
    return{date:d,sessions:list,track:track(list[0].track),number:i+1};
  });
}
function allDrivers(){let map=new Map;for(const s of sessions)for(const r of s.results){if(!map.has(r.id))map.set(r.id,{...r});}return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name))}
function info(){return ''}
function head(k,t,desc=''){
  const prefix = backendMulti && eventContext && eventContext.name ? (eventContext.kind||'').toUpperCase()+' · '+eventContext.name : '';
  const eye = prefix ? prefix : 'GDSP / '+k;
  return `<div class="eyebrow">${esc(eye)}</div><h1>${t}</h1>${desc?`<p class="note">${desc}</p>`:''}`;
}
function table(headers,rows){
  try{
    const hs=Array.isArray(headers)?headers:[];
    let rs=[];
    if(Array.isArray(rows))rs=rows;
    else if(typeof rows==='string')rs=[rows];
    else if(rows)rs=[String(rows)];
    const head=hs.map(x=>`<th>${x==null?'':x}</th>`).join('');
    const body=rs.length?rs.join(''):'<tr><td colspan="8">Aucune donnée disponible.</td></tr>';
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }catch(e){return `<p class="note" style="color:#9c3021">Erreur tableau : ${esc(e.message)}</p>`}
}
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
    return `<a class="event-card" style="display:block;text-decoration:none;color:inherit" href="/evenements/${encodeURIComponent(e.slug)}" onclick="if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();switchEvent('${esc(e.slug)}')">${coef}${tag}<h3>${esc(e.name)}</h3><p class="note">Mis à jour le ${new Date(e.updated_at).toLocaleDateString('fr-FR')}</p><span class="label">Ouvrir →</span></a>`;
  }
  const section=(title,arr)=>arr.length?`<div class="section-head"><div><div class="eyebrow">${title}</div><h2>${arr.length} événement${arr.length>1?'s':''}</h2></div></div><div class="cardlist">${arr.map(card).join('')}</div>`:'';

  const reglesDiscord = `
    <ol style="padding-left:20px;line-height:1.65">
      <li>Soyez respectueux. Les commentaires racistes, vulgaires, offensants… sont bannis de ce Discord.</li>
      <li>Toute forme de spam est interdite. La promotion et publicité pour vos évènements/channels/discords n'est autorisée que dans le channel dédié et sous validation d'un administrateur.</li>
      <li>Tout le monde est le bienvenue, peu importe l'âge et le niveau en piste de chacun. Cependant, en intégrant cette communauté, vous acceptez de vous plier aux règles de bienséance et de savoir-vivre.</li>
      <li>Il n'y a pas de questions bêtes, mais généralement vous avez déjà toutes les réponses devant vos yeux : lisez attentivement les règlements et informations disponibles sur le Discord. Si vous ne trouvez pas la réponse, n'hésitez pas à contacter un membre du Staff.</li>
      <li>Merci de respecter les délais : skins, inscriptions, changements divers et variés. Hors délai, le staff se donne le droit de rejeter une demande.</li>
      <li>La distribution des mods payants est strictement interdite dans ce Discord.</li>
      <li>Les personnes qui s'inscrivent à un championnat/événement sont priées de s'y tenir. Si vous ne respectez pas ce principe, les sanctions sont les suivantes :
        <ul style="list-style:none;padding-left:14px;margin-top:6px">
          <li>2 absences consécutives non prévenues lors d'un championnat → <b>disqualification du championnat</b>.</li>
          <li>2 disqualifications de championnat pour absence → <b>expulsé du Discord Gentlemen Drivers Project</b>.</li>
          <li>2 absences non prévenues pour des évènements hors championnats → votre inscription ne sera pas prioritaire et vous ne roulerez que s'il y a de la place.</li>
        </ul>
      </li>
    </ol>
    <p class="note" style="margin-top:10px">Nous pouvons comprendre que chacun a une vie et des contraintes, mais l'organisation d'évènements demande du temps et de l'énergie. Par respect pour le staff, veillez à faire acte de présence ou à signaler vos absences.</p>`;

  const reglesPiste = `
    <ol style="padding-left:20px;line-height:1.65">
      <li>Tous les pilotes acceptent de suivre le règlement de piste donné sous format PDF ci-dessous. Ce règlement suit les principes de base, il peut y avoir des manques ou des oublis. Mais le bon-sens et le respect en piste primeront toujours.</li>
      <li>Le staff se donne le droit de disqualifier ou d'expulser un pilote dont le comportement est jugé dangereux, anti-sportif ou problématique lors d'une session entraînement, qualification et course.</li>
      <li>Les pilotes sont responsables de leur connexion et de leur matériel. Le Staff se donne la liberté de mettre des avertissements aux pilotes dont la connexion ou le matériel peut poser problème. Si la situation ne change pas après avertissement(s), le Staff se donnera également le droit de disqualifier un pilote.</li>
      <li>Les plaintes sont à déposer dans le channel dédié. Merci de ne pas encombrer les channels informatifs et de discussion inutilement.</li>
      <li>Le redémarrage d'une course ou d'un serveur doit rester exceptionnel. Il ne sera accordé qu'à la demande de la majorité des pilotes et selon certaines conditions : bug serveur, problème de connexion, mauvaise mise en place d'un évènement, etc.</li>
    </ol>`;

  const details = (id,titre,contenu,pdfLabel=null,pdfHref=null)=>`
    <details class="rules-details" id="${id}" style="margin-top:14px;border-top:1px solid #3a5a63;padding-top:14px">
      <summary style="cursor:pointer;font-weight:600;font-size:15px;color:#f7ecd5;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
        <span>${titre}</span><span class="chev" style="font-family:monospace;font-size:20px;color:#d8a347">+</span>
      </summary>
      <div style="margin-top:12px;color:#d1cbbd;font-size:14px">${contenu}
        ${pdfLabel?`<div style="margin-top:14px"><a class="btn secondary small" href="${pdfHref||'#'}" target="_blank" rel="noopener" style="text-decoration:none;color:#f7ecd5;border-color:#d8a347">${pdfLabel}</a></div>`:''}
      </div>
    </details>`;

  // Nombre de pilotes CLASSÉS au GLOBAL (≥5 courses + non exclus par l'admin)
  // (Appelée une seule fois ici : globalRankingSync la rappelle mais elle est pure et rapide.)
  const pilotsCount = globalPerformanceRatings().length;

  return `
  <div class="hero hub-hero">
    <div class="hero-text hub-hero-text">
      <div class="hero-masthead">GENTLEMAN &nbsp; DRIVERS &nbsp; PROJECT</div>
      <h1>La piste,<br>entre gentlemen.<br><em>Compétition le mercredi. Arsouille entre copains toujours.</em></h1>
      <div class="hero-lede">Ici, nous roulons entre passionnés et Gentlemen Drivers. Nous cherchons à partager des moments simples, amicaux et sérieux — il y a de la place à la fois pour la compétition et pour l'arsouille.</div>
      <p>Notre organisation se concentre essentiellement sur <b>Assetto Corsa</b> à travers des championnats, opens et évènements spéciaux, avec une passion pour le simracing <b>historique et vintage</b>.</p>
      <p>Nous espérons que vous trouverez votre bonheur ici et que vous aurez l'occasion de rencontrer une communauté avec laquelle vous aurez plaisir à rouler et échanger.</p>
      <div class="hero-sign">— Au plaisir de vous croiser sur la route&nbsp;)</div>
    </div>

    <div class="hero-side hub-hero-side">
      <div class="hub-actions">
        <button class="hub-link-global" onclick="go('global')">
          <span>🏆 &nbsp; Classement GLOBAL Discord<small style="display:block;font-weight:400;font-size:11px;margin-top:2px;letter-spacing:0">Niveau pilote tous événements</small></span><span>↗</span>
        </button>
      </div>

      <div>
        <h3 class="hub-side-h">📘 &nbsp; Règlements</h3>
        <div class="hub-rules">
          <details class="hub-rule">
            <summary>Règlement Discord<span class="chev"></span></summary>
            <div class="hub-rule-body">${reglesDiscord.replace(/style="[^"]*"/g,'')}</div>
          </details>
          <details class="hub-rule">
            <summary>Règlement piste<span class="chev"></span></summary>
            <div class="hub-rule-body">${reglesPiste.replace(/style="[^"]*"/g,'')}
              <div style="margin-top:10px"><a class="hub-pdf" href="https://cdn.discordapp.com/attachments/1027270562499809440/1312457170310135968/Reglement_Piste_GDSP.pdf?ex=6ae5703d&is=6ae41ebd&hm=21c799554a4f8d861f7020895ca7302307acda2c0310da87e4016c6323a0769e&" target="_blank" rel="noopener">📎 Règlement de piste (PDF) ↗</a></div>
            </div>
          </details>
        </div>
      </div>

      <div>
        <h3 class="hub-side-h">📊 &nbsp; En un coup d'œil</h3>
        <div class="hub-stats">
          <div class="hub-stat-card"><div class="hub-stat-lbl">Championnats</div><strong>${String(champs.length).padStart(2,'0')}</strong></div>
          <div class="hub-stat-card"><div class="hub-stat-lbl">Opens</div><strong>${String(opens.length).padStart(2,'0')}</strong></div>
          <div class="hub-stat-card"><div class="hub-stat-lbl">Archives</div><strong>${String(archives.length).padStart(2,'0')}</strong></div>
          <div class="hub-stat-card"><div class="hub-stat-lbl">Pilotes</div><strong>${pilotsCount||'—'}</strong></div>
        </div>
      </div>

      <div class="hub-where">
        <h3 class="hub-side-h">📍 &nbsp; Où nous trouver</h3>
        <p>Inscriptions, livrées, plaintes et annonces se passent sur le Discord.</p>
        <a class="hub-discord-btn" href="https://discord.gg/kDZXwRgRS" target="_blank" rel="noopener">discord.gg/kDZXwRgRS</a>
      </div>
    </div>
  </div>

  <style>
    /* HERO LAYOUT — 65 / 35 ratio */
    .hero.hub-hero{
      background:#132d35 url('/hero-gdsp.jpg?v=1') center/cover!important;
      position:relative;min-height:560px;
      grid-template-columns:65% 35%!important;
      overflow:hidden;color:#f7ecd5;
    }
    /* Overlay: diagonal darkening from left-deep to right-deep (photo visible center-left, readable panels both sides) */
    .hero.hub-hero::before{
      content:"";position:absolute;inset:0;pointer-events:none;z-index:1;
      background:
        linear-gradient(100deg,
          rgba(14,34,40,.75) 0%,
          rgba(14,34,40,.40) 40%,
          rgba(14,34,40,.55) 55%,
          rgba(14,34,40,.88) 100%),
        radial-gradient(ellipse at 30% 40%, transparent 0%, rgba(14,34,40,.20) 55%, rgba(14,34,40,.55) 100%);
    }
    .hero.hub-hero::after{
      content:"";position:absolute;inset:0;pointer-events:none;z-index:1;opacity:.07;mix-blend-mode:multiply;
      background-image:radial-gradient(circle at 1px 1px,#000 1px,transparent 1.2px);
      background-size:3px 3px;
    }
    .hub-hero-text{position:relative;z-index:2;padding:56px 48px 52px 44px;
      background:linear-gradient(90deg,rgba(14,34,40,.72) 0%,rgba(14,34,40,.40) 75%,transparent 100%)}
    .hub-hero-side{
      position:relative;z-index:2;padding:42px 34px;display:flex;flex-direction:column;gap:20px;
      background:linear-gradient(180deg,rgba(14,34,40,.50) 0%,rgba(14,34,40,.82) 100%);
      border-left:1px solid #d8a34740;
    }
    /* Masthead & title */
    .hero-masthead{display:inline-block;font-family:'Bebas Neue',sans-serif;letter-spacing:4px;font-size:13px;color:#d8a347;
      border-top:1px solid #d8a347;border-bottom:1px solid #d8a347;padding:8px 0;margin-bottom:18px}
    .hub-hero h1{font-family:'Bebas Neue',sans-serif;letter-spacing:2px;line-height:.95;margin:0;
      font-size:clamp(36px,5.2vw,70px);text-shadow:1px 1px 0 #0008}
    .hub-hero h1 em{font-family:'Playfair Display',serif;font-style:italic;font-weight:700;color:#d8a347;
      display:block;font-size:.42em;letter-spacing:1px;margin-top:10px;line-height:1.2}
    .hero-lede{font-size:15px;color:#e8dfc5;margin:22px 0 14px;max-width:540px;line-height:1.7;border-left:3px solid #d8a347;padding-left:14px}
    .hub-hero-text p{line-height:1.65;color:#d1cbbd;max-width:540px;margin:8px 0;font-size:14px}
    .hero-sign{font-family:'Playfair Display',serif;font-style:italic;color:#d8a347;margin-top:18px;font-size:15px}

    /* Side headings */
    .hub-side-h{font-family:'Bebas Neue',sans-serif;letter-spacing:2px;font-size:15px;color:#d8a347;
      margin:0 0 8px;text-transform:uppercase;border-bottom:1px solid #d8a34760;padding-bottom:6px;font-weight:400}

    /* Actions */
    .hub-actions{display:flex;flex-direction:column;gap:8px}
    .hub-link-discord,.hub-link-global{
      display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;
      padding:11px 14px;border:none;font-weight:700;font-size:13px;letter-spacing:.4px;cursor:pointer;
      border-radius:2px;font-family:inherit;text-align:left;text-decoration:none;
    }
    .hub-link-discord{background:#5865F2;color:#fff}
    .hub-link-discord:hover{background:#4752c4}
    .hub-link-global{background:transparent;color:#f7ecd5;border:2px solid #d8a347}
    .hub-link-global:hover{background:#d8a34720}
    .hub-link-discord small,.hub-link-global small{color:#e8dfc5}

    /* Rules */
    .hub-rules{display:flex;flex-direction:column;gap:2px}
    .hub-rule{border-top:1px dashed #d8a34755;padding-top:6px}
    .hub-rule summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;
      color:#f7ecd5;font-weight:600;font-size:14px;user-select:none;padding:8px 0}
    .hub-rule summary::-webkit-details-marker{display:none}
    .hub-rule .chev{font-family:monospace;color:#d8a347;font-size:16px}
    .hub-rule[open] .chev::before{content:"−"}
    .hub-rule:not([open]) .chev::before{content:"+"}
    .hub-rule-body{color:#d1cbbd;font-size:13px;line-height:1.6;padding:4px 0 8px}
    .hub-rule-body ol{padding-left:18px;margin:6px 0}
    .hub-rule-body ol li{margin:4px 0}
    .hub-rule-body ul{list-style:none;padding-left:12px;margin:6px 0;font-size:12px;color:#bfb5a0}
    .hub-rule-body .note{font-size:12px;color:#a9a28f;margin-top:8px;font-style:italic}
    .hub-pdf{display:inline-block;margin-top:10px;padding:6px 12px;border:1px solid #d8a347;color:#f7ecd5;font-size:12px;font-weight:600;text-decoration:none}
    .hub-pdf:hover{background:#d8a34720}

    /* Stats */
    .hub-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .hub-stat-card{background:rgba(247,236,213,.06);border:1px solid #d8a34740;padding:12px 14px;border-left:3px solid #d8a347}
    .hub-stat-lbl{font-size:10px;letter-spacing:2px;color:#c9bfab;font-weight:700;text-transform:uppercase}
    .hub-stat-card strong{font-family:'Bebas Neue',sans-serif;font-size:28px;color:#f7ecd5;letter-spacing:1px;display:block;line-height:1;margin-top:4px}

    /* Where */
    .hub-where p{font-size:13px;color:#d1cbbd;line-height:1.6;margin:6px 0 10px}
    .hub-discord-btn{display:inline-block;padding:9px 16px;background:#5865F2;color:#fff;font-weight:700;font-size:13px;border-radius:2px;letter-spacing:.5px;text-decoration:none}
    .hub-discord-btn:hover{background:#4752c4}

    /* Hub sections (below hero) */
    #hub-sections details summary{padding:10px 0;border-top:1px solid #d9cfb5;cursor:pointer;display:flex;align-items:center;gap:12px;list-style:none;user-select:none}
    #hub-sections details summary::-webkit-details-marker{display:none}
    #hub-sections details[open] > summary .chev::before{content:"−"}
    #hub-sections details:not([open]) > summary .chev::before{content:"+"}
    #hub-sections details .chev{font-family:monospace;font-size:22px;color:#d8a347;margin-left:8px}

    @media (max-width:960px){
      .hero.hub-hero{grid-template-columns:1fr!important}
      .hub-hero-side{padding:28px 26px;border-left:none!important;border-top:1px solid #d8a34740}
      .hub-hero-text{padding:34px 26px!important;background:rgba(14,34,40,.75)!important}
    }
  </style>
  <div id="hub-sections" style="margin-top:32px">
    ${section('Championnats en cours',champs)}
    ${section('Opens & week-ends',opens)}
    ${archives.length?`<details style="margin-top:42px"><summary style="cursor:pointer;display:flex;align-items:center;gap:12px;user-select:none;list-style:none"><div class="eyebrow">Saisons archivées</div><h2 style="margin:4px 0 0;font-size:22px;font-family:'Bebas Neue',sans-serif;letter-spacing:1px;color:#5d5b56">${archives.length} saison${archives.length>1?'s':''} terminée${archives.length>1?'s':''}</h2><span class="chev" style="font-family:monospace;font-size:22px;color:#d8a347;margin-left:8px"></span></summary><div style="margin-top:14px"><div class="cardlist">${archives.map(card).join('')}</div></div></details>`:''}
    ${(!events.length)?'<p class="note">Aucun événement configuré pour l\'instant.</p>':''}
  </div>`;
}

// Global ranking across all events — shown only in multi mode, built on demand
async function globalRanking(){
  // Charger les data de tous les événements qui n'ont pas encore leurs sessions en mémoire
  const needFetch=events.filter(ev=>!ev.__loaded);
  if(needFetch.length){
    const results=await Promise.all(needFetch.map(ev=>{
      const ctl=new AbortController();
      const to=setTimeout(()=>ctl.abort(),20000);
      return apiGet('/api/events/'+encodeURIComponent(ev.slug),{signal:ctl.signal})
        .then(r=>{clearTimeout(to);if(!r.ok)return null;return r.json().catch(()=>null)})
        .catch(e=>{clearTimeout(to);console.warn('load event failed:',ev.slug,e.message);return null});
    }));
    needFetch.forEach((ev,i)=>{
      const j=results[i];
      if(j&&j.slug){ev.data=j.data||{};ev.points_config=j.points_config||ev.points_config;ev.updated_at=j.updated_at||ev.updated_at}
      else{ev.data={}}
      ev.__loaded=true;
    });
  }
  try{return globalRankingSync()}
  catch(e){console.error('globalRankingSync error:',e);return `<div class="panel"><p class="note" style="color:#9c3021">✗ Erreur lors du calcul : ${esc(e.message)}</p><pre style="font-size:11px;overflow:auto">${esc(e.stack||'')}</pre></div>`}
}
function globalRankingSync(){
  if(!backendMulti)return ranking();
  const ratings=globalPerformanceRatings();
  if(!ratings.length)return `${head('global','Classement GLOBAL Discord','Niveau pilote inter-événements GDSP.')}<div class="panel"><p class="note">Pas encore assez de données pour évaluer les pilotes. Il faut au moins <b>${GLOBAL_MIN_RACES} courses RACE</b> par pilote, tous championnats/opens confondus.</p></div>`;
  // Regrouper par niveau (1=élite … 4=débutant)
  const tiers={1:[],2:[],3:[],4:[]};
  ratings.forEach(r=>tiers[r.level].push(r));
  const tierLabel={1:'Niveau 1 · Élite · 81–100',2:'Niveau 2 · Confirmé · 61–80',3:'Niveau 3 · Intermédiaire · 41–60',4:'Niveau 4 · Débutant · 0–40'};
  const tierDesc={
    1:'Pilotes les plus complets et constants sur la durée : résultats, propreté, vitesse et régularité au rendez-vous dans tous les championnats.',
    2:'Pilotes solides, capables de belles performances et d\'une bonne finition en course. Quelques axes à travailler pour rejoindre l\'élite.',
    3:'Pilotes en progression, avec des éclairs de vitesse mais encore de l\'irrégularité ou des incidents de course coûteux.',
    4:'Pilotes récents ou en phase d\'apprentissage : la régularité et la propreté sont à construire, la marge de progression est importante.'
  };
  const now=Date.now();
  function trendArrow(t){const v=t.trend||0; if(v>4)return `<span style="color:#3b6341">▲ ${v.toFixed(0)} places</span>`; if(v>1)return `<span style="color:#3b6341">↑ ${v.toFixed(1)}</span>`; if(v<-4)return `<span style="color:#9c3021">▼ ${Math.abs(v).toFixed(0)} places</span>`; if(v<-1)return `<span style="color:#9c3021">↓ ${Math.abs(v).toFixed(1)}</span>`; return `<span style="color:#6d726c">→ stable</span>`}
  // Blocs tiers (3 colonnes pour 1/2/3-4 ? Mieux 4 colonnes)
  const tierCards=[1,2,3,4].map(l=>{
    const list=tiers[l].slice(0,18).map(d=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed #dbd0ba;cursor:pointer" data-pid="${esc(d.id)}" onclick="globalDriverId=this.dataset.pid;go('gpilote')"><span><b>${esc(d.name)}</b></span><span class="muted" style="font-size:12px">${d.count}c · ${d.score.toFixed(0)}</span></div>`).join('');
    return `<div class="lvl-block"><div style="margin-bottom:8px">${levelBadge(l,72)}</div><h2 style="margin-top:10px">${tierLabel[l]}</h2><p class="note">${tierDesc[l]}</p><p class="note" style="margin:10px 0"><b>${tiers[l].length}</b> pilote${tiers[l].length>1?'s':''} · top ${tiers[l][0]?tiers[l][0].score.toFixed(0):'—'} → ${tiers[l].length?tiers[l][tiers[l].length-1].score.toFixed(0):'—'}/100</p><div style="margin-top:8px">${list||'<p class="note" style="font-size:12px">—</p>'}</div></div>`;
  }).join('');
  const labels={regularite:'Rythme',proprete:'Propreté',vitesse:'Vitesse',resultats:'Résultats'};
  // Couleurs associées à chaque niveau (barre latérale + teinte de fond)
  const LVL_COLORS={1:{bar:'#d7a347',bg:'rgba(215,163,71,0.10)'},2:{bar:'#9c3021',bg:'rgba(156,48,33,0.07)'},3:{bar:'#3b6341',bg:'rgba(59,99,65,0.07)'},4:{bar:'#6d726c',bg:'rgba(109,114,108,0.08)'}};
  const LVL_NAMES={1:'Élite',2:'Confirmé',3:'Intermédiaire',4:'Débutant'};
  const detailRows=[];
  let lastLevel=null;
  ratings.forEach((d,i)=>{
    // Séparateur visuel quand on change de niveau
    if(lastLevel!==null&&d.level!==lastLevel){
      detailRows.push(`<tr data-tier-divider><td colspan="6" style="padding:8px 14px;background:#132d35;color:#f7ecd5;font-family:Impact,sans-serif;font-size:13px;letter-spacing:2px">${levelBadge(d.level,24)} &nbsp; ${LVL_NAMES[d.level]} &nbsp;·&nbsp; niveau ${d.level}</td></tr>`);
    }
    lastLevel=d.level;
    const barTips={regularite:PROFILE_TIPS.regulariteGlobal,proprete:PROFILE_TIPS.proprete,vitesse:PROFILE_TIPS.vitesse,resultats:PROFILE_TIPS.resultats,progression:PROFILE_TIPS.progression};
    const bars=Object.keys(labels).map(k=>{
      const v=d.details[k]||0;
      const tipBody=`<b>${labels[k]} : ${v.toFixed(0)} / 100</b><br>${(barTips[k]||'').replace(/^<b>[^<]*<\/b><br>/,'')}`;
      return `<span class="gdsp-tip gdsp-bar" style="display:inline-block;width:34px;margin-right:3px"><span class="mini-bar"><i style="width:${Math.max(2,Math.min(100,v))}%"></i></span><span style="font-size:9px;color:#6d726c;display:block;text-align:center;margin-top:2px">${Math.round(v)}</span><span class="gdsp-bubble">${tipBody}</span></span>`;
    }).join('');
    const c=LVL_COLORS[d.level]||LVL_COLORS[4];
    detailRows.push(`<tr style="cursor:pointer;background:${c.bg};border-left:4px solid ${c.bar}" onclick="globalDriverId=this.dataset.pid;go('gpilote')" data-pid="${esc(d.id)}"><td class="pos">${i+1}</td><td>${levelBadge(d.level,40)}</td><td><b>${esc(d.name)}</b></td><td>${d.count}</td><td><b>${d.score.toFixed(0)}</b> ${trendArrow(d)}</td><td>${bars}</td></tr>`);
  });
  const detailHtml=detailRows.join('');
  return `${head('global','Classement GLOBAL Discord','Niveau GDSP de 1 à 4, calculé en temps réel sur la base de tous les résultats de championnats et opens.')}
    <p class="note" style="margin-bottom:16px">Le niveau est établi par week-end sur <b>quatre critères</b> : position finale en course, <b>rythme</b> (écart moyen au meilleur tour, 1<sup>er</sup> tour et stands exclus), <b>propreté</b> (contacts responsables causant ≥ 1,5 s de perte &amp; cuts), <b>vitesse au tour</b> sur le week-end (Q + R). Survolez les <b>?</b> dorés pour la définition complète de chaque critère. Les manches récentes comptent davantage (demi-vie 90 jours). Il faut au moins <b>${GLOBAL_MIN_RACES} courses</b> pour être classé.</p>
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px">${tierCards}</div>
    <div class="panel global-rank-wrap"><h2>Détail des pilotes classés</h2><p class="note">Trié par score global. Les 4 mini-barres représentent Rythme / Propreté / Vitesse / Résultats (0-100) — survolez une mini-barre ou l'icône ? pour le détail. Les séparateurs bleu foncé marquent les changements de niveau.</p>${table(['#','','Pilote','Courses','Score / 100',`4 critères (0-100) ${gdspTip(PROFILE_TIPS.quatreCriteres,'gdsp-tip-right')}`],detailRows)}</div>`;
}

// ---------- Méthodes de calcul de performance (Régularité iRacing, Vitesse Q+R, Propreté Option 3, Résultats v45) ----------
const FAULT_SIDE_Z=1.0;      // |Z| >= 1.0 m → choc latéral / côte à côte → 0-0
const FAULT_REAR_X=0.4;      // |X| >= 0.4 m → choc avant/arrière franc
const FAULT_LOSS_MIN=1.5;    // perte minimale de la victime (en s) pour compter la faute
const FAULT_DIVISOR=2;       // points de faute = secondes perdues / 2
const FAULT_CUT_WEIGHT=1;    // +1 point par cut de piste
const PIT_SLOW_MS=21000;     // tour > meilleur tour + 21 s considéré comme tour stand / sortie

function groupSessionsByDate(sessList){
  const m={};
  (sessList||[]).filter(s=>s&&s.date).forEach(s=>(m[String(s.date).slice(0,10)]??=[]).push(s));
  return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).map(([dt,ss],idx)=>({
    date:dt,sessions:ss,ts:new Date(ss[0].date||dt).getTime(),roundIndex:idx
  }));
}

// Régularité (Race Consistency type iRacing) : moyenne(tour - best) en ms, 1er tour et tours > best+21s exclus.
function raceConsistencyMs(lapsRaw){
  const all=(lapsRaw||[]).map(l=>Number(l&&(Number.isFinite(l.LapTime)?l.LapTime:l.time))).filter(t=>Number.isFinite(t)&&t>0&&t<600000);
  if(all.length<3)return null;
  const rest=all.slice(1);
  const best1=Math.min(...rest);
  if(!Number.isFinite(best1)||best1<=0)return null;
  const nonPit=rest.filter(t=>t-best1<=PIT_SLOW_MS);
  if(nonPit.length<2)return null;
  const best2=Math.min(...nonPit);
  const nonBest=nonPit.filter(t=>t>best2);
  if(nonBest.length===0)return 0;
  return nonBest.reduce((a,t)=>a+(t-best2),0)/nonBest.length;
}

// Barème v45 du critère Résultats (variable selon la taille de grille N ; DNF/DNS/DQ = 0).
function scoreResultsV45(N,P,isOut){
  if(isOut)return 0.0;
  if(N<=1)return 50.0;
  const pos=Math.max(1,Math.min(N,P));
  const amplitude=N>=28?100:10+(90*(N-2)/26);
  const s=Math.max(0,Math.min(100,50+amplitude*(N+1-2*pos)/(2*(N-1))));
  return Math.round(s*10)/10;
}

// Tri d'une session en appliquant les décisions Commission de son événement (sans muter la source).
function sortSessionForPerf(sess,rIdx,sIdx,evPenMap,minPct=0.75){
  if(!sess||!Array.isArray(sess.results))return [];
  const arr=sess.results.map(r=>({...r,comTimeAdd:0,comDQ:false,comDNF:false,comDNS:false,comWarning:false}));
  if(evPenMap&&typeof evPenMap==='object'&&rIdx>=0&&sIdx>=0){
    const prefix=`${rIdx}:${sIdx}:`;
    for(const k in evPenMap){
      if(!k.startsWith(prefix))continue;
      const did=k.slice(prefix.length);
      const y=arr.find(x=>x.id===did);if(!y)continue;
      const adj=evPenMap[k];if(!adj)continue;
      if(adj.dq)y.comDQ=true;
      if(adj.dns)y.comDNS=true;
      if(adj.dnf)y.comDNF=true;
      if(adj.warning)y.comWarning=true;
      if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0)y.comTimeAdd+=(adj.timeAdd*1000);
    }
  }
  if(sess.type==='QUALIFY'){
    arr.forEach(x=>{
      x._dq=!!(x.disqualified||x.comDQ||x.comDNS);
      const b=Number.isFinite(x.best)&&x.best>0?x.best:1e18;
      x._adjustedBest=b<1e17?Math.max(1,b+(x.comTimeAdd||0)):1e18;
    });
    arr.sort((a,b)=>{
      const aOk=!a._dq&&(a.laps||0)>=2&&a._adjustedBest<1e17;
      const bOk=!b._dq&&(b.laps||0)>=2&&b._adjustedBest<1e17;
      if(aOk!==bOk)return aOk?-1:1;
      return a._adjustedBest-b._adjustedBest||(b.laps||0)-(a.laps||0);
    });
    return arr;
  }
  arr.forEach(x=>{
    const base=Number.isFinite(x.time)&&x.time>0?x.time:1e18;
    x._eff=base;
    x._t=base<1e17?base+(x.comTimeAdd||0):1e18;
    x._dq=!!(x.disqualified||x.comDQ||x.comDNS);
    if(x._dq||x.comDNF||(x.laps||0)<=0)x._t=1e18;
  });
  const maxLaps=Math.max(0,...arr.filter(x=>!x._dq&&!x.comDNS).map(x=>x.laps||0));
  const minLaps=Math.ceil(maxLaps*(Number.isFinite(minPct)?minPct:0.75));
  arr.forEach(x=>{
    if(!x._dq&&!x.comDNS&&(x.laps||0)<minLaps){x.comDNF=true;x._t=1e18;}
  });
  let wl=0,wt=1e18;
  for(const x of arr){
    if(x._dq||x.comDNS||x.comDNF||x._t>=1e17)continue;
    const L=x.laps||0;
    if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}
  }
  const fin=[],cls=[],nc=[],dq=[];
  for(const x of arr){
    if(x._dq||x.comDNS){dq.push(x);continue;}
    if(x.comDNF||x._t>=1e17||(x.laps||0)<minLaps){x.comDNF=true;nc.push(x);continue;}
    if(wl>0&&wt<1e17&&x._t>=wt)fin.push(x);
    else if(wl>0&&(x.laps||0)>=minLaps)cls.push(x);
    else{x.comDNF=true;nc.push(x);}
  }
  fin.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
  cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t);
  nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
  dq.sort((a,b)=>(b.laps||0)-(a.laps||0));
  return [...fin,...cls,...nc,...dq];
}

// Option 3 : score de fautes sur une course (cuts + chocs arrière causant >= 1,5 s de perte à la victime).
function raceFoulScores(race){
  const lapsById={};
  const byCarId={},byName={};
  (race.results||[]).forEach(r=>{
    if(!r)return;
    if(r.CarId!=null&&r.id)byCarId[r.CarId]=r.id;
    if(r.DriverName&&r.id)byName[String(r.DriverName).trim().toLowerCase()]=r.id;
    if(r.name&&r.id)byName[String(r.name).trim().toLowerCase()]=r.id;
  });
  (race.laps||[]).forEach(l=>{
    if(!l)return;
    const lid=l.id||(l.CarId!=null?byCarId[l.CarId]:null);
    if(!lid)return;
    if(!lapsById[lid])lapsById[lid]=[];
    lapsById[lid].push(l);
  });
  function driverPaceMs(id){
    const ls=(lapsById[id]||[]).map(l=>Number(Number.isFinite(l.LapTime)?l.LapTime:l.time)).filter(t=>Number.isFinite(t)&&t>0&&t<600000);
    if(ls.length<3)return null;
    const rest=ls.slice(1);
    const best=Math.min(...rest);
    const nonPit=rest.filter(t=>t-best<=PIT_SLOW_MS);
    return nonPit.length>=2?Math.min(...nonPit):best;
  }
  function resolveId(ev,which){
    const cid=ev[which==='a'?'CarId':'OtherCarId'];
    if(cid!=null&&byCarId[cid])return byCarId[cid];
    const idKey=which==='a'?'aid':'bid',nKey=which==='a'?'a':'b';
    if(ev[idKey])return ev[idKey];
    const nm=ev[nKey];
    if(nm){const k=String(nm).trim().toLowerCase();if(byName[k])return byName[k];}
    return null;
  }
  function evTsSec(ev){
    const raw=Number.isFinite(ev.Timestamp)?ev.Timestamp:ev.timestamp;
    if(!Number.isFinite(raw))return null;
    return raw>1e11?raw/1000:raw;
  }
  function lapTsSec(l){
    const raw=Number.isFinite(l.Timestamp)?l.Timestamp:l.timestamp;
    if(!Number.isFinite(raw))return null;
    return raw>1e11?raw/1000:raw;
  }
  const scores=new Map();
  const add=(id,pts)=>{if(!id||!Number.isFinite(pts))return;scores.set(id,(scores.get(id)||0)+pts);};

  // 1) Cuts de piste (+1 pt / cut)
  (race.results||[]).forEach(r=>{
    if(!r||!r.id)return;
    let c=0;
    (lapsById[r.id]||[]).forEach(l=>{
      const v=Number.isFinite(l.cuts)?l.cuts:(Number.isFinite(l.Cuts)?l.Cuts:0);
      c+=Math.max(0,v);
    });
    add(r.id,FAULT_CUT_WEIGHT*c);
  });

  // 2) Collisions voiture-contre-voiture (Option 3)
  const evs=(race.events||[]).filter(e=>e&&(e.type==='COLLISION_WITH_CAR'||e.Type==='COLLISION_WITH_CAR'||(!e.type&&!e.Type&&(e.a||e.aid||e.CarId!=null))));
  const seenPairs=new Set();
  for(let i=0;i<evs.length;i++){
    const a=evs[i];
    const aid=resolveId(a,'a'),bid=resolveId(a,'b');
    if(!aid||!bid||aid===bid)continue;
    const tsA=evTsSec(a);
    let b=null;
    for(let j=i+1;j<evs.length;j++){
      const o=evs[j];
      const oid=resolveId(o,'a'),ooid=resolveId(o,'b');
      if(!oid||!ooid)continue;
      const tsO=evTsSec(o);
      const closeEnough=(tsA==null||tsO==null)?true:Math.abs(tsO-tsA)<=2.5;
      if(((oid===aid&&ooid===bid)||(oid===bid&&ooid===aid))&&closeEnough){b=o;break;}
    }
    const pairKey=[aid,bid].sort().join('-')+':'+(tsA!=null?Math.round(tsA):i);
    if(seenPairs.has(pairKey))continue;
    seenPairs.add(pairKey);

    let rp=a.RelPosition||a.relPos||null;
    let refAid=aid,refBid=bid;
    if((!rp||rp.X==null||rp.Z==null)&&b&&(b.RelPosition||b.relPos)){
      rp=b.RelPosition||b.relPos;
      refAid=resolveId(b,'a');refBid=resolveId(b,'b');
    }
    if(!rp||rp.X==null||rp.Z==null)continue;
    const rx=Number(rp.X),rz=Number(rp.Z);
    if(!Number.isFinite(rx)||!Number.isFinite(rz))continue;
    if(Math.abs(rz)>=FAULT_SIDE_Z)continue; // côte à côte → 0-0

    let culpritId=null,victimId=null;
    if(rx>=FAULT_REAR_X){culpritId=refAid;victimId=refBid;}
    else if(rx<=-FAULT_REAR_X){culpritId=refBid;victimId=refAid;}
    if(!culpritId||!victimId)continue;

    const vLaps=lapsById[victimId]||[];
    if(!vLaps.length)continue;
    let victimLap=null;
    if(tsA!=null){
      for(const L of vLaps){
        const lts=lapTsSec(L);
        if(lts!=null&&lts>=tsA-5){victimLap=L;break;}
      }
    }
    if(!victimLap)victimLap=vLaps[vLaps.length-1];
    const vPaceMs=driverPaceMs(victimId);
    const lapRaw=victimLap&&(Number.isFinite(victimLap.LapTime)?victimLap.LapTime:victimLap.time);
    if(!Number.isFinite(lapRaw)||lapRaw<=0||!Number.isFinite(vPaceMs)||vPaceMs<=0)continue;
    const lapSec=lapRaw>1000?lapRaw/1000:lapRaw;
    const paceSec=vPaceMs>1000?vPaceMs/1000:vPaceMs;
    const lossSec=lapSec-paceSec;
    if(lossSec>=FAULT_LOSS_MIN)add(culpritId,lossSec/FAULT_DIVISOR);
  }
  return scores;
}

// Meilleur tour du week-end (Q + R) : Map<id, {best, bestSession:'Q'|'R'}>
function weekendBestLaps(rd,rIdx=-1,evPenMap=null){
  const best=new Map();
  (rd.sessions||[]).forEach((s,sIdx)=>{
    if(!s||(s.type!=='RACE'&&s.type!=='QUALIFY'))return;
    const sorted=sortSessionForPerf(s,rIdx,sIdx,evPenMap);
    const tag=s.type==='QUALIFY'?'Q':'R';
    for(const r of sorted){
      if(!r||!r.id||r._dq||r.comDNS)continue;
      const rawBest=(s.type==='QUALIFY'&&Number.isFinite(r._adjustedBest)&&r._adjustedBest<1e17)?r._adjustedBest:r.best;
      const b=Number.isFinite(rawBest)&&rawBest>0&&rawBest<600000?rawBest:null;
      if(b==null)continue;
      const cur=best.get(r.id);
      if(!cur||b<cur.best)best.set(r.id,{best:b,bestSession:tag});
    }
  });
  return best;
}

// Encadré « Analyse du rythme — Race consistency & meilleur tour week-end » (utilisé dans Pilotes et Global)
function buildRythmeCard(targetDriverId,roundsList,opts={}){
  if(!targetDriverId||!Array.isArray(roundsList)||!roundsList.length)return '';
  const list=[];
  roundsList.forEach(rd=>{
    const raceSessions=(rd.sessions||[]).filter(s=>s&&s.type==='RACE');
    if(!raceSessions.length)return;
    const rIdx=typeof rd.roundIndex==='number'?rd.roundIndex:-1;
    const evPen=rd.penMap||null;
    const bestMap=weekendBestLaps(rd,rIdx,evPen);
    const b=bestMap.get(targetDriverId);
    const participated=b||raceSessions.some(s=>(s.results||[]).some(r=>r&&r.id===targetDriverId));
    if(!participated)return;

    let totalLaps=0,totalPits=0,gapSum=0,gapCount=0,cleanSumMs=0,cleanCount=0,bestPos=null;
    (rd.sessions||[]).forEach((s,sIdx)=>{
      if(!s||s.type!=='RACE')return;
      const sorted=sortSessionForPerf(s,rIdx,sIdx,evPen);
      const pos=sorted.findIndex(r=>r&&r.id===targetDriverId)+1;
      if(pos>0&&(bestPos==null||pos<bestPos))bestPos=pos;

      const myLaps=(s.laps||[]).filter(l=>l&&l.id===targetDriverId&&Number.isFinite(l.time)&&l.time>0&&l.time<600000).map(l=>l.time);
      totalLaps+=myLaps.length;
      if(myLaps.length<3)return;
      const rest=myLaps.slice(1);
      const best1=Math.min(...rest);
      const nonPit=rest.filter(t=>t-best1<=PIT_SLOW_MS);
      totalPits+=(rest.length-nonPit.length);
      if(nonPit.length<2)return;
      const consMs=raceConsistencyMs(myLaps.map(t=>({time:t})));
      if(consMs!=null){gapSum+=consMs/1000;gapCount++;}
      nonPit.forEach(t=>{cleanSumMs+=t;cleanCount++;});
    });

    const label=(opts.showEvent&&rd.eventName?esc(rd.eventName)+' · ':'')+esc(track(rd.track||(rd.sessions[0]&&rd.sessions[0].track)||''));
    const weekendBestMs=b?b.best:null;
    const weekendTag=b?b.bestSession:null;
    const gapSec=gapCount?gapSum/gapCount:null;
    const avgRaceMs=cleanCount?cleanSumMs/cleanCount:(weekendBestMs!=null&&gapSec!=null?weekendBestMs+gapSec*1000:null);
    if(weekendBestMs==null&&gapSec==null){
      list.push({label,valid:false,laps:totalLaps});
      return;
    }
    list.push({label,valid:true,laps:totalLaps,bestMs:weekendBestMs,tag:weekendTag,avgMs:avgRaceMs,gapSec,pits:totalPits,pos:bestPos});
  });
  if(!list.some(x=>x.valid))return '';
  const tagStyle='display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:5px;vertical-align:middle;font-family:Arial,sans-serif;line-height:1.3';
  const qStyle=tagStyle+';background:#3b6341;color:#f7ecd5';
  const rStyle=tagStyle+';background:#9c3021;color:#f7ecd5';
  const rows=list.map(x=>{
    if(!x.valid)return `<tr><td>${x.label}</td><td colspan="5" class="muted" style="text-align:center">tours insuffisants (${x.laps})</td></tr>`;
    const tagHtml=x.tag?`<span style="${x.tag==='Q'?qStyle:rStyle}">${x.tag}</span>`:'';
    return `<tr><td>${x.label}${x.pos?` <span class="muted">· P${x.pos}</span>`:''}</td><td>${x.bestMs!=null?fmt(x.bestMs)+tagHtml:'—'}</td><td>${x.avgMs!=null?fmt(x.avgMs):'—'}</td><td><b>${x.gapSec!=null?'+'+x.gapSec.toFixed(2)+' s':'—'}</b></td><td>${x.laps} t.</td><td>${x.pits}</td></tr>`;
  }).join('');
  return `<div class="panel rythme-wrap" style="margin-top:16px"><div class="eyebrow">Analyse du rythme</div><h2>Race consistency &amp; meilleur tour week-end</h2>`
    +`<p class="note">Meilleur tour du week-end (qualification <span style="${qStyle}">Q</span> ou course <span style="${rStyle}">R</span>). Δ rythme = écart moyen au meilleur tour en course (1<sup>er</sup> tour et tours aux stands &gt; +21 s exclus).</p>`
    +`<table class="rythme-table"><thead><tr><th>Manche</th><th>Meilleur WE ${gdspTip(PROFILE_TIPS.meilleurWE)}</th><th>Moy. course</th><th>Δ rythme ${gdspTip(PROFILE_TIPS.sigma)}</th><th>Tours</th><th>Pit/exclu ${gdspTip(PROFILE_TIPS.pitExclu,'gdsp-tip-right')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Calcule un score 0-100 par pilote, tous événements confondus, par week-end avec pondération récente (demi-vie 90 jours).
// Le niveau suit le score entier affiché, indépendamment du nombre de pilotes.
function globalLevelForScore(score){
  const displayedScore=Math.round(score);
  return displayedScore>=81?1:displayedScore>=61?2:displayedScore>=41?3:4;
}
// Retourne un tableau trié par score décroissant, avec level (1=élite..4=débutant).
function globalPerformanceRatings(){
  const allWeekends=[];
  const idName=new Map(),idTeam=new Map();
  for(const ev of events){
    const d=ev.data||{};
    const evSessions=Array.isArray(d.sessions)?d.sessions:[];
    const evPenMap=d.penMap||{};
    const minPct=(ev.points_config&&typeof ev.points_config.minPercentDistance==='number')?ev.points_config.minPercentDistance:0.75;
    const evRounds=groupSessionsByDate(evSessions);
    evRounds.forEach((rd,rIdx)=>{
      const raceSessions=[];
      rd.sessions.forEach((s,sIdx)=>{if(s&&s.type==='RACE')raceSessions.push({s,sIdx});});
      if(!raceSessions.length)return;
      const bestMap=weekendBestLaps(rd,rIdx,evPenMap);
      const pilotAgg=new Map();
      let firstRaceTs=rd.ts;
      for(const {s,sIdx} of raceSessions){
        const ts=new Date(s.date).getTime();
        if(isFinite(ts))firstRaceTs=isFinite(firstRaceTs)?Math.min(firstRaceTs,ts):ts;
        const lapsById={};
        (s.laps||[]).forEach(l=>{if(!l||!l.id)return;if(!lapsById[l.id])lapsById[l.id]=[];lapsById[l.id].push(l);});
        const sorted=sortSessionForPerf(s,rIdx,sIdx,evPenMap,minPct);
        const N=sorted.length;
        const foulScores=raceFoulScores({...s,results:sorted});
        sorted.forEach((r,i)=>{
          if(!r||!r.id)return;
          if(r.name)idName.set(r.id,r.name);
          if(r.team!=null)idTeam.set(r.id,r.team||'');
          const myLaps=(lapsById[r.id]||[]).filter(l=>Number.isFinite(l.time)&&l.time>0&&l.time<600000);
          const consistency=raceConsistencyMs(myLaps);
          const isOut=!!(r._dq||r.comDQ||r.comDNS||r.disqualified||r.comDNF);
          const resScore=scoreResultsV45(N,i+1,isOut);
          const fouls=foulScores.get(r.id)??0;
          if(!pilotAgg.has(r.id))pilotAgg.set(r.id,{id:r.id,n:0,consS:0,consN:0,foulS:0,foulN:0,resS:0,resN:0});
          const p=pilotAgg.get(r.id);
          p.n++;
          if(consistency!=null){p.consS+=consistency;p.consN++;}
          p.foulS+=fouls;p.foulN++;
          p.resS+=resScore;p.resN++;
        });
      }
      const entries=[];
      for(const [id,p] of pilotAgg){
        const b=bestMap.get(id);
        entries.push({
          id,
          raceCount:p.n,
          consistency:p.consN?p.consS/p.consN:null,
          foul:p.foulN?p.foulS/p.foulN:0,
          best:b?b.best:null,
          bestSession:b?b.bestSession:null,
          resScore:p.resN?p.resS/p.resN:0
        });
      }
      if(entries.length>=2&&isFinite(firstRaceTs))allWeekends.push({ts:firstRaceTs,entries});
    });
  }
  if(allWeekends.length===0)return [];
  const now=Date.now();
  const HALF_LIFE=90*24*3600*1000;
  const pilot=new Map();
  function pct(arr,key,lower){
    const valid=arr.filter(x=>Number.isFinite(x[key]));
    if(valid.length<2)return arr.map(()=>null);
    return arr.map(it=>{
      if(!Number.isFinite(it[key]))return null;
      const better=valid.filter(x=>lower?x[key]<it[key]:x[key]>it[key]).length;
      const equal=valid.filter(x=>x[key]===it[key]).length;
      return 100*(1-(better+(equal-1)/2)/(valid.length-1));
    });
  }
  function pctFoul(arr,key){
    const valid=arr.filter(x=>Number.isFinite(x[key]));
    if(valid.length<2)return arr.map(it=>(Number.isFinite(it[key])&&it[key]<=0)?100:null);
    return arr.map(it=>{
      if(!Number.isFinite(it[key]))return null;
      if(it[key]<=0)return 100;
      const better=valid.filter(x=>x[key]<it[key]).length;
      const equal=valid.filter(x=>x[key]===it[key]).length;
      return 100*(1-(better+(equal-1)/2)/(valid.length-1));
    });
  }
  for(const rc of allWeekends){
    const weight=Math.exp(-(now-rc.ts)/HALF_LIFE);
    const pcons=pct(rc.entries,'consistency',true);
    const pcln=pctFoul(rc.entries,'foul');
    const pspd=pct(rc.entries,'best',true);
    const rankedByRes=rc.entries.slice().sort((a,b)=>b.resScore-a.resScore);
    rc.entries.forEach((e,i)=>{
      if(!pilot.has(e.id)){
        pilot.set(e.id,{
          id:e.id,sumW:0,raceCount:0,
          ax:{regularite:0,proprete:0,vitesse:0,resultats:0},
          wAx:{regularite:0,proprete:0,vitesse:0,resultats:0},
          positions:[],ts:[]
        });
      }
      const p=pilot.get(e.id);
      const weekendRank=rankedByRes.findIndex(x=>x.id===e.id)+1;
      const vals={regularite:pcons[i],proprete:pcln[i],vitesse:pspd[i],resultats:e.resScore};
      for(const k in vals){
        const v=vals[k];
        if(Number.isFinite(v)){p.ax[k]+=v*weight;p.wAx[k]+=weight;}
      }
      p.sumW+=weight;
      p.raceCount+=(e.raceCount||1);
      p.positions.push(weekendRank);
      p.ts.push(rc.ts);
    });
  }
  const out=[];
  for(const [id,p] of pilot){
    if(p.sumW<=0)continue;
    const det={};
    for(const k in p.ax)det[k]=p.wAx[k]>0?p.ax[k]/p.wAx[k]:50;
    let prog=null;
    if(p.ts.length>=3){
      const idx=p.ts.map((t,i)=>({t,pos:p.positions[i]})).sort((a,b)=>a.t-b.t);
      const n=idx.length;
      const meanT=idx.reduce((a,x)=>a+x.t,0)/n;
      const meanP=idx.reduce((a,x)=>a+x.pos,0)/n;
      let num=0,den=0;
      idx.forEach(x=>{num+=(x.t-meanT)*(x.pos-meanP);den+=(x.t-meanT)**2;});
      if(den>0){
        const slope=num/den;
        prog=-slope*30*24*3600*1000;
      }
    }
    p.prog=prog;
    p.races=p.raceCount;
    p.det=det;
    out.push(p);
  }
  const progVals=out.filter(x=>Number.isFinite(x.prog)).map(x=>x.prog);
  if(progVals.length>=2){
    out.forEach(p=>{
      if(!Number.isFinite(p.prog)){p.det.progression=50;return;}
      const better=progVals.filter(v=>v>p.prog).length;
      const equal=progVals.filter(v=>v===p.prog).length;
      p.det.progression=100*(1-(better+(equal-1)/2)/(progVals.length-1));
    });
  }else{out.forEach(p=>{p.det.progression=50;});}
  const final=out.filter(p=>p.races>=GLOBAL_MIN_RACES&&!globalHidden[p.id]).map(p=>{
    const ax=p.det;
    const score=(ax.regularite+ax.proprete+ax.vitesse+ax.resultats)/4;
    return {id:p.id,name:idName.get(p.id)||'?',team:idTeam.get(p.id)||'',score,details:ax,count:p.races,trend:p.prog||0};
  }).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  final.forEach(p=>{p.level=globalLevelForScore(p.score);});
  return final;
}


// Compute standings for an event without touching global sessions/penMap
function computeEventStandings(sArr,penMapArg,cfg){
  const sess=sArr.map(s=>({...s,results:s.results.map(r=>({...r}))}));
  // Group rounds by date
  const rMap={};sess.filter(s=>s&&s.date).forEach(s=>(rMap[s.date.slice(0,10)]??=[]).push(s));
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
    let poleId=null;
    for(let si=0;si<r.sessions.length;si++){
      const s=r.sessions[si];
      applyPens(s,j,si);
      if(s.type==='QUALIFY'){
        const qPole=s.results.filter(p=>!p.disqualified&&!p.comDQ&&(p.laps||0)>=2&&Number.isFinite(p.best)&&p.best>0)
          .sort((a,b)=>(a.best+(a.comTimeAdd||0))-(b.best+(b.comTimeAdd||0)))[0];
        poleId=qPole?qPole.id:null;
      }
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
        let cls=0;
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
          d.eventTotal+=pts;
          if(d.rounds.length<=j)d.rounds.push(0);
          d.rounds[j]+=pts;
        });
      }
    }
    if(poleId&&pole){
      const d=map.get(poleId);
      if(d){d.eventTotal+=pole*mult;if(d.rounds.length<=j)d.rounds.push(0);d.rounds[j]+=pole*mult;}
    }
  }
  const ptsAdj=championshipPointsMap(penMapArg);
  ptsAdj.forEach((delta,did)=>{
    const d=map.get(did);
    if(d)d.eventTotal+=delta;
  });
  return [...map.values()];
}

// Home for legacy mode OR when an event is loaded (becomes that event's "home")
function home(){
  if(backendMulti&&!eventContext)return hub();
  if(backendMulti&&eventContext&&!events.find(e=>e.slug===eventContext.slug)){
    // eventContext périmé (ex: événement supprimé) → retour au hub
    eventContext=null;currentSlug=null;return hub();
  }
  let rs=rounds(),last=rs.at(-1);
  const isLola=!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG;
  // Hero original Lola T290
  if(isLola){
    return `<div class="hero"><div class="hero-text"><div class="eyebrow" style="color:#d7a347">● &nbsp; LE CHAMPIONNAT HISTORIQUE GDSP</div><h1>International<br>Series <em>Lola T290</em></h1><p>Six manches, une voiture de légende et l’esprit gentleman driver. Revivez le championnat comme si vous y étiez.</p><button class="btn" onclick="go('manches')">Explorer les résultats &nbsp; ↗</button></div><div class="hero-image"></div></div><div class="stats"><div class="stat"><span class="label">Manches prévues</span><strong>06</strong></div><div class="stat"><span class="label">Manches importées</span><strong>${String(rs.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Pilotes dans les fichiers</span><strong>${allDrivers().length}</strong></div><div class="stat"><span class="label">Voitures sur le serveur</span><strong>30 max.</strong></div></div>${info()}<div class="section-head"><div><div class="eyebrow">Le carnet de course</div><h2>Au cœur de la saison</h2></div></div><div class="grid"><div class="panel"><div class="eyebrow">Dernière manche importée</div><h2>${last?esc(last.track):'—'}</h2><p class="note">${last?`${date(last.date)} · ${last.sessions.length-1} course(s) · Manche ${last.number}`:'Aucune session importée.'}</p>${last?`<button class="btn secondary" onclick="round=${rs.length-1};sessionIndex=1;go('manches')">Voir les résultats →</button>`:''}</div><div class="panel"><div class="eyebrow">La formule</div><h2>Un retour aux années 70</h2><p class="note">Quatre manches en 2 × 25 minutes, deux manches d’une heure, un calendrier évolutif et une seule ambition : faire vivre la compétition historique.</p><span class="tag">ASSETTO CORSA</span> &nbsp; <span class="tag">LOLA T290</span></div></div>`;
  }
  // Hero générique pour les autres événements (opens, autres championnats)
  const evName=eventContext.name||'Événement';
  return `<div class="hero"><div class="hero-text"><div class="eyebrow" style="color:#d7a347">● &nbsp; ${esc((eventContext.kind||'').toUpperCase())} GDSP</div><h1>${esc(evName)}</h1><p>Saison en cours, classements, résultats course par course et profils pilotes.</p><button class="btn" onclick="go('manches')">Explorer les résultats &nbsp; ↗</button></div><div class="hero-image"></div></div><div class="stats"><div class="stat"><span class="label">Manches importées</span><strong>${String(rs.length).padStart(2,'0')}</strong></div><div class="stat"><span class="label">Pilotes</span><strong>${allDrivers().length}</strong></div><div class="stat"><span class="label">Coefficient global</span><strong>×${(pointsConfig().globalCoef||1).toFixed(1)}</strong></div><div class="stat"><span class="label">Type</span><strong>${esc(eventContext.kind)}</strong></div></div><div class="section-head"><div><div class="eyebrow">Le carnet de course</div><h2>Au cœur de la saison</h2></div></div><div class="grid"><div class="panel"><div class="eyebrow">Dernière manche importée</div><h2>${last?esc(last.track):'—'}</h2><p class="note">${last?`${date(last.date)} · ${last.sessions.length-1} course(s) · Manche ${last.number}`:'Aucune session importée.'}</p>${last?`<button class="btn secondary" onclick="round=${rs.length-1};sessionIndex=1;go('manches')">Voir les résultats →</button>`:''}</div><div class="panel"><div class="eyebrow">Barème appliqué</div><h2>${(pointsConfig().pointsScale||[]).slice(0,5).join('/')}…</h2><p class="note">${pointsConfig().doubleLongRaces?'Points doublés pour les courses d’1h. ':''}+${pointsConfig().polePoints||0} pt pôle · ${Math.round((pointsConfig().minPercentDistance||0.75)*100)}% de distance · coeff ×${(pointsConfig().globalCoef||1).toFixed(1)}.</p><span class="tag">ASSETTO CORSA</span></div></div>`;
}

// Liveries (Lola T290 2026 — gardé en dur, d'autres championnats pourront avoir leurs propres visuels plus tard)
const liveries=[['pistol','pistol','01'],['kimy','kimy','07'],['zplouch','jim','08'],['streetbike','streetbike','09'],['fmherrou','fmherrou','10'],['lenain','lenain','11'],['ponge','thomas','13'],['yohana','yohana','14'],['tofusan','tofusan','21'],['holden','holden','23'],['assassin','assassins','25'],['elouan','elouan','27'],['harryth','harry','28'],['jenkweed','jenkweed','29'],['erwann','erwann','30'],['arthur maus','arthur','31'],['alexou','alexou','33'],['orthopedux','victor','35'],['superslipos','superslipos','42'],['51r gilles','gilles','55'],['51r sherman','sherman','56'],['richard','richard','66'],['cheucheu','cheucheu','69'],['karl74','karl','74'],['neutraliz','neutraliz','77'],['alan mc','alan','84'],['pierre','pierre','86'],['kant-1','kant','88']];
function livery(name){return liveries.find(x=>(name||'').toLocaleLowerCase('fr').includes(x[0]))}
function car(name){
  const isLola=!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG||eventContext.slug===ACTIVE_LOLA_SLUG;
  if(!isLola)return `<span class="muted">${esc(carModel(name)||'—')}</span>`;
  let l=livery(name);return l?`<img class="car-thumb" src="/assets/${l[1]}.jpg?v=6" alt="Voiture n° ${l[2]} de ${esc(name)}">`:'<span class="muted">Visuel à ajouter</span>'
}
function carModel(name){
  // find model from current event sessions
  for(const s of sessions){for(const r of (s.results||[])){if(r.name===name)return r.model||''}}
  return '';
}
function number(name){let l=livery(name);return l?`<span class="race-number">${l[2]}</span>`:'—'}

// Per-event points helper using current pointsConfig()
function baseFull(place,multiplier){
  const sc=pointsConfig().pointsScale||DEFAULT_POINTS.pointsScale;
  return (sc[place-1]||0)*multiplier;
}

function championshipPointsMap(pm){
  if(typeof window!=='undefined'&&typeof window.championshipPointsAdjustments==='function'){
    return window.championshipPointsAdjustments(pm);
  }
  const out=new Map();
  if(!pm||typeof pm!=='object')return out;
  for(const k in pm){
    const a=pm[k];
    if(!a||typeof a!=='object')continue;
    const delta=Number(a.pointsDelta);
    if(!Number.isFinite(delta)||delta===0)continue;
    const did=a.driverId||(k.startsWith('champ:')?k.split(':')[1]:k.split(':')[2]);
    if(!did)continue;
    out.set(did,(out.get(did)||0)+delta);
  }
  return out;
}
function pointsAdjCell(val){
  const n=Number(val)||0;
  if(!n)return '<td class="muted">—</td>';
  if(n<0)return `<td class="penalty">${n}</td>`;
  return `<td style="color:#3b6341;font-weight:700">+${n}</td>`;
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
    let r=rs[j],races=r.sessions.filter(s=>s.type==='RACE'),qual=r.sessions.find(s=>s.type==='QUALIFY'),multiplier=races.length===1&&doubleLong?2:1;
    const qPole=qual&&qual.results.find(p=>{
      const best=Number.isFinite(p._adjustedBest)?p._adjustedBest:p.best;
      return !p.disqualified&&!p.comDQ&&!p.comDNS&&!p.comDNF&&!p._dq&&(p.laps||0)>=2&&Number.isFinite(best)&&best>0&&best<1e17;
    });
    for(let race of races){
      let clsIdx=0;
      race.results.forEach((p,i)=>{
        let d=map.get(p.id);if(!d)return;
        let s=finishStatus(race,p),pts=0,place=i+1;
        if(s.full){clsIdx++;pts=(sc[clsIdx-1]||0)*multiplier}
        if(effDQ(p))pts=0;
        d.rounds[j]+=pts;
        if(pts>0){
          let mm=2*multiplier;
          if(typeof p.grid==='number'&&p.grid>0){let gain=p.grid-place;if(gain>=6)mm+=3*multiplier;else if(gain>=4)mm+=2*multiplier;else if(gain>=2)mm+=1*multiplier}
          d.merit[j]+=mm;
        }
      });
    }
    if(qPole&&polePts){
      const d=map.get(qPole.id);
      if(d)d.rounds[j]+=polePts*multiplier;
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
  const ptsAdj=championshipPointsMap(penMap);
  return [...map.values()].map(d=>{
    const pointsAdj=ptsAdj.get(d.id)||0;
    return {...d,pointsAdj,total:d.rounds.reduce((a,b)=>a+b,0)+pointsAdj,joker:jokerTotal(d.rounds)+pointsAdj,meritTotal:d.merit.reduce((a,b)=>a+b,0)};
  });
}
function meritRows(){let rs=rounds(),ds=calculate();ds.sort((a,b)=>b.meritTotal-a.meritTotal||a.name.localeCompare(b.name));const isL=!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG||eventContext.slug===ACTIVE_LOLA_SLUG;const carCol=isL?'Voiture':'Modèle';return table(['Pos.','N°','Pilote',carCol,...rs.map(x=>'M'+x.number),'Total mérite'],ds.map((d,i)=>`<tr><td class="pos">${i+1}</td><td>${number(d.name)}</td><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td><td>${car(d.name)}</td>${d.merit.map(p=>`<td>${p}</td>`).join('')}<td><b>${d.meritTotal}</b></td></tr>`))}
function ranking(){
  if(backendMulti&&!eventContext)return hub();
  let ds=calculate(),r=rounds(),value=ranktab==='joker'?'joker':'total';
  let tabshtml=tabs([['pilotes','Pilotes'],['joker',jokerTabLabel()],['equipes','Équipes'],['merite','Trophée du mérite']],ranktab,'showrank');
  if(ranktab==='merite')return `${head('classements','La course aux points','Pilotes, équipes et Trophée du mérite.')}${tabshtml}<div class="panel"><h2>Trophée du mérite</h2><p class="note">Course terminée, meilleur tour en course, meilleur temps en course qu'en qualification, progression depuis la grille, résultat meilleur que son classement général à partir de la manche 2, et absence de pénalité post-course. Les manches d'une heure rapportent le double.</p>${meritRows()}</div>`;
  let rows;
  if(ranktab==='equipes'){
    let teams=new Map;
    ds.forEach(d=>{let t=(d.team||'').trim();if(!t||/indépendant/i.test(t))return;let key=t.toLocaleLowerCase('fr');if(!teams.has(key))teams.set(key,{name:t,rounds:Array(r.length).fill(0),pointsAdj:0,count:0});let team=teams.get(key);team.count++;team.pointsAdj+=(d.pointsAdj||0);for(let j=0;j<r.length;j++)team.rounds[j]+=d.rounds[j]});
    const hasTeamAdj=[...teams.values()].some(t=>t.pointsAdj);
    let arr=[...teams.values()].map(t=>({...t,total:t.rounds.reduce((a,b)=>a+b,0)+t.pointsAdj,joker:jokerTotal(t.rounds)+t.pointsAdj})).sort((a,b)=>b.joker-a.joker);
    rows=table(['Pos.','Équipe issue des fichiers','Pilotes',...r.map(x=>'M'+x.number),...(hasTeamAdj?['Ajust.']:[]),'Total Joker'],arr.map((t,i)=>`<tr><td class="pos">${i+1}</td><td><b>${esc(t.name)}</b></td><td>${t.count}</td>${t.rounds.map(p=>`<td>${p}</td>`).join('')}${hasTeamAdj?pointsAdjCell(t.pointsAdj):''}<td><b>${t.joker}</b></td></tr>`));
  }else{
    ds.sort((a,b)=>b[value]-a[value]||a.name.localeCompare(b.name));
    const carHead=(!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG||eventContext.slug===ACTIVE_LOLA_SLUG)?'Voiture':'Modèle';
    const hasAdj=ds.some(d=>d.pointsAdj);
    rows=table(['Pos.','N°','Pilote',carHead,...r.map(x=>'M'+x.number),...(hasAdj?['Ajust.']:[]),ranktab==='joker'?'Total Joker':'Total'],ds.map((d,i)=>`<tr><td class="pos">${i+1}</td><td>${number(d.name)}</td><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td><td>${car(d.name)}</td>${d.rounds.map(p=>`<td>${p}</td>`).join('')}${hasAdj?pointsAdjCell(d.pointsAdj):''}<td><b>${d[value]}</b></td></tr>`));
  }
  return `${head('classements','La course aux points','Pilotes et équipes selon le barème de cet événement.')}${tabshtml}<div class="panel"><h2>${({pilotes:'Classement général',joker:'Classement Joker',equipes:'Classement équipes'})[ranktab]}</h2><p class="note">${ranktab==='equipes'?`Points des pilotes cumulés par équipe ; ${jokerDescription()}`:ranktab==='joker'?jokerDescription():'Tous les résultats sont cumulés.'}</p>${rows}</div>`;
}

// ---------- Espace Événement unifié (Accueil événement + Classements + Résultats + Pilotes) ----------
function isSafeHttpUrl(u){
  if(typeof u!=='string')return false;
  const s=u.trim();
  if(!s)return false;
  return /^https?:\/\/[^\s"'<>]+$/i.test(s)||/^\/[a-z0-9_\-./?=&]+$/i.test(s);
}
function getEventInfo(evCtx){
  const ctx=evCtx||eventContext||{};
  const raw=(ctx.data&&ctx.data.eventInfo&&typeof ctx.data.eventInfo==='object')?ctx.data.eventInfo:{};
  const isLola=!ctx.slug||ctx.slug===LEGACY_DEFAULT_SLUG||ctx.slug===ACTIVE_LOLA_SLUG;
  let detectedModel='';
  for(const s of sessions){
    for(const r of (s.results||[])){
      if(r&&r.model){detectedModel=r.model;break;}
    }
    if(detectedModel)break;
  }
  const cfg=pointsConfig();
  const defaultCar=isLola?'Lola T290 · Prototypes historiques':(detectedModel||(ctx.kind==='open'?'Open · Assetto Corsa':'Championnat · Assetto Corsa'));
  const defaultSchedule='Mercredi soir · Informations & briefing sur le Discord GDSP';
  const defaultBriefing=isLola
    ?"Six manches historiques, l'esprit Gentleman Driver et tout le suivi du championnat réunis au même endroit : affiche officielle, calendrier, podium provisoire, classements, résultats et fiches pilotes."
    :"Retrouvez sur cette page l'affiche officielle, les informations pratiques, le calendrier des manches et l'accès direct aux classements, résultats et fiches pilotes de l'événement.";
  const defaultFormat=`${cfg.doubleLongRaces!==false?'Manches à course unique (1h) à points doublés · ':''}${cfg.polePoints?'+'+cfg.polePoints+' pt pole en qualification · ':''}${Math.round((cfg.minPercentDistance||0.75)*100)} % de distance minimale pour marquer des points.`;
  return {
    car:String(raw.car||'').trim()||defaultCar,
    schedule:String(raw.schedule||'').trim()||defaultSchedule,
    briefing:String(raw.briefing||'').trim()||defaultBriefing,
    formatText:String(raw.formatText||'').trim()||defaultFormat,
    rulesUrl:isSafeHttpUrl(raw.rulesUrl)?raw.rulesUrl.trim():'',
    skinsUrl:isSafeHttpUrl(raw.skinsUrl)?raw.skinsUrl.trim():'',
    discordUrl:isSafeHttpUrl(raw.discordUrl)?raw.discordUrl.trim():'https://discord.gg/kDZXwRgRS'
  };
}
function getEventGallery(evCtx){
  const ctx=evCtx||eventContext;
  const arr=(ctx&&ctx.data&&Array.isArray(ctx.data.galleryImages))?ctx.data.galleryImages:[];
  return arr.filter(g=>g&&isSafePosterSrc(g.src)).map(g=>({src:g.src.trim(),caption:String(g.caption||'').trim()}));
}
function eventHome(){
  if(backendMulti&&!eventContext)return hub();
  const ev=eventContext||{slug:LEGACY_DEFAULT_SLUG,name:'International Series Lola T290',kind:'championship',pointsConfig:DEFAULT_POINTS,data:{}};
  const infoObj=getEventInfo(ev);
  const gallery=getEventGallery(ev);
  const rs=rounds();
  const ds=allDrivers();
  const cfg=pointsConfig();
  const posterBlock=renderEventPosterBlock();
  const adminPosterHint=(!posterBlock&&adminAuth&&currentSlug)
    ?`<div class="panel" style="margin-bottom:22px;text-align:center;background:#f4ecd8"><p class="note" style="margin:0 0 10px">Aucune affiche officielle n'est encore enregistrée pour <b>${esc(ev.name)}</b>.</p><button type="button" class="btn secondary small" onclick="adminTab='events';go('admin')">🖼️ Ajouter une affiche dans Administration → Événements</button></div>`
    :'';

  const importedDates=new Set(rs.map(r=>String(r.date).slice(0,10)));
  const plannedExtras=(customCalendar&&typeof customCalendar==='object')
    ?Object.entries(customCalendar)
      .filter(([dt,val])=>dt&&val&&!importedDates.has(String(dt).slice(0,10)))
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([dt,val])=>({date:dt,track:val.track||'Circuit à annoncer'}))
    :[];
  const isLola=!ev.slug||ev.slug===LEGACY_DEFAULT_SLUG||ev.slug===ACTIVE_LOLA_SLUG;
  const totalExpected=Number(cfg.expectedRounds)||(isLola?Math.max(6,rs.length+plannedExtras.length):(rs.length+plannedExtras.length));

  const carParts=infoObj.car.split('·');
  const carMain=(carParts[0]||'Assetto Corsa').trim();
  const carSub=(carParts.slice(1).join('·')||'Assetto Corsa').trim();

  const kpisHtml=`<div class="ev-kpis">`
    +`<div class="ev-kpi"><span class="label">Progression saison</span><strong>${totalExpected?`${String(rs.length).padStart(2,'0')} / ${String(totalExpected).padStart(2,'0')}`:String(rs.length).padStart(2,'0')}</strong><small>${rs.length?`${rs.length} manche(s) disputée(s)`:'Coup d’envoi à venir'}</small></div>`
    +`<div class="ev-kpi gold"><span class="label">Pilotes engagés</span><strong>${ds.length||'Inscriptions'}</strong><small>${ds.length?'Classés ou ayant pris un départ':'Ouvertes sur le Discord GDSP'}</small></div>`
    +`<div class="ev-kpi green"><span class="label">Voiture / Plateau</span><strong style="font-size:21px;line-height:1.2">${esc(carMain)}</strong><small>${esc(carSub)}</small></div>`
    +`<div class="ev-kpi red"><span class="label">Coefficient Global</span><strong>×${Number(cfg.globalCoef??1).toFixed(1)}</strong><small>${cfg.polePoints?`+${cfg.polePoints} pt pole · `:''}${Math.round((cfg.minPercentDistance||0.75)*100)} % distance min.</small></div>`
    +`</div>`;

  const linksArr=[];
  if(infoObj.rulesUrl)linksArr.push({icon:'📘',label:"Règlement de l'événement",hint:'Consulter le document',url:infoObj.rulesUrl});
  if(infoObj.skinsUrl)linksArr.push({icon:'🎨',label:'Pack Skins / Téléchargement',hint:'Ressources événement',url:infoObj.skinsUrl});
  if(infoObj.discordUrl)linksArr.push({icon:'💬',label:'Salon Discord GDSP',hint:'Inscriptions, briefing & annonces',url:infoObj.discordUrl});

  const jokerRuleTxt=ev.kind==='open'
    ?'Sans Joker (open)'
    :(shouldDropWorstJoker()?'1 pire manche décomptée':(Number(cfg.jokerCount)>0?`${cfg.jokerCount} meilleures manches`:'Toutes les manches'));

  const infoGridHtml=`<div class="ev-two-col">`
    +`<div class="panel"><div class="eyebrow">Présentation de l'événement</div><h2 style="margin-top:4px">Briefing &amp; Infos pratiques</h2>`
    +`<p class="note" style="font-size:14px;color:#3d4745">${esc(infoObj.briefing).replace(/\n/g,'<br>')}</p>`
    +`<p class="note" style="margin-top:10px"><b>📅 Rendez-vous :</b> ${esc(infoObj.schedule)}</p>`
    +(linksArr.length?`<div class="ev-links">${linksArr.map(l=>`<a class="ev-link-item" href="${esc(l.url)}" target="_blank" rel="noopener"><span>${l.icon} &nbsp; ${esc(l.label)}</span><small>${esc(l.hint)} ↗</small></a>`).join('')}</div>`:'')
    +`</div>`
    +`<div class="panel"><div class="eyebrow">Règlement sportif</div><h2 style="margin-top:4px">Format &amp; Barème</h2>`
    +`<p class="note">${esc(infoObj.formatText)}</p>`
    +`<ul class="ev-spec-list">`
    +`<li><span>Catégorie</span><b>${esc(infoObj.car)}</b></li>`
    +`<li><span>Top 5 barème</span><b>${(cfg.pointsScale||DEFAULT_POINTS.pointsScale).slice(0,5).join(' · ')} pts…</b></li>`
    +`<li><span>Course longue (1h)</span><b>${cfg.doubleLongRaces!==false?'Points doublés (×2)':'Barème standard'}</b></li>`
    +`<li><span>Bonus Pole Qualif</span><b>${cfg.polePoints?'+'+cfg.polePoints+' point':'Aucun'}</b></li>`
    +`<li><span>Règle Joker</span><b>${esc(jokerRuleTxt)}</b></li>`
    +`</ul></div></div>`;

  const galleryHtml=gallery.length
    ?`<div class="section-head" style="margin-top:10px"><div><div class="eyebrow">En piste &amp; dans les stands</div><h2>Galerie de l'événement</h2></div><span class="muted">Cliquer sur une image pour agrandir</span></div>`
      +`<div class="ev-gallery">${gallery.map(g=>{
        const cap=g.caption||ev.name||'Image événement';
        return `<div class="ev-gal-card" onclick="openPosterLightbox(this.dataset.src,this.dataset.cap)" data-src="${esc(g.src)}" data-cap="${esc(cap)}"><div class="ev-gal-img-wrap"><img src="${esc(g.src)}" alt="${esc(cap)}"></div>${g.caption?`<div class="ev-gal-cap"><b>📷</b> ${esc(g.caption)}</div>`:''}</div>`;
      }).join('')}</div>`
    :'';

  const calRows=[];
  rs.forEach((r,idx)=>{
    const races=r.sessions.filter(s=>s.type==='RACE');
    const fmtLbl=(races.length===1&&cfg.doubleLongRaces!==false)?'Endurance (points ×2)':`${races.length} course${races.length>1?'s':''}`;
    let winTxt='';
    if(races[0]){
      const sorted=sortSession(races[0]);
      const win=sorted.find(x=>!x._dq&&!x.comDNF&&!x.comDNS);
      if(win&&win.name)winTxt=`🏆 ${win.name}`;
    }
    calRows.push(`<div class="ev-cal-row done"><div class="ev-cal-num">M${r.number}</div><div><b>${esc(r.track)}</b> &nbsp; <span class="muted">· ${esc(fmtLbl)}</span><div class="muted" style="margin-top:2px">${date(r.date)}${winTxt?` &nbsp;·&nbsp; <span style="color:#3b6341;font-weight:700">${esc(winTxt)}</span>`:''}</div></div><div><button type="button" class="btn secondary small" onclick="openEventRoundResult(${idx})">Résultats →</button></div></div>`);
  });
  plannedExtras.forEach((p,idx)=>{
    const mNum=rs.length+idx+1;
    calRows.push(`<div class="ev-cal-row"><div class="ev-cal-num">M${mNum}</div><div><b>${esc(track(p.track))}</b> &nbsp; <span class="muted">· Programmée</span><div class="muted" style="margin-top:2px">${date(p.date)}</div></div><div><span class="tag" style="background:#efe6d0;color:#6d726c">À VENIR</span></div></div>`);
  });

  const calendarPanel=`<div class="panel"><div class="eyebrow">Programme de la saison</div><h2 style="margin-top:4px">Calendrier des manches</h2>${calRows.length?`<div>${calRows.join('')}</div>`:`<p class="note">Aucune manche programmée ou importée pour l'instant.</p>`}</div>`;

  let podiumPanel='';
  if(rs.length>0&&ds.length>0){
    const standings=calculate().slice().sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));
    const top3=standings.slice(0,3);
    const meritLeader=standings.slice().sort((a,b)=>b.meritTotal-a.meritTotal||a.name.localeCompare(b.name))[0];
    podiumPanel=`<div class="panel"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap"><div><div class="eyebrow">Situation au championnat</div><h2 style="margin-top:4px">Podium provisoire</h2></div><button type="button" class="btn small" onclick="setEventSubTab('classement')">Classement complet →</button></div>`
      +`<div style="margin-top:12px">${top3.map((p,i)=>`<div class="ev-podium-row" data-did="${esc(p.id)}" onclick="openEventDriver(this.dataset.did)"><div style="display:flex;align-items:center;gap:12px"><span class="podium-pill p${i+1}">P${i+1}</span><div><b>${esc(p.name)}</b>${number(p.name)!=='—'?' &nbsp;'+number(p.name):''}<div class="muted">${esc(p.team||'Pilote indépendant')} · Joker : ${p.joker} pts</div></div></div><div style="text-align:right"><strong style="font-family:Impact,sans-serif;font-size:24px;color:var(--ink)">${p.total} <small style="font-family:Arial;font-size:11px;color:#6d726c">PTS</small></strong></div></div>`).join('')}</div>`
      +(meritLeader&&meritLeader.meritTotal>0?`<div style="margin-top:14px;padding:11px 14px;background:#efe6d0;border-left:4px solid #d7a347;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px"><span>🎖 <b>Leader Trophée du mérite :</b> ${esc(meritLeader.name)} (${meritLeader.meritTotal} pts)</span><a style="color:var(--red);font-weight:700;cursor:pointer" onclick="ranktab='merite';setEventSubTab('classement')">Voir →</a></div>`:'')
      +`</div>`;
  }else{
    podiumPanel=`<div class="panel"><div class="eyebrow">Inscriptions &amp; Départ</div><h2 style="margin-top:4px">Événement à venir</h2><p class="note">Aucune session n'a encore été disputée sur cet événement. Dès que la première manche sera importée, le podium provisoire, les résultats et les fiches pilotes apparaîtront automatiquement ici.</p><div style="margin-top:16px"><a class="btn" href="${esc(infoObj.discordUrl||'https://discord.gg/kDZXwRgRS')}" target="_blank" rel="noopener">Rejoindre sur Discord ↗</a></div></div>`;
  }

  return `<div class="ev-home-wrap"><div class="ev-home-poster">${posterBlock}${adminPosterHint}</div>${kpisHtml}${infoGridHtml}${galleryHtml}<div class="ev-two-col">${calendarPanel}${podiumPanel}</div></div>`;
}
function renderEventShell(){
  if(backendMulti&&!eventContext)return hub();
  const ev=eventContext||{slug:LEGACY_DEFAULT_SLUG,name:'International Series Lola T290',kind:'championship'};
  const rs=rounds();
  const ds=allDrivers();
  const cfg=pointsConfig();
  const badgeHtml=ev.kind==='open'
    ?'<span class="tag open">OPEN GDSP</span>'
    :ev.kind==='archive'
    ?'<span class="tag archive">SAISON ARCHIVÉE</span>'
    :(rs.length===0?'<span class="tag" style="background:#d7a347;color:#102a32">CHAMPIONNAT À VENIR</span>':'<span class="tag live">CHAMPIONNAT EN COURS</span>');

  const activeSub=page==='classement'?'classement':page==='manches'?'manches':page==='pilotes'?'pilotes':(page==='circuit'&&hasCircuitData())?'circuit':'event';
  const subBody=activeSub==='classement'?ranking():activeSub==='manches'?manche():activeSub==='pilotes'?drivers():activeSub==='circuit'?circuit():eventHome();

  return `<div class="ev-shell">`
    +`<div class="ev-banner"><div><div class="ev-banner-kicker">${badgeHtml}<span style="font-size:11px;letter-spacing:1.8px;color:#d7a347;font-weight:700;text-transform:uppercase">Espace événement GDSP</span></div><h1>${esc(ev.name)}</h1><div class="ev-banner-meta">${rs.length?`${rs.length} manche(s) importée(s) · ${ds.length} pilote(s) engagé(s)`:'Saison en préparation · Inscriptions sur Discord'} · Coefficient Global ×${Number(cfg.globalCoef??1).toFixed(1)}</div></div>`
    +`</div>`
    +`<div class="ev-subtabs">`
    +`<button type="button" class="ev-subtab ${activeSub==='event'?'active':''}" onclick="setEventSubTab('event')">Accueil <span class="ev-subtab-badge">Affiche &amp; Infos</span></button>`
    +`<button type="button" class="ev-subtab ${activeSub==='classement'?'active':''}" onclick="setEventSubTab('classement')">Classements <span class="ev-subtab-badge">${ds.length||0}</span></button>`
    +`<button type="button" class="ev-subtab ${activeSub==='manches'?'active':''}" onclick="setEventSubTab('manches')">Résultats <span class="ev-subtab-badge">${rs.length} M.</span></button>`
    +(hasCircuitData()?`<button type="button" class="ev-subtab ${activeSub==='circuit'?'active':''}" onclick="setEventSubTab('circuit')">Circuit <span class="ev-subtab-badge">${esc(circuitBadgeLabel())}</span></button>`:'')
    +`<button type="button" class="ev-subtab ${activeSub==='pilotes'?'active':''}" onclick="setEventSubTab('pilotes')">Pilotes <span class="ev-subtab-badge">${ds.length||0}</span></button>`
    +`</div></div>`
    +`<div class="ev-subcontent">${subBody}</div>`;
}

// ---------- Onglet Circuit (section championnat) ----------
// Une fiche par manche : M1 Mont-Tremblant → M6 Österreichring.
// La manche affichée est choisie par le bandeau de manches (ou l'URL #M4).
const CIRCUIT_ROUND_KEY = 'gdsp_circuit_round';
const CIRCUIT_ALT_KEY = 'gdsp_circuit_alt';
let circuitsCache = null, circuitsError = '', circuitsPending = null;

/** Manche sélectionnée (numéro), bornée au calendrier chargé. */
function circuitRound(){
  const data = circuitsCache;
  const total = (data && data.rounds && data.rounds.length) || 6;
  const raw = Number(localStorage.getItem(CIRCUIT_ROUND_KEY));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(total, Math.round(raw));
}
function setCircuitRound(n){
  const total = (circuitsCache && circuitsCache.rounds && circuitsCache.rounds.length) || 6;
  const val = Math.max(1, Math.min(total, Number(n) || 1));
  localStorage.setItem(CIRCUIT_ROUND_KEY, String(val));
  render();
}
/** Variante affichée : seulement pour les circuits qui en ont plusieurs. */
function circuitAlt(){
  return localStorage.getItem(CIRCUIT_ALT_KEY) === 'no_chicane' ? 'no_chicane' : 'chicane';
}
function setCircuitAlt(key){
  localStorage.setItem(CIRCUIT_ALT_KEY, key === 'no_chicane' ? 'no_chicane' : 'chicane');
  render();
}
/**
 * Manches ajoutées depuis l'administration (import Drive).
 * Elles vivent dans l'événement (`data.circuitRounds`), donc elles sont
 * persistées en PostgreSQL et partagées par tous les visiteurs, alors que
 * `data/circuits.json` est un fichier statique du dépôt.
 */
function importedCircuitRounds(){
  const d = (eventContext && eventContext.data) || {};
  const list = d.circuitRounds;
  return Array.isArray(list) ? list.filter(r => r && typeof r === 'object' && r.name) : [];
}
/**
 * Fusionne les manches statiques et importées.
 * Une manche importée portant le même numéro remplace la statique.
 */
function mergeCircuitRounds(base, extra){
  const byRound = new Map();
  const key = r => (Number.isFinite(Number(r && r.round)) && Number(r.round) > 0)
    ? 'n' + Number(r.round)
    : 'k' + String((r && (r.id || r.name)) || '');
  for (const r of base) byRound.set(key(r), r);
  for (const r of extra) byRound.set(key(r), { ...byRound.get(key(r)), ...r, imported: true });
  const hasRound = r => Number.isFinite(Number(r && r.round)) && Number(r.round) > 0;
  const sorted = [...byRound.values()].sort((a, b) => {
    const ra = Number(a.round), rb = Number(b.round);
    if (hasRound(a) && hasRound(b) && ra !== rb) return ra - rb;
    // Les manches sans numéro passent après celles qui en ont un.
    if (hasRound(a) !== hasRound(b)) return hasRound(a) ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  // Numérotation finale : on garde le numéro fourni, sinon on prend le premier
  // numéro libre (jamais M1 si M1 existe déjà).
  const used = new Set(sorted.filter(hasRound).map(r => Number(r.round)));
  let next = 1;
  return sorted.map(r => {
    let n = Number(r.round);
    if (!hasRound(r)) { while (used.has(next)) next++; n = next; used.add(n); }
    return { ...r, round: n, label: r.label || `M${n}` };
  });
}
async function circuitsData(){
  if (circuitsCache) return circuitsCache;
  if (circuitsError) return null;
  let base = null, err = '';
  // `data/circuits.json` décrit le championnat Lola T290. Les autres événements
  // n'ont que les manches importées depuis l'administration : y mêler le
  // calendrier Lola afficherait six circuits qui ne les concernent pas.
  if (isLolaEvent()) {
    try {
      const r = await fetch('/data/circuits.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      base = await r.json();
      if (!base || !Array.isArray(base.rounds)) throw new Error('Données circuit incomplètes');
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
  }
  const extra = importedCircuitRounds();
  // Les manches importées suffisent à afficher l'onglet même sans fichier statique.
  if (!base && !extra.length) { circuitsError = err || 'Aucun circuit pour cet événement'; return null; }
  const merged = mergeCircuitRounds((base && base.rounds) || [], extra);
  if (!merged.length) { circuitsError = err || 'Aucun circuit pour cet événement'; return null; }
  const j = {
    ...(base || {}),
    rounds: merged,
    totalCount: merged.length,
    completedCount: merged.filter(r => r.date || (r.stats && r.stats.races)).length
  };
  circuitsCache = j; circuitsError = '';
  return j;
}
/** Ouvre les résultats importés de la manche circuit affichée (appariement par date). */
function openCircuitRoundResult(idx){
  const data=circuitsCache;
  const r=data&&data.rounds&&data.rounds[idx];
  const rs=rounds();
  const target=circuitRoundIndex(r);
  if(target<0)return;
  // `round` est une propriété réservée de window : on passe par la navigation
  // standard (go) puis on sélectionne la manche.
  const apply=()=>{ round=target; sessionIndex=(rs[target]&&rs[target].sessions.length>1)?1:0; render(); window.scrollTo(0,0); };
  Promise.resolve(go('manches')).then(apply,apply);
}
// Correspondance entre le dossier du mod (JSON AH / Drive) et les libellés
// de piste des sessions importées.
const CIRCUIT_TRACK_ALIASES = {
  'mt-tremblant_69': ['mont-tremblant', 'mt-tremblant_69', 'mont tremblant'],
  'riverside': ['riverside'],
  'sebring_90s': ['sebring', 'sebring_90s'],
  'mid_ohio': ['mid-ohio', 'mid ohio'],
  '6thgpmexico67': ['6thgpmexico67', 'mexico'],
  'oesterreichring1979': ['oesterreichring1979', 'oesterreichring']
};
/** Retrouve l'index de la manche importée correspondant à une fiche circuit. */
function circuitRoundIndex(r){
  if(!r)return -1;
  const rs=rounds();
  const aliases=(CIRCUIT_TRACK_ALIASES[r.driverFolder]||[String(r.driverFolder||'')]).map(a=>a.toLowerCase());
  let idx=rs.findIndex(x=>aliases.includes(String(x.track||'').toLowerCase()));
  if(idx<0&&r.date){
    const d=String(r.date).slice(0,10);
    idx=rs.findIndex(x=>String(x.date||'').slice(0,10)===d);
  }
  return idx;
}
function circuitCountryCode(country){
  return ({ 'Autriche': 'AUT', 'Canada': 'CAN', 'U.S.A.': 'USA', 'USA': 'USA', 'Mexique': 'MEX' })[country] || '—';
}
/** Entier formaté à la française (séparateur d'espace insécable). */
const nb = (v, d = 0) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const frNum = (v, d = 1) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

function circuitElevSvg(profile){
  const p = profile && profile.profile;
  if (!p) return '';
  return `<svg viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden="true">`
    + `<line class="base" x1="0" y1="119" x2="1000" y2="119"/>`
    + `<path class="area" d="${p.closed}"/>`
    + `<path class="line" d="${p.path}"/></svg>`;
}

/**
 * Tracé interactif.
 * mode = corners | collisions | sectors
 */
function circuitMap(round, profile, mode, opts = {}){
  const o = (profile && profile.outline) || round.outline || {};
  if (!o.path) return '';
  const compact = !!opts.compact;
  const corners = (o.corners || []).map(c =>
    `<g class="cir-pin" data-corner="${c.id}"><circle cx="${c.x}" cy="${c.y}" r="13"/>`
    + `<text x="${c.x}" y="${c.y + 4.5}" text-anchor="middle">${c.id}</text>`
    + `<title>Virage ${c.id}${c.name ? ' · ' + esc(c.name) : ''} · ${Math.round(c.dist)} m</title></g>`).join('');
  const sectorDots = (o.sectors || []).map(s =>
    `<circle class="cir-sector-dot" cx="${s.x}" cy="${s.y}" r="8"><title>${esc(s.label || 'Secteur')} · ${Math.round(s.dist || 0)} m</title></circle>`).join('');
  const crashPins = (round.demoCollisions || []).filter(c => c.point).map((c, i) =>
    `<g class="cir-crash ${c.speed > 25 ? 'hard' : ''}"><circle cx="${c.point.x}" cy="${c.point.y}" r="${c.speed > 25 ? 11 : 8}"/>`
    + `<text x="${c.point.x}" y="${c.point.y + 4}" text-anchor="middle">${i + 1}</text>`
    + `<title>${esc(c.a)} / ${esc(c.b)} · ${c.speed} km/h · ${esc(c.corner || '')}</title></g>`).join('');
  const pins = mode === 'collisions' ? crashPins : (mode === 'sectors' ? '' : corners);
  return `<svg viewBox="${o.viewBox || '0 0 1000 560'}" role="img" aria-label="Tracé ${esc(round.name)}">`
    + `<path class="cir-map-glow" d="${o.path}"/>`
    + `<path class="cir-map-outline" d="${o.path}"/>`
    + `<path class="cir-map-center" d="${o.path}"/>`
    + (compact ? '' : sectorDots)
    + pins
    + `<circle class="cir-map-start" cx="${o.start ? o.start.x : 0}" cy="${o.start ? o.start.y : 0}" r="9"><title>Ligne de départ / arrivée</title></circle>`
    + `</svg>`;
}

function circMode(){
  const m = localStorage.getItem('gdsp_circuit_mode');
  return ['corners', 'collisions', 'sectors'].includes(m) ? m : 'corners';
}
function setCircMode(mode){
  localStorage.setItem('gdsp_circuit_mode', ['corners', 'collisions', 'sectors'].includes(mode) ? mode : 'corners');
  render();
}
function navEventTitle(name){
  return String(name || '').replace(/\s+/g, ' ').trim() || 'Championnat';
}
/**
 * L'onglet Circuit doit-il apparaître pour l'événement courant ?
 *
 * Vrai dès qu'au moins une manche existe : le calendrier statique pour le
 * championnat Lola T290, ou les manches importées depuis l'administration
 * pour n'importe quel autre événement.
 *
 * Le calendrier n'étant pas encore chargé au premier rendu, la fonction
 * déclenche le chargement et renvoie `true` de façon optimiste : sans cela
 * l'onglet n'apparaîtrait jamais. Si le chargement révèle qu'il n'y a
 * aucune manche, il disparaît au rendu suivant.
 */
function hasCircuitData(){
  if (circuitsError) return false;
  const imported = importedCircuitRounds().length;
  if (isLolaEvent()) return true;          // le championnat a son calendrier
  if (imported) return true;               // manches importées
  if (circuitsCache) return false;         // chargé : vraiment aucun circuit
  if (!circuitsPending) {
    circuitsPending = circuitsData().finally(() => {
      circuitsPending = null;
      // Re-rendu pour faire apparaître/disparaître l'onglet une fois su.
      if (page === 'event' || page === 'circuit') render();
    });
  }
  return true;
}
function isLolaEvent(){
  const slug = eventContext && eventContext.slug;
  return !slug || slug === LEGACY_DEFAULT_SLUG || slug === ACTIVE_LOLA_SLUG;
}
/** Badge de l'onglet : manche en cours de consultation + ville. */
function circuitBadgeLabel(){
  const data = circuitsCache;
  if (!data || !data.rounds || !data.rounds.length) return 'À VENIR';
  const r = data.rounds[circuitRound() - 1] || data.rounds[0];
  // Un circuit importé peut n'avoir ni ville ni pays : on n'affiche pas « M1 · ».
  const where = String(r.city || r.country || '').trim().toUpperCase();
  return where ? `${r.label} · ${where}` : String(r.label || 'À VENIR');
}
function circuitStatusLabel(round){
  return round.status === 'done' ? 'Disputée' : 'À venir';
}
function circuitDateLabel(round){
  if (round.status !== 'done') return 'Date à confirmer';
  if (round.dateLabel) return round.dateLabel;
  if (round.date) {
    const d = new Date(round.date);
    return date(d);
  }
  return 'Date à confirmer';
}

function circuit(){
  if (backendMulti && !eventContext) return hub();
  if (!hasCircuitData()) return eventHome();
  const cfg = pointsConfig();
  const data = circuitsCache;
  if (!data) {
    return `<div class="eyebrow">Programme de la saison</div><h1>Circuit</h1>`
      + `<div class="cir-wait">${circuitsError ? `La fiche circuit n'a pas pu être chargée (${esc(circuitsError)}).` : 'Chargement de la fiche circuit…'}</div>`;
  }

  const rounds = data.rounds || [];
  const idx = Math.max(0, Math.min(rounds.length - 1, circuitRound() - 1));
  const round = rounds[idx];
  const alt = circuitAlt();
  const variants = round.profiles || [];
  const activeProfile = variants.length
    ? (variants.find(p => p.key === alt) || variants[0])
    : round;
  const mode = circMode();
  const isDone = round.status === 'done';

  // --- Bandeau des manches : une pastille cliquable par manche ---
  const calendar = rounds.map((r, i) => {
    const cls = ['cir-round-pill',
      r.status === 'done' ? 'done' : 'next',
      i === idx ? 'selected' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" onclick="setCircuitRound(${r.round})" title="${esc(r.name)}">`
      + `<b>${esc(r.label)}</b><span>${esc(r.shortName || r.name)}</span>`
      + `<span class="cir-round-state">${r.status === 'done' ? 'Disputée' : 'À venir'}</span></button>`;
  }).join('');

  // --- Variantes (Österreichring uniquement) ---
  const variantButtons = variants.length > 1
    ? `<div class="cir-variants" role="group" aria-label="Variante du tracé">`
      + variants.map(v => `<button type="button" class="${v.key === activeProfile.key ? 'active' : ''}" onclick="setCircuitAlt('${esc(v.key)}')" title="${esc(v.lengthStr || '')}">${v.key === 'no_chicane' ? 'Sans chicane' : 'Avec chicane'}</button>`).join('')
      + `</div>`
    : '';

  // --- Hero ---
  const heroImage = (round.heroByVariant && round.heroByVariant[activeProfile.key]) || round.hero || null;
  // Un circuit importé n'a pas de photo : fond uni plutôt qu'une image 404.
  const heroStyle = heroImage
    ? `background-image:linear-gradient(90deg,#0f252c 0%,#0f252cf2 38%,#0f252c66 58%,#0f252c22 78%),url('/${esc(heroImage)}')`
    : 'background-image:linear-gradient(135deg,#0f252c 0%,#143a44 60%,#1c5a63 100%)';
  const heroMeta = [
    ['Plateau', isLolaEvent() ? 'Lola T290' : ((eventContext && eventContext.name) || '—')],
    ['Configuration', round.layout || 'Non précisée'],
    ['Coordonnées GPS', round.gps || 'Non communiquées'],
    ['Auteur du mod', round.author || 'Non communiqué']
  ];
  const statusChip = `<span class="cir-status ${isDone ? 'done' : ''}">${circuitStatusLabel(round)}</span>`;
  const winnerLine = round.winner
    ? `<span class="cir-winner"><small>Vainqueur</small>${esc(round.winner)}</span>`
    : `<span class="cir-winner"><small>Manche</small>à venir</span>`;

  // --- KPI ---
  const seasonBest = data.seasonBest;
  const capacity = round.pitboxes ? `${round.pitboxes} stands` : '—';
  const elev = activeProfile.elevation;
  const kpis = `<div class="cir-kpis">`
    + `<div class="cir-kpi"><span>Longueur du tracé</span><strong>${esc(activeProfile.lengthStr || round.lengthStr)}</strong><small>${esc(round.layout)} · ${esc(round.width || '')}</small></div>`
    + `<div class="cir-kpi gold"><span>Dénivelé sur un tour</span><strong>${elev ? frNum(elev.delta, 1) + ' m' : '—'}</strong><small>Alt. ${elev ? frNum(elev.min, 1) + ' m → ' + frNum(elev.max, 1) + ' m' : '—'}</small></div>`
    + `<div class="cir-kpi green"><span>Capacité des stands</span><strong>${capacity}</strong><small>${isLolaEvent() ? 'Grille Lola T290 du championnat' : 'Places en grille'}</small></div>`
    + `<div class="cir-kpi red"><span>${isLolaEvent() ? 'Meilleur tour de la saison' : 'Meilleur tour'}</span><strong>${seasonBest ? esc(seasonBest.time) : '—'}</strong><small>${seasonBest ? `${esc(seasonBest.driver)} · ${esc(seasonBest.track)}` : 'Aucun tour enregistré'}</small></div>`
    + `</div>`;

  // --- Inspecteur (3 modes) ---
  const inspector = mode === 'collisions' ? (() => {
    const list = round.demoCollisions || [];
    if (!list.length) {
      return `<div class="cir-inspector"><div class="eyebrow">Contacts</div><h3>Carte des collisions</h3>`
        + `<div class="cir-empty">Aucune collision de démonstration disponible pour ce circuit. Les contacts réels apparaîtront avec les sessions importées.</div></div>`;
    }
    return `<div class="cir-inspector"><div class="eyebrow">Contacts (démonstration)</div><h3>Carte des collisions</h3>`
      + `<p class="cir-src">Positions issues du fichier de démonstration du mod. Les contacts réels arriveront avec les sessions importées.</p>`
      + `<ul class="cir-crash-list">${list.map((c, i) => `<li><span class="cir-crash-num ${c.speed > 25 ? 'hard' : ''}">${i + 1}</span>`
        + `<span><b>${esc(c.a)}</b> / ${esc(c.b)}<small>${esc(c.corner || '')}${c.lap ? ` · tour ${c.lap}` : ''} ${c.clock ? '· ' + esc(c.clock) : ''}</small></span>`
        + `<b class="cir-speed">${c.speed ? frNum(c.speed, 1) + ' km/h' : ''}</b></li>`).join('')}</ul></div>`;
  })() : mode === 'sectors' ? (() => {
    const splits = round.outline ? (round.outline.sectors || []) : [];
    // `splits` ne contient que les bornes internes ; le dernier tronçon va
    // jusqu'à la ligne d'arrivée, d'où le +1 (3 secteurs pour 2 bornes).
    const bounds = [0, ...splits.map(s => s.at), 1];
    const marks = [0, ...splits.map(s => s.dist), round.lengthM || 0];
    const rows = splits.concat([null]).map((s, i) => {
      const from = marks[i] ?? 0;
      const to = marks[i + 1] ?? (round.lengthM || 0);
      const pct = (bounds[i + 1] ?? 1) * 100;
      return `<tr><td><b>Secteur ${i + 1}</b><small>${nb(from, 0)} m → ${nb(to, 0)} m</small></td>`
        + `<td class="cir-sector-time">${frNum(pct, 0)} %</td><td class="muted">${nb(to - from, 0)} m</td></tr>`;
    }).join('');
    return `<div class="cir-inspector"><div class="eyebrow">Chronométrie</div><h3>Découpage des secteurs</h3>`
      + `<p class="cir-src">${splits.length ? `Bornes issues du fichier <code>${esc(round.overlaysFile || 'overlays.ini')}</code> du mod.` : 'Ce circuit ne fournit pas de découpage par secteur : la chronométrie utilise les 3 tiers du tour.'}</p>`
      + (splits.length
        ? `<table class="cir-sector-table"><tbody>${rows}</tbody></table>`
        : `<div class="cir-empty">Pas de secteurs officiels dans le mod.</div>`)
      + `<div class="cir-optimal"><span>Longueur mesurée (fast_lane.ai)</span><b>${nb(round.lengthM || 0, 0)} m</b></div></div>`;
  })() : (() => {
    const corners = (round.outline && round.outline.corners) || [];
    const named = round.namedCorners;
    if (named && named.length) {
      return `<div class="cir-inspector"><div class="eyebrow">Repères du tracé</div><h3>Points du circuit</h3><ul class="cir-sections">`
        + named.map((s, i) => `<li><span class="cir-sec-num">${String(i + 1).padStart(2, '0')}</span>`
          + `<span class="cir-sec-name">${esc(s.name)}<small>${esc([s.type, s.gear ? `rapport ${s.gear}` : '', s.dist != null ? `à ${String(s.dist).replace('.', ',')} km` : ''].filter(Boolean).join(' · '))}</small></span>`
          + `<span class="cir-sec-data"><b>${s.alt != null ? frNum(s.alt, 1) + ' m' : '—'}</b><span>${s.slope != null ? (s.slope > 0 ? '+' : '') + frNum(s.slope, 1) + ' %' : ''}</span></span></li>`).join('')
        + `</ul></div>`;
    }
    if (!corners.length) {
      return `<div class="cir-inspector"><div class="eyebrow">Repères du tracé</div><h3>Points du circuit</h3>`
        + `<div class="cir-empty">Aucun virage détecté sur la ligne rapide de ce mod.</div></div>`;
    }
    return `<div class="cir-inspector"><div class="eyebrow">Repères du tracé</div><h3>Points du circuit</h3>`
      + `<p class="cir-src">${corners.length} virages relevés sur la ligne rapide (<code>fast_lane.ai</code>), numérotés depuis la ligne de départ.</p>`
      + `<ul class="cir-sections">${corners.map(c => `<li><span class="cir-sec-num">${String(c.id).padStart(2, '0')}</span>`
        + `<span class="cir-sec-name">Virage ${c.id}<small>à ${nb(c.dist, 0)} m de la ligne</small></span>`
        + `<span class="cir-sec-data"><b>${frNum(c.norm * 100, 0)} %</b><span>du tour</span></span></li>`).join('')}</ul></div>`;
  })();

  // --- Carte + profil altimétrique ---
  const cornerCount = (round.outline && round.outline.corners || []).length;
  const tabs = [
    ['corners', `Virages & secteurs (${cornerCount})`],
    ['collisions', 'Carte des collisions'],
    ['sectors', 'Records par secteur']
  ].map(([k, l]) => `<button type="button" class="${mode === k ? 'active' : ''}" onclick="setCircMode('${k}')">${l}</button>`).join('');

  // `round.outline.sectors` ne contient que les bornes INTERNES (S1/S2… sur un
  // tour en 3 secteurs). Le nombre de secteurs est donc pins + 1, et l'on se
  // fie à `sectorSplits` (source de vérité) quand il est disponible.
  const sectorPins = (round.outline && round.outline.sectors) || [];
  const sectorCount = Array.isArray(round.sectorSplits) && round.sectorSplits.length
    ? round.sectorSplits.length
    : (sectorPins.length ? sectorPins.length + 1 : 0);
  const sectorLegend = `<div class="cir-map-legend">`
    + (sectorPins.length
        ? sectorPins.map((s, i) => `<span class="lg lg-${(i % 3) + 1}">${esc(s.label || 'Secteur')} · ${nb(s.dist, 0)} m</span>`).join('')
        : `<span class="lg lg-1">Départ / arrivée</span>`)
    + `</div></div>`;

  const mapBlock = `<div class="cir-map-block">`
    + `<div class="cir-map-head"><div class="cir-map-tabs">${tabs}</div>`
    + sectorLegend
    + `<div class="cir-map-stage"><div class="cir-map-tag">${round.direction === 'clockwise' ? 'Sens horaire' : 'Sens anti-horaire'} · tracé extrait du fast_lane.ai</div>`
    + `${circuitMap(round, activeProfile, mode)}`
    + `<div class="cir-map-hint">${cornerCount} virages · ${nb(round.lengthM || 0, 0)} m mesurés</div></div>`
    + `<div class="cir-elev"><div class="cir-elev-top"><span>Profil altimétrique sur un tour</span><b>${elev ? frNum(elev.delta, 1) + " m d'amplitude" : '—'}</b></div>${circuitElevSvg(activeProfile)}</div>`
    + `</div>`;

  // --- Briefing surfaces ---
  const surfaceRows = round.surfaces || [];
  const surfaces = surfaceRows.map(s => `<tr><td><b>${esc(s.label)}</b></td><td>${s.grip != null ? frNum(s.grip, 0) + ' %' : '—'}</td>`
    + `<td><span class="cir-pill ${s.valid ? 'ok' : 'no'}">${s.valid ? 'Valide' : 'Cut'}</span></td><td class="muted">${esc(s.note)}</td></tr>`).join('');
  const briefing = `<div class="cir-panel"><div class="eyebrow">Extrait de <code>${esc(round.surfaceFile || 'surfaces.ini')}</code></div><h3>Briefing pilotes &amp; track limits</h3>`
    + (surfaceRows.length
      ? `<div class="table-wrap"><table class="cir-surfaces"><thead><tr><th>Surface</th><th>Adhérence</th><th>Statut</th><th>Comportement</th></tr></thead><tbody>${surfaces}</tbody></table></div>`
      : `<div class="cir-empty">Les surfaces de ce circuit ne sont pas disponibles.</div>`)
    + `<div class="cir-tip"><b>Rappel Direction de course :</b> le règlement du championnat s'applique quelle que soit la manche — 1 point pour la pole, 75 % de la distance minimum pour marquer, et une seule manche « Joker » décomptée sur la saison.</div></div>`;

  // --- Chronométrie / meilleurs tours de la manche ---
  const lapRows = (() => {
    const stats = round.stats;
    if (!stats) {
      return `<div class="cir-empty">Cette manche n'a pas encore été disputée : les chronos seront publiés après la course.</div>`;
    }
    const rows = [];
    if (stats.fastestLap) rows.push(['Meilleur tour (toutes sessions)', stats.fastestLap.time, stats.fastestLap.driver]);
    if (stats.fastestRaceLap) rows.push(['Meilleur tour en course', stats.fastestRaceLap.time, stats.fastestRaceLap.driver]);
    (stats.podium || []).forEach(p => rows.push([`P${p.pos} — ${p.team || 'Course'}`, p.time || '—', p.name]));
    if (!rows.length) return `<div class="cir-empty">Aucun chrono enregistré pour cette manche.</div>`;
    return `<div class="table-wrap"><table class="cir-surfaces"><thead><tr><th>Repère</th><th>Chrono</th><th>Pilote</th></tr></thead><tbody>`
      + rows.map(([k, t, d]) => `<tr><td><b>${esc(k)}</b></td><td><span class="cir-partial">${esc(t || '—')}</span></td><td>${esc(d || '')}</td></tr>`).join('')
      + `</tbody></table></div>`;
  })();

  const entries = round.stats
    ? `${round.stats.races || 0} course${(round.stats.races || 0) > 1 ? 's' : ''}`
    : (round.status === 'done' ? (round.format || '—') : 'Aucune session importée');
  const sectorsTable = `<div class="cir-panel"><div class="eyebrow">Chronométrie &amp; repères de la manche</div><h3>${esc(round.label)} · ${esc(isDone ? circuitDateLabel(round) : 'À venir')}</h3>`
    + `<p class="cir-src" style="margin:0 0 10px">${esc(round.format)}${isDone ? ' · ' + esc(entries) : ''}${round.stats && round.stats.drivers ? ` · ${round.stats.drivers} pilotes classés` : ''}${round.winner ? ` · vainqueur ${esc(round.winner)}` : ''}.</p>`
    + lapRows
    + `<div class="cir-optimal"><span>${isLolaEvent() ? 'Tour le plus rapide de la saison' : 'Tour le plus rapide'}</span><b>${seasonBest ? esc(seasonBest.time) : '—'}</b></div>`
    + `<div class="cir-link"><div><div class="eyebrow" style="margin:0">Calendrier</div><div class="muted" style="margin-top:2px">${nb(data.completedCount || 0, 0)} manches disputées sur ${nb(data.totalCount || rounds.length, 0)}.</div></div>`
    + `<button type="button" class="btn secondary small" onclick="openCircuitRoundResult(${idx})">Voir les résultats →</button></div></div>`;

  // --- Détail technique de la manche ---
  const techRows = [
    ['Manche', `${round.label} · ${round.name}`],
    ['Configuration du mod', round.layout + (round.layoutKey ? ` (${round.layoutKey})` : '')],
    ['Longueur officielle', round.lengthStr || '—'],
    ['Longueur mesurée', round.lengthM ? `${nb(round.lengthM, 0)} m` : '—'],
    ['Largeur', round.width || '—'],
    ['Sens de rotation', round.direction === 'clockwise' ? 'Horaire' : 'Anti-horaire'],
    ['Stands', round.pitboxes ? `${round.pitboxes} places` : '—'],
    ['Année du tracé', round.year || 'Non précisée'],
    ['Version du mod', round.version || 'Non précisée'],
    ['Dossier du mod', round.driveName || '—'],
    ['Source du tracé', round.source || '—']
  ];
  const tech = `<div class="cir-panel"><div class="eyebrow">Fiche technique</div><h3>Informations de la manche</h3>`
    + `<div class="table-wrap"><table class="cir-surfaces"><tbody>`
    + techRows.map(([k, v]) => `<tr><td class="muted" style="white-space:nowrap">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')
    + `</tbody></table></div></div>`;

  return `<div class="cir-roundbar">${calendar}</div>`
    + `<div class="cir-toolbar"><div class="cir-select"><span>Manche</span><b>${esc(round.label)} · ${esc(round.name)} (${esc(round.country)})</b></div>${variantButtons}</div>`
    + `<div class="cir-hero cir-hero-photo" style="${heroStyle}">`
      + `<div class="cir-hero-txt"><div>`
        + `<div class="cir-kicker"><span class="cir-flag">${esc(round.label)}</span>${statusChip}<span class="cir-eyebrow">${esc(round.city || round.country || '')} · ${esc(round.country || '')}${round.year ? ' · ' + round.year : ''}</span></div>`
        + `<h2>${esc(round.name)}</h2>`
        + `<div class="cir-hero-sub">${esc(round.layout)} · ${round.direction === 'clockwise' ? 'sens horaire' : 'sens anti-horaire'}</div>`
        + `<dl class="cir-hero-meta">${heroMeta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
      + `</div>`
      + `<div class="cir-hero-actions"><button type="button" class="btn" onclick="setCircMode('corners')">Track guide &amp; virages</button>`
        + `<span class="cir-date-chip"><i>${isDone ? 'Course' : 'Cal.'}</i> ${esc(circuitDateLabel(round))}</span>${winnerLine}</div>`
      + `</div>`
      + `<div class="cir-map-badge">${circuitMap(round, activeProfile, 'corners', { compact: true })}<span>${esc(round.label)} · ${esc(round.shortName)}</span></div>`
    + `</div>`
    + kpis
    + `<div class="cir-section-head"><div><div class="eyebrow">Reconnaissance &amp; direction de course</div><h2>Carte télémétrique &amp; profil altimétrique</h2></div>`
      + `<div class="cir-map-legend big">${sectorCount ? `Chronométrie · ${sectorCount} secteurs (${esc(round.overlaysFile || 'overlays.ini')})` : 'Pas de découpage officiel par secteur'}</div></div>`
    + `<div class="cir-map-grid">${mapBlock}${inspector}</div>`
    + `<div class="cir-cols">${briefing}${sectorsTable}</div>`
    + `<div class="cir-cols" style="grid-template-columns:1fr">${tech}</div>`;
}

// ---------- Pages Manches / Pilotes ----------
function manche(){
  if(backendMulti&&!eventContext)return hub();
  const rs=rounds();
  if(round>=rs.length)round=0;
  const r=rs[round];
  if(!r)return `${head('résultats','Les manches','')}<p class="note">Aucune manche importée.</p>`;
  if(sessionIndex<0||sessionIndex>=r.sessions.length)sessionIndex=0;
  const s=r.sessions[sessionIndex];
  if(!s)return `${head('résultats','Les manches','')}<p class="note">Aucune session disponible pour cette manche.</p>`;

  const rows=sortSession(s);
  const ptsMap=typeof sessionPoints==='function'?sessionPoints(s):new Map();
  const winner=s.type==='RACE'?rows.find(x=>!x._dq&&!x.comDNF&&!x.comDNS&&Number.isFinite(x._t)&&x._t<1e17):null;
  function penaltyLabel(x){
    const tags=[];
    if(x.comDQ||x.disqualified)tags.push('DQ');
    else if(x.comDNS)tags.push('DNS');
    else if(x.comDNF)tags.push('DNF');
    if(Number.isFinite(x.comTimeAdd)&&x.comTimeAdd!==0){
      const sec=x.comTimeAdd/1000;
      const value=Number.isInteger(sec)?Math.abs(sec).toFixed(0):Math.abs(sec).toFixed(1);
      tags.push((sec>0?'+':sec<0?'-':'')+value+'s');
    }
    if(x.comWarning)tags.push('Aver.');
    return tags.join(', ');
  }
  function penaltyCell(x){
    const label=penaltyLabel(x);
    return `<td class="${label?'penalty':'muted'}">${label?esc(label):'—'}</td>`;
  }
  function pointsCell(x){
    const pts=ptsMap.get(x.id)||0;
    return pts>0?`<td><b>${pts}</b></td>`:'<td class="muted">0</td>';
  }
  function gapTo(a,b){
    if(!a||!b||a._dq||b._dq||a.comDNF||a.comDNS||b.comDNF||b.comDNS)return '—';
    if(!Number.isFinite(a._t)||!Number.isFinite(b._t)||a._t>=1e17||b._t>=1e17)return '—';
    if(a.laps!==b.laps)return a.laps<b.laps?`+${b.laps-a.laps} t`:'—';
    const delta=(a._t-b._t)/1000;
    return delta>0?'+'+delta.toFixed(3)+' s':'—';
  }

  const resultrows=s.type==='QUALIFY'
    ?rows.map((x,i)=>`<tr><td class="pos">${String(i+1).padStart(2,'0')}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.team)||'—'}</td><td>${x.laps??'—'}</td><td>${fmt(x._adjustedBest??x.best)}</td>${penaltyCell(x)}${pointsCell(x)}</tr>`)
    :rows.map((x,i)=>`<tr><td class="pos">${String(i+1).padStart(2,'0')}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.team)||'—'}</td><td>${x.grid??'—'}</td><td>${x.laps??'—'}</td><td>${fmt(x.best)}</td>${penaltyCell(x)}<td>${i===0&&winner?'Tête':gapTo(x,winner)}</td><td>${i===0?'—':gapTo(x,rows[i-1])}</td>${pointsCell(x)}</tr>`);

  function raceClock(ts,start){
    if(typeof ts!=='number'||typeof start!=='number')return '—';
    const sec=Math.max(0,ts-start),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60),ms=Math.floor((sec%1)*10);
    return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  }
  const eventrows=(s.events||[]).filter(e=>e.a&&e.b).map((e,i)=>`<tr><td>${i+1}</td><td><b>${esc(e.a)}</b></td><td>${esc(e.b)}</td><td>${typeof e.speed==='number'?e.speed.toFixed(1)+' km/h':'—'}</td><td>${raceClock(e.timestamp,s.raceStart)}</td></tr>`);
  const headers=s.type==='QUALIFY'
    ?['Pos.','Pilote','Équipe','Tours','Meilleur tour','Pénal.','Pts']
    :['Pos.','Pilote','Équipe','Grille','Tours','Meilleur tour','Pénal.','Écart / tête','Écart / préc.','Pts'];
  return `${head('résultats','Les manches','Toutes les sessions importées, regroupées par date.')}<div class="controls"><select onchange="round=+this.value;sessionIndex=0;eventtab='resultats';render()">${rs.map((x,i)=>`<option value="${i}" ${i===round?'selected':''}>Manche ${i+1} · ${esc(x.track)}</option>`).join('')}</select><select onchange="sessionIndex=+this.value;eventtab='resultats';render()">${r.sessions.map((x,i)=>`<option value="${i}" ${i===sessionIndex?'selected':''}>${x.type==='QUALIFY'?'Qualification':'Course '+r.sessions.slice(0,i+1).filter(y=>y.type==='RACE').length}</option>`).join('')}</select><span class="tag">${date(r.date)}</span></div>${tabs([['resultats','Résultats'],...(s.type==='RACE'?[['collisions','Collisions entre pilotes']]:[])],eventtab,'showevent')}<div class="panel">${eventtab==='collisions'?`<h2>Incidents enregistrés</h2><p class="note">Événements bruts entre voitures en course, sans attribution de responsabilité.</p>${table(['#','Pilote','Autre pilote','Vitesse','Temps de course'],eventrows)}`:`<h2>${esc(r.track)} · ${s.type==='QUALIFY'?'Qualification':'Course'}</h2><p class="note">Classement officiel : meilleur tour pour les qualifications, ordre d'arrivée (avec pénalités Commission) pour les courses.</p>${table(headers,resultrows)}`}</div>`;
}

// Performance ratings (par week-end : Régularité iRacing, Propreté Option 3, Vitesse Q+R, Résultats v45)
function performanceRatings(){
  const pilots=new Map();
  const pct=(arr,id,key,lower=true)=>{
    const eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);
    if(!item||eligible.length<2)return null;
    const better=eligible.filter(x=>lower?x[key]<item[key]:x[key]>item[key]).length,
          equal=eligible.filter(x=>x[key]===item[key]).length;
    return 100*(1-(better+(equal-1)/2)/(eligible.length-1));
  };
  const pctFoul=(arr,id,key)=>{
    const eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);
    if(!item)return null;
    if(item[key]<=0)return 100;
    if(eligible.length<2)return null;
    const better=eligible.filter(x=>x[key]<item[key]).length,
          equal=eligible.filter(x=>x[key]===item[key]).length;
    return 100*(1-(better+(equal-1)/2)/(eligible.length-1));
  };
  const cfg=pointsConfig();
  const minPct=typeof cfg.minPercentDistance==='number'?cfg.minPercentDistance:0.75;
  const evRounds=groupSessionsByDate(sessions);
  evRounds.forEach((rd,rIdx)=>{
    const raceSessions=[];
    rd.sessions.forEach((s,sIdx)=>{if(s&&s.type==='RACE')raceSessions.push({s,sIdx});});
    if(!raceSessions.length)return;
    const bestMap=weekendBestLaps(rd,rIdx,penMap);
    const pilotAgg=new Map();
    for(const {s,sIdx} of raceSessions){
      const sorted=sortSessionForPerf(s,rIdx,sIdx,penMap,minPct);
      const N=sorted.length;
      const lapsById={};
      (s.laps||[]).forEach(l=>{if(!l||!l.id)return;if(!lapsById[l.id])lapsById[l.id]=[];lapsById[l.id].push(l);});
      const foulScores=raceFoulScores({...s,results:sorted});
      sorted.forEach((r,idx)=>{
        if(!r||!r.id)return;
        const myLaps=(lapsById[r.id]||[]).filter(l=>Number.isFinite(l.time)&&l.time>0&&l.time<600000);
        const consistency=raceConsistencyMs(myLaps);
        const isOut=!!(r._dq||r.comDQ||r.comDNS||r.disqualified||r.comDNF);
        const resScore=scoreResultsV45(N,idx+1,isOut);
        const fouls=foulScores.get(r.id)??0;
        if(!pilotAgg.has(r.id))pilotAgg.set(r.id,{id:r.id,n:0,consS:0,consN:0,foulS:0,foulN:0,resS:0,resN:0});
        const p=pilotAgg.get(r.id);
        p.n++;
        if(consistency!=null){p.consS+=consistency;p.consN++;}
        p.foulS+=fouls;p.foulN++;
        p.resS+=resScore;p.resN++;
      });
    }
    const entries=[];
    for(const [id,p] of pilotAgg){
      const b=bestMap.get(id);
      entries.push({
        id,
        raceCount:p.n,
        regularity:p.consN?p.consS/p.consN:null,
        foul:p.foulN?p.foulS/p.foulN:0,
        best:b?b.best:null,
        bestSession:b?b.bestSession:null,
        resScore:p.resN?p.resS/p.resN:0
      });
    }
    for(const e of entries){
      const v={
        regularite:pct(entries,e.id,'regularity',true),
        proprete:pctFoul(entries,e.id,'foul'),
        vitesse:pct(entries,e.id,'best',true),
        resultats:e.resScore
      };
      if(v.regularite===null&&v.vitesse===null&&v.proprete===null)continue;
      for(const k in v)if(v[k]===null)v[k]=50;
      if(!pilots.has(e.id))pilots.set(e.id,{items:[],races:0});
      const rec=pilots.get(e.id);
      rec.items.push(v);
      rec.races+=(e.raceCount||1);
    }
  });
  const out=[];
  for(const [id,rec] of pilots){
    const items=rec.items;
    if(rec.races<2&&items.length<2)continue;
    const average=key=>items.reduce((a,x)=>a+x[key],0)/items.length;
    const details={regularite:average('regularite'),proprete:average('proprete'),vitesse:average('vitesse'),resultats:average('resultats')};
    const score=Object.values(details).reduce((a,b)=>a+b,0)/4;
    out.push({id,score,details,count:rec.races});
  }
  out.sort((a,b)=>b.score-a.score);
  for(let i=0;i<out.length;i++){const rank=out.findIndex(x=>Math.abs(x.score-out[i].score)<1e-9);out[i].level=4-Math.min(3,Math.floor(rank*4/out.length));}
  return out;
}
function ratingCard(id){
  let ratings=performanceRatings(),r=ratings.find(x=>x.id===id);
  if(!r)return `<div class="panel drv-rating-card"><div class="eyebrow">Évaluation de performance ${gdspTip(PROFILE_TIPS.scoreEvent,'gdsp-tip-left')}</div><h2>Niveau à déterminer</h2><p class="note">Au moins deux courses exploitables sont nécessaires pour établir les quatre jauges de performance.</p></div>`;
  let labels={regularite:'Régularité',proprete:'Propreté',vitesse:'Vitesse au tour',resultats:'Résultats'},
      tips={regularite:PROFILE_TIPS.regularite,proprete:PROFILE_TIPS.proprete,vitesse:PROFILE_TIPS.vitesse,resultats:PROFILE_TIPS.resultats},
      bars=Object.entries(r.details).map(([k,v])=>{
        const cls=v>=70?'g-hi':v>=45?'g-mid':'g-lo';
        const w=Math.max(2,Math.min(100,v)).toFixed(1);
        return `<div class="drv-gauge"><div class="drv-gauge-top"><span><b>${labels[k]}</b>${tips[k]?gdspTip(tips[k],'gdsp-tip-left'):''}</span><span class="drv-gauge-val">${v.toFixed(0)} <small>/ 100</small></span></div><div class="drv-bar"><span class="drv-bar-mid" title="Repère 50 / 100"></span><i class="${cls}" style="width:${w}%"></i></div></div>`;
      }).join('');
  return `<div class="panel drv-rating-card"><div class="drv-rating-head"><div><div class="eyebrow">Évaluation de performance · provisoire</div><h2>Niveau ${r.level} <span style="font-family:Arial;font-size:13px;color:#6d726c">/ 4</span> ${gdspTip(PROFILE_TIPS.scoreEvent,'gdsp-tip-left')}</h2><p class="note" style="margin:4px 0 0">${r.count} course(s) exploitables · ${ratings.length} pilotes évalués</p></div><div class="drv-score-badge"><strong>${r.score.toFixed(1)}</strong><span>Score / 100</span></div></div>${bars}<div class="drv-gauge-legend"><span><i class="dot dot-hi"></i>≥ 70 Point fort</span><span><i class="dot dot-mid"></i>45–69 Solide</span><span><i class="dot dot-lo"></i>&lt; 45 À travailler</span><span>┆ Repère 50</span></div></div>`;
}
function plotHistory(metrics,mode){if(!metrics.length)return '<p class="note">Aucune course disponible.</p>';let w=700,h=190,left=42,right=20,top=16,bottom=42,vals=metrics.map(m=>mode==='position'?m.position:m.collisions),max=Math.max(mode==='position'?5:1,...vals),x=i=>left+(metrics.length===1?(w-left-right)/2:i*(w-left-right)/(metrics.length-1)),y=v=>mode==='position'?top+(v-1)*(h-top-bottom)/Math.max(max-1,1):top+(max-v)*(h-top-bottom)/max;let line=vals.map((v,i)=>`${x(i)},${y(v)}`).join(' '),ticks=[1,Math.ceil(max/2),max].filter((v,i,a)=>a.indexOf(v)===i);let grid=ticks.map(t=>`<line x1="${left}" y1="${y(t)}" x2="${w-right}" y2="${y(t)}" stroke="#d8cdbb"/><text x="${left-8}" y="${y(t)+4}" text-anchor="end" font-size="11" fill="#69756e">${t}</text>`).join('');let points=vals.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="5" fill="#9c3021"><title>${esc(track(metrics[i].race.track))} — ${date(metrics[i].race.date)} : ${v}</title></circle><text x="${x(i)}" y="${h-17}" text-anchor="middle" font-size="10" fill="#69756e">C${i+1}</text>`).join('');return `<svg viewBox="0 0 ${w} ${h}" role="img" style="width:100%;height:auto;display:block">${grid}<polyline fill="none" stroke="#a83729" stroke-width="2.5" points="${line}"/>${points}</svg><p class="note">${metrics.map((m,i)=>`C${i+1} : ${esc(track(m.race.track))} · ${date(m.race.date)}`).join(' &nbsp; / &nbsp; ')}</p>`}
function drivers(){
  if(backendMulti&&!eventContext)return hub();
  let ds=allDrivers();
  if(driverId){
    let d=ds.find(x=>x.id===driverId);if(!d){driverId='';return drivers()}
    const evRounds=groupSessionsByDate(sessions).map(rd=>({...rd,penMap}));
    let races=sessions.filter(s=>s.type==='RACE'&&s.results.some(x=>x.id===driverId));
    let metrics=races.map(s=>{
      const [rIdx,sIdx]=findSessionIdx(s);
      const sorted=sortSessionForPerf(s,rIdx,sIdx,penMap);
      let index=sorted.findIndex(x=>x.id===driverId),r=sorted[index]||s.results.find(x=>x.id===driverId);
      if(index<0)index=s.results.findIndex(x=>x.id===driverId);
      let name=(r.name||'').trim().toLowerCase();
      let collisions=(s.events||[]).filter(e=>[e.a,e.b].some(x=>String(x||'').trim().toLowerCase()===name)).length;
      return {race:s,result:r,position:index+1,delta:typeof r.grid==='number'&&r.grid>0?r.grid-(index+1):null,collisions};
    });
    let known=metrics.filter(x=>x.delta!==null),avgDelta=known.length?known.reduce((n,x)=>n+x.delta,0)/known.length:null,avgColl=metrics.length?metrics.reduce((n,x)=>n+x.collisions,0)/metrics.length:null,avgPos=metrics.length?metrics.reduce((n,x)=>n+x.position,0)/metrics.length:null;
    let positives=[],weaknesses=[];
    if(known.length>=2){if(avgDelta>0.5)positives.push(`Progression moyenne de ${signed(avgDelta)} place(s) entre le départ et l'arrivée.`);else if(avgDelta<-.5)weaknesses.push(`Recul moyen de ${Math.abs(avgDelta).toFixed(1)} place(s) entre le départ et l'arrivée.`);else positives.push('Positions de départ globalement conservées en course.')}
    if(metrics.length>=2){if(avgColl<1)positives.push("Moins d'un événement de collision enregistré par course en moyenne.");else if(avgColl>=3)weaknesses.push("Plusieurs événements de collision enregistrés par course en moyenne.");if(avgPos<=5)positives.push('Position moyenne à l’arrivée dans les cinq premiers.')}
    let desc=arr=>arr.length?arr.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>Pas assez de données.</li>';
    const isLolaProf=!eventContext||eventContext.slug===LEGACY_DEFAULT_SLUG||eventContext.slug===ACTIVE_LOLA_SLUG;
    const l=isLolaProf?livery(d.name):null;
    const initials=(d.name||'').trim().split(/[\s._-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'—';
    const roundelHtml=l?`<div class="drv-roundel">${esc(l[2])}</div>`:`<div class="drv-roundel drv-roundel-txt">${esc(initials)}</div>`;
    let carVisual,carNumLabel,carFootLeft;
    if(!isLolaProf){
      const md=races[0]&&races[0].results.find(r=>r.id===driverId);
      const modelName=md&&md.model?md.model:(eventContext&&eventContext.name?eventContext.name:'Modèle engagé');
      carVisual=`<div class="drv-car-placeholder">${esc(modelName)}</div>`;
      carNumLabel=md&&md.model?esc(md.model):'Engagé';
      carFootLeft=esc((eventContext&&eventContext.name)||'GDSP');
    }else{
      carVisual=l?`<img class="driver-car" src="/assets/${l[1]}.jpg?v=6" alt="Voiture numéro ${l[2]} de ${esc(d.name)}">`:'<div class="drv-car-placeholder">Visuel de voiture à ajouter</div>';
      carNumLabel=l?`N° ${esc(l[2])}`:'N° —';
      carFootLeft='Lola T290 · International Series';
    }
    const rPerf=performanceRatings().find(x=>x.id===driverId);
    const lvlStamp=rPerf?`<span class="drv-lvl-stamp"><b>Niveau ${rPerf.level} / 4</b> · ${rPerf.score.toFixed(1)} / 100</span>`:`<span class="drv-lvl-stamp">Niveau à déterminer · ${races.length} course(s)</span>`;
    const heroEye=backendMulti&&eventContext&&eventContext.name?`${(eventContext.kind||'').toUpperCase()} · ${eventContext.name}`:'GDSP · Fiche pilote engagé';
    const bestPosVal=races.length?Math.min(...metrics.map(m=>m.position)):null;
    const winsCount=metrics.filter(m=>m.position===1).length;
    const podiumsCount=metrics.filter(m=>m.position<=3).length;
    const roundsDisputed=evRounds.filter(rd=>(rd.sessions||[]).some(s=>s&&s.type==='RACE'&&(s.results||[]).some(r=>r&&r.id===driverId))).length;
    const totalColl=metrics.reduce((n,m)=>n+m.collisions,0);
    const deltaDisplay=avgDelta===null?'—':(avgDelta>0.05?'▲ '+signed(avgDelta):avgDelta<-0.05?'▼ '+signed(avgDelta):'= '+signed(avgDelta));
    const deltaCls=avgDelta===null?'':(avgDelta>0.05?'kpi-val-pos':avgDelta<-0.05?'kpi-val-neg':'');
    const quickOpts=ds.map(x=>{
      const xl=isLolaProf?livery(x.name):null;
      return `<option value="${esc(x.id)}" ${x.id===driverId?'selected':''}>${xl?'#'+esc(xl[2])+' · ':''}${esc(x.name)}</option>`;
    }).join('');
    let rows=metrics.map(m=>{
      const s=m.race,r=m.result;
      let times=(s.laps||[]).filter(x=>x.id===driverId&&x.time>0&&x.time<600000);
      const consMs=raceConsistencyMs(times);
      const posHtml=m.position<=3?`<span class="podium-pill p${m.position}">P${m.position}</span>`:`<span class="pos">P${m.position}</span>`;
      const deltaHtml=m.delta===null?'<span class="muted">—</span>':(m.delta>0?`<span class="delta-pill up">▲ +${m.delta}</span>`:m.delta<0?`<span class="delta-pill down">▼ ${m.delta}</span>`:'<span class="delta-pill eq">= 0</span>');
      const collHtml=m.collisions===0?'<span class="coll-zero">0</span>':(m.collisions>=3?`<span class="penalty">${m.collisions}</span>`:String(m.collisions));
      return `<tr><td class="hist-mono">${date(s.date)}</td><td><b>${esc(track(s.track))}</b></td><td class="hist-mono">${r.grid?'P'+r.grid:'—'}</td><td>${posHtml}</td><td>${deltaHtml}</td><td class="hist-mono">${collHtml}</td><td class="hist-mono">${fmt(r.best)}</td><td class="hist-mono"><b>${consMs!=null?'+'+(consMs/1000).toFixed(2)+' s':'—'}</b></td></tr>`;
    });
    const rythmeHtml=buildRythmeCard(driverId,evRounds,{showEvent:false})||'<div class="panel rythme-wrap"><div class="eyebrow">Analyse du rythme</div><h2>Race consistency &amp; meilleur tour week-end</h2><p class="note">Pas encore assez de tours chronométrés pour analyser la régularité sur cet événement.</p></div>';
    return `<div class="drv-topbar"><button class="btn secondary" onclick="driverId='';render()">← Tous les pilotes</button><div class="drv-quick-switch"><span class="label">Fiche pilote</span><select aria-label="Choisir un pilote" onchange="driverId=this.value;render()">${quickOpts}</select></div></div>`
      +`<div class="drv-hero"><div class="drv-hero-id"><div class="drv-hero-eyebrow">${esc(heroEye)}</div><div class="drv-id-main">${roundelHtml}<div><h1>${esc(d.name)}</h1><div class="drv-team-line">${esc(d.team)||'Pilote indépendant'}</div></div></div><div class="drv-hero-stamps">${lvlStamp}</div></div>`
      +`<div class="drv-hero-car"><div class="drv-car-head"><span class="label">Voiture engagée</span><span class="drv-car-num">${carNumLabel}</span></div><div class="drv-car-stage">${carVisual}</div><div class="drv-car-foot"><span>${carFootLeft}</span><span>Arrivée moy. ${gdspTip(PROFILE_TIPS.avgPos,'gdsp-tip-right')} <b>${avgPos!==null?'P'+avgPos.toFixed(1):'—'}</b></span></div></div></div>`
      +`<div class="drv-kpis">`
      +`<div class="drv-kpi"><span class="label">Courses enregistrées ${gdspTip(PROFILE_TIPS.courses,'gdsp-tip-left')}</span><strong>${races.length}</strong><span class="drv-kpi-sub">${roundsDisputed} manche(s) disputée(s)</span></div>`
      +`<div class="drv-kpi kpi-gold"><span class="label">Meilleur résultat brut ${gdspTip(PROFILE_TIPS.bestPos)}</span><strong class="${bestPosVal===1?'kpi-val-gold':''}">${bestPosVal!==null?'P'+bestPosVal:'—'}</strong><span class="drv-kpi-sub">${races.length?`${winsCount} victoire(s) · ${podiumsCount} podium(s)`:'Aucune course enregistrée'}</span></div>`
      +`<div class="drv-kpi kpi-green"><span class="label">Places gagnées / course ${gdspTip(PROFILE_TIPS.delta)}</span><strong class="${deltaCls}">${deltaDisplay}</strong><span class="drv-kpi-sub">Grille départ − position d’arrivée</span></div>`
      +`<div class="drv-kpi kpi-red"><span class="label">Collisions / course ${gdspTip(PROFILE_TIPS.collisions,'gdsp-tip-right')}</span><strong>${avgColl===null?'—':avgColl.toFixed(1)}</strong><span class="drv-kpi-sub">${totalColl} contact(s) serveur au total</span></div>`
      +`</div>`
      +`<div class="section-head"><div><div class="eyebrow">Quatre critères · un niveau</div><h2>Profil de performance &amp; rythme</h2></div></div>`
      +`<div class="drv-perf-grid">${ratingCard(driverId)}${rythmeHtml}</div>`
      +`<div class="section-head"><div><div class="eyebrow">Analyse</div><h2>Portrait du pilote</h2></div></div>`
      +`<div class="drv-portrait-grid"><div class="panel drv-portrait-card drv-portrait-pos"><div class="drv-portrait-head"><span class="drv-portrait-ico pos">✓</span><div><div class="eyebrow" style="color:#3b6341">Points forts</div><h3>Ce qui fonctionne en piste</h3></div></div><ul class="drv-portrait-list">${desc(positives)}</ul></div><div class="panel drv-portrait-card drv-portrait-axe"><div class="drv-portrait-head"><span class="drv-portrait-ico axe">↗</span><div><div class="eyebrow">Axes de progression</div><h3>Points de vigilance</h3></div></div><ul class="drv-portrait-list">${desc(weaknesses)}</ul></div></div>`
      +`<div class="section-head"><div><div class="eyebrow">Carnet de route</div><h2>Historique en course</h2></div><span class="muted">${races.length} départ(s)</span></div>`
      +`<div class="panel driver-hist-wrap">${table(['Date','Circuit','Départ','Arrivée',`Delta ${gdspTip(PROFILE_TIPS.delta)}`,`Collisions brutes ${gdspTip(PROFILE_TIPS.collisions)}`,'Meilleur tour',`Δ rythme ${gdspTip(PROFILE_TIPS.sigma,'gdsp-tip-right')}`],rows)}</div>`;
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
  try{
    const r=await apiPost('/api/admin/login',{username:u,password:p});
    if(r.status>=500){alert('Serveur de connexion temporairement indisponible. Réessayez dans quelques instants.');return}
    const j=await r.json();
    if(!r.ok||!j.token){alert(j.error||j.message||'Identifiant ou mot de passe incorrect.');return}
    adminToken=j.token;
    // Stocker aussi dans sessionStorage pour que les tokens JWT (expirant) ne survivent pas
    // à la fermeture du navigateur, MAIS garder dans localStorage pour compatibilité.
    localStorage.setItem('gdsp_admin_token',adminToken);
    sessionStorage.setItem('gdsp_admin_token',adminToken);
    adminAuth=true;
    adminUser=j.user||'Direction de course';
    if(backendError)await detectBackend();
    if(j.warning)alert('⚠ Connexion en mode secours :\n\n'+j.warning);
    try{
      if(backendMulti){
        const slugToLoad=currentSlug||(events.find(e=>e.kind==='championship')||events[0]||{}).slug;
        if(slugToLoad)await loadEvent(slugToLoad);
      }else await loadRemoteLegacy();
    }catch(e){}
    render()
  }catch(e){alert('Erreur de connexion : '+e.message)}
}
async function adminLogout(){adminToken=null;adminAuth=false;adminUser='';localStorage.removeItem('gdsp_admin_token');sessionStorage.removeItem('gdsp_admin_token');render()}
async function doSaveRemote(){
  const el=document.getElementById('save-status');
  function say(txt,c){if(el){el.textContent=txt;el.style.color=c||'#586260'}console.log('[save]',txt)}
  say('Envoi en cours…');
  try{const j=await saveRemote();say('✓ Sauvegarde envoyée au serveur ('+new Date(j.updatedAt||Date.now()).toLocaleString('fr-FR')+').','#3b6341')}
  catch(e){say('✗ Échec : '+e.message,'#9c3021');console.error(e)}
}
async function saveRemote(){
  if(!adminToken)throw new Error('Non connecté administrateur.');
  // Minifier le payload : les données tour-par-tour (laps) représentent 90%+ de la taille.
  // On ne garde que les champs nécessaires aux calculs (id/time/cuts) ; on supprime
  // skin, sector, lapNumber, etc. Pour events (collisions), on garde seulement aid/bid/speed.
  const minSessions=sessions.map(ss=>{
    const o={...ss};
    if(Array.isArray(o.laps)){
      o.laps=o.laps.map(l=>{
        const lp={id:l.id,time:l.time,cuts:l.cuts||0};
        if(l.timestamp!=null)lp.timestamp=l.timestamp;
        else if(l.Timestamp!=null)lp.timestamp=l.Timestamp;
        return lp;
      });
    }
    if(Array.isArray(o.events)){
      o.events=o.events.map(e=>{
        const ev={type:e.type||'COLLISION_WITH_CAR',aid:e.aid,bid:e.bid,speed:e.speed,a:e.a,b:e.b,timestamp:e.timestamp};
        if(e.RelPosition||e.relPos)ev.RelPosition=e.RelPosition||e.relPos;
        return ev;
      });
    }
    if(Array.isArray(o.results)){
      o.results=o.results.map(r=>{
        const rr={id:r.id,name:r.name,team:r.team||'',grid:r.grid,laps:r.laps,best:r.best,time:r.time};
        if(r.disqualified)rr.disqualified=true;
        if(r.hasPenalty)rr.hasPenalty=true;
        if(r.penaltyTime)rr.penaltyTime=r.penaltyTime;
        if(r.lapPenalty)rr.lapPenalty=r.lapPenalty;
        return rr;
      });
    }
    return o;
  });
  const baseData=(eventContext&&eventContext.data&&typeof eventContext.data==='object')?eventContext.data:{};
  const payload={};
  if(baseData.ahServer)payload.ahServer=baseData.ahServer;
  if(baseData.ahUuid)payload.ahUuid=baseData.ahUuid;
  if(baseData.posterImage)payload.posterImage=baseData.posterImage;
  if(Array.isArray(baseData.galleryImages)&&baseData.galleryImages.length)payload.galleryImages=baseData.galleryImages;
  if(baseData.eventInfo&&typeof baseData.eventInfo==='object')payload.eventInfo=baseData.eventInfo;
  // Manches circuit ajoutées par l'import Drive : sans cette ligne, chaque
  // sauvegarde de l'événement les effacerait.
  if(Array.isArray(baseData.circuitRounds)&&baseData.circuitRounds.length)payload.circuitRounds=baseData.circuitRounds;
  Object.assign(payload,{sessions:minSessions,penMap,manualDrivers,customCalendar});
  if(eventContext)eventContext.data=Object.assign({},baseData,payload);
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
    const events=(j.Events||[]).filter(e=>e.Type==='COLLISION_WITH_CAR'&&j.Type==='RACE').map(e=>{const a=cars[e.CarId],b=cars[e.OtherCarId];if(!a||!b)return null;const ev={type:'COLLISION_WITH_CAR',a:a.name,b:b.name,aid:a.id,bid:b.id,speed:e.ImpactSpeed,timestamp:e.Timestamp};if(e.RelPosition)ev.RelPosition=e.RelPosition;return ev}).filter(Boolean);
    let raceStart=null;
    if(j.Type==='RACE'){const c=[];laps.forEach(l=>{if(typeof l.timestamp==='number'&&typeof l.time==='number'&&40000<l.time<600000)c.push(l.timestamp-l.time/1000)});if(c.length)raceStart=Math.min(...c)}
    const sess={date:j.Date,track:j.TrackName,type:j.Type,results,laps,events,raceStart};
    const idx=sessions.findIndex(x=>x.date===j.Date&&x.type===j.Type);
    if(idx>=0)sessions[idx]=sess;else sessions.push(sess);
    sessions.sort((a,b)=>a.date.localeCompare(b.date));
    saveState();alert(`Import réussi : ${j.Type} du ${j.Date}.`);render();return true;
  }catch(err){alert('Erreur d\'import : '+err.message);return false}
}
function handleImport(ev){
  const f=ev.target.files[0];if(!f)return;
  const out=document.getElementById('ah-result');
  if(out)out.innerHTML='<p class="note">Lecture du fichier…</p>';
  const r=new FileReader();
  r.onload=e=>{
    const ok=importSessionJson(e.target.result,f.name);
    if(out&&ok)out.innerHTML=`<p class="note">✅ Fichier <b>${esc(f.name)}</b> importé avec succès. N'oublie pas d'enregistrer.</p>`;
    if(ok){saveState();render()}
    ev.target.value='';
  };
  r.readAsText(f);
}
async function bulkImport(ev){
  const fs=Array.from(ev.target.files||[]);
  if(!fs.length)return;
  const out=document.getElementById('ah-result');
  if(out)out.innerHTML=`<p class="note">Import de ${fs.length} fichier(s) en cours…</p>`;
  let ok=0,errs=[];
  for(const f of fs){
    const txt=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsText(f)});
    try{
      if(importSessionJson(txt,f.name,{silent:true}))ok++;
      else errs.push(f.name+' : format invalide ou ignoré');
    }catch(e){errs.push(f.name+' : '+e.message)}
  }
  saveState();render();
  if(out)out.innerHTML=`<p class="note"><b>Import terminé :</b> ${ok} fichier(s) importé(s), ${errs.length} erreur(s).</p>${errs.length?`<ul class="note" style="font-family:monospace;font-size:11px">${errs.map(x=>'<li>✗ '+esc(x)+'</li>').join('')}</ul>`:''}`;
  ev.target.value='';
}
function addAdjustment(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note,opts){
  const adj={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};
  if(opts&&(opts.dnf||opts.dns)){
    adj.timeAdd=0;adj.dq=false;adj.warning=false;
    if(opts.dnf)adj.dnf=true;
    if(opts.dns)adj.dns=true;
  }
  penMap[`${roundKey}:${sessionIdx}:${drvId}`]=adj;
  saveState();render();
}
function addChampionshipPoints(drvId,pointsDelta,note){
  const delta=Number(pointsDelta);
  if(!drvId||!Number.isFinite(delta)||delta===0)return false;
  const drv=allDrivers().find(x=>x.id===drvId);
  const uid=Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  penMap[`champ:${drvId}:${uid}`]={
    driverId:drvId,
    driverName:drv?drv.name:'',
    pointsDelta:delta,
    note:(note||'').trim()
  };
  saveState();render();
  return true;
}
function submitChampPointsAdj(sign){
  const drvEl=document.getElementById('champ-pts-driver');
  const ptsEl=document.getElementById('champ-pts-delta');
  const noteEl=document.getElementById('champ-pts-note');
  const drvId=drvEl?drvEl.value:'';
  if(!drvId){alert('Sélectionne d\'abord un pilote.');return;}
  const raw=ptsEl?Number(String(ptsEl.value||'').replace(',','.')):NaN;
  if(!Number.isFinite(raw)||raw===0){alert('Saisis un nombre de points non nul (ex : 5).');return;}
  const delta=(sign===1)?Math.abs(raw):(sign===-1)?-Math.abs(raw):raw;
  const note=noteEl?noteEl.value:'';
  addChampionshipPoints(drvId,delta,note);
}
function removeAdjustment(key){delete penMap[key];saveState();render()}
function addRound(){const d=prompt('Date (AAAA-MM-JJ) ?','2026-11-18');if(!d)return;const t=prompt('Circuit (ex: spa_1970) ?','spa_1970');if(!t)return;customCalendar=customCalendar||{};customCalendar[d]={track:t};saveState();render()}
function removePlannedRound(dateKey){
  if(!customCalendar||!dateKey)return;
  delete customCalendar[dateKey];
  if(!Object.keys(customCalendar).length){customCalendar=null;localStorage.removeItem('gdsp_calendar');}
  saveState();render();
}

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
  markEventSlugDeleted(slugIn,false);
  const r=await apiPost('/api/events',{slug:slugIn,name,kind,pointsConfig:cfg});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)return alert('Erreur : '+(j.error||r.status));
  // Reload events list
  const lst=await apiGet('/api/events');const lj=await lst.json().catch(()=>({}));if(Array.isArray(lj.events))events=filterEventsList(lj.events);
  await switchEvent(slugIn);
  alert('Événement créé. Tu peux maintenant importer ses JSON.');
}
async function deleteEvent(slug){
  if(!backendMulti||!slug)return;
  const evObj=events.find(e=>e.slug===slug)||(eventContext&&eventContext.slug===slug?eventContext:{slug,name:slug});
  if(!confirm(`Supprimer DÉFINITIVEMENT "${evObj.name||slug}" du serveur ? Cette action est irréversible.`))return;
  const hdrs=adminToken?{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'}:{'Content-Type':'application/json'};
  if(slug===LEGACY_DEFAULT_SLUG){
    // L'événement legacy ("International Series Lola T290 — 2026") est recréé au démarrage du backend
    // si sa ligne est absente de PostgreSQL (ON CONFLICT DO NOTHING). On conserve donc une tombe
    // (_deleted:true) en base et on vide l'ancienne table championship pour qu'il ne revienne jamais.
    const tombCfg=Object.assign({},DEFAULT_POINTS,{_deleted:true});
    const putRes=await fetch('/api/events/'+encodeURIComponent(slug),{
      method:'PUT',headers:hdrs,body:JSON.stringify({kind:'archive',pointsConfig:tombCfg})
    }).catch(()=>null);
    await apiPost('/api/events/'+encodeURIComponent(slug)+'/data',{_deleted:true,sessions:[],penMap:{},manualDrivers:null,customCalendar:null}).catch(()=>null);
    await apiPost('/api/save-championship',{_reset:true,_deleted:true,sessions:[],penMap:{},manualDrivers:null,customCalendar:null}).catch(()=>null);
    if(!putRes||putRes.status===404){
      const delRes=await fetch('/api/events/'+encodeURIComponent(slug),{method:'DELETE',headers:adminToken?{Authorization:'Bearer '+adminToken}:{}});
      if(!delRes.ok&&delRes.status!==404){
        const dj=await delRes.json().catch(()=>({}));
        return alert('Erreur : '+(dj.error||delRes.status));
      }
    }else if(!putRes.ok){
      const pj=await putRes.json().catch(()=>({}));
      return alert('Erreur : '+(pj.error||putRes.status));
    }
  }else{
    const r=await fetch('/api/events/'+encodeURIComponent(slug),{method:'DELETE',headers:adminToken?{Authorization:'Bearer '+adminToken}:{}});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)return alert('Erreur : '+(j.error||r.status));
  }
  markEventSlugDeleted(slug,true);
  if(localStorage.getItem('gdsp_last_event')===slug)localStorage.removeItem('gdsp_last_event');
  events=events.filter(e=>e.slug!==slug);
  if(currentSlug===slug){
    const next=events.find(e=>e.kind==='championship')||events[0];
    if(next){
      try{await loadEvent(next.slug)}catch(e){currentSlug=null;eventContext=null;sessions.length=0;penMap={};}
    }else{
      currentSlug=null;eventContext=null;sessions.length=0;penMap={};
    }
  }
  if(page!=='admin')page='accueil';
  render();
}
async function deleteCurrentEvent(){
  if(!backendMulti||!currentSlug)return;
  await deleteEvent(currentSlug);
}

function saveGlobalHidden(){
  localStorage.setItem('gdsp_global_hidden',JSON.stringify(globalHidden));
  // Sauvegarde SERVEUR (partagée entre tous les admins / navigateurs).
  apiPut('/api/global-exclusions',{ids:globalHidden})
    .then(r=>{if(!r.ok&&r.status!==404&&r.status!==503)console.warn('global-exclusions: sauvegarde serveur HTTP',r.status)})
    .catch(e=>console.warn('global-exclusions: serveur indisponible, sauvegarde locale conservée.'));
}
async function loadGlobalHidden(){
  // 1) Charger depuis le serveur (exclusions partagées entre admins)
  try{
    const r=await fetch('/api/global-exclusions',{cache:'no-store'});
    if(r.ok){
      const j=await r.json();
      if(j&&typeof j.ids==='object'){globalHidden=j.ids||{};localStorage.setItem('gdsp_global_hidden',JSON.stringify(globalHidden));return}
    }
  }catch(e){}
  // 2) Fallback: localStorage (pour le mode GitHub Pages sans serveur)
  try{globalHidden=JSON.parse(localStorage.getItem('gdsp_global_hidden')||'{}')}catch(e){globalHidden={}}
}
function toggleGlobalHidden(id,hide){
  if(hide)globalHidden[id]=true;else delete globalHidden[id];
  localStorage.setItem('gdsp_global_hidden',JSON.stringify(globalHidden));
  // Push serveur
  apiPut('/api/global-exclusions',{ids:globalHidden})
    .then(r=>{if(!r.ok)console.warn('global-exclusions: échec push serveur HTTP',r.status)})
    .catch(e=>console.warn('global-exclusions: push serveur impossible',e));
  render();
}
// ---------- Admin : import de circuits depuis Google Drive ----------
// Le dossier Drive doit être partagé « tout le monde disposant du lien ».
// Aucune clé API Google n'est requise.
const CIR_IMPORT_KEY='gdsp_circuit_import_draft';
function circuitImportDraft(){
  try{return JSON.parse(localStorage.getItem(CIR_IMPORT_KEY)||'null')||{}}catch(e){return {}}
}
function circuitsAdminSet(field,value){
  const d=circuitImportDraft();d[field]=value;
  try{localStorage.setItem(CIR_IMPORT_KEY,JSON.stringify(d))}catch(e){}
}
function renderCircuitsAdmin(){
  const draft=circuitImportDraft();
  return `<h2>Importer un circuit depuis Google Drive</h2>
  <p class="note">Partagez le dossier du mod sur Drive en <b>« Tout le monde disposant du lien »</b>, puis collez son adresse ci-dessous.
  L'import lit <code>fast_lane.ai</code> (tracé, altitude, virages), <code>surfaces.ini</code>, <code>overlays.ini</code> (secteurs) et <code>ui_track.json</code>.</p>
  <div class="grid" style="grid-template-columns:1fr;gap:14px;margin-top:14px">
    <div class="panel">
      <h3>1 · Dossier du circuit</h3>
      <input id="cir-drive-url" type="text" class="admin-input" style="width:100%"
        placeholder="https://drive.google.com/drive/folders/…"
        value="${esc(draft.driveUrl||'')}" oninput="circuitsAdminSet('driveUrl',this.value)">
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
        <input id="cir-name" type="text" class="admin-input" style="flex:2;min-width:200px"
          placeholder="Nom du circuit (ex. Watkins Glen 1971)"
          value="${esc(draft.name||'')}" oninput="circuitsAdminSet('name',this.value)">
        <input id="cir-round" type="number" min="1" max="99" class="admin-input" style="flex:0 0 120px"
          placeholder="Manche n°"
          value="${esc(draft.round||'')}" oninput="circuitsAdminSet('round',this.value)">
      </div>
      <div style="margin-top:12px"><button class="btn" onclick="circuitImportRun()">📥 Analyser le dossier Drive</button></div>
      <div id="cir-import-result" style="margin-top:12px"></div>
    </div>
    <div class="panel">
      <h3>2 · Enregistrement</h3>
      <p class="note">L'analyse produit une fiche de manche complète. Enregistrez-la pour l'ajouter à <code>data/circuits.json</code>.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="circuitImportSave()">💾 Ajouter à l'onglet Circuit</button>
        <button class="btn secondary" onclick="circuitImportDownload()">⬇ Télécharger le JSON</button>
        <button class="btn secondary" onclick="circuitImportReset()">Réinitialiser</button>
      </div>
      <p class="note" style="margin-top:10px">La manche est enregistrée dans l'événement courant (<b>${esc((eventContext&&eventContext.name)||'aucun événement sélectionné')}</b>) : elle est visible par tous les visiteurs, sans redéploiement.</p>
      <div id="cir-save-result" style="margin-top:10px"></div>
    </div>
    <div class="panel">
      <h3>Fichiers attendus dans le dossier</h3>
      <ul class="note">
        <li><code>fast_lane.ai</code> — <b>obligatoire</b> : tracé, profil d'altitude, virages.</li>
        <li><code>surfaces.ini</code> — grip et validité des surfaces.</li>
        <li><code>overlays.ini</code> — bornes de secteurs.</li>
        <li><code>ui_track.json</code> — nom et identifiant du circuit.</li>
      </ul>
      <p class="note">Le dossier doit contenir ces fichiers directement (pas dans un sous-dossier).</p>
    </div>
  </div>`;
}
async function circuitImportRun(){
  const box=document.getElementById('cir-import-result');
  const draft=circuitImportDraft();
  const url=(draft.driveUrl||'').trim();
  if(!url){if(box)box.innerHTML=`<p class="note" style="color:#9c3021">Collez d'abord l'adresse du dossier Drive.</p>`;return}
  if(box)box.innerHTML=`<p class="note">Lecture du dossier Drive… (quelques secondes)</p>`;
  try{
    const r=await fetch('/api/admin/circuits/import',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},adminToken?{Authorization:'Bearer '+adminToken}:{}),
      body:JSON.stringify({driveUrl:url,name:(draft.name||'').trim()||undefined,round:draft.round?Number(draft.round):undefined})
    });
    const payload=await r.json().catch(()=>({error:'Réponse illisible du serveur'}));
    if(!r.ok) throw new Error(payload.error||('HTTP '+r.status));
    circuitImportShow(payload);
  }catch(e){
    if(box)box.innerHTML=`<p class="note" style="color:#9c3021">✗ ${esc(e.message)}</p>`;
  }
}
function circuitImportShow(payload){
  try{localStorage.setItem(CIR_IMPORT_KEY+'_result',JSON.stringify(payload))}catch(e){}
  const r=payload.round||{};
  const box=document.getElementById('cir-import-result');
  if(!box)return;
  const files=Object.entries(payload.files||{}).map(([k,v])=>`<li><code>${esc(v.name)}</code> — ${esc({line:'tracé',surfaces:'surfaces',overlays:'secteurs',ui:'métadonnées'}[k]||k)}</li>`).join('');
  const warn=(payload.warnings||[]).length
    ? `<ul class="note" style="color:#8a6a1f">${payload.warnings.map(w=>`<li>⚠ ${esc(w)}</li>`).join('')}</ul>`
    : `<p class="note" style="color:#3b6341">✓ Tous les fichiers attendus ont été lus.</p>`;
  box.innerHTML=`<div class="panel" style="background:#fbf7ee">
    <h3 style="margin-top:0">Résultat</h3>
    <table class="cir-surfaces" style="width:100%"><tbody>
      <tr><td class="muted">Circuit</td><td><b>${esc(r.name||'—')}</b></td></tr>
      <tr><td class="muted">Longueur</td><td><b>${nb(r.lengthM||0,0)} m</b></td></tr>
      <tr><td class="muted">Dénivelé</td><td><b>${frNum((r.elevation&&r.elevation.max)-(r.elevation&&r.elevation.min)||0,1)} m</b></td></tr>
      <tr><td class="muted">Virages</td><td><b>${r.cornerCount||0}</b></td></tr>
      <tr><td class="muted">Secteurs</td><td><b>${r.sectorCount||(r.sectorSplits||[]).length||3}</b></td></tr>
      <tr><td class="muted">Surfaces</td><td><b>${(r.surfaces||[]).length}</b></td></tr>
    </tbody></table>
    ${files?`<p class="note" style="margin-top:10px">Fichiers lus :</p><ul class="note">${files}</ul>`:''}
    ${warn}
  </div>`;
}
function circuitImportDownload(){
  let payload=null;
  try{payload=JSON.parse(localStorage.getItem(CIR_IMPORT_KEY+'_result')||'null')}catch(e){}
  const box=document.getElementById('cir-save-result');
  if(!payload||!payload.round){if(box)box.innerHTML=`<p class="note" style="color:#9c3021">Lancez d'abord une analyse.</p>`;return}
  const blob=new Blob([JSON.stringify(payload.round,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='manche-'+(payload.round.round||'nouvelle')+'-'+String(payload.round.name||'circuit').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'.json';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
  if(box)box.innerHTML=`<p class="note" style="color:#3b6341">✓ Fichier téléchargé. Ajoutez-le à <code>data/circuits.json</code> (tableau <code>rounds</code>) puis committez.</p>`;
}
async function circuitImportSave(){
  const box=document.getElementById('cir-save-result');
  const say=(txt,color)=>{if(box)box.innerHTML=`<p class="note" style="color:${color||'#586260'}">${txt}</p>`};
  let payload=null;
  try{payload=JSON.parse(localStorage.getItem(CIR_IMPORT_KEY+'_result')||'null')}catch(e){}
  if(!payload||!payload.round){say('Lancez d\'abord une analyse du dossier Drive.','#9c3021');return}
  if(!adminToken){say('Connexion administrateur requise.','#9c3021');return}
  if(!eventContext||!currentSlug){say('Sélectionnez d\'abord un événement (championnat) dans le menu.','#9c3021');return}
  const incoming=payload.round;
  say('Enregistrement en cours…');
  try{
    // On relit l'état serveur pour ne pas écraser une manche ajoutée entre-temps.
    const r=await apiGet('/api/events/'+encodeURIComponent(currentSlug));
    if(!r.ok)throw new Error('Impossible de relire l\'événement (HTTP '+r.status+')');
    const ev=await r.json();
    const data=Object.assign({},(ev&&ev.data)||eventContext.data||{});
    const existing=Array.isArray(data.circuitRounds)?data.circuitRounds.slice():[];
    // Remplacement par numéro de manche, sinon par nom.
    const sameRound=r=>Number.isFinite(Number(incoming.round))&&Number.isFinite(Number(r.round))&&Number(r.round)===Number(incoming.round);
    const sameName=r=>String(r.name||'').toLowerCase()===String(incoming.name||'').toLowerCase();
    const idx=existing.findIndex(r=>sameRound(r)||sameName(r));
    let added=true;
    if(idx>=0){existing[idx]=Object.assign({},existing[idx],incoming);added=false}
    else existing.push(incoming);
    existing.sort((a,b)=>(Number(a.round)||999)-(Number(b.round)||999));
    data.circuitRounds=existing;

    const put=await fetch('/api/events/'+encodeURIComponent(currentSlug)+'/data',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},adminToken?{Authorization:'Bearer '+adminToken}:{}),
      body:JSON.stringify(data)
    });
    if(!put.ok){
      let msg='HTTP '+put.status;
      try{const j=await put.json();msg=j.error||j.message||msg}catch(e){}
      throw new Error(msg);
    }
    // Mise à jour locale : la manche apparaît sans rechargement.
    eventContext.data=data;
    circuitsCache=null;circuitsError='';
    try{localStorage.removeItem(CIR_IMPORT_KEY+'_result')}catch(e){}
    say(added?'✓ Manche ajoutée à l\'onglet Circuit.':'✓ Manche mise à jour dans l\'onglet Circuit.','#3b6341');
    setTimeout(()=>{circuitsData().then(()=>render())},600);
  }catch(e){
    say('✗ Échec : '+esc(e.message),'#9c3021');
  }
}
function circuitImportReset(){
  try{localStorage.removeItem(CIR_IMPORT_KEY);localStorage.removeItem(CIR_IMPORT_KEY+'_result')}catch(e){}
  render();
}

function renderGlobalExclusions(){
  const pilots=new Map();
  allDrivers().forEach(d=>pilots.set(d.id,{name:d.name,team:d.team||''}));
  const ratings=globalPerformanceRatings();
  ratings.forEach(r=>{if(!pilots.has(r.id))pilots.set(r.id,{name:r.name,team:r.team||''})});
  const arr=[...pilots.entries()].map(([id,d])=>({id,name:d.name,team:d.team,hidden:!!globalHidden[id]})).sort((a,b)=>Number(b.hidden)-Number(a.hidden)||a.name.localeCompare(b.name));
  const rows=arr.map(d=>`<tr>
    <td><b>${esc(d.name)}</b>${d.team?`<br><span class="muted">${esc(d.team)}</span>`:''}</td>
    <td>${d.hidden?'<span class="tag archive">exclu</span>':'<span class="tag live">classé</span>'}</td>
    <td>${d.hidden
      ?`<button class="btn secondary small" onclick="toggleGlobalHidden(this.dataset.id,false)" data-id="${esc(d.id)}">Réintégrer</button>`
      :`<button class="btn secondary small" onclick="toggleGlobalHidden(this.dataset.id,true)" data-id="${esc(d.id)}">Exclure du Global</button>`}</td>
  </tr>`).join('');
  return `<h2>Classement GLOBAL · pilotes exclus</h2>
    <p class="note">Exclut des pilotes du Classement GLOBAL Discord (invités, organisateurs, remplaçants, faux comptes). Les autres classements (par événement) ne sont pas affectés. La liste est <b>sauvegardée sur le serveur</b> et partagée entre tous les administrateurs (une copie locale dans le navigateur sert de secours si le serveur est indisponible).</p>
    <p class="note"><b>${Object.keys(globalHidden).length}</b> pilote(s) exclu(s).</p>
    ${table(['Pilote','Statut','Action'],rows)}`;
}
async function setEventKind(slug,kind){
  const label=kind==='archive'?'clôturer':kind==='open'?'passer en open':'passer en championnat';
  if(!confirm(`Valider pour ${label} cet événement ?`))return;
  try{
    const r=await apiPut('/api/events/'+encodeURIComponent(slug),{kind});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){alert(j.error||'Erreur.');return}
    const ev=events.find(e=>e.slug===slug);if(ev){ev.kind=kind;ev.updated_at=new Date().toISOString()}
    // Recharger le listing
    const lr=await apiGet('/api/events');const lj=await lr.json().catch(()=>({}));
    if(Array.isArray(lj.events))events=filterEventsList(lj.events);
    if(currentSlug===slug){
      // Mettre à jour eventContext sans perdre eventContext.data
      const ec=events.find(e=>e.slug===slug);
      const prevData=(eventContext&&eventContext.slug===slug&&eventContext.data)?eventContext.data:{};
      if(ec){eventContext={slug:ec.slug,name:ec.name,kind:ec.kind,pointsConfig:ec.points_config||{},data:ec.data||prevData}}
    }
    render();
  }catch(e){alert('Erreur : '+e.message)}
}

// ---------- Affiche d'événement (page Classements) ----------
let pendingPosterSlug=null;

function isSafePosterSrc(src){
  if(typeof src!=='string')return false;
  const s=src.trim();
  if(!s)return false;
  if(/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(s))return true;
  if(/^(\/[a-z0-9_\-./?=&]+|https?:\/\/[^\s"'<>]+)$/i.test(s))return true;
  return false;
}
function loadLocalPosterMap(){
  try{return JSON.parse(localStorage.getItem('gdsp_event_posters')||'{}')||{};}
  catch(e){return {};}
}
function saveLocalPosterEntry(slug,dataUrl){
  if(!slug)return;
  try{
    const m=loadLocalPosterMap();
    if(dataUrl)m[slug]=dataUrl;else delete m[slug];
    localStorage.setItem('gdsp_event_posters',JSON.stringify(m));
  }catch(e){}
}
function getEventPoster(evOrCtx){
  const target=evOrCtx||eventContext;
  if(!target)return '';
  const fromData=target.data&&target.data.posterImage;
  if(isSafePosterSrc(fromData))return fromData.trim();
  const cfg=target.pointsConfig||target.points_config||{};
  if(isSafePosterSrc(cfg.posterImage))return cfg.posterImage.trim();
  const slug=target.slug||currentSlug;
  if(slug){
    const local=loadLocalPosterMap()[slug];
    if(isSafePosterSrc(local))return local.trim();
  }
  return '';
}
function hasEventPoster(ev){
  if(!ev)return false;
  if(getEventPoster(ev))return true;
  if(currentSlug&&ev.slug===currentSlug&&getEventPoster(eventContext))return true;
  const cfg=ev.points_config||ev.pointsConfig||{};
  return !!cfg.hasPoster;
}
function renderEventPosterBlock(){
  const src=getEventPoster(eventContext);
  if(!src)return '';
  const alt=eventContext&&eventContext.name?`Affiche — ${eventContext.name}`:"Affiche de l'événement";
  return `<div class="event-poster-wrap"><img class="event-poster-img" src="${esc(src)}" alt="${esc(alt)}" onclick="openPosterLightbox(this.src,this.alt)"><span class="event-poster-hint">🔍 Cliquer pour agrandir</span></div>`;
}
function openPosterLightbox(src,alt){
  if(!isSafePosterSrc(src))return;
  const box=document.getElementById('poster-lightbox');
  const img=document.getElementById('poster-lightbox-img');
  if(!box||!img)return;
  img.src=src;
  img.alt=alt||"Affiche de l'événement";
  if(box.classList&&box.classList.add)box.classList.add('open');
  else box.className='poster-lightbox open';
}
function closePosterLightbox(){
  const box=document.getElementById('poster-lightbox');
  const img=document.getElementById('poster-lightbox-img');
  if(!box)return;
  if(box.classList&&box.classList.remove)box.classList.remove('open');
  else box.className='poster-lightbox';
  if(img)img.src='';
}
if(typeof document!=='undefined'&&document.addEventListener){
  document.addEventListener('keydown',ev=>{if(ev&&ev.key==='Escape')closePosterLightbox();});
}
function compressPosterImage(file){
  return new Promise((resolve,reject)=>{
    if(!file)return reject(new Error('Aucun fichier sélectionné.'));
    if(typeof file.dataUrl==='string'&&isSafePosterSrc(file.dataUrl))return resolve(file.dataUrl);
    if(typeof FileReader==='undefined')return reject(new Error('Lecture de fichier non supportée.'));
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Impossible de lire le fichier image.'));
    reader.onload=()=>{
      const rawDataUrl=String(reader.result||'');
      if(!isSafePosterSrc(rawDataUrl))return reject(new Error("Format d'image non reconnu (utilise PNG, JPG ou WEBP)."));
      if(typeof Image==='undefined'||typeof document==='undefined'||!document.createElement){
        return resolve(rawDataUrl);
      }
      const probeCanvas=document.createElement('canvas');
      if(!probeCanvas||typeof probeCanvas.getContext!=='function')return resolve(rawDataUrl);
      const img=new Image();
      img.onerror=()=>resolve(rawDataUrl);
      img.onload=()=>{
        try{
          const origW=img.naturalWidth||img.width||1400;
          const origH=img.naturalHeight||img.height||950;
          const encodeAt=(maxSide,quality)=>{
            let w=origW,h=origH;
            if(w>maxSide||h>maxSide){
              const ratio=Math.min(maxSide/w,maxSide/h);
              w=Math.max(1,Math.round(w*ratio));
              h=Math.max(1,Math.round(h*ratio));
            }
            const c=document.createElement('canvas');
            c.width=w;c.height=h;
            const ctx=c.getContext('2d');
            if(!ctx)return rawDataUrl;
            ctx.fillStyle='#f4ecd8';
            ctx.fillRect(0,0,w,h);
            ctx.drawImage(img,0,0,w,h);
            return c.toDataURL('image/jpeg',quality);
          };
          let out=encodeAt(1600,0.86);
          if(out.length>750000)out=encodeAt(1400,0.78);
          if(out.length>750000)out=encodeAt(1200,0.72);
          resolve(isSafePosterSrc(out)?out:rawDataUrl);
        }catch(err){resolve(rawDataUrl);}
      };
      img.src=rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}
function triggerEventPosterUpload(slug){
  pendingPosterSlug=slug||currentSlug;
  const inp=document.getElementById('event-poster-input');
  if(!inp){alert("Champ d'import d'affiche introuvable.");return;}
  inp.value='';
  if(typeof inp.click==='function')inp.click();
}
async function handleEventPosterFile(ev){
  const file=ev&&ev.target&&ev.target.files&&ev.target.files[0];
  const slug=pendingPosterSlug||currentSlug;
  if(!file||!slug)return;
  const statusEl=document.getElementById('event-poster-status');
  if(statusEl){statusEl.style.color='#132d35';statusEl.textContent="⏳ Optimisation et envoi de l'affiche sur le serveur…";}
  try{
    const dataUrl=await compressPosterImage(file);
    await saveEventPoster(slug,dataUrl);
  }catch(e){
    if(statusEl){statusEl.style.color='#9c3021';statusEl.textContent='✗ '+(e.message||e);}
    else alert('Erreur : '+(e.message||e));
  }
}
async function saveEventPoster(slug,dataUrl){
  if(!slug)throw new Error('Événement non spécifié.');
  if(dataUrl&&!isSafePosterSrc(dataUrl))throw new Error('Image invalide.');
  let evName=slug;
  const listed=events.find(x=>x.slug===slug);
  if(listed&&listed.name)evName=listed.name;
  else if(eventContext&&eventContext.slug===slug&&eventContext.name)evName=eventContext.name;

  if(backendMulti){
    const getRes=await apiGet('/api/events/'+encodeURIComponent(slug));
    if(!getRes.ok)throw new Error("Impossible de charger l'événement ("+getRes.status+').');
    const remoteEv=await getRes.json();
    const nextData=Object.assign({},remoteEv.data||{});
    if(!Array.isArray(nextData.sessions))nextData.sessions=[];
    if(!nextData.penMap||typeof nextData.penMap!=='object')nextData.penMap={};
    if(dataUrl)nextData.posterImage=dataUrl;
    else delete nextData.posterImage;

    const postRes=await apiPost('/api/events/'+encodeURIComponent(slug)+'/data',nextData);
    if(!postRes.ok){
      const pj=await postRes.json().catch(()=>({}));
      throw new Error(pj.error||pj.message||('HTTP '+postRes.status));
    }
    const nextCfg=Object.assign({},remoteEv.points_config||(listed&&listed.points_config)||{});
    if(dataUrl)nextCfg.hasPoster=true;
    else delete nextCfg.hasPoster;
    delete nextCfg.posterImage;
    await apiPut('/api/events/'+encodeURIComponent(slug),{pointsConfig:nextCfg}).catch(()=>null);

    if(listed){
      listed.points_config=nextCfg;
      listed.updated_at=new Date().toISOString();
      if(listed.data)listed.data=nextData;
    }
    if(currentSlug===slug&&eventContext){
      eventContext.pointsConfig=nextCfg;
      eventContext.data=Object.assign({},eventContext.data||{},nextData);
      if(!dataUrl&&eventContext.data)delete eventContext.data.posterImage;
    }
  }else{
    if(!eventContext)eventContext={slug:LEGACY_DEFAULT_SLUG,name:evName,kind:'championship',pointsConfig:DEFAULT_POINTS,data:{}};
    if(!eventContext.data)eventContext.data={};
    if(dataUrl)eventContext.data.posterImage=dataUrl;
    else delete eventContext.data.posterImage;
    if(adminToken)await saveRemote();
  }
  saveLocalPosterEntry(slug,dataUrl||'');
  render();
  const statusEl=document.getElementById('event-poster-status');
  if(statusEl){
    statusEl.style.color='#3b6341';
    statusEl.textContent=dataUrl
      ?`✓ Affiche enregistrée pour « ${evName} » (affichée dans l'onglet Accueil de l'événement).`
      :`✓ Affiche retirée pour « ${evName} ».`;
  }
}
async function removeEventPoster(slug){
  const listed=events.find(x=>x.slug===slug);
  const label=(listed&&listed.name)||(eventContext&&eventContext.slug===slug&&eventContext.name)||slug;
  if(!confirm(`Retirer l'affiche officielle pour « ${label} » ?`))return;
  try{
    await saveEventPoster(slug,'');
  }catch(e){
    alert('Erreur : '+(e.message||e));
  }
}

async function saveEventHomePatch(slug,mutator,okMessage){
  if(!slug)throw new Error('Événement non spécifié.');
  let evName=slug;
  const listed=events.find(x=>x.slug===slug);
  if(listed&&listed.name)evName=listed.name;
  else if(eventContext&&eventContext.slug===slug&&eventContext.name)evName=eventContext.name;

  if(backendMulti){
    const getRes=await apiGet('/api/events/'+encodeURIComponent(slug));
    if(!getRes.ok)throw new Error("Impossible de charger l'événement ("+getRes.status+').');
    const remoteEv=await getRes.json();
    const nextData=Object.assign({},remoteEv.data||{});
    if(!Array.isArray(nextData.sessions))nextData.sessions=[];
    if(!nextData.penMap||typeof nextData.penMap!=='object')nextData.penMap={};
    mutator(nextData);
    const postRes=await apiPost('/api/events/'+encodeURIComponent(slug)+'/data',nextData);
    if(!postRes.ok){
      const pj=await postRes.json().catch(()=>({}));
      throw new Error(pj.error||pj.message||('HTTP '+postRes.status));
    }
    if(listed){
      listed.updated_at=new Date().toISOString();
      if(listed.data)listed.data=nextData;
    }
    if(currentSlug===slug&&eventContext){
      eventContext.data=Object.assign({},eventContext.data||{},nextData);
      if(!nextData.galleryImages&&eventContext.data)delete eventContext.data.galleryImages;
      if(!nextData.eventInfo&&eventContext.data)delete eventContext.data.eventInfo;
    }
  }else{
    if(!eventContext)eventContext={slug:LEGACY_DEFAULT_SLUG,name:evName,kind:'championship',pointsConfig:DEFAULT_POINTS,data:{}};
    if(!eventContext.data)eventContext.data={};
    mutator(eventContext.data);
    if(adminToken)await saveRemote();
  }
  render();
  const statusEl=document.getElementById('event-poster-status');
  if(statusEl&&okMessage){
    statusEl.style.color='#3b6341';
    statusEl.textContent=okMessage;
  }
}

async function saveEventInfoForm(){
  if(!currentSlug&&backendMulti)return;
  const slug=currentSlug||LEGACY_DEFAULT_SLUG;
  const val=id=>{const el=document.getElementById(id);return el&&typeof el.value==='string'?el.value.trim():'';};
  const info={
    car:val('evinfo-car'),
    schedule:val('evinfo-schedule'),
    briefing:val('evinfo-briefing'),
    formatText:val('evinfo-format'),
    rulesUrl:val('evinfo-rules'),
    skinsUrl:val('evinfo-skins'),
    discordUrl:val('evinfo-discord')
  };
  for(const k of ['rulesUrl','skinsUrl','discordUrl']){
    if(info[k]&&!isSafeHttpUrl(info[k])){
      alert('URL invalide pour '+k+' (doit commencer par https://, http:// ou /).');
      return;
    }
  }
  const hasAny=Object.values(info).some(Boolean);
  try{
    await saveEventHomePatch(slug,d=>{
      if(hasAny)d.eventInfo=info;
      else delete d.eventInfo;
    },'✓ Informations de l’onglet Accueil événement enregistrées.');
  }catch(e){
    const statusEl=document.getElementById('event-poster-status');
    if(statusEl){statusEl.style.color='#9c3021';statusEl.textContent='✗ '+(e.message||e);}
    else alert('Erreur : '+(e.message||e));
  }
}

function triggerEventGalleryUpload(){
  const inp=document.getElementById('event-gallery-input');
  if(!inp){alert("Champ d'import galerie introuvable.");return;}
  inp.value='';
  if(typeof inp.click==='function')inp.click();
}
async function handleEventGalleryFile(ev){
  const file=ev&&ev.target&&ev.target.files&&ev.target.files[0];
  const slug=currentSlug||LEGACY_DEFAULT_SLUG;
  if(!file||!slug)return;
  const capEl=document.getElementById('evgal-caption');
  const caption=capEl&&typeof capEl.value==='string'?capEl.value.trim():'';
  const statusEl=document.getElementById('event-poster-status');
  if(statusEl){statusEl.style.color='#132d35';statusEl.textContent='⏳ Ajout de l’image à la galerie de l’événement…';}
  try{
    const dataUrl=await compressPosterImage(file);
    await saveEventHomePatch(slug,d=>{
      const cur=Array.isArray(d.galleryImages)?d.galleryImages.filter(g=>g&&isSafePosterSrc(g.src)):[];
      if(cur.length>=6)throw new Error('Maximum 6 images dans la galerie par événement.');
      cur.push({src:dataUrl,caption});
      d.galleryImages=cur;
    },'✓ Image ajoutée à la galerie de l’Accueil événement.');
  }catch(e){
    if(statusEl){statusEl.style.color='#9c3021';statusEl.textContent='✗ '+(e.message||e);}
    else alert('Erreur : '+(e.message||e));
  }
}
async function removeEventGalleryImage(idx){
  const slug=currentSlug||LEGACY_DEFAULT_SLUG;
  if(!slug)return;
  try{
    await saveEventHomePatch(slug,d=>{
      const cur=Array.isArray(d.galleryImages)?d.galleryImages.slice():[];
      cur.splice(idx,1);
      if(cur.length)d.galleryImages=cur;
      else delete d.galleryImages;
    },'✓ Image retirée de la galerie.');
  }catch(e){
    alert('Erreur : '+(e.message||e));
  }
}

function renderEventsAdmin(){
  if(!events.length)return '<p class="note">Aucun événement.</p>';
  const fileInput=`<input type="file" id="event-poster-input" accept="image/*" style="display:none" onchange="handleEventPosterFile(event)"><input type="file" id="event-gallery-input" accept="image/*" style="display:none" onchange="handleEventGalleryFile(event)">`;
  const topBar=`${fileInput}<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px"><button class="btn" onclick="createEventPrompt()">+ Créer un événement</button>${currentSlug&&eventContext?`<button class="btn secondary" onclick="triggerEventPosterUpload('${currentSlug.replace(/'/g,"\\'")}')">🖼️ ${hasEventPoster(eventContext)?'Changer':'Insérer'} l'affiche de l'événement courant (${esc(eventContext.name)})</button><button class="btn secondary" onclick="deleteCurrentEvent()">Supprimer l'événement courant</button>`:''}</div><div id="event-poster-status" class="note" style="margin-bottom:12px"></div>`;
  const row=(e)=>{
    const safe=e.slug.replace(/'/g,"\\'");
    const tag = e.kind==='championship'?'<span class="tag live">CHAMPIONNAT</span>':e.kind==='open'?'<span class="tag open">OPEN</span>':'<span class="tag archive">ARCHIVÉ</span>';
    const posterOn=hasEventPoster(e);
    let actions;
    if(e.kind==='archive'){
      actions=`<button class="btn secondary small" onclick="setEventKind('${safe}','championship')">Réactiver en championnat</button>
               <button class="btn secondary small" onclick="setEventKind('${safe}','open')">Réactiver en open</button>`;
    }else{
      actions=`<button class="btn secondary small" onclick="setEventKind('${safe}','archive')">🏁 Clôturer (archiver)</button>`;
    }
    const posterBtns=posterOn
      ?`<button class="btn secondary small" onclick="triggerEventPosterUpload('${safe}')">🖼️ Changer l'affiche</button><button class="btn secondary small" onclick="removeEventPoster('${safe}')" title="Retirer l'affiche">✕ Affiche</button>`
      :`<button class="btn secondary small" onclick="triggerEventPosterUpload('${safe}')">🖼️ Insérer une affiche</button>`;
    return `<tr>
      <td>${tag}</td>
      <td><b>${esc(e.name)}</b><br><span class="muted" style="font-size:12px">${esc(e.slug)}</span></td>
      <td>${currentSlug===e.slug?'<span class="tag live">▶</span>':''}</td><td>${e.points_config&&e.points_config.globalCoef?'×'+e.points_config.globalCoef:'—'}</td>
      <td>${posterOn?'<span class="tag live">✓ Active</span>':'<span class="muted">—</span>'}</td>
      <td>${new Date(e.updated_at).toLocaleDateString('fr-FR')}</td>
      <td style="white-space:nowrap;text-align:right">
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn secondary small" onclick="switchEvent('${safe}')">Ouvrir</button>
          ${posterBtns}
          ${actions}
          <button class="btn secondary small" style="border-color:#9c3021;color:#9c3021" onclick="deleteEvent('${safe}')">Supprimer</button>
        </div>
      </td>
    </tr>`;
  };
  const currentPoster=getEventPoster(eventContext);
  const rawInfo=(eventContext&&eventContext.data&&eventContext.data.eventInfo)||{};
  const gallery=getEventGallery(eventContext);
  const evHomeEditor=(currentSlug&&eventContext)?`<div class="panel" style="margin-top:18px;background:#f4ecd8">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
      <div><div class="eyebrow">Onglet Accueil de l'événement courant</div><h3 style="margin:2px 0 0">${esc(eventContext.name)}</h3></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn secondary small" onclick="go('event')">Voir l'Accueil événement →</button>
        ${currentPoster?`<button type="button" class="btn secondary small" onclick="removeEventPoster('${currentSlug.replace(/'/g,"\\'")}')">Retirer l'affiche</button>`:''}
      </div>
    </div>
    ${currentPoster?`<img src="${esc(currentPoster)}" alt="Aperçu affiche" style="display:block;max-width:440px;width:100%;height:auto;border:1px solid #c9bba1;margin-bottom:14px">`:''}
    <div class="admin-evhome-grid">
      <label>Voiture / Catégorie<input id="evinfo-car" type="text" value="${esc(rawInfo.car||'')}" placeholder="Ex : Lola T290 · Prototypes historiques"></label>
      <label>Horaires / Rendez-vous<input id="evinfo-schedule" type="text" value="${esc(rawInfo.schedule||'')}" placeholder="Ex : Mercredi 21h00 · Essais 20h30"></label>
      <label style="grid-column:1 / -1">Présentation / Briefing de l'événement<textarea id="evinfo-briefing" rows="3" placeholder="Texte d'accueil affiché sur l'onglet Accueil de l'événement…">${esc(rawInfo.briefing||'')}</textarea></label>
      <label style="grid-column:1 / -1">Précision format sportif (optionnel)<input id="evinfo-format" type="text" value="${esc(rawInfo.formatText||'')}" placeholder="Laisser vide pour le résumé automatique du barème"></label>
      <label>Lien Règlement PDF (optionnel)<input id="evinfo-rules" type="text" value="${esc(rawInfo.rulesUrl||'')}" placeholder="https://..."></label>
      <label>Lien Pack Skins / Mod (optionnel)<input id="evinfo-skins" type="text" value="${esc(rawInfo.skinsUrl||'')}" placeholder="https://..."></label>
      <label style="grid-column:1 / -1">Lien Discord / Inscription (optionnel)<input id="evinfo-discord" type="text" value="${esc(rawInfo.discordUrl||'')}" placeholder="https://discord.gg/kDZXwRgRS"></label>
    </div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button type="button" class="btn small" onclick="saveEventInfoForm()">💾 Enregistrer la présentation</button>
      <span class="muted">Astuce : pour ajouter des manches « À venir » au calendrier, utilise l'onglet <b>Manches</b>.</span>
    </div>
    <div style="margin-top:18px;padding-top:14px;border-top:1px dashed #c9bba1">
      <div class="eyebrow">Autres images · Galerie (${gallery.length} / 6)</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <input id="evgal-caption" type="text" class="admin-input" placeholder="Légende optionnelle de la photo…" style="min-width:240px">
        <button type="button" class="btn secondary small" onclick="triggerEventGalleryUpload()">📷 Ajouter une image à la galerie</button>
      </div>
      ${gallery.length?`<div class="admin-gal-thumbs">${gallery.map((g,idx)=>`<div class="admin-gal-thumb"><button type="button" class="admin-gal-del" title="Retirer" onclick="removeEventGalleryImage(${idx})">✕</button><img src="${esc(g.src)}" alt="${esc(g.caption||'Photo')}"><div class="muted" style="font-size:10px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.caption||'Sans légende')}</div></div>`).join('')}</div>`:''}
    </div>
  </div>`:'';
  return topBar+table(['','Événement','Courant','Coeff','Affiche','Mis à jour',''],events.map(row))+evHomeEditor;
}

function renderChampPointsPanel(){
  const ds=allDrivers();
  if(!ds.length)return `<div class="panel" style="margin:14px 0;background:#f4ecd8"><div class="eyebrow">Points au championnat</div><p class="note" style="margin:6px 0 0">Importe au moins une session pour pouvoir attribuer ou retirer des points à un pilote.</p></div>`;
  return `<div class="panel" style="margin:14px 0;background:#f4ecd8">
    <div class="eyebrow">Classement général &amp; Joker</div>
    <h3 style="margin:4px 0 8px">Points au championnat (bonus / pénalité)</h3>
    <p class="note" style="margin:0 0 12px">Choisis un pilote, indique le nombre de points puis clique sur <b>+ Ajouter des points</b> ou <b>− Enlever des points</b>. L'ajustement s'applique directement au cumul du championnat (général et Joker).</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <select id="champ-pts-driver" style="min-width:220px"><option value="">— Choisir un pilote —</option>${ds.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select>
      <input id="champ-pts-delta" type="number" step="any" min="0.5" placeholder="Nb de points (ex : 5)" class="admin-input" style="min-width:165px;max-width:185px">
      <input id="champ-pts-note" type="text" placeholder="Motif / note (ex : sanction Commission, bonus…)" class="admin-input" style="flex:1;min-width:220px">
      <button class="btn" style="background:#3b6341" onclick="submitChampPointsAdj(1)">+ Ajouter des points</button>
      <button class="btn" onclick="submitChampPointsAdj(-1)">− Enlever des points</button>
    </div>
  </div>`;
}

function admin(){
  if(!adminAuth){return `${head('administration','Direction de course','Accès direction de course.')}<div class="panel"><h2>Connexion direction de course</h2><p class="note">Identifiant et mot de passe configurés dans les variables d'environnement Render (<code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code>). Les classements restent consultables librement.</p><div style="display:flex;gap:10px;align-items:center;max-width:520px;flex-wrap:wrap"><input id="adminuser" type="text" placeholder="Identifiant" class="admin-input" style="min-width:140px"><input id="adminpass" type="password" placeholder="Mot de passe" style="flex:1;min-width:200px" class="admin-input"><button class="btn" onclick="adminLogin()">Entrer</button></div></div>`}
  // Quand on arrive sur Admin depuis le hub (pas d'event), ouvrir par défaut sur "Événements"
  // (où l'on peut créer/choisir un event) plutôt que sur "Imports" qui nécessite un event chargé.
  if(backendMulti&&!eventContext&&adminTab==='import')adminTab='events';
  const rs=rounds();
  const allDrv=allDrivers();
  const adjList=Object.entries(penMap).map(([k,v])=>{
    const safeKey=esc(String(k).replace(/'/g,"\\'"));
    if(v&&Number.isFinite(Number(v.pointsDelta))&&Number(v.pointsDelta)!==0){
      const pts=Number(v.pointsDelta);
      const did=v.driverId||(k.startsWith('champ:')?k.split(':')[1]:k.split(':')[2]);
      const drv=allDrv.find(x=>x.id===did);
      const drvName=(drv&&drv.name)||v.driverName||'(pilote)';
      const txt=(pts>0?'+':'')+pts+' pt'+(Math.abs(pts)>1?'s':'');
      const badge=pts<0?`<span class="penalty">${esc(txt)}</span>`:`<span style="color:#3b6341;font-weight:700">${esc(txt)}</span>`;
      return `<tr><td><span class="tag live">Championnat</span></td><td>Classement général</td><td><b>${esc(drvName)}</b></td><td>${badge}</td><td>${esc(v.note||'')}</td><td><button class="btn secondary small" onclick="removeAdjustment('${safeKey}')">Retirer</button></td></tr>`;
    }
    const [rj,sj,did]=k.split(':');const ri=+rj,si=+sj,r=rs[ri],s=r&&r.sessions[si];const drv=s&&s.results.find(x=>x.id===did);const raceCount=r?r.sessions.slice(0,si+1).filter(x=>x.type==='RACE').length:0;let label='';if(v.dq)label='DQ';else if(v.dns)label='DNS';else if(v.dnf)label='DNF';else if(typeof v.timeAdd==='number'&&v.timeAdd!==0)label=(v.timeAdd>0?'+':'')+v.timeAdd+' s';else if(v.warning)label='Avertissement';return `<tr><td>${r?'M'+r.number:'—'}</td><td>${s?(s.type==='QUALIFY'?'Qualif':'Course '+raceCount):'—'}</td><td>${esc(drv?drv.name:'(pilote)')}</td><td>${label}</td><td>${esc(v.note||'')}</td><td><button class="btn secondary small" onclick="removeAdjustment('${safeKey}')">Retirer</button></td></tr>`;
  });
  const importedDateSet=new Set(rs.map(r=>String(r.date).slice(0,10)));
  const plannedRoundCards=(customCalendar&&typeof customCalendar==='object')
    ?Object.entries(customCalendar)
      .filter(([dt,val])=>dt&&val&&!importedDateSet.has(String(dt).slice(0,10)))
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([dt,val],idx)=>{
        const safeDt=esc(String(dt).replace(/'/g,"\\'"));
        return `<div class="admin-round" style="border-style:dashed"><b>Manche ${rs.length+idx+1} · ${esc(track(val.track||''))} <span class="tag" style="margin-left:6px">À VENIR</span></b><div class="muted">${date(dt)} · Date prévisionnelle</div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn secondary small" onclick="removePlannedRound('${safeDt}')">Retirer</button></div></div>`;
      }).join('')
    :'';
  const roundCards=rs.map((r,i)=>{
    const races=r.sessions.filter(s=>s.type==='RACE').length;
    const quals=r.sessions.filter(s=>s.type==='QUALIFY').length;
    const info=quals?`${races} course(s) · ${quals} qualif`:`${races} course(s)`;
    return `<div class="admin-round"><b>Manche ${r.number} · ${esc(track(r.track))}</b><div class="muted">${date(r.date)} · ${info}</div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn secondary small" onclick="openAdj(${i})">Pénalités</button><button class="btn secondary small" onclick="resetRound(${i})">Effacer</button></div></div>`;
  }).join('')+plannedRoundCards;
  // Les onglets qui nécessitent un événement chargé : imports/manches/commission/pilotes/données.
  // Les autres onglets (events, ah, globalexc) fonctionnent SANS événement sélectionné.
  const eventTabs=new Set(['import','rounds','adjust','drivers','data']);
  if(backendMulti&&!eventContext&&eventTabs.has(adminTab)){
    return `${head('administration','Direction de course','')}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px"><span class="tag">Connecté : ${esc(adminUser)}</span><button class="btn secondary small" onclick="adminLogout()">Déconnexion</button></div><div class="tabs">${[['import','Imports'],['rounds','Manches'],['adjust','Commission'],['drivers','Pilotes'],['data','Données']].concat(backendMulti?[['events','Événements'],['ah','Serveurs AH'],['circuits','Circuits'],['globalexc','Global · exclusions']]:[]).map(([id,l])=>`<button class="${adminTab===id?'active':''}" onclick="adminTabs('${id}')">${l}</button>`).join('')}</div><div class="panel"><h2>Sélectionne d'abord un événement</h2><p class="note">Choisis un championnat/open dans le menu en haut à droite, ou crée-en un depuis l'onglet <b>« Serveurs AH »</b> ou <b>« Événements »</b>, avant d'importer des résultats.</p><button class="btn secondary" onclick="goHome()">← Retour à l'accueil</button></div>`;
  }
  return `${head('administration','Direction de course','Gestion des imports, pénalités, calendrier et sauvegarde.')}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px"><span class="tag">Connecté : ${esc(adminUser)}</span><button class="btn secondary small" onclick="adminLogout()">Déconnexion</button></div><div class="tabs">${[['import','Imports'],['rounds','Manches'],['adjust','Commission'],['drivers','Pilotes'],['data','Données']].concat(backendMulti?[['events','Événements'],['ah','Serveurs AH'],['circuits','Circuits'],['globalexc','Global · exclusions']]:[]).map(([id,l])=>`<button class="${adminTab===id?'active':''}" onclick="adminTabs('${id}')">${l}</button>`).join('')}</div><div class="panel">${adminTab==='import'?`<h2>Importer des résultats</h2><p class="note">Import direct depuis les deux serveurs AssettoHosting GDSP (fr2 / fr5) : <b>PRACTICE ignorés</b>, sessions dont le nom contient « test » ignorées, doublons détectés automatiquement.</p><div style="margin:12px 0"><button class="btn" onclick="ahImport()">📥 Importer automatiquement les nouveaux résultats</button></div><div id="ah-result"></div><div class="grid" style="margin-top:16px"><div class="panel"><h3>Importer un fichier JSON</h3><p class="note">Import manuel si besoin (un ou plusieurs).</p><input type="file" accept=".json" onchange="handleImport(event)"><br><input type="file" accept=".json" multiple onchange="bulkImport(event)" style="margin-top:8px"></div><div class="panel"><h3>Règles de filtrage automatique</h3><ul class="note"><li>QUALIFY et RACE importés.</li><li>PRACTICE systématiquement ignorés.</li><li>Toute session dont le nom (serveur/piste) contient « test » est ignorée.</li><li>Une session déjà importée (même date/heure et type) n'est pas réimportée.</li></ul></div></div>${currentSlug?`<p class="note" style="margin-top:12px">Ces résultats iront dans <b>${esc(eventContext.name)}</b>.</p>`:''}`:adminTab==='rounds'?`<h2>Calendrier et manches</h2><p class="note">${rs.length} manches chargées.</p><div class="grid admin-grid">${roundCards}<div class="admin-round dashed"><button class="btn secondary" onclick="addRound()">+ Ajouter une manche au calendrier</button></div></div>`:adminTab==='adjust'?`<h2>Commission</h2><p class="note">Ajustements de points au championnat (+ / −), pénalités temps en course (reclassement automatique), DNF/DNS/DQ ou avertissements.</p>${renderChampPointsPanel()}${selectedRaceAdj!==null&&rs[selectedRaceAdj]?renderAdjPanel(rs[selectedRaceAdj]):rs.length?`<div class="controls"><select onchange="selectedRaceAdj=this.value===''?null:+this.value;render()"><option value="">— Choisir une manche pour ajuster un résultat de course —</option>${rs.map((x,i)=>`<option value="${i}">Manche ${x.number} · ${esc(track(x.track))}</option>`).join('')}</select></div>`:`<p class="note">Aucune manche importée pour les pénalités de course.</p>`}${table(['Manche','Session','Pilote','Ajustement','Note',''],adjList)}`:adminTab==='drivers'?`<h2>Pilotes et équipes</h2><div class="driver-admin-list">${allDrivers().map(d=>`<div class="driver-admin-row"><span>${number(d.name)} <b>${esc(d.name)}</b> <span class="muted">${esc(d.team)}</span></span><button class="btn secondary small" onclick="editDriver('${d.id}')">Modifier</button></div>`).join('')}</div>`:adminTab==='events'?`<h2>Gestion des championnats & opens</h2><p class="note">Liste de tous les événements configurés. Un événement <b>clôturé</b> bascule dans les <b>Archives</b> et n'apparaît plus sur la page d'accueil. Les classements et résultats restent accessibles depuis la section Archives et depuis le classement GLOBAL.</p>${renderEventsAdmin()}`:adminTab==='ah'?`<h2>Découverte automatique depuis AssettoHosting</h2><p class="note">Scanne les deux serveurs GDSP (fr2:50648 et fr5:50145), récupère la liste des championnats/opens avec leur barème. Les PRACTICE et événements « test » sont filtrés. Clique sur « Créer » pour ajouter un événement dans le portail avec son barème, puis va sur l'onglet Imports de cet événement pour importer ses sessions.</p><div style="margin:12px 0"><button class="btn" onclick="ahScanChamps()">🔍 Scanner les serveurs AH</button></div><div id="ah-champs-result"><p class="note">Clique sur « Scanner » pour commencer.</p></div>`:adminTab==='circuits'?renderCircuitsAdmin():adminTab==='globalexc'?renderGlobalExclusions()
:`<h2>Données et sauvegarde</h2><p class="note">Les modifications sont sauvegardées en PostgreSQL (Render/Neon).</p><div id="save-status" class="note" style="margin:8px 0"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" onclick="exportData()">Exporter</button><button class="btn" onclick="doSaveRemote()">Enregistrer sur le serveur</button><button class="btn secondary" onclick="if(confirm('Recharger la dernière sauvegarde serveur ?')){(backendMulti&&currentSlug?loadEvent(currentSlug):loadRemoteLegacy()).then(()=>render())}">Recharger depuis le serveur</button><button class="btn secondary" onclick="resetChampionship()">Vider cet événement</button></div><p class="note" style="margin-top:12px">${currentSlug?`Événement courant : <b>${esc(eventContext.name)}</b> · `:''}Sessions chargées : ${sessions.length}.</p>`}</div>`;
}
function renderAdjPanel(r){
  const rs=rounds();
  // rounds() recrée ses objets : retrouver la manche par sa date, pas sa référence.
  const curIdx=rs.findIndex(x=>x.date===r.date);
  const switcher=(i)=>`selectedRaceAdj=${i};render()`;
  // Compter correctement les courses (RACE) — pas juste length-1 (certaines manches n'ont pas de qualif).
  const racesCount=r.sessions.filter(s=>s.type==='RACE').length;
  const quaysCount=r.sessions.filter(s=>s.type==='QUALIFY').length;
  let html=`<div class="controls"><select onchange="${switcher('Number(this.value)')}">${rs.map((x,i)=>`<option value="${i}" ${i===curIdx?'selected':''}>Manche ${x.number} · ${esc(track(x.track))}</option>`).join('')}</select></div><p class="note">${racesCount} course(s)${quaysCount?' · '+quaysCount+' qualif':''}. Sélectionne un pilote pour ajuster son résultat.</p><div class="grid">`;
  r.sessions.forEach((s,sj)=>{
    if(s.type!=='RACE')return;
    const raceNum=r.sessions.slice(0,sj+1).filter(x=>x.type==='RACE').length;
    const rIdx=r.number-1;
    html+=`<div class="panel"><h3>Course ${raceNum}</h3>${table(['Pos.','Pilote','Ajuster'],s.results.map((p,i)=>`<tr><td class="pos">${i+1}</td><td>${esc(p.name)}</td><td><button class="btn secondary small" onclick="openAdjForm(${rIdx},${sj},'${String(p.id).replace(/'/g,"\\'")}')">Modifier</button></td></tr>`))}</div>`;
  });
  return html+'</div>';
}
function openAdj(roundIdx){selectedRaceAdj=roundIdx;adminTab='adjust';render()}
function openAdjForm(rj,sj,did){
  const choice=String(prompt('Ajustement :\n1=Pénalité temps\n2=DNF non-classé (<75%)\n3=DNS (absent)\n4=DQ\n5=Avertissement\n0=Annuler','1')||'').trim();
  if(!choice||choice==='0')return;
  if(choice==='2'){
    if(!confirm('DNF non-classé (<75%) ?'))return;
    addAdjustment(rj,sj,did,0,false,false,prompt('Note ?','Abandon')||'Abandon',{dnf:true});return;
  }
  if(choice==='3'){
    if(!confirm('DNS (absent) ?'))return;
    addAdjustment(rj,sj,did,0,false,false,prompt('Note ?','Absent')||'Absent',{dns:true});return;
  }
  if(choice==='4'){
    if(!confirm('DQ (drapeau noir) ?'))return;
    addAdjustment(rj,sj,did,0,true,false,prompt('Note ?','')||'');return;
  }
  if(choice==='5'){
    if(!confirm('Avertissement sans sanction ?'))return;
    addAdjustment(rj,sj,did,0,false,true,'');return;
  }
  const ta=prompt('Ajustement temps en secondes ?','0');
  if(ta===null)return;
  addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note / motif ?','')||'');
}

// ---------- AssettoHosting auto-import ----------
// ---------- AH championship discovery ----------
let ahChampsCache=null;
async function ahScanChamps(){
  const out=document.getElementById('ah-champs-result');
  if(out)out.innerHTML='<p class="note">Scan des serveurs AssettoHosting en cours… (peut prendre 10-20s, les serveurs doivent être réveillés)</p>';
  try{
    const r=await apiGet('/api/ah-championships');
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error((j.error||'HTTP '+r.status)+'');
    if(!Array.isArray(j.items))throw new Error('Réponse inattendue (items non tableau): '+JSON.stringify(j).slice(0,200));
    ahChampsCache=j.items;
    renderAhChamps();
  }catch(e){if(out)out.innerHTML=`<p class="note" style="color:#9c3021">✗ ${esc(e.message)}</p>`;console.error('ah-scan',e)}
}
function renderAhChamps(){
  const out=document.getElementById('ah-champs-result');if(!out||!ahChampsCache)return;
  try{
  if(!Array.isArray(ahChampsCache)){out.innerHTML='<p class="note">Réponse invalide du serveur.</p>';return}
  if(!ahChampsCache.length){out.innerHTML='<p class="note">Aucun championnat trouvé.</p>';return}
  const existing=new Set(events.map(e=>e.slug));
  const rows=ahChampsCache.map(c=>{
    try{
      const exists=events.some(e=>e.slug===c.slug);
      const tag=(c.kind==='open')?'<span class="tag open">OPEN</span>':'<span class="tag live">CHAMPIONNAT</span>';
      const scale=Array.isArray(c.pointsScale)?c.pointsScale:[];
      const prog=Number.isFinite(c.progress)?c.progress.toFixed(0):'—';
      const nev=Number.isFinite(c.numEvents)?c.numEvents:0;
      return `<tr>
        <td>${tag}</td>
        <td><b>${esc(c.name||'?')}</b><br><span class="muted">${esc(String(c.server||'').replace('https://',''))}</span></td>
        <td>${prog}</td>
        <td>${nev}</td>
        <td>${scale.slice(0,5).join('/')}${scale.length>5?'…':''}</td>
        <td>${exists?'<span class="tag archive">déjà présent</span>':`<button class="btn secondary small" data-ah-server="${esc(c.server)}" data-ah-uuid="${esc(c.uuid)}" data-ah-slug="${esc(c.slug)}" onclick="ahCreateEventFromBtn(this)">+ Créer</button>`}</td>
      </tr>`;
    }catch(e){return `<tr><td colspan="6" class="muted">Erreur ligne : ${esc(e.message)}</td></tr>`}
  });
  out.innerHTML=`<p class="note">${ahChampsCache.length} championnats/opens détectés. Les championnats de type « test » et doublons ont été filtrés. Clique sur « Créer » pour ajouter un événement dans le portail avec son barème.</p>${table(['','Nom','Progression','Manches','Barème (places)',''],rows)}`;
  }catch(e){out.innerHTML='<p class="note" style="color:#9c3021">✗ '+esc(e.message)+'<br><pre style="font-size:11px;overflow:auto">'+esc(e.stack||'')+'</pre></p>'}
}
async function ahCreateEventFromBtn(btn){
  if(btn.disabled)return;
  const server=btn.dataset.ahServer, uuid=btn.dataset.ahUuid, slug=btn.dataset.ahSlug;
  const oldText=btn.textContent;
  btn.disabled=true;btn.textContent='⏳ Création…';
  try{
    // Vérifie d'abord que le backend répond (sinon ça va rester bloqué en erreur silencieuse)
    const h=await fetch('/api/events',{cache:'no-store'}).catch(()=>null);
    if(!h||!h.ok||!/json/i.test(h.headers.get('content-type')||'')){
      alert("❌ Le backend n'est pas joignable (API introuvable).\n\nLe frontend est actuellement servi en mode statique (GitHub Pages ou preview) sans proxy API. Pour créer des événements via AH, il faut déployer le serveur Node (app.js) sur Render avec le backend, ou utiliser le serveur local.\n\nLes autres pages (classements, résultats, GLOBAL) restent consultables normalement.");
      return;
    }
    if(!adminAuth||!adminToken){
      alert("Tu dois être connecté en tant qu'administrateur pour créer un événement.");
      return;
    }
    await ahCreateEvent(server,uuid,slug);
  }catch(e){
    alert('Erreur : '+e.message);
  }finally{
    btn.disabled=false;btn.textContent=oldText;
  }
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
    // Normalise le slug généré par AH (caractères non autorisés)
    const safeSlug=String(c.slug||'').toLowerCase()
      .replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'')
      .slice(0,60);
    if(!/^[a-z0-9][a-z0-9-]{1,60}$/.test(safeSlug)){
      throw new Error('Slug généré invalide ("'+c.slug+'"). Renomme le championnat sur AH puis rescane.');
    }
    markEventSlugDeleted(safeSlug,false);
    const r=await apiPost('/api/events',{slug:safeSlug,name:c.name,kind:c.kind,pointsConfig:cfg,data:{ahServer:c.server,ahUuid:c.uuid}});
    let j={};
    try{j=await r.json()}catch(e){
      const text=await r.text().catch(()=>'');
      throw new Error('Réponse inattendue du serveur (HTTP '+r.status+')'+(text?' : '+text.slice(0,200):''));
    }
    if(!r.ok)throw new Error(j.error||'Erreur HTTP '+r.status+' lors de la création.');
    // Sauvegarder le lien AH aussi en local
    try{localStorage.setItem('gdsp_ah_map',JSON.stringify(Object.assign({},JSON.parse(localStorage.getItem('gdsp_ah_map')||'{}'),{[safeSlug]:{server:c.server,uuid:c.uuid}})))}catch(e){}
    // Recharger events
    const lr=await apiGet('/api/events');
    let lj={};try{lj=await lr.json()}catch(e){}
    if(Array.isArray(lj.events))events=filterEventsList(lj.events);
    alert('✅ Événement créé : '+c.name+' (slug: '+safeSlug+').\n\nTu peux maintenant le sélectionner dans le menu et y importer ses résultats.');
    await switchEvent(safeSlug);
    render();
  }catch(e){alert('❌ Erreur création événement : '+e.message)}
}

async function ahImport(){
  const out=document.getElementById('ah-result');
  if(out){out.innerHTML='<p class="note">Scan des serveurs AssettoHosting en cours…</p>'}
  try{
    let endpoint='/api/ah-scan';
    let scopeNote='';
    if(ahConfig){
      endpoint=`/api/ah-championship-sessions?server=${encodeURIComponent(ahConfig.server)}&uuid=${encodeURIComponent(ahConfig.uuid)}`;
    }else if(currentSlug){
      if(!confirm("Cet événement n'est pas lié à un championnat AssettoHosting.\n\nL'importation va parcourir TOUS les résultats des serveurs GDSP et ne pourra pas distinguer les sessions de cet événement de celles des autres. Il est recommandé de lier l'événement depuis l'onglet « Serveurs AH » (supprime-le puis recrée-le avec + Créer).\n\nContinuer quand même ?")){
        if(out)out.innerHTML='<p class="note">Import annulé. Passe par l\'onglet « Serveurs AH » pour lier cet événement à un championnat AH, ou importe des fichiers JSON manuellement.</p>';
        return;
      }
    }
    const r=await apiGet(endpoint);
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    let items=(j.items||[]).map(x=>({...x,_type:x.sessionType||x.rawType||x.type}));
    // Filtres:
    // 1) Enlever PRACTICE
    items=items.filter(x=>x._type!=='PRACTICE');
    // 2) Enlever celles qui contiennent "test" dans le nom/serveur/url (insensible à la casse)
    const isTest=x=>/test/i.test((x.eventName||'')+' '+(x.sessionName||'')+' '+(x.filename||'')+' '+(x.server||''));
    items=items.filter(x=>!isTest(x));
    // 3) Enlever celles déjà importées (même date+type)
    const existing=new Set(sessions.filter(s=>s&&s.date).map(s=>{
      const k=new Date(s.date);return isFinite(k)?k.toISOString().slice(0,16)+'|'+s.type:null;
    }).filter(Boolean));
    const pending=items.filter(x=>{
      if(!x.date)return false;
      const d=new Date(x.date);if(!isFinite(d))return false;
      const key=d.toISOString().slice(0,16)+'|'+x._type;
      return !existing.has(key);
    });
    const alreadyKnown=items.length-pending.length;
    const evLabel=esc(j.championship||'');
    if(ahConfig && out){
      if(items.length===0){
        out.innerHTML=`<p class="note">Événement lié à <b>${evLabel}</b> (${j.events||0} manches côté AH), mais <b>AssettoHosting n'a conservé aucun résultat historique pour cet événement</b> (les données ont été purgées avec le temps). Importe les fichiers JSON manuellement si tu les possèdes encore.</p>`;
        return;
      }
      out.innerHTML=`<p class="note">Événement lié à <b>${evLabel}</b> (${j.events||0} manches côté AH, ${items.length} sessions récupérables depuis l'archive AH). ${pending.length} nouvelle(s), ${alreadyKnown} déjà importée(s).</p>`;
    }
    if(!pending.length){
      let msg;
      if(ahConfig)msg=`✅ Aucune nouvelle session à importer (${alreadyKnown} déjà présente${alreadyKnown>1?'s':''} dans cet événement).`;
      else msg=`✅ Aucune nouvelle session QUALIFY/RACE à importer (${alreadyKnown} déjà connues, PRACTICE ignorées).`;
      if(out)out.innerHTML=(ahConfig?out.innerHTML:'')+`<p class="note">${msg}</p>`;
      return;
    }
    if(out)out.innerHTML+=(ahConfig?'':`<p class="note">Récupération de ${pending.length} session(s) en cours…</p>`);
    let ok=0,err=0,details=[];
    for(const it of pending){
      try{
        let fr,txt,fname=it.filename||(it.rawType+'_'+(it.date||'').slice(0,10));
        if(it.source==='export'){
          const qs=new URLSearchParams({server:it.server,uuid:ahConfig.uuid,eventId:it.eventId,rawType:it.rawType}).toString();
          fr=await apiGet('/api/ah-championship-session-json?'+qs);
        }else{
          fr=await apiGet('/api/ah-fetch?url='+encodeURIComponent(it.url));
        }
        if(!fr.ok)throw new Error('HTTP '+fr.status);
        txt=await fr.text();
        if(importSessionJson(txt,fname,{silent:true})){ok++;details.push(`+ ${it._type} ${it.track||''} ${it.eventName?'('+it.eventName+')':''}`)}
        else{err++;details.push(`✗ erreur parsing ${fname}`)}
      }catch(e){err++;details.push(`✗ ${it._type} ${it.eventName||''}: ${e.message}`)}
    }
    if(ok>0)saveState();
    render();
    if(out)out.innerHTML+=`<p class="note"><b>Import terminé :</b> ${ok} session(s) importée(s), ${err} erreur(s).</p><ul class="note" style="font-family:monospace;font-size:11px">${details.map(d=>'<li>'+esc(d)+'</li>').join('')}</ul>`;
  }catch(e){if(out)out.innerHTML=`<p class="note" style="color:#9c3021">✗ Erreur : ${esc(e.message)}</p>`}
}

// Patch importSessionJson to support silent mode
const _origImport=importSessionJson;
importSessionJson=function(text,fileName,opts){
  opts=opts||{};
  let j;
  try{j=JSON.parse(text)}catch(e){if(!opts.silent)alert('Fichier JSON invalide : '+e.message);return false}
  try{
    function driverFrom(obj){const drv=obj.Driver||obj.driver||{};const guid=drv.Guid||obj.DriverGuid||obj.Guid||'';const name=clean(drv.Name||obj.DriverName||'').trim();return {id:pseudonymizeGuid(guid||name+'|'+(obj.CarId||obj.Model||Math.random())),name,team:clean(drv.Team||obj.Team||'')||'',skin:clean(obj.Skin||name||''),model:obj.Model||obj.CarModel}}
    function clean(v){return String(v||'').replace(/7656119\d{10}/g,m=>pseudonymizeGuid(m))}
    function toArr(x){
      if(Array.isArray(x))return x;
      if(x&&typeof x==='object'){const out=[];for(const k in x){if(x[k]&&typeof x[k]==='object')out.push(x[k])}return out}
      return [];
    }
    // Si le JSON est un export AH "Results" object imbriqué (Sessions.Events.Sessions.Results), extraire automatiquement
    if(!j.Type&&j.Results){j=j.Results}
    if(!j.Type){if(!opts.silent)alert('Ce fichier JSON ne semble pas être un résultat de session Assetto Corsa (champ Type/Date manquant). Utilise un fichier /results/download/*.json ou l\'export session AH.');return false}
    if(j.Type==='PRACTICE'){if(!opts.silent)alert('Les sessions PRACTICE ne sont pas importées.');return false}
    // Filtre "test"
    const serverName=String(j.ServerName||j.Name||''), track=String(j.TrackName||'');
    if(/test/i.test(serverName+' '+track)){if(!opts.silent)alert('Session ignorée (nom contient "test").');return false}
    const cars={};toArr(j.Cars).forEach(c=>{if(c&&c.CarId!=null)cars[c.CarId]=driverFrom(c)});
    const results=toArr(j.Result).map(r=>{
      if(!r)return null;
      const meta=cars[r.CarId]||driverFrom(r);
      return {id:meta.id,name:meta.name,team:meta.team||'',skin:meta.skin||'',grid:(typeof r.GridPosition==='number')?r.GridPosition:null,laps:r.NumLaps||0,best:r.BestLap,time:r.TotalTime,disqualified:!!r.Disqualified,hasPenalty:!!r.HasPenalty,penaltyTime:r.PenaltyTime||0,lapPenalty:r.LapPenalty||0}
    }).filter(r=>r&&!(r.model==='dodge_monaco_police'||/broadcast/i.test(r.name)));
    if(!results.length){if(!opts.silent)alert('Aucun pilote dans ce fichier, session ignorée.');return false}
    const laps=toArr(j.Laps).map(l=>{
      if(!l)return null;
      const meta=cars[l.CarId];if(!meta)return null;
      return {id:meta.id,time:l.LapTime,cuts:l.Cuts||0,timestamp:l.Timestamp}
    }).filter(Boolean);
    const events=toArr(j.Events).filter(e=>e&&e.Type==='COLLISION_WITH_CAR'&&j.Type==='RACE').map(e=>{
      const a=cars[e.CarId],b=cars[e.OtherCarId];if(!a||!b)return null;
      const ev={type:'COLLISION_WITH_CAR',a:a.name,b:b.name,aid:a.id,bid:b.id,speed:e.ImpactSpeed,timestamp:e.Timestamp};
      if(e.RelPosition)ev.RelPosition=e.RelPosition;
      return ev;
    }).filter(Boolean);
    let raceStart=null;
    if(j.Type==='RACE'){const c=[];laps.forEach(l=>{if(typeof l.timestamp==='number'&&typeof l.time==='number'&&l.time>40000&&l.time<600000)c.push(l.timestamp-l.time/1000)});if(c.length)raceStart=Math.min(...c)}
    if(!j.Date){if(!opts.silent)alert('Date manquante dans le JSON, session ignorée.');return false}
    const sess={date:j.Date,track:j.TrackName||'',type:j.Type,results,laps,events,raceStart};
    const idx=sessions.findIndex(x=>x.date===j.Date&&x.type===j.Type);
    if(idx>=0)sessions[idx]=sess;else sessions.push(sess);
    sessions.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    if(!opts.silent){saveState();alert(`Import réussi : ${j.Type} du ${j.Date} (${results.length} pilotes).`);render()}
    return true;
  }catch(err){console.error('import error',err);if(!opts.silent)alert('Erreur d\'import : '+err.message);return false}
};

function importSessionJson(text,fileName,opts){return importSessionJson(text,fileName,opts)}

// Collecte toutes les manches RACE de tous les événements chargés, groupées par date.
function collectAllRaces(){
  const out=[];
  for(const ev of events){
    const d=ev.data||{};
    const evSessions=Array.isArray(d.sessions)?d.sessions:[];
    const evPenMap=d.penMap||{};
    const evRounds=groupSessionsByDate(evSessions);
    evRounds.forEach((rd,rIdx)=>{
      out.push({
        date:rd.date,
        sessions:rd.sessions,
        roundIndex:rIdx,
        penMap:evPenMap,
        track:track(rd.sessions[0]&&rd.sessions[0].track),
        eventName:ev.name,
        eventKind:ev.kind,
        eventSlug:ev.slug
      });
    });
  }
  out.sort((a,b)=>a.date.localeCompare(b.date));
  out.forEach((r,i)=>r.number=i+1);
  return out;
}

// Fiche pilote GLOBALE (tous championnats/opens confondus)
function globalDriverProfile(){
  const id=globalDriverId;
  const ratings=globalPerformanceRatings();
  const r=ratings.find(x=>x.id===id);
  const allRounds=collectAllRaces();
  const races=[];
  for(const rd of allRounds){
    rd.sessions.forEach((s,sIdx)=>{
      if(!s||s.type!=='RACE')return;
      const sorted=sortSessionForPerf(s,rd.roundIndex,sIdx,rd.penMap);
      const idx=sorted.findIndex(x=>x.id===id);if(idx<0)return;
      const res=sorted[idx];
      const name=(res.name||'').trim().toLowerCase();
      const collisions=(s.events||[]).filter(e=>[e.a,e.b].some(v=>String(v||'').trim().toLowerCase()===name)).length;
      const laps=(s.laps||[]).filter(l=>l.id===id&&Number.isFinite(l.time)&&l.time>0&&l.time<600000);
      races.push({round:rd,session:s,result:res,position:idx+1,
        delta:(typeof res.grid==='number'&&res.grid>0)?res.grid-(idx+1):null,collisions,laps,eventName:rd.eventName});
    });
  }
  if(!r||!races.length)return `${head('global','Profil pilote','Classement GLOBAL Discord.')}<button class="btn secondary" onclick="go('global')">← Retour au classement</button><div class="panel"><p class="note">Pilote introuvable ou pas assez de courses.</p></div>`;
  const validD=races.filter(x=>x.delta!==null);
  const avgDelta=validD.length?validD.reduce((n,x)=>n+x.delta,0)/validD.length:null;
  const avgColl=races.length?races.reduce((n,x)=>n+x.collisions,0)/races.length:null;
  const avgPos=races.length?races.reduce((n,x)=>n+x.position,0)/races.length:null;
  const positives=[],weaknesses=[];
  if(avgPos!==null&&avgPos<=5)positives.push(`Position moyenne dans le top ${Math.ceil(avgPos)} sur ${races.length} courses tous championnats confondus.`);
  if(avgDelta!==null&&avgDelta>1)positives.push(`Progression moyenne de ${signed(avgDelta.toFixed(1))} place(s) entre le départ et l'arrivée.`);
  else if(avgDelta!==null&&avgDelta<-1)weaknesses.push(`Recul moyen de ${Math.abs(avgDelta).toFixed(1)} place(s) entre le départ et l'arrivée.`);
  if(avgColl<1)positives.push("Moins d'un incident de collision enregistré par course en moyenne.");
  else if(avgColl>=3)weaknesses.push("Plusieurs incidents de collision par course en moyenne.");
  if(r.details.progression>=60)positives.push("Tendance à la progression dans le temps.");
  else if(r.details.progression<=40)weaknesses.push("Tendance à la régression récente.");
  if(r.details.proprete>=65)positives.push("Bonne propreté de course (peu de cuts et de contacts responsables).");
  if(r.details.regularite>=65)positives.push("Régularité de rythme solide (faible écart moyen au meilleur tour).");
  if(r.details.vitesse>=65)positives.push("Vitesse au tour parmi les plus rapides du plateau.");
  if(r.details.regularite<=40)weaknesses.push("Rythme irrégulier entre les tours.");
  if(!positives.length)positives.push("En cours d'évaluation.");
  if(!weaknesses.length)weaknesses.push("Continue sur cette lancée.");
  const lbl={regularite:'Rythme',proprete:'Propreté',vitesse:'Vitesse au tour',resultats:'Résultats'};
  const gTips={regularite:PROFILE_TIPS.regulariteGlobal,proprete:PROFILE_TIPS.proprete,vitesse:PROFILE_TIPS.vitesse,resultats:PROFILE_TIPS.resultats,progression:PROFILE_TIPS.progression};
  const bars=Object.keys(lbl).map(k=>{const v=r.details[k];return `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span><b>${lbl[k]||k}</b>${gTips[k]?gdspTip(gTips[k],'gdsp-tip-left'):''}</span><span>${v.toFixed(0)} / 100</span></div><div class="bar" style="margin-top:6px"><i style="width:${v.toFixed(1)}%"></i></div></div>`;}).join('');
  const rythmeHtml=buildRythmeCard(id,allRounds,{showEvent:true});
  const raceRows=races.map(x=>{
    const consMs=raceConsistencyMs(x.laps);
    return `<tr><td>${date(x.session.date)}</td><td>${esc(x.eventName)}</td><td>${esc(track(x.session.track))}</td><td>${x.result.grid??'—'}</td><td class="pos">${x.position}</td><td>${x.delta===null?'—':(x.delta>0?'+':'')+x.delta.toFixed(1)}</td><td>${x.collisions}</td><td>${fmt(x.result.best)}</td><td>${consMs!=null?'+'+(consMs/1000).toFixed(2)+' s':'—'}</td></tr>`;
  }).join('');
  const levelLabels={1:'Élite',2:'Confirmé',3:'Intermédiaire',4:'Débutant'};
  const initials=r.name.trim().split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
  const bestPos=Math.min(...races.map(x=>x.position));
  const wins=races.filter(x=>x.position===1).length;
  const podiums=races.filter(x=>x.position<=3).length;
  const kpi=(label,value,sub,cls='')=>`<div class="drv-kpi ${cls}"><span class="label">${label}</span><strong>${value}</strong><span class="drv-kpi-sub">${sub}</span></div>`;
  const portrait=(items,positive)=>`<div class="panel drv-portrait-card ${positive?'drv-portrait-pos':'drv-portrait-axe'}"><div class="drv-portrait-head"><span class="drv-portrait-ico ${positive?'pos':'axe'}">${positive?'✓':'↗'}</span><div><div class="eyebrow">${positive?'Points forts':'Axes de progression'}</div><h3>${positive?'Ce qui fonctionne en piste':'Points de vigilance'}</h3></div></div><ul class="drv-portrait-list">${items.map(x=>'<li>'+esc(x)+'</li>').join('')}</ul></div>`;
  return `<div class="drv-topbar"><button class="btn secondary" onclick="go('global')">← Retour au classement Global</button><div class="drv-quick-switch"><span class="label">Fiche pilote Global</span><select aria-label="Choisir un pilote Global" onchange="globalDriverId=this.value;render()">${ratings.map(x=>`<option value="${esc(x.id)}" ${x.id===id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div></div>
    <div class="drv-hero"><div class="drv-hero-id"><div class="drv-hero-eyebrow">GLOBAL GDSP · TOUS ÉVÉNEMENTS</div><div class="drv-id-main"><div class="drv-roundel drv-roundel-txt">${esc(initials)}</div><div><h1>${esc(r.name)}</h1><div class="drv-team-line">Profil inter-événements · Classement GLOBAL Discord</div></div></div><div class="drv-hero-stamps"><span class="tag">${races.length} courses enregistrées</span><span class="tag">${esc(levelLabels[r.level]||'')} · ${r.score.toFixed(0)} / 100</span></div></div>
    <div class="drv-hero-car drv-global-level"><div class="drv-car-head"><span class="label">Niveau GLOBAL ${gdspTip(PROFILE_TIPS.niveauGlobal,'gdsp-tip-left')}</span><span class="drv-car-num">${esc(levelLabels[r.level]||'')}</span></div><div class="drv-car-stage">${levelBadge(r.level,180)}</div><div class="drv-car-foot"><span>Score <b>${r.score.toFixed(0)} / 100</b></span><span>Arrivée moy. ${gdspTip(PROFILE_TIPS.avgPos,'gdsp-tip-right')} <b>P${avgPos.toFixed(1)}</b></span></div></div></div>
    <div class="drv-kpis">${kpi('Courses '+gdspTip(PROFILE_TIPS.courses,'gdsp-tip-left'),races.length,'Tous événements confondus')}${kpi('Meilleur '+gdspTip(PROFILE_TIPS.bestPos),'P'+bestPos,`${wins} victoire(s) · ${podiums} podium(s)`,'kpi-gold')}${kpi('Pos. moy. '+gdspTip(PROFILE_TIPS.avgPos),'P'+avgPos.toFixed(1),'Position moyenne en course')}${kpi('Δ départ '+gdspTip(PROFILE_TIPS.delta),signed(avgDelta!==null?avgDelta.toFixed(1):null),'Grille départ − position d’arrivée','kpi-green')}${kpi('Coll./course '+gdspTip(PROFILE_TIPS.collisions,'gdsp-tip-right'),avgColl.toFixed(1),'Contacts serveur enregistrés','kpi-red')}</div>
    <div class="section-head"><div><div class="eyebrow">Évaluation GLOBALE</div><h2>Profil de performance &amp; rythme</h2></div></div>
    <div class="drv-perf-grid"><div class="panel"><div class="eyebrow">Quatre critères · un niveau</div><h2>Niveau et profil</h2>${bars}</div>${rythmeHtml}</div>
    <div class="section-head"><div><div class="eyebrow">Analyse</div><h2>Portrait inter-événements</h2></div></div>
    <div class="drv-portrait-grid">${portrait(positives,true)}${portrait(weaknesses,false)}</div>
    <div class="section-head"><div><div class="eyebrow">Carnet de route</div><h2>Historique toutes compétitions</h2></div><span class="muted">${races.length} départ(s)</span></div>
    <div class="panel driver-hist-wrap">${table(['Date','Événement','Circuit','Grille','Arr.',`Δ ${gdspTip(PROFILE_TIPS.delta)}`,`Coll. ${gdspTip(PROFILE_TIPS.collisions)}`,'Meilleur',`Δ rythme ${gdspTip(PROFILE_TIPS.sigma,'gdsp-tip-right')}`],raceRows)}</div>`;
}

// ---------- RENDER ----------
function render(){
  // Keep landing metadata consistent after in-app navigation as well as direct loads.
  if(document.querySelector&&window.location){
    const isLanding=isEventPage(page)&&eventContext;
    const title=isLanding?eventContext.name+' | GDSP Assetto Corsa':'GDSP — Open et championnat Assetto Corsa historique & vintage';
    if(isLanding||page==='hub'||page==='accueil'){
      document.title=title;
      const description=document.querySelector('meta[name="description"]');
      if(description)description.content=isLanding?String(eventContext.data?.eventInfo?.briefing||'Calendrier et présentation de '+eventContext.name+' — Gentleman Drivers Project.').slice(0,180):'GDSP : open et championnat Assetto Corsa, simracing historique et vintage. Retrouvez les calendriers, résultats et classements.';
      const canonical=document.querySelector('link[rel="canonical"]');
      if(canonical)canonical.href=new URL(isLanding?'/evenements/'+encodeURIComponent(eventContext.slug):'/',canonical.href).href;
    }
  }
  nav();
  if(backendError){
    const warning=`<div class="panel" role="alert"><h2>Connexion au serveur interrompue</h2><p>${esc(backendError)}</p><button class="btn secondary" onclick="retryBackend()">Réessayer</button><button class="btn secondary" onclick="go('admin')">Administration</button></div>`;
    app.innerHTML=warning+(page==='admin'?admin():hub());
    return;
  }
  if(backendMulti&&page==='gpilote'){
    // Sécurité : si les données ne sont pas encore chargées, passer par go('gpilote')
    const anyLoaded=events.some(ev=>ev.__loaded);
    if(!anyLoaded){go('gpilote');return}
    app.innerHTML=globalDriverProfile();return;
  }
  if(page==='hub'&&backendMulti){app.innerHTML=hub();return}
  // En mode multi, 'accueil' = LA PAGE D'ACCUEIL GDSP (hero 65/35, Règlements, Stats, Discord)
  if(page==='accueil'&&backendMulti){app.innerHTML=hub();return}
  if(isEventPage(page)){
    if(page==='circuit'&&!circuitsCache&&!circuitsError){
      if(!circuitsPending){
        circuitsPending=circuitsData().finally(()=>{circuitsPending=null});
      }
      app.innerHTML=`<div class="panel"><p class="note">Chargement de la fiche circuit…</p></div>`;
      circuitsPending.then(()=>{if(page==='circuit')render()});
      return;
    }
    app.innerHTML=renderEventShell();return;
  }
  const renderers={accueil:home,global:globalRankingSync,admin};
  app.innerHTML=(renderers[page]||home)();
}
// URL dédiée de l'onglet circuit (permet un lien direct et le bouton Retour).
function circuitUrl(){
  const slug=(eventContext&&eventContext.slug)||currentSlug;
  return slug?'/evenements/'+encodeURIComponent(slug)+'/circuit':null;
}
function syncCircuitHistory(){
  const target=circuitUrl();
  if(!target||!window.history||!window.location)return;
  if(window.location.pathname!==target)window.history.pushState({},'',target);
}

// ---------- BOOTSTRAP ----------
(async()=>{
  // Migrate legacy penMap local storage
  loadDeletedEventSlugs();
  let penMapRaw=JSON.parse(localStorage.getItem('gdsp_penalties')||'{}');
  await loadGlobalHidden();
  for(const k in penMapRaw){if('pts' in penMapRaw[k]&&!('timeAdd' in penMapRaw[k])&&!('warning' in penMapRaw[k]))delete penMapRaw[k]}
  penMap=penMapRaw;
  manualDrivers=JSON.parse(localStorage.getItem('gdsp_drivers')||'null');
  customCalendar=JSON.parse(localStorage.getItem('gdsp_calendar')||'null');
  let storedSessions=JSON.parse(localStorage.getItem('gdsp_sessions')||'null');
  if(storedSessions&&Array.isArray(storedSessions)&&storedSessions.length)sessions=storedSessions;

  await detectBackend();

  if(backendMulti){
    // Les visiteurs commencent toujours sur l'accueil GDSP. L'événement par
    // défaut est préchargé en arrière-plan pour que Résultats réponde vite.
    const last=localStorage.getItem('gdsp_last_event');
    if(last&&!events.some(e=>e.slug===last))localStorage.removeItem('gdsp_last_event');
    const target=events.find(e=>e.slug===last)||events.find(e=>e.kind==='championship')||events[0];
    if(adminToken&&!backendError){
      try{
        const auth=await apiGet('/api/admin/verify');
        const info=await auth.json().catch(()=>({}));
        if(!auth.ok||!info.ok)throw new Error('Session administrateur invalide');
        adminAuth=true;adminUser=info.user||'Direction de course';page='admin';
      }catch(e){
        adminToken=null;adminAuth=false;adminUser='';
        localStorage.removeItem('gdsp_admin_token');sessionStorage.removeItem('gdsp_admin_token');
      }
    }
    if(adminAuth){
      if(target&&!eventContext)await loadEvent(target.slug);
    }else{
      const path=window.location?window.location.pathname:'/';
      const match=path.match(/^\/evenements\/([^/]+)(\/circuit)?\/?$/);
      if(match){
        try{await loadEvent(decodeURIComponent(match[1]));page=match[2]?'circuit':'event'}
        catch(error){return} // Preserve the server's error page rather than showing another event.
      }else{
        page='hub';
        if(target&&!eventContext)loadEvent(target.slug).catch(()=>{});
      }
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
        if(!sessions.length){try{const r=await fetch('/data/data.json',{cache:'no-store'});if(r.ok){const base=await r.json();if(Array.isArray(base)&&base.length)sessions.push(...base)}}catch(e){}}
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
      if(adminToken){try{const r=await apiGet('/api/admin/verify');const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error('bad token');adminAuth=true;adminUser=j.user||'Direction de course';page='admin'}catch(e){adminToken=null;adminAuth=false;localStorage.removeItem('gdsp_admin_token');sessionStorage.removeItem('gdsp_admin_token')}}
    }catch(e){app.innerHTML='Erreur de rendu : '+e.message}
  }
  render();
})();

// Permanent landing pages: Back/Forward restores the event without adding history entries.
if(window.addEventListener)window.addEventListener('popstate',async()=>{
  const match=window.location.pathname.match(/^\/evenements\/([^/]+)(\/circuit)?\/?$/);
  if(match){
    try{await loadEvent(decodeURIComponent(match[1]));page=match[2]?'circuit':'event';driverId='';render()}
    catch(error){window.location.reload()}
  }else if(window.location.pathname==='/'){page='hub';render()}
});

'use strict';
(function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=value=>typeof value==='string'?value.trim():'';
  const entrantRoles=typeof module!=='undefined'&&module.exports?require('../assets/entrant-roles'):window.GDSPEntrantRoles;
  const validSlug=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{1,60}$/.test(value);
  const readable=value=>text(value).replace(/[_-]+/g,' ').trim();
  const kindLabel=kind=>({championship:'Championnat',cup:'Cup',endurance:'Endurance',open:'Open',fiesta:'Fiesta',trackday:'Trackday',archive:'Archive'})[kind]||'Événement';
  // Mêmes règles que le catalogue PC : le backend peut conserver des
  // tombstones et recréer un ancien doublon Lola. Ne pas les présenter actifs.
  function isDeletedEvent(ev,deleted={}){
    return !ev||!ev.slug||!!(ev._deleted||ev.name==='[DELETED]'||ev.points_config?._deleted||ev.pointsConfig?._deleted||ev.data?._deleted||deleted[ev.slug]);
  }
  function filterEventsList(raw,deleted={}){
    const list=Array.isArray(raw)?raw:[];
    const hasLola=list.some(ev=>ev?.slug==='lola-t290-gdsp-championnat-2026'&&!isDeletedEvent(ev,deleted));
    return list.filter(ev=>!isDeletedEvent(ev,deleted)&&validSlug(ev.slug)&&text(ev.name)&&!(hasLola&&ev.slug==='lola-t290-2026'));
  }
  function readDeletedEvents(){
    try{const value=JSON.parse(localStorage.getItem('gdsp_deleted_events')||'{}');return value&&typeof value==='object'?value:{};}catch(_){return {};}
  }
  function rich(value){
    const input=text(value),pattern=/\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)<>"']+)\)|(https?:\/\/[^\s<>"']+)/gi;
    let result='',offset=0,match;
    while((match=pattern.exec(input))){
      result+=esc(input.slice(offset,match.index));
      const raw=match[2]||match[3],href=raw.replace(/[.,!?;:]+$/,''),tail=raw.slice(href.length);
      result+=`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(match[1]||href)}</a>${esc(tail)}`;
      offset=pattern.lastIndex;
    }
    return result+esc(input.slice(offset));
  }
  function dateLabel(day){
    if(!/^\d{4}-\d\d-\d\d$/.test(day))return day;
    const parsed=new Date(day+'T12:00:00Z');
    return Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(parsed):day;
  }
  function calendar(data){
    const entries=new Map();
    function add(day,track,label,done,layout){
      day=String(day||'').slice(0,10);if(!/^\d{4}-\d\d-\d\d$/.test(day))return;
      track=text(track);layout=text(layout);
      const key=day+'\0'+track.toLowerCase()+'\0'+layout.toLowerCase(),old=entries.get(key);
      const fallback=[readable(track),readable(layout)].filter(Boolean).join(' · ');
      entries.set(key,{day,label:text(label)||fallback||'Circuit à confirmer',done:!!done||!!old?.done});
    }
    for(const s of Array.isArray(data?.sessions)?data.sessions:[])if(s)add(s.date,s.track,'',true,s.trackConfig||s.layoutId);
    const planned=data?.customCalendar&&typeof data.customCalendar==='object'?data.customCalendar:{};
    for(const [day,entry] of Object.entries(planned)){
      const tracks=Array.isArray(entry)?entry:(Array.isArray(entry?.tracks)&&entry.tracks.length?entry.tracks:[entry]);
      for(const item of tracks){
        if(typeof item==='string')add(day,item,'',false);
        else if(item&&typeof item==='object')add(day,item.trackId||item.track||item.id,item.trackName||item.name,false,item.layoutId||item.trackConfig);
      }
    }
    return [...entries.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.label.localeCompare(b.label));
  }
  function eventCard(ev){
    if(!validSlug(ev?.slug)||!text(ev.name))return '';
    return `<a class="event-card" href="#event=${encodeURIComponent(ev.slug)}"><div><strong>${esc(ev.name)}</strong><small>${esc(kindLabel(ev.kind))}</small></div><span class="arrow" aria-hidden="true">↗</span></a>`;
  }
  function eventDetail(ev){
    const data=ev.data&&typeof ev.data==='object'?ev.data:{},info=data.eventInfo&&typeof data.eventInfo==='object'?data.eventInfo:{};
    const allEntries=Array.isArray(data.ahEntrants)?data.ahEntrants.filter(x=>x&&text(x.name)).slice(0,500):[];
    const entries=entrantRoles.drivers(allEntries),services=entrantRoles.services(allEntries);
    const rounds=calendar(data),slug=encodeURIComponent(ev.slug);
    const defaultBriefing=['lola-t290-2026','lola-t290-gdsp-championnat-2026'].includes(ev.slug)
      ?"Six manches historiques, l’esprit Gentleman Driver et tout le suivi du championnat réunis au même endroit : calendrier, classements, résultats et fiches pilotes."
      :"Retrouvez ici les informations pratiques, le calendrier, les classements et les résultats de l’événement.";
    return `<a class="back" href="#events">← Tous les événements</a><div class="eyebrow">${esc(kindLabel(ev.kind))} · Assetto Corsa</div><h1 class="page-title">${esc(ev.name)}</h1><div class="actions"><a class="btn" href="#detail=${slug}">Résultats et classement →</a><a class="btn secondary" href="#car=${slug}">Fiche voiture →</a><a class="btn secondary" href="#pilots=${slug}">Fiches pilotes →</a></div>`
      +`<section class="panel"><div class="eyebrow">L'événement</div><h2>Briefing & informations</h2><p>${rich(text(info.briefing)||defaultBriefing)}</p>${text(info.car)?`<p><b>Voiture :</b> ${esc(info.car)}</p>`:''}${text(info.schedule)?`<p><b>Rendez-vous :</b> ${rich(info.schedule)}</p>`:''}${text(info.formatText)?`<p><b>Format :</b> ${rich(info.formatText)}</p>`:''}</section>`
      +`<section class="panel"><div class="eyebrow">Sur la piste</div><h2>Calendrier</h2>${rounds.length?rounds.map(r=>`<div class="row"><div><b>${esc(r.label)}</b><small>${esc(dateLabel(r.day))}</small></div>${r.done?`<a class="pill" href="#detail=${slug}">Voir les résultats →</a>`:'<span class="pill">À venir</span>'}</div>`).join(''):'<p>Le calendrier n’est pas encore renseigné.</p>'}</section>`
      +(entries.length?`<section class="panel"><div class="eyebrow">Inscriptions AssettoHosting</div><h2>${entries.length} pilote${entries.length>1?'s':''} engagé${entries.length>1?'s':''}</h2><p class="muted">Liste distincte des résultats et du classement.</p>${entries.map(d=>`<div class="row"><div><b>${esc(d.name)}</b><small>${esc(text(d.team)||'Équipe non renseignée')}</small></div><span class="muted">${esc(readable(d.car))}</span></div>`).join('')}</section>`:'')
      +(services.length?`<section class="panel"><h2>Véhicules de service</h2><p class="muted">Ces inscriptions sont conservées mais ne sont pas comptées comme pilotes : ${services.map(e=>esc(e.name)+' ('+esc(entrantRoles.serviceRole(e))+')').join(', ')}. Les résultats et classements restent inchangés.</p></section>`:'')
      +`<section class="panel"><div class="eyebrow">En détail</div><h2>Plus d’informations</h2><a class="more-link" href="#detail=${slug}">Classements & résultats →</a><a class="more-link" href="#circuit=${slug}">Fiche circuit →</a></section>`;
  }
  function liveView(data){
    const status=data?.status||{},server=data?.server||{};
    const cars=(Array.isArray(data?.cars)?data.cars:[]).filter(c=>c&&c.connected===true);
    const rows=cars.map(c=>`<div class="result-row"><span class="position">${esc(c.position??'—')}</span><div class="result-person"><b>${esc(c.name||'Pilote')}</b><small>${esc(c.team||c.model||'')} · ${esc(c.laps??0)} tours${c.inPit?' · stands':''}</small><small>Dernier : ${esc(c.lastLap||'—')} · Meilleur : ${esc(c.bestLap||'—')}</small></div><div class="score"><small>${esc(c.gap==='leader'?'Leader':c.gap||'—')}</small></div></div>`).join('');
    return `<a class="back" href="#live">← Retour au direct</a><div class="eyebrow">En piste</div><h1 class="page-title">Live timing</h1><section class="panel"><span class="pill">${esc(status.status||'État indisponible')}</span><h2>${esc(server.name||'Serveur GDSP')}</h2><p class="muted">${esc(server.track||'Circuit non communiqué')} · Actualisation toutes les 10 secondes</p>${rows||'<p>Aucune voiture connectée pour le moment.</p>'}<button class="btn secondary" type="button" data-retry>Actualiser</button></section><p class="muted">Cette vue présente l’instantané principal. Les cartes, archives et outils avancés restent sur le site complet.</p><a class="more-link" href="/live-timing" target="_blank" rel="noopener noreferrer">Ouvrir le live complet ↗</a>`;
  }
  function telemetryView(summary){
    const cars=Array.isArray(summary?.cars)?summary.cars:[];
    const cards=cars.map(c=>`<section class="panel"><h2>${esc(c.car||'Voiture')}</h2><p class="muted">${esc([c.track,c.trackConfig,c.driverName].filter(Boolean).join(' · '))}</p><dl class="spec-list">${[['Tours',c.laps],['Meilleur tour',window.gdspMobileEventViews.formatTime(c.bestLapMs)],['Tour médian',window.gdspMobileEventViews.formatTime(c.medianLapMs)],['Carburant par tour',c.fuelPerLap==null?'—':c.fuelPerLap+' L'],['Usure par tour',c.tyreWearPerLap==null?'—':c.tyreWearPerLap+' %'],['Vitesse maximale',c.speedMaxKmh==null?'—':c.speedMaxKmh+' km/h']].map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v??'—')}</dd></div>`).join('')}</dl></section>`).join('');
    return `<a class="back" href="#more">← Retour à Plus</a><div class="eyebrow">Administration sécurisée</div><h1 class="page-title">Télémétrie</h1><p>${esc(summary?.rows??0)} tours mesurés · synthèse globale</p>${cards||'<section class="panel"><p>Aucun tour enregistré.</p></section>'}<p class="muted">Filtres, export et modification des séances restent sur le site complet.</p><a class="more-link" href="/telemetry" target="_blank" rel="noopener noreferrer">Ouvrir la télémétrie complète ↗</a>`;
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={esc,validSlug,calendar,eventCard,eventDetail,liveView,isDeletedEvent,filterEventsList,dateLabel};
  if(typeof document==='undefined')return;
  const content=document.getElementById('content');let serial=0,installPrompt=null,candidate=null,liveTimer=null;
  const request=async path=>{const r=await fetch(path,{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw new Error('Service indisponible (HTTP '+r.status+').');return r.json();};
  async function loadGlobalProfiles(){
    if(!window.gdspMobileProfiles||!window.gdspMobileProfileViews)throw new Error('Moteur de profils indisponible. Recharge l’application.');
    const [catalog,exclusions]=await Promise.all([request('/api/events'),request('/api/global-exclusions')]);
    if(!Array.isArray(catalog?.events)||!exclusions?.ids||typeof exclusions.ids!=='object'||Array.isArray(exclusions.ids))throw new Error('Données du classement global indisponibles.');
    const all=filterEventsList(catalog.events,readDeletedEvents());
    // Tout charger avant de calculer : un résultat incomplet ne doit jamais
    // être présenté comme classement global complet.
    const events=await Promise.all(all.map(async item=>{
      try{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
        let response;try{response=await fetch('/api/events/'+encodeURIComponent(item.slug),{cache:'no-store',credentials:'same-origin',signal:controller.signal});}finally{clearTimeout(timer);}
        if(!response.ok)throw new Error('HTTP '+response.status);
        const ev=await response.json();if(!ev||ev.slug!==item.slug||isDeletedEvent(ev,readDeletedEvents())||!ev.data||typeof ev.data!=='object')throw new Error('réponse invalide');
        return ev;
      }catch(_){throw new Error('Classement global indisponible : tous les événements n’ont pas pu être chargés. Réessaie.');}
    }));
    return window.gdspMobileProfiles.global(events,exclusions.ids);
  }
  async function adminRequest(path,body){
    const options=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    const response=await window.gdspAuth.fetch(path,options),data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Service indisponible.');
    return data;
  }
  async function updatePanel(){
    if(!window.gdspAuth)return '<p class="muted">Connexion indisponible. Recharge la page avec une connexion réseau.</p>';
    let session;try{session=await window.gdspAuth.session();}catch(_){return '<p class="muted">Connexion administrateur indisponible.</p>';}
    if(!session.authenticated)return `<p>Connecte-toi avec ton compte administrateur GDSP pour accéder aux mises à jour.</p><form id="mobile-login"><label>Identifiant <input name="username" autocomplete="username" required maxlength="200"></label><label>Mot de passe <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button class="btn" type="submit">Se connecter</button></form><p id="update-output" class="muted" role="status"></p>`;
    let state;try{state=await adminRequest('/api/admin/mobile-update');}catch(e){return `<p class="muted">${esc(e.message)}</p>`;}
    if(!state.enabled)return '<p>La mise à jour depuis le mobile est désactivée sur ce PC. Elle nécessite une installation et une activation locales préalables.</p>';
    const current=state.state?`<p class="muted">État : ${esc(({queued:'en attente',running:'en cours',completed:'terminée',failed:'interrompue'})[state.state]||'indisponible')}${state.message?' · '+esc(state.message):''}</p>`:'';
    return `<p>Seule une version publiée sur la branche principale GDSP peut être installée. Le PC vérifie le dépôt et crée une sauvegarde avant de redémarrer.</p>${current}<button class="btn secondary" type="button" data-update-check ${state.pending?'disabled':''}>Vérifier les mises à jour</button>${state.pending?'<p class="muted">Une demande est déjà en attente. Recharge cette page pour suivre son état.</p>':''}<div id="update-output" role="status"></div>`;
  }
  const fail=message=>`<div class="error"><b>Impossible de charger les données.</b><p>${esc(message||'Vérifie ta connexion puis réessaie.')}</p><button class="btn secondary" type="button" data-retry>Réessayer</button></div>`;
  async function show(background=false){
    if(liveTimer)clearTimeout(liveTimer);liveTimer=null;
    const version=++serial,hash=location.hash.slice(1)||'home',match=hash.match(/^event=([a-z0-9-]+)$/),view=hash.match(/^(detail|car|circuit|pilots)=([a-z0-9-]+)$/)||hash.match(/^service=(admin|live|telemetry)$/);
    const params=new URLSearchParams(hash),driverSlug=params.get('driver'),driverId=params.get('id'),globalDriver=params.get('global-driver');
    const driverRoute=driverSlug!==null,globalRoute=hash==='global'||globalDriver!==null;
    const tab=driverRoute||match||view&&['detail','car','circuit','pilots'].includes(view[1])?'events':globalRoute?'global':view&&view[1]==='live'?'live':view?'more':['events','live','more'].includes(hash)?hash:'home';
    document.querySelectorAll('[data-nav]').forEach(el=>{if(el.dataset.nav===tab)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    if(background!==true)content.innerHTML='<div class="loading">Chargement…</div>';
    try{
      let html='';
      if(globalRoute){
        const computed=await loadGlobalProfiles(),views=window.gdspMobileProfileViews;
        if(globalDriver!==null){
          if(!globalDriver||globalDriver.length>500)throw new Error('Pilote invalide.');
          const rating=computed.ratings.find(r=>r.id===globalDriver);if(!rating)throw new Error('Pilote introuvable ou pas assez de courses pour figurer au classement global.');
          html=views.profile(rating,rating,computed.history(globalDriver),{global:true,trueskill:computed.trueskill});
        }else html=views.globalList(computed);
      }else if(driverRoute||view&&view[1]==='pilots'){
        const slug=driverRoute?driverSlug:view[2];if(!validSlug(slug)||driverRoute&&(!driverId||driverId.length>500))throw new Error('Pilote ou événement invalide.');
        const ev=await request('/api/events/'+encodeURIComponent(slug));
        if(!ev||ev.slug!==slug||!text(ev.name)||isDeletedEvent(ev,readDeletedEvents()))throw new Error('Événement indisponible.');
        const engine=window.gdspMobileProfiles,views=window.gdspMobileProfileViews;if(!engine||!views)throw new Error('Moteur de profils indisponible. Recharge l’application.');
        const computed=engine.event(ev);
        if(driverRoute){const driver=computed.drivers.find(d=>d.id===driverId);if(!driver)throw new Error('Pilote introuvable dans cet événement.');
          html=views.profile(driver,computed.ratings.find(r=>r.id===driverId),computed.history(driverId),{slug,eventName:ev.name,photo:views.driverImage(ev,driver,computed.drivers)});
        }else html=views.eventList(ev,computed);
      }else if(view&&['detail','car','circuit'].includes(view[1])){
        const slug=view[2];if(!validSlug(slug))throw new Error('Événement invalide.');
        const ev=await request('/api/events/'+encodeURIComponent(slug));
        if(!ev||ev.slug!==slug||!text(ev.name)||isDeletedEvent(ev,readDeletedEvents()))throw new Error('Événement indisponible.');
        const views=window.gdspMobileEventViews;
        if(!views)throw new Error('Vues mobiles indisponibles. Recharge l’application.');
        if(view[1]==='detail'){
          if(!window.gdspMobileResults)throw new Error('Moteur de résultats indisponible. Recharge l’application.');
          html=views.resultView(ev,window.gdspMobileResults.calculate(ev));
        }else if(view[1]==='car')html=views.carView(ev);
        else{
          let base=null,unavailable=false;
          if(['lola-t290-2026','lola-t290-gdsp-championnat-2026'].includes(slug)){
            try{base=await request('/data/circuits.json');}catch(_){unavailable=true;}
          }
          html=views.circuitView(ev,base)+(unavailable?'<p class="error">Fiches historiques indisponibles : réessaie avec une connexion.</p>':'');
        }
      }else if(view&&view[1]==='live'){
        html=liveView(await request('/api/live/snapshot'));
      }else if(view&&view[1]==='telemetry'){
        const session=await window.gdspAuth.session();
        if(!session.authenticated)html='<a class="back" href="#more">← Retour à Plus</a><h1 class="page-title">Télémétrie</h1><section class="panel"><p>Connecte-toi avec ton compte administrateur dans Plus pour consulter la télémétrie.</p><a class="btn" href="#more">Se connecter →</a></section>';
        else html=telemetryView(await adminRequest('/api/telemetry/summary'));
      }else if(view){
        html='<a class="back" href="#more">← Retour à Plus</a><h1 class="page-title">Administration</h1><section class="panel"><p>Les outils complets d’administration ne sont pas encore adaptés au mobile. Ils s’ouvrent séparément, sans cadre intégré.</p><a class="btn" href="/admin" target="_blank" rel="noopener noreferrer">Ouvrir l’administration complète ↗</a></section>';
      }else if(match){
        const slug=match[1];if(!validSlug(slug))throw new Error('Événement invalide.');
        const ev=await request('/api/events/'+encodeURIComponent(slug));
        if(!ev||ev.slug!==slug||!text(ev.name)||isDeletedEvent(ev,readDeletedEvents()))throw new Error('Événement indisponible.');
        html=eventDetail(ev);
      }else if(tab==='home'||tab==='events'){
        const data=await request('/api/events');if(!Array.isArray(data.events))throw new Error('Liste des événements indisponible.');
        const all=filterEventsList(data.events,readDeletedEvents());
        const events=all.filter(e=>e.kind!=='archive'),archives=all.filter(e=>e.kind==='archive');
        const cards=events.map(eventCard).join('')||'<div class="panel">Aucun événement actif pour le moment.</div>';
        const archived=archives.length?`<section class="archive-list"><div class="section-title"><h2>Archives</h2></div><div class="cards">${archives.map(eventCard).join('')}</div></section>`:'';
        html=tab==='home'?`<section class="hero"><div class="eyebrow">Gentleman Drivers Project</div><h1>La passion de la course, partout.</h1><p>Les événements, les pilotes et le direct GDSP réunis dans votre poche.</p><div class="hero-actions"><a class="btn" href="#events">Voir les événements</a><a class="btn secondary" href="#live">Suivre le direct</a></div></section><div class="section-title"><h2>À la une</h2><a href="#events">Tout voir →</a></div><div class="cards">${events.slice(0,3).map(eventCard).join('')||'<div class="panel">Aucun événement actif pour le moment.</div>'}</div>`:`<div class="eyebrow">La communauté en piste</div><h1 class="page-title">Événements</h1><p class="muted">Sélectionne un événement pour retrouver ses informations et ses engagés.</p><div class="cards">${cards}</div>${archived}`;
      }else if(tab==='live'){
        const data=await request('/api/live/status');
        const state=data?.status?.status||'indisponible',server=text(data?.server?.name)||'Serveur GDSP';
        html=`<div class="eyebrow">En piste</div><h1 class="page-title">Le direct</h1><section class="panel"><span class="pill">${esc(data.enabled?'État : '+state:'Direct indisponible')}</span><h2>${esc(server)}</h2><p>Retrouve les temps et les positions dans le direct complet.</p><a class="btn" href="#service=live">Ouvrir le live timing →</a></section>`;
      }else{
        const update=await updatePanel();
        html=`<div class="eyebrow">Votre espace GDSP</div><h1 class="page-title">Plus</h1><section class="panel"><h2>Accès rapides</h2><a class="more-link" href="/">Site complet ↗</a><a class="more-link" href="#service=admin">Administration →</a><a class="more-link" href="#service=telemetry">Télémétrie →</a></section><section class="panel"><div class="eyebrow">Administration sécurisée</div><h2>Mise à jour du PC serveur</h2>${update}</section><section class="panel"><h2>Installer l’application</h2><p>Sur Android, utilise « Installer l’application » dans le menu du navigateur. Sur iPhone, touche Partager puis « Sur l’écran d’accueil ».</p>${installPrompt?'<button class="btn" type="button" data-install>Installer GDSP</button>':''}<p class="muted">Une connexion est nécessaire pour les données et le direct ; aucun résultat n’est conservé hors ligne.</p></section>`;
      }
      if(version===serial)content.innerHTML=html;
    }catch(e){if(version===serial)content.innerHTML=fail(navigator.onLine===false?'Tu es hors ligne. Les données de course nécessitent une connexion.':e.message);}
    finally{if(version===serial&&view&&view[1]==='live')liveTimer=setTimeout(()=>show(true),10000);}
  }
  window.addEventListener('hashchange',show);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;if(location.hash==='#more')show();});
  content.addEventListener('click',async event=>{
    if(event.target.closest('[data-scroll-results]')){const target=document.getElementById('mobile-round-results');if(target){target.scrollIntoView();target.focus({preventScroll:true});}}
    if(event.target.closest('[data-retry]'))show();
    if(event.target.closest('[data-install]')&&installPrompt){const prompt=installPrompt;installPrompt=null;await prompt.prompt();show();}
    const button=event.target.closest('[data-update-check]');
    if(button){
      const output=document.getElementById('update-output');button.disabled=true;candidate=null;output.textContent='Vérification en cours…';
      try{
        const result=await adminRequest('/api/admin/mobile-update/check',{});
        if(!/^[a-f0-9]{40}$/.test(result.target))throw new Error('Version reçue invalide.');
        if(!result.available){output.textContent='Le PC est déjà à jour.';return;}
        candidate=result.target;
        output.innerHTML=`<p>Version disponible : <b>${esc(candidate.slice(0,12))}</b>. Le site sera interrompu pendant la sauvegarde et le redémarrage.</p><form id="mobile-update-form"><label>Clé de mise à jour <input name="key" type="password" autocomplete="off" required minlength="43" maxlength="43"></label><button class="btn" type="submit">Installer cette version</button></form><p class="muted">Ne lance pas de mise à jour pendant une course ou pendant qu’un autre administrateur modifie le site.</p>`;
      }catch(e){output.textContent=e.message;}
      finally{button.disabled=false;}
    }
  });
  content.addEventListener('input',event=>{
    if(!event.target.matches?.('[data-driver-search]'))return;
    const q=String(event.target.value||'').trim().toLocaleLowerCase('fr');let visible=0;
    content.querySelectorAll('[data-driver-item]').forEach(item=>{const match=String(item.dataset.search||'').includes(q);item.hidden=!match;if(match)visible++;});
    const empty=content.querySelector('[data-search-empty]');if(empty)empty.hidden=visible>0;
  });
  content.addEventListener('error',event=>{
    const image=event.target;if(!image.matches?.('[data-livery-image], [data-profile-image]'))return;
    image.hidden=true;const note=image.parentElement?.querySelector('[data-image-missing]');if(note)note.hidden=false;
  },true);
  content.addEventListener('change',event=>{
    const select=event.target.closest('[data-livery-select]');if(!select)return;
    const container=select.closest('.livery'),image=container?.querySelector('[data-livery-image]'),note=container?.querySelector('[data-image-missing]');
    if(image){image.hidden=false;if(note)note.hidden=true;image.src=select.value;image.alt=select.selectedOptions[0]?.textContent||'Livrée';}
  });
  content.addEventListener('submit',async event=>{
    const form=event.target;if(form.id!=='mobile-login'&&form.id!=='mobile-update-form')return;
    event.preventDefault();const output=document.getElementById('update-output');
    if(form.id==='mobile-login'){
      const username=form.elements.username.value,password=form.elements.password.value;
      try{await adminRequest('/api/admin/login',{username,password});form.elements.password.value='';await show();}
      catch(e){form.elements.password.value='';output.textContent=e.message;}
      return;
    }
    if(!candidate)return;
    if(!window.confirm('Sauvegarder puis installer la version '+candidate.slice(0,12)+' ? Le site sera temporairement interrompu.'))return;
    const key=form.elements.key.value,target=candidate;form.elements.key.value='';candidate=null;
    output.textContent='Demande envoyée. Le site peut être momentanément indisponible…';
    try{await adminRequest('/api/admin/mobile-update/apply',{target,key});output.textContent='Demande transmise. Reviens dans quelques minutes pour voir le résultat.';}
    catch(e){output.textContent='Demande non confirmée : '+e.message+' Si le site redémarre, attends et consulte l’état avant de réessayer.';}
  });
  if('serviceWorker' in navigator){
    const worker=navigator.serviceWorker,hadController=!!worker.controller;
    const banner=document.getElementById('app-update-banner'),reload=document.getElementById('app-update-reload');
    if(reload)reload.addEventListener('click',()=>window.location.reload());
    if(worker.addEventListener)worker.addEventListener('controllerchange',()=>{if(hadController&&banner)banner.hidden=false;});
    worker.register('/mobile/sw.js',{scope:'/mobile/'}).then(reg=>{if(reg&&reg.update)return reg.update();}).catch(()=>{});
  }
  show();
})();

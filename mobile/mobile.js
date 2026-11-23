'use strict';
(function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=value=>typeof value==='string'?value.trim():'';
  const validSlug=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{1,60}$/.test(value);
  const readable=value=>text(value).replace(/[_-]+/g,' ').trim();
  const kindLabel=kind=>({championship:'Championnat',cup:'Cup',endurance:'Endurance',open:'Open',fiesta:'Fiesta',trackday:'Trackday',archive:'Archive'})[kind]||'Événement';
  const eventLink=slug=>'/evenements/'+encodeURIComponent(slug);
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
    const entries=Array.isArray(data.ahEntrants)?data.ahEntrants.filter(x=>x&&text(x.name)).slice(0,500):[];
    const rounds=calendar(data),url=eventLink(ev.slug);
    return `<a class="back" href="#events">← Tous les événements</a><div class="eyebrow">${esc(kindLabel(ev.kind))} · Assetto Corsa</div><h1 class="page-title">${esc(ev.name)}</h1><div class="actions"><a class="btn" href="${esc(url)}">Résultats et classement ↗</a><a class="btn secondary" href="${esc(url+'/voiture')}">Fiche voiture ↗</a></div>`
      +`<section class="panel"><div class="eyebrow">L'événement</div><h2>Briefing & informations</h2><p>${rich(text(info.briefing)||'Les informations de cet événement ne sont pas encore renseignées.')}</p>${text(info.car)?`<p><b>Voiture :</b> ${esc(info.car)}</p>`:''}${text(info.schedule)?`<p><b>Rendez-vous :</b> ${rich(info.schedule)}</p>`:''}${text(info.formatText)?`<p><b>Format :</b> ${rich(info.formatText)}</p>`:''}</section>`
      +`<section class="panel"><div class="eyebrow">Sur la piste</div><h2>Calendrier</h2>${rounds.length?rounds.map(r=>`<div class="row"><div><b>${esc(r.label)}</b><small>${esc(dateLabel(r.day))}</small></div><span class="pill">${r.done?'Résultats importés':'À venir'}</span></div>`).join(''):'<p>Le calendrier n’est pas encore renseigné.</p>'}</section>`
      +(entries.length?`<section class="panel"><div class="eyebrow">Inscriptions AssettoHosting</div><h2>${entries.length} pilote${entries.length>1?'s':''} engagé${entries.length>1?'s':''}</h2><p class="muted">Liste distincte des résultats et du classement.</p>${entries.map(d=>`<div class="row"><div><b>${esc(d.name)}</b><small>${esc(text(d.team)||'Équipe non renseignée')}</small></div><span class="muted">${esc(readable(d.car))}</span></div>`).join('')}</section>`:'')
      +`<section class="panel"><div class="eyebrow">En détail</div><h2>Plus d’informations</h2><a class="more-link" href="${esc(url)}">Classements, résultats & fiches pilotes ↗</a><a class="more-link" href="${esc(url+'/circuit')}">Fiche circuit ↗</a></section>`;
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={esc,validSlug,calendar,eventCard,eventDetail,dateLabel};
  if(typeof document==='undefined')return;
  const content=document.getElementById('content');let serial=0,installPrompt=null,candidate=null;
  const request=async path=>{const r=await fetch(path,{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw new Error('Service indisponible (HTTP '+r.status+').');return r.json();};
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
  async function show(){
    const version=++serial,hash=location.hash.slice(1)||'home',match=hash.match(/^event=([a-z0-9-]+)$/),tab=match?'events':['events','live','more'].includes(hash)?hash:'home';
    document.querySelectorAll('[data-nav]').forEach(el=>{if(el.dataset.nav===tab)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    content.innerHTML='<div class="loading">Chargement…</div>';
    try{
      let html='';
      if(match){
        const slug=match[1];if(!validSlug(slug))throw new Error('Événement invalide.');
        const ev=await request('/api/events/'+encodeURIComponent(slug));
        if(!ev||ev.slug!==slug||!text(ev.name))throw new Error('Événement indisponible.');
        html=eventDetail(ev);
      }else if(tab==='home'||tab==='events'){
        const data=await request('/api/events');if(!Array.isArray(data.events))throw new Error('Liste des événements indisponible.');
        const events=data.events.filter(e=>e&&e.kind!=='archive'&&validSlug(e.slug)&&text(e.name));
        const cards=events.map(eventCard).join('')||'<div class="panel">Aucun événement actif pour le moment.</div>';
        html=tab==='home'?`<section class="hero"><div class="eyebrow">Gentleman Drivers Project</div><h1>La passion de la course, partout.</h1><p>Les événements, les pilotes et le direct GDSP réunis dans votre poche.</p><div class="hero-actions"><a class="btn" href="#events">Voir les événements</a><a class="btn secondary" href="#live">Suivre le direct</a></div></section><div class="section-title"><h2>À la une</h2><a href="#events">Tout voir →</a></div><div class="cards">${events.slice(0,3).map(eventCard).join('')||'<div class="panel">Aucun événement actif pour le moment.</div>'}</div>`:`<div class="eyebrow">La communauté en piste</div><h1 class="page-title">Événements</h1><p class="muted">Sélectionne un événement pour retrouver ses informations et ses engagés.</p><div class="cards">${cards}</div>`;
      }else if(tab==='live'){
        const data=await request('/api/live/status');
        const state=data?.status?.status||'indisponible',server=text(data?.server?.name)||'Serveur GDSP';
        html=`<div class="eyebrow">En piste</div><h1 class="page-title">Le direct</h1><section class="panel"><span class="pill">${esc(data.enabled?'État : '+state:'Direct indisponible')}</span><h2>${esc(server)}</h2><p>Retrouve les temps et les positions dans le direct complet.</p><a class="btn" href="/live-timing">Ouvrir le live timing ↗</a></section>`;
      }else{
        const update=await updatePanel();
        html=`<div class="eyebrow">Votre espace GDSP</div><h1 class="page-title">Plus</h1><section class="panel"><h2>Accès rapides</h2><a class="more-link" href="/">Site complet ↗</a><a class="more-link" href="/admin">Administration ↗</a><a class="more-link" href="/telemetry">Télémétrie ↗</a></section><section class="panel"><div class="eyebrow">Administration sécurisée</div><h2>Mise à jour du PC serveur</h2>${update}</section><section class="panel"><h2>Installer l’application</h2><p>Sur Android, utilise « Installer l’application » dans le menu du navigateur. Sur iPhone, touche Partager puis « Sur l’écran d’accueil ».</p>${installPrompt?'<button class="btn" type="button" data-install>Installer GDSP</button>':''}<p class="muted">Une connexion est nécessaire pour les données et le direct ; aucun résultat n’est conservé hors ligne.</p></section>`;
      }
      if(version===serial)content.innerHTML=html;
    }catch(e){if(version===serial)content.innerHTML=fail(navigator.onLine===false?'Tu es hors ligne. Les données de course nécessitent une connexion.':e.message);}
  }
  window.addEventListener('hashchange',show);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;if(location.hash==='#more')show();});
  content.addEventListener('click',async event=>{
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
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/mobile/sw.js',{scope:'/mobile/'}).catch(()=>{});
  show();
})();

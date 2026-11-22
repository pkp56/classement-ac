'use strict';
// Brouillon local uniquement : ne sauvegarde ni ne pilote un serveur.
(function (global) {
  const groups = [
    {title:'Serveur et circuit',section:'SERVER',fields:[['NAME','Nom du serveur'],['TRACK','Circuit'],['CONFIG_TRACK','Variante du circuit'],['CARS','Voitures autorisées'],['MAX_CLIENTS','Nombre maximum de pilotes'],['REVERSED_GRID_RACE_POSITIONS','Deuxième course'],['PICKUP_MODE_ENABLED','Entrée libre (0/1)'],['LOOP_MODE','Boucler les sessions (0/1)'],['REGISTER_TO_LOBBY','Serveur public (0/1)']]},
    {title:'Règles et aides',section:'SERVER',fields:[['ABS_ALLOWED','ABS'],['TC_ALLOWED','Antipatinage'],['STABILITY_ALLOWED','Contrôle de stabilité (0/1)'],['AUTOCLUTCH_ALLOWED','Embrayage auto (0/1)'],['TYRE_BLANKETS_ALLOWED','Couvertures chauffantes (0/1)'],['FORCE_VIRTUAL_MIRROR','Rétroviseur virtuel (0/1)'],['FUEL_RATE','Consommation carburant (%)'],['DAMAGE_MULTIPLIER','Dégâts (%)'],['TYRE_WEAR_RATE','Usure pneus (%)'],['ALLOWED_TYRES_OUT','Roues hors piste autorisées'],['MAX_BALLAST_KG','Lest maximum (kg)'],['VOTING_QUORUM','Quorum vote (%)'],['KICK_QUORUM','Quorum exclusion (%)'],['VOTE_DURATION','Durée vote (s)'],['MAX_CONTACTS_PER_KM','Contacts maximum/km']]},
    {title:'Heure',section:'SERVER',fields:[['SUN_ANGLE','Angle du soleil'],['TIME_OF_DAY_MULT','Multiplicateur de temps']]},
    ...[['PRACTICE','Essais'],['QUALIFY','Qualifications'],['RACE','Course']].map(([section,title])=>({title,section,fields:[['NAME','Nom'],['TIME','Durée (min)'],['LAPS','Tours'],['WAIT_TIME','Attente (s)'],['IS_OPEN','Entrée en session']]})),
  ];
  const weatherLabels={GRAPHICS:'Météo',__CM_GRAPHICS:'Météo CM',BASE_TEMPERATURE_AMBIENT:'Température ambiante',BASE_TEMPERATURE_ROAD:'Écart de température piste',VARIATION_AMBIENT:'Variation ambiante',VARIATION_ROAD:'Variation piste',WIND_BASE_SPEED_MIN:'Vent minimum',WIND_BASE_SPEED_MAX:'Vent maximum',WIND_BASE_DIRECTION:'Direction du vent',WIND_VARIATION_DIRECTION:'Variation du vent'};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function normaliseCsp(value){return String(value??'').replace(/\r\n?/g,'\n');}
  function cspChanged(current,original){return normaliseCsp(current)!==normaliseCsp(original);}
  function options(list,current){
    const values=[...new Set(list||[])];
    if(current&&!values.includes(current)) values.unshift(current);
    return values.map(v=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(v)}${v===current&&!(list||[]).includes(v)?' (actuel, non trouvé)':''}</option>`).join('');
  }
  function modelOptions(allowed,current){
    const missing=current&&!allowed.includes(current)?`<option value="${esc(current)}" selected disabled>${esc(current)} (actuelle, non autorisée)</option>`:'';
    return missing+options(allowed,allowed.includes(current)?current:'');
  }
  function field(section,key,label,value,inventory,extra){
    const current=String(value==null?'':value),data=`data-cm-section="${esc(section)}" data-cm-key="${esc(key)}" data-cm-original="${esc(current)}"`;
    if(section==='SERVER'&&key==='REVERSED_GRID_RACE_POSITIONS'){
      const choices=[['0','Une course'],['1','Deux courses · ordre d’arrivée'],['-1','Deux courses · grille inversée complète']];
      if(current&&!choices.some(([v])=>v===current))choices.push([current,`Deux courses · ${current} positions inversées (actuel)`]);
      return `<label>Nombre de courses et grille de la course 2 <select class="admin-input" ${data}>${!current?'<option value="" selected>— Non indiqué dans le fichier —</option>':''}${choices.map(([v,label])=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(label)}</option>`).join('')}</select><small>Fonction native expérimentale : la course 2 reprend le format de la course 1 (même durée ou nombre de tours), pas 15 puis 25 minutes. Vérifie Loop Mode et teste la transition, les abandons et la grille en jeu.</small></label>`;
    }
    if(section==='SERVER'&&key==='CARS'&&inventory?.cars?.length){
      const chosen=current.split(';').filter(Boolean),ids=inventory.cars.map(c=>c.id),all=[...new Set([...chosen,...ids])];
      return `<label>${esc(label)} <select class="admin-input" multiple size="7" data-cm-allowed>${all.map(id=>`<option value="${esc(id)}" ${chosen.includes(id)?'selected':''}>${esc(id)}${!ids.includes(id)?' (actuelle, non trouvée)':''}</option>`).join('')}</select><small>Maintiens Ctrl pour sélectionner ou retirer plusieurs voitures. Les places doivent utiliser une voiture autorisée.</small><input type="hidden" ${data} data-cm-cars value="${esc(current)}"></label>`;
    }
    if(section==='SERVER'&&key==='TRACK'&&extra?.csp?.encodedInTrack&&!extra?.csp?.trackEditable){
      return `<label>${esc(label)} <input class="admin-input" value="${esc(extra.csp.trackId)}" disabled><small>CSP est encodé dans le circuit ; changement à finaliser avant activation.</small></label>`;
    }
    if(section==='SERVER'&&key==='TRACK'&&extra?.csp?.encodedInTrack&&extra?.csp?.trackEditable){
      const track=String(extra.csp.trackId||'');
      return inventory?.tracks?.length?`<label>${esc(label)} <select class="admin-input" data-cm-section="SERVER" data-cm-key="TRACK" data-cm-original="${esc(track)}" data-cm-track>${options(inventory.tracks.map(x=>x.id),track)}</select><small>Les options CSP encodées sont conservées.</small></label>`:`<label>${esc(label)} <input class="admin-input" data-cm-section="SERVER" data-cm-key="TRACK" data-cm-original="${esc(track)}" value="${esc(track)}"><small>Les options CSP encodées sont conservées.</small></label>`;
    }
    if(section==='SERVER'&&key==='TRACK'&&inventory?.tracks?.length){
      return `<label>${esc(label)} <select class="admin-input" ${data} data-cm-track>${options(inventory.tracks.map(x=>x.id),current)}</select></label>`;
    }
    if(section==='SERVER'&&key==='CONFIG_TRACK'&&inventory?.tracks?.length){
      const track=inventory.tracks.find(t=>t.id===(extra?.csp?.trackId||''));
      return `<label>${esc(label)} <select class="admin-input" ${data} data-cm-layout><option value="">— Tracé principal —</option>${options(track?.layouts||[],current)}</select><small>Choisis une variante installée pour ce circuit.</small></label>`;
    }
    return `<label>${esc(label)} <input class="admin-input" ${data} value="${esc(current)}" maxlength="500"></label>`;
  }
  // Seules les données structurées de la Cup sont reprises. Les durées et le
  // nombre de places restent saisis explicitement par l'administrateur.
  function cupOptions(event){
    if(event?.kind!=='cup')return {rounds:[],cars:[]};
    const rounds=[];
    for(const [date,raw] of Object.entries(event.data?.customCalendar||{})){
      const list=Array.isArray(raw)?raw:(Array.isArray(raw?.tracks)?raw.tracks:[raw]);
      for(const item of list){
        const track=String(item?.track||item?.trackId||''),layout=String(item?.layout||item?.layoutId||'');
        if(/^[a-zA-Z0-9_-]{1,120}$/.test(track)&&(!layout||/^[a-zA-Z0-9_-]{1,120}$/.test(layout)))rounds.push({date,track,layout,name:String(item.trackName||item.name||track)});
      }
    }
    const seen=new Set();const cars=[];
    for(const c of event.data?.carSheets||[]){const id=String(c?.id||'');if(/^[a-zA-Z0-9_-]{1,120}$/.test(id)&&!seen.has(id)){seen.add(id);cars.push({id,name:String(c.name||id)});}}
    return {rounds,cars};
  }
  function cupDraft(data,inventory,event,roundIndex,carId,places,qualify,race){
    const opts=cupOptions(event),round=opts.rounds[roundIndex];
    if(!round||!opts.cars.some(c=>c.id===carId))throw Error('Choisis une manche et une voiture de la Cup.');
    if(!inventory||!Array.isArray(inventory.tracks)||!Array.isArray(inventory.cars))throw Error('Inventaire local indisponible.');
    const track=inventory.tracks.find(t=>t.id===round.track),car=inventory.cars.find(c=>c.id===carId);
    if(!track||round.layout&&!(track.layouts||[]).includes(round.layout)||!car)throw Error('Circuit, variante ou voiture non trouvé dans le contenu installé.');
    const nums=[places,qualify,race].map(v=>String(v).trim());
    if(nums.some(v=>!/^\d+$/.test(v)||Number(v)<1)||Number(nums[0])>200||Number(nums[1])>1440||Number(nums[2])>1440)throw Error('Renseigne des nombres valides pour les places et durées.');
    const slots=data.slots||[];if(slots.some((s,i)=>s.id!==i))throw Error('Numérotation des places ambiguë.');
    for(const slot of slots){
      if(slot.model!==carId && (slot.reserved||slot.cspSkin||slot.skinEditable===false))throw Error('Une place réservée ou protégée utilise une autre voiture : adaptation manuelle nécessaire.');
      if(slot.model===carId&&slot.skin&&!(car.skins||[]).includes(slot.skin))throw Error('Un skin existant est introuvable : vérification manuelle nécessaire.');
    }
    if(!['active','inactive'].includes(data.extra?.sessions?.QUALIFY)||!['active','inactive'].includes(data.extra?.sessions?.RACE))throw Error('Séance qualification ou course absente : configure-la dans Content Manager.');
    return {round,carId,places:nums[0],qualify:nums[1],race:nums[2],slots:slots.filter(s=>s.model!==carId).map(s=>s.id),additions:Math.max(0,Number(nums[0])-slots.length)};
  }
  function render(data,inventory,event){
    const settings=data?.settings||{},extra=data?.extra||{};
    if(!extra.csp?.trackId && settings.SERVER?.TRACK)extra.csp={...(extra.csp||{}),trackId:settings.SERVER.TRACK};
    const sections=groups.map(g=>{
      const isSession=['PRACTICE','QUALIFY','RACE'].includes(g.section),state=extra.sessions?.[g.section];
      const values=state==='inactive'?(extra.inactiveSessions?.[g.section]||{}):(settings[g.section]||{});
      const fields=g.fields.filter(([key])=>(Object.prototype.hasOwnProperty.call(values,key)||(g.section==='SERVER'&&key==='CONFIG_TRACK'&&Object.prototype.hasOwnProperty.call(values,'TRACK'))||(g.section==='SERVER'&&key==='REVERSED_GRID_RACE_POSITIONS'&&Object.keys(values).length>0))&&!(g.section==='RACE'&&['TIME','LAPS'].includes(key)));
      const stateLabel=isSession?(state==='active'||state==='inactive'?`<label>Session <select class="admin-input" data-cm-section="${g.section}" data-cm-key="ENABLED" data-cm-original="${state==='active'?'1':'0'}"><option value="1" ${state==='active'?'selected':''}>Active</option><option value="0" ${state==='inactive'?'selected':''}>Désactivée</option></select></label>`:'<p class="note">Session absente du préréglage : création non disponible.</p>'):'';
      const raceMode=g.section==='RACE'&&/^\d+$/.test(values.LAPS||'')&&/^\d+(?:\.\d+)?$/.test(values.TIME||'')?(Number(values.LAPS)===0?'time':'laps'):null;
      const raceValue=raceMode?(raceMode==='time'?values.TIME:values.LAPS):'';
      const raceFields=raceMode?`<div class="cm-editor-grid"><label>Limite de course <select class="admin-input" data-race-mode data-original="${raceMode}"><option value="laps" ${raceMode==='laps'?'selected':''}>Tours</option><option value="time" ${raceMode==='time'?'selected':''}>Temps (minutes)</option></select></label><label>Valeur <input class="admin-input" data-race-value data-original="${esc(raceValue)}" value="${esc(raceValue)}"></label></div>`:'';
      return `<section class="panel"><h3>${esc(g.title)}</h3>${stateLabel}${raceFields}${fields.length?`<div class="cm-editor-grid">${fields.map(([key,label])=>field(state==='inactive'?'__CM_'+g.section+'_OFF':g.section,key,label,values[key],inventory,extra)).join('')}</div>`:'<p class="note">Aucune valeur disponible pour cette section.</p>'}</section>`;
    }).join('');
    const weather=Object.entries(extra.weather||{}).map(([section,values])=>`<section class="panel"><h3>${esc(section)} · Météo</h3><label><input type="checkbox" data-cm-weather-remove="${Number(section.slice(8))}"> Supprimer cette météo</label><div class="cm-editor-grid">${Object.entries(values).map(([key,value])=>`<label>${esc(weatherLabels[key]||key)} <input class="admin-input" data-cm-section="${esc(section)}" data-cm-key="${esc(key)}" data-cm-original="${esc(value)}" value="${esc(value)}" maxlength="500"></label>`).join('')}</div></section>`).join('')||'<section class="panel"><h3>Météo</h3><p class="note">Aucune météo détectée dans le préréglage.</p></section>';
    const cars=(data?.slots||[]).map(slot=>{
      const car=inventory?.cars?.find(x=>x.id===slot.model),ids=(settings.SERVER?.CARS||'').split(';').filter(Boolean);
      const models=ids.length?`<select class="admin-input" data-cm-slot="${Number(slot.id)}" data-cm-slot-field="model" data-cm-original="${esc(slot.model)}" ${slot.cspSkin||slot.skinEditable===false?'disabled':''}>${modelOptions(ids,slot.model)}</select>`:`<input class="admin-input" data-cm-slot="${Number(slot.id)}" data-cm-slot-field="model" data-cm-original="${esc(slot.model)}" value="${esc(slot.model)}" ${slot.cspSkin||slot.skinEditable===false?'disabled':''}>`;
      const skins=car?.skins||[];
      const skin=skins.length?`<select class="admin-input" data-cm-slot="${Number(slot.id)}" data-cm-slot-field="skin" data-cm-original="${esc(slot.skin)}" ${slot.skinEditable===false?'disabled':''}><option value="">—</option>${options(skins,slot.skin)}</select>`:`<input class="admin-input" data-cm-slot="${Number(slot.id)}" data-cm-slot-field="skin" data-cm-original="${esc(slot.skin)}" value="${esc(slot.skin)}" ${slot.skinEditable===false?'disabled':''}>`;
      return `<div class="cm-slot"><b>Place ${Number(slot.id)+1}${slot.reserved?' · réservée':''}${slot.cspSkin?' · options CSP conservées':''}${slot.skinEditable===false?' · options inconnues, modification bloquée':''}</b><label>Voiture ${models}</label><label>Skin ${skin}</label><label><input type="checkbox" data-cm-remove="${Number(slot.id)}" ${slot.reserved||slot.cspSkin||slot.skinEditable===false?'disabled':''}> Supprimer</label></div>`;
    }).join('');
    const cup=cupOptions(event);
    const cupPanel=event?.kind==='cup'?`<section class="panel"><h3>Préparer une manche de ${esc(event.name||'la Cup')}</h3>
      <p class="note">Préremplit le brouillon seulement. Saisis les places et durées après vérification du règlement. Contrôle les places de stands du circuit. Les skins réservés sont conservés ; les nouvelles places ont un skin vide à vérifier. Le setup fixe, la grille inversée et une deuxième course ne sont pas configurés automatiquement.</p>
      ${event.data?.eventInfo?.formatText?`<p class="note">Format indiqué dans la fiche : ${esc(event.data.eventInfo.formatText)}</p>`:''}
      <label>Manche <select class="admin-input" data-cup-round><option value="">— Choisir —</option>${cup.rounds.map((r,i)=>`<option value="${i}">${esc(r.date)} · ${esc(r.name)} · ${esc(r.track)} / ${esc(r.layout||'principal')}</option>`).join('')}</select></label>
      <label>Voiture de la Cup <select class="admin-input" data-cup-car><option value="">— Choisir —</option>${cup.cars.map(c=>`<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.id)}</option>`).join('')}</select></label>
      <label>Places <input class="admin-input" type="number" min="1" max="200" data-cup-places placeholder="Ex. 20"></label>
      <label>Qualifications (minutes) <input class="admin-input" type="number" min="1" max="1440" data-cup-qualify placeholder="Ex. 10"></label>
      <label>Course 1 (minutes) <input class="admin-input" type="number" min="1" max="1440" data-cup-race placeholder="Ex. 15"></label>
      <button type="button" class="btn secondary" id="cm-cup-prepare">Préparer la course 1 en brouillon</button><p class="note" id="cm-cup-result" aria-live="polite"></p></section>`:'';
    return `<div class="cm-editor">${cupPanel}<p class="note"><b>Brouillon :</b> rien n’est enregistré tant que tu ne confirmes pas l’enregistrement. Les champs absents ne sont pas inventés, sauf la variante du circuit et la deuxième course si tu les choisis explicitement. Vérifie les valeurs avec Content Manager.</p>${inventory?'':'<p class="note">Inventaire indisponible : les identifiants sont à vérifier dans Content Manager.</p>'}${sections}<section class="panel"><h3>Voitures et places existantes</h3><p class="note">Les réservations pilotes sont conservées. Seules les dernières places sans données protégées peuvent être supprimées.</p>${cars||'<p class="note">Aucune place détectée.</p>'}<div class="cm-slot"><b>Ajouter une place</b><label>Voiture <select class="admin-input" data-cm-add-model><option value="">— Choisir —</option>${options((settings.SERVER?.CARS||'').split(';').filter(Boolean),'')}</select></label><label>Skin <input class="admin-input" data-cm-add-skin placeholder="Facultatif"></label></div><button type="button" class="btn secondary" id="cm-add-slot-btn">+ Ajouter la place au brouillon</button><div id="cm-added-slots" aria-live="polite"></div><p class="note">Clique sur le bouton pour ajouter chaque place au brouillon : elle ne sera enregistrée qu’après vérification et confirmation.</p><p class="note">Ajuste aussi le nombre maximum de pilotes et la liste des voitures autorisées si nécessaire.</p></section>${weather}<section class="panel"><h3>Ajouter une météo</h3><label>Identifiant météo Assetto Corsa <input class="admin-input" data-cm-weather-add placeholder="Ex. 3_clear"></label><p class="note">Valeurs initiales : 18 °C, piste +6 °C, vent nul ; recharge après ajout pour les modifier. Seule la dernière météo peut être supprimée et il faut en conserver au moins une.</p></section><section class="panel"><h3>Options CSP et scripts</h3><p class="note">CSP ${extra.csp?.encodedInTrack?'détecté dans la configuration du circuit':'non identifié dans le circuit'}. Les scripts Race Control et télémétrie existants sont compris dans ces options : ne les efface pas si tu veux les garder.</p>${data.cspWelcome?.available?`<label>Extra options CSP (INI)<textarea class="admin-input" data-cm-csp rows="10" maxlength="65536">${esc(data.cspWelcome.config)}</textarea></label><p class="note">Le message d’accueil reste inchangé. La configuration complète ci-dessus remplacera les options CSP actuelles après confirmation.</p>`:'<p class="note">Fichier CSP indisponible ou chemin non pris en charge : utilise Content Manager.</p>'}<a class="btn secondary" href="/race-control.html" target="_blank" rel="noopener">Ouvrir Race Control</a></section><button type="button" class="btn" id="cm-preview-btn">Voir les changements du brouillon</button><button type="button" class="btn secondary" id="cm-check-btn">Vérifier le brouillon sur le serveur</button><button type="button" class="btn" id="cm-save-btn">Enregistrer après confirmation</button><p class="note">Enregistrement expérimental, désactivé par défaut : nécessite une sauvegarde privée configurée, Content Manager fermé et le serveur sélectionné arrêté. Une interruption peut nécessiter une restauration manuelle.</p><pre class="note" id="cm-preview" style="white-space:pre-wrap"></pre></div>`;
  }
  function collect(container){
    const changes=[];
    for(const el of container.querySelectorAll('[data-cm-original]')){
      if(el.disabled||String(el.value)===el.dataset.cmOriginal)continue;
      if(el.dataset.cmSection)changes.push({section:el.dataset.cmSection,key:el.dataset.cmKey,before:el.dataset.cmOriginal,after:String(el.value)});
      else changes.push({slot:Number(el.dataset.cmSlot),key:el.dataset.cmSlotField,before:el.dataset.cmOriginal,after:String(el.value)});
    }
    return changes;
  }
  function attach(container,inventory,data,check,save,id,event){
    const additions=[];
    const addedView=container.querySelector('#cm-added-slots');
    function showAdded(message=''){
      if(!addedView)return;
      addedView.innerHTML=(message?`<p class="note">${esc(message)}</p>`:'')+additions.map((slot,i)=>`<div class="cm-added-slot">Place à ajouter : <b>${esc(slot.model)}</b>${slot.skin?' · '+esc(slot.skin):''} <button type="button" class="btn secondary small" data-cm-undo-add="${i}">Retirer du brouillon</button></div>`).join('');
    }
    container.querySelector('#cm-cup-prepare')?.addEventListener('click',()=>{
      const out=container.querySelector('#cm-cup-result');
      try{
        if(collect(container).length||additions.length||container.querySelector('[data-cm-remove]:checked, [data-cm-weather-remove]:checked')||container.querySelector('[data-cm-weather-add]')?.value.trim()||cspChanged(container.querySelector('[data-cm-csp]')?.value||'',data.cspWelcome?.config||'')||((container.querySelector('[data-race-mode]')?.value||'')!==(container.querySelector('[data-race-mode]')?.dataset.original||''))||((container.querySelector('[data-race-value]')?.value||'')!==(container.querySelector('[data-race-value]')?.dataset.original||'')))throw Error('Recharge le serveur avant de préparer une Cup : le brouillon contient déjà des changements.');
        const index=container.querySelector('[data-cup-round]').value;
        const plan=cupDraft(data,inventory,event,index===''?-1:Number(index),container.querySelector('[data-cup-car]').value,container.querySelector('[data-cup-places]').value,container.querySelector('[data-cup-qualify]').value,container.querySelector('[data-cup-race]').value);
        const get=(section,key)=>container.querySelector(`[data-cm-section="${section}"][data-cm-key="${key}"]`);
        const track=get('SERVER','TRACK'),layout=get('SERVER','CONFIG_TRACK'),cars=container.querySelector('[data-cm-allowed]'),hidden=container.querySelector('[data-cm-cars]'),max=get('SERVER','MAX_CLIENTS');
        const qualifyEnable=get('QUALIFY','ENABLED'),raceEnable=get('RACE','ENABLED');
        const qualSection=data.extra.sessions.QUALIFY==='inactive'?'__CM_QUALIFY_OFF':'QUALIFY';
        const qual=get(qualSection,'TIME'),mode=container.querySelector('[data-race-mode]'),value=container.querySelector('[data-race-value]');
        const slotFields=plan.slots.map(id=>({model:container.querySelector(`[data-cm-slot="${id}"][data-cm-slot-field="model"]`),skin:container.querySelector(`[data-cm-slot="${id}"][data-cm-slot-field="skin"]`)}));
        if([track,layout,cars,hidden,max,qualifyEnable,raceEnable,qual,mode,value,...slotFields.flatMap(x=>[x.model,x.skin])].some(x=>!x||x.disabled))throw Error('Certains champs ne peuvent pas être préremplis : vérifie le préréglage dans Content Manager.');
        if(![...cars.options].some(o=>o.value===plan.carId)||track.tagName==='SELECT'&&![...track.options].some(o=>o.value===plan.round.track))throw Error('La voiture ou le circuit ne figure pas dans les choix disponibles.');
        // Aucun fichier n'est modifié : on remplit les mêmes champs que l'éditeur.
        track.value=plan.round.track;track.dispatchEvent(new Event('change',{bubbles:true}));layout.value=plan.round.layout;
        for(const option of cars.options)option.selected=option.value===plan.carId;
        cars.dispatchEvent(new Event('change',{bubbles:true}));max.value=plan.places;
        for(const field of slotFields){field.model.value=plan.carId;field.model.dispatchEvent(new Event('change',{bubbles:true}));field.skin.value='';}
        for(let i=0;i<plan.additions;i++)additions.push({model:plan.carId,skin:''});
        qualifyEnable.value='1';raceEnable.value='1';qual.value=plan.qualify;mode.value='time';value.value=plan.race;
        showAdded();out.textContent='Brouillon préparé, aucun fichier modifié. Vérifie les places et les skins, puis utilise Vérifier le brouillon. Setup fixe et course 2 non configurés.';
      }catch(error){out.textContent=error.message||'Préparation impossible. Aucun fichier modifié.';}
    });
    container.querySelector('#cm-add-slot-btn')?.addEventListener('click',()=>{
      const model=container.querySelector('[data-cm-add-model]')?.value.trim()||'',skin=container.querySelector('[data-cm-add-skin]')?.value.trim()||'';
      const allowed=(container.querySelector('[data-cm-cars]')?.value??container.querySelector('[data-cm-section="SERVER"][data-cm-key="CARS"]')?.value??data.settings?.SERVER?.CARS??'').split(';').map(x=>x.trim()).filter(Boolean);
      if(!model||!allowed.includes(model)){showAdded('Choisis une voiture autorisée avant d’ajouter une place.');return;}
      if(!/^[a-zA-Z0-9_-]{1,120}$/.test(model)||! /^[a-zA-Z0-9_-]{0,120}$/.test(skin)){showAdded('Identifiant de voiture ou skin invalide.');return;}
      if(additions.length>=200){showAdded('Limite de 200 modifications de places par enregistrement.');return;}
      additions.push({model,skin});showAdded('Place ajoutée au brouillon, aucun fichier modifié.');
    });
    container.addEventListener('click',event=>{
      const button=event.target.closest?.('[data-cm-undo-add]');
      if(!button)return;
      const index=Number(button.dataset.cmUndoAdd);
      if(Number.isInteger(index)&&index>=0&&index<additions.length){additions.splice(index,1);showAdded('Place retirée du brouillon.');}
    });
    // Initialiser explicitement : le parseur HTML peut retirer le premier saut de ligne.
    const cspInput=container.querySelector('[data-cm-csp]');
    if(cspInput&&data.cspWelcome?.available)cspInput.value=normaliseCsp(data.cspWelcome.config);
    container.addEventListener('change',event=>{
      const el=event.target;
      if(el.matches?.('[data-cm-allowed]')){
        const chosen=[...el.selectedOptions].map(option=>option.value),hidden=container.querySelector('[data-cm-cars]');
        if(hidden)hidden.value=chosen.join(';');
        for(const select of container.querySelectorAll('[data-cm-slot-field="model"], [data-cm-add-model]')){
          if(select.tagName!=='SELECT'||select.disabled)continue;
          const old=select.value;
          select.innerHTML=(select.hasAttribute('data-cm-add-model')?'<option value="">— Choisir —</option>':'')+modelOptions(chosen,old);
          select.value=old;
        }
      }
      if(el.matches?.('[data-cm-track]')){
        const layout=container.querySelector('[data-cm-layout]'),track=inventory?.tracks?.find(t=>t.id===el.value);
        if(layout){const old=layout.value;layout.innerHTML='<option value="">— Tracé principal —</option>'+options(track?.layouts||[],old);layout.value=old;}
      }
      if(el.dataset?.cmSlotField==='model'){
        const skin=container.querySelector(`[data-cm-slot="${Number(el.dataset.cmSlot)}"][data-cm-slot-field="skin"]`),car=inventory?.cars?.find(c=>c.id===el.value);
        if(skin?.tagName==='SELECT'){
          const old=skin.value;skin.innerHTML='<option value="">—</option>'+options(car?.skins||[],old);skin.value=old;
        }
      }
    });
    async function send(event,saving){
      const out=container.querySelector('#cm-preview'),changes=collect(container);
      const removed=[...container.querySelectorAll('[data-cm-remove]:checked')].map(el=>Number(el.dataset.cmRemove));
      const weatherRemoved=[...container.querySelectorAll('[data-cm-weather-remove]:checked')].map(el=>Number(el.dataset.cmWeatherRemove)).sort((a,b)=>b-a);
      const weatherAdd=container.querySelector('[data-cm-weather-add]')?.value.trim()||'';
      const cspValue=container.querySelector('[data-cm-csp]')?.value;
      const cspIsChanged=cspValue!==undefined&&cspChanged(cspValue,data.cspWelcome?.config);
      const raceModeEl=container.querySelector('[data-race-mode]'),raceValueEl=container.querySelector('[data-race-value]');
      const raceChanged=!!raceModeEl&&(raceModeEl.value!==raceModeEl.dataset.original||raceValueEl.value!==raceValueEl.dataset.original);
      if(!changes.length&&!removed.length&&!additions.length&&!weatherRemoved.length&&!weatherAdd&&!cspIsChanged&&!raceChanged){out.textContent='Aucun changement dans le brouillon.';return;}
      const configChanges=[],slots=new Map();
      for(const c of changes){
        if(c.section){
          configChanges.push({section:c.section,key:c.key,value:c.after});
        }else{
          if(!slots.has(c.slot))slots.set(c.slot,{id:c.slot});
          slots.get(c.slot)[c.key]=c.after;
        }
      }
      for(const slot of removed){if(slots.has(slot)){out.textContent='Annule les modifications des places à supprimer avant de continuer.';return;}slots.set(slot,{id:slot,operation:'remove'});}
      if(additions.length){
        if(removed.length){out.textContent='Enregistre les suppressions avant d’ajouter une place.';return;}
        const next=data.slots.length?Math.max(...data.slots.map(x=>x.id))+1:0;
        additions.forEach((slot,i)=>slots.set(next+i,{id:next+i,operation:'add',...slot}));
      }
      if(weatherRemoved.length&&weatherAdd){out.textContent='Enregistre les suppressions avant d’ajouter une météo.';return;}
      const weatherChanges=weatherRemoved.map(id=>({id,operation:'remove'}));
      if(weatherAdd){const ids=Object.keys(data.extra?.weather||{}).map(x=>Number(x.slice(8)));weatherChanges.push({id:ids.length?Math.max(...ids)+1:0,operation:'add',graphics:weatherAdd});}
      if(saving&&cspIsChanged&&!global.confirm('Les Extra options CSP seront remplacées par le texte affiché. Les scripts supprimés dans ce texte ne seront plus chargés. Confirmer ?'))return;
      if(saving&&!global.confirm(`Enregistrer sur ${id==='local1'?'Serveur CM 1':'Serveur CM 2'} ? Content Manager doit être fermé et le serveur arrêté. Une sauvegarde sera créée ; une interruption peut nécessiter une restauration manuelle.`))return;
      event.target.disabled=true;out.textContent='Vérification…';
      try{
        const payload={configRevision:data.revision,entryRevision:data.entryRevision,configChanges,entryChanges:[...slots.values()],weatherChanges,...(raceChanged?{raceMode:{mode:raceModeEl.value,value:raceValueEl.value}}:{}),...(cspIsChanged?{cspConfig:cspValue,welcomeRevision:data.cspWelcome.revision}:{})};
        const result=await (saving?save({...payload,confirmation:id,cmClosed:true}):check(payload));
        const plan=saving?result.plan:result;
        const lines=[...plan.configChanges.map(c=>`${c.section} · ${c.key} : ${c.before||'(vide)'} → ${c.after||'(vide)'}`),...plan.slotChanges.map(c=>`Place ${c.id+1} : ${c.before?c.before.model+' / '+c.before.skin:'(nouvelle)'} → ${c.after?c.after.model+' / '+c.after.skin:'(supprimée)'}`),...(plan.weatherChanges||[]).map(c=>`Météo ${c.id+1} : ${c.before?'existante':'(nouvelle)'} → ${c.after?(c.after.__CM_GRAPHICS||c.after.GRAPHICS||'existante'):'(supprimée)'}`)];
        if(plan.raceChange)lines.push(`Course : ${plan.raceChange.value} ${plan.raceChange.mode==='time'?'minutes':'tours'}.`);
        if(plan.cspChanged)lines.push('Extra options CSP modifiées ; message d’accueil conservé.');
        out.textContent=(lines.length?lines.join('\n'):'Aucun changement effectif.')+(saving?'\n\nEnregistrement confirmé et sauvegarde créée. Recharge le serveur avant une autre modification.':'\n\nVérifié en lecture seule : aucun fichier enregistré.');
        if(saving){container.querySelector('#cm-save-btn').disabled=true;container.querySelector('#cm-check-btn').disabled=true;const addButton=container.querySelector('#cm-add-slot-btn');if(addButton)addButton.disabled=true;}
      }catch(error){out.textContent=(error.message||'Opération non confirmée.')+(saving?' Vérifie les fichiers avant de réessayer.':' Aucun fichier modifié.');}
      finally{if(!saving||!out.textContent.includes('Enregistrement confirmé'))event.target.disabled=false;}
    }
    container.querySelector('#cm-check-btn')?.addEventListener('click',event=>send(event,false));
    container.querySelector('#cm-save-btn')?.addEventListener('click',event=>send(event,true));
    container.querySelector('#cm-preview-btn')?.addEventListener('click',()=>{
      const changes=collect(container),out=container.querySelector('#cm-preview');
      const lines=changes.map(c=>`${c.section||'Place '+(c.slot+1)} · ${c.key} : ${c.before||'(vide)'} → ${c.after||'(vide)'}`);
      for(const el of container.querySelectorAll('[data-cm-remove]:checked'))lines.push(`Place ${Number(el.dataset.cmRemove)+1} : suppression demandée`);
      for(const el of container.querySelectorAll('[data-cm-weather-remove]:checked'))lines.push(`Météo ${Number(el.dataset.cmWeatherRemove)+1} : suppression demandée`);
      const weather=container.querySelector('[data-cm-weather-add]')?.value.trim();
      for(const slot of additions)lines.push(`Nouvelle place : ${slot.model}${slot.skin?' / '+slot.skin:''}`);if(weather)lines.push(`Nouvelle météo : ${weather}`);
      const mode=container.querySelector('[data-race-mode]'),rv=container.querySelector('[data-race-value]');if(mode&&(mode.value!==mode.dataset.original||rv.value!==rv.dataset.original))lines.push(`Course : ${rv.value} ${mode.value==='time'?'minutes':'tours'}.`);
      const csp=container.querySelector('[data-cm-csp]');if(csp&&cspChanged(csp.value,data.cspWelcome?.config))lines.push('Extra options CSP modifiées.');
      out.textContent=lines.length?lines.join('\n')+'\n\nAucun changement n’a été enregistré.':'Aucun changement dans le brouillon.';
    });
  }
  global.gdspServerEditor={render,collect,attach,cspChanged,cupOptions,cupDraft};
})(window);

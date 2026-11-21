'use strict';
// Brouillon local uniquement : ne sauvegarde ni ne pilote un serveur.
(function (global) {
  const groups = [
    {title:'Serveur et circuit',section:'SERVER',fields:[['NAME','Nom du serveur'],['TRACK','Circuit'],['CONFIG_TRACK','Variante du circuit'],['CARS','Voitures autorisées'],['MAX_CLIENTS','Nombre maximum de pilotes'],['PICKUP_MODE_ENABLED','Entrée libre (0/1)'],['LOOP_MODE','Boucler les sessions (0/1)'],['REGISTER_TO_LOBBY','Serveur public (0/1)']]},
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
  function render(data,inventory){
    const settings=data?.settings||{},extra=data?.extra||{};
    if(!extra.csp?.trackId && settings.SERVER?.TRACK)extra.csp={...(extra.csp||{}),trackId:settings.SERVER.TRACK};
    const sections=groups.map(g=>{
      const isSession=['PRACTICE','QUALIFY','RACE'].includes(g.section),state=extra.sessions?.[g.section];
      const values=state==='inactive'?(extra.inactiveSessions?.[g.section]||{}):(settings[g.section]||{});
      const fields=g.fields.filter(([key])=>(Object.prototype.hasOwnProperty.call(values,key)||(g.section==='SERVER'&&key==='CONFIG_TRACK'&&Object.prototype.hasOwnProperty.call(values,'TRACK')))&&!(g.section==='RACE'&&['TIME','LAPS'].includes(key)));
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
    return `<div class="cm-editor"><p class="note"><b>Brouillon :</b> rien n’est enregistré tant que tu ne confirmes pas l’enregistrement. Les champs absents ne sont pas inventés, sauf la variante du circuit si tu en choisis une. Vérifie les valeurs avec Content Manager.</p>${inventory?'':'<p class="note">Inventaire indisponible : les identifiants sont à vérifier dans Content Manager.</p>'}${sections}<section class="panel"><h3>Voitures et places existantes</h3><p class="note">Les réservations pilotes sont conservées. Seules les dernières places sans données protégées peuvent être supprimées.</p>${cars||'<p class="note">Aucune place détectée.</p>'}<div class="cm-slot"><b>Ajouter une place</b><label>Voiture <select class="admin-input" data-cm-add-model><option value="">— Choisir —</option>${options((settings.SERVER?.CARS||'').split(';').filter(Boolean),'')}</select></label><label>Skin <input class="admin-input" data-cm-add-skin placeholder="Facultatif"></label></div><p class="note">Ajuste aussi le nombre maximum de pilotes et la liste des voitures autorisées si nécessaire.</p></section>${weather}<section class="panel"><h3>Ajouter une météo</h3><label>Identifiant météo Assetto Corsa <input class="admin-input" data-cm-weather-add placeholder="Ex. 3_clear"></label><p class="note">Valeurs initiales : 18 °C, piste +6 °C, vent nul ; recharge après ajout pour les modifier. Seule la dernière météo peut être supprimée et il faut en conserver au moins une.</p></section><section class="panel"><h3>Options CSP et scripts</h3><p class="note">CSP ${extra.csp?.encodedInTrack?'détecté dans la configuration du circuit':'non identifié dans le circuit'}. Les scripts Race Control et télémétrie existants sont compris dans ces options : ne les efface pas si tu veux les garder.</p>${data.cspWelcome?.available?`<label>Extra options CSP (INI)<textarea class="admin-input" data-cm-csp rows="10" maxlength="65536">${esc(data.cspWelcome.config)}</textarea></label><p class="note">Le message d’accueil reste inchangé. La configuration complète ci-dessus remplacera les options CSP actuelles après confirmation.</p>`:'<p class="note">Fichier CSP indisponible ou chemin non pris en charge : utilise Content Manager.</p>'}<a class="btn secondary" href="/race-control.html" target="_blank" rel="noopener">Ouvrir Race Control</a></section><button type="button" class="btn" id="cm-preview-btn">Voir les changements du brouillon</button><button type="button" class="btn secondary" id="cm-check-btn">Vérifier le brouillon sur le serveur</button><button type="button" class="btn" id="cm-save-btn">Enregistrer après confirmation</button><p class="note">Enregistrement expérimental, désactivé par défaut : nécessite une sauvegarde privée configurée, Content Manager fermé et le serveur sélectionné arrêté. Une interruption peut nécessiter une restauration manuelle.</p><pre class="note" id="cm-preview" style="white-space:pre-wrap"></pre></div>`;
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
  function attach(container,inventory,data,check,save,id){
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
      const addModel=container.querySelector('[data-cm-add-model]')?.value.trim()||'',addSkin=container.querySelector('[data-cm-add-skin]')?.value.trim()||'';
      const weatherRemoved=[...container.querySelectorAll('[data-cm-weather-remove]:checked')].map(el=>Number(el.dataset.cmWeatherRemove)).sort((a,b)=>b-a);
      const weatherAdd=container.querySelector('[data-cm-weather-add]')?.value.trim()||'';
      const cspValue=container.querySelector('[data-cm-csp]')?.value;
      const cspIsChanged=cspValue!==undefined&&cspChanged(cspValue,data.cspWelcome?.config);
      const raceModeEl=container.querySelector('[data-race-mode]'),raceValueEl=container.querySelector('[data-race-value]');
      const raceChanged=!!raceModeEl&&(raceModeEl.value!==raceModeEl.dataset.original||raceValueEl.value!==raceValueEl.dataset.original);
      if(!changes.length&&!removed.length&&!addModel&&!weatherRemoved.length&&!weatherAdd&&!cspIsChanged&&!raceChanged){out.textContent='Aucun changement dans le brouillon.';return;}
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
      if(addModel){
        if(removed.length){out.textContent='Enregistre les suppressions avant d’ajouter une place.';return;}
        const next=data.slots.length?Math.max(...data.slots.map(x=>x.id))+1:0;
        slots.set(next,{id:next,operation:'add',model:addModel,skin:addSkin});
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
        if(saving){container.querySelector('#cm-save-btn').disabled=true;container.querySelector('#cm-check-btn').disabled=true;}
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
      const model=container.querySelector('[data-cm-add-model]')?.value.trim(),weather=container.querySelector('[data-cm-weather-add]')?.value.trim();
      if(model)lines.push(`Nouvelle place : ${model}`);if(weather)lines.push(`Nouvelle météo : ${weather}`);
      const mode=container.querySelector('[data-race-mode]'),rv=container.querySelector('[data-race-value]');if(mode&&(mode.value!==mode.dataset.original||rv.value!==rv.dataset.original))lines.push(`Course : ${rv.value} ${mode.value==='time'?'minutes':'tours'}.`);
      const csp=container.querySelector('[data-cm-csp]');if(csp&&cspChanged(csp.value,data.cspWelcome?.config))lines.push('Extra options CSP modifiées.');
      out.textContent=lines.length?lines.join('\n')+'\n\nAucun changement n’a été enregistré.':'Aucun changement dans le brouillon.';
    });
  }
  global.gdspServerEditor={render,collect,attach,cspChanged};
})(window);

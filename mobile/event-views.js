'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.gdspMobileEventViews=api;
})(typeof window!=='undefined'?window:null,function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=value=>typeof value==='string'?value.trim():'';
  const readable=value=>String(value||'').replace(/[_-]+/g,' ').trim();
  const value=v=>v==null?'':String(v).trim();
  const isLola=ev=>['lola-t290-2026','lola-t290-gdsp-championnat-2026'].includes(ev?.slug);
  function back(ev){return `<a class="back" href="#event=${encodeURIComponent(ev.slug)}">← Retour à l’événement</a>`;}
  function formatTime(ms){
    const n=Number(ms);if(!Number.isFinite(n)||n<=0||n>=99999999)return '—';
    const mins=Math.floor(n/60000),seconds=((n%60000)/1000).toFixed(3);
    return `${mins}:${seconds.padStart(6,'0')}`;
  }
  function dateLabel(day){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day||'')))return 'Date à confirmer';
    const d=new Date(day+'T12:00:00Z');return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(d):'Date à confirmer';
  }
  function resultStatus(p){
    if(p.comDNS)return 'DNS';
    if(p.disqualified||p.comDQ||p._dq)return 'DQ';
    if(p.comDNF)return 'DNF';
    return '';
  }
  function resultView(ev,calculated){
    const standings=Array.isArray(calculated?.standings)?calculated.standings:[];
    const rounds=Array.isArray(calculated?.rounds)?calculated.rounds:[];
    const ranking=standings.length?standings.map((d,i)=>`<div class="result-row"><span class="position">${i+1}</span><div class="result-person"><b>${esc(d.name||'Pilote')}</b><small>${esc(d.team||'Indépendant')}</small></div><div class="score"><b>${esc(d.total)}</b><small>points</small></div></div>`).join(''):'<p>Aucun classement disponible pour cet événement.</p>';
    const scoreRows=(rows,field)=>rows.map((d,i)=>`<div class="result-row"><span class="position">${i+1}</span><div class="result-person"><b>${esc(d.name||'Pilote')}</b><small>${esc(d.team||'')}</small></div><div class="score"><b>${esc(d[field])}</b><small>points</small></div></div>`).join('');
    const jokers=standings.slice().sort((a,b)=>b.joker-a.joker||String(a.name||'').localeCompare(String(b.name||'')));
    const merits=standings.slice().sort((a,b)=>b.meritTotal-a.meritTotal||String(a.name||'').localeCompare(String(b.name||'')));
    const teams=Array.isArray(calculated?.teamStandings)?calculated.teamStandings:[];
    const other=standings.length?`<details class="session-detail"><summary>Classement Joker</summary>${scoreRows(jokers,'joker')}</details><details class="session-detail"><summary>Trophée du mérite</summary>${scoreRows(merits,'meritTotal')}</details>${teams.length?`<details class="session-detail"><summary>Classement équipes · Joker</summary>${scoreRows(teams,'joker')}</details>`:''}`:'';
    const sections=rounds.map(r=>{
      const items=(r.sessions||[]).map((s,i)=>{
        const label=s.type==='QUALIFY'?'Qualifications':`Course ${(r.sessions||[]).filter((x,j)=>x.type==='RACE'&&j<=i).length}`;
        const rows=(s.results||[]).map((p,j)=>{
          const status=resultStatus(p),time=s.type==='QUALIFY'?p._adjustedBest:p.finalTime;
          return `<div class="result-row"><span class="position">${j+1}</span><div class="result-person"><b>${esc(p.name||'Pilote')}</b><small>${esc(p.team||'Indépendant')} · ${esc(p.laps??0)} tour${p.laps===1?'':'s'}${status?' · '+esc(status):''}</small><small>${s.type==='QUALIFY'?'Meilleur tour':'Temps'} : ${esc(formatTime(time))}</small></div><div class="score"><b>${esc(p.points)}</b><small>pts</small></div></div>`;
        }).join('')||'<p>Aucun résultat dans cette session.</p>';
        return `<details class="session-detail"><summary>${esc(label)} <span>${(s.results||[]).length} pilotes</span></summary><div class="session-rows">${rows}</div></details>`;
      }).join('');
      return items?`<section class="panel"><div class="eyebrow">Manche ${esc(r.number)}</div><h2>${esc(readable(r.track)||'Circuit à confirmer')}</h2><p class="muted">${esc(dateLabel(r.date))}</p>${items}</section>`:'';
    }).join('');
    return `${back(ev)}<div class="eyebrow">${esc(ev.name)}</div><h1 class="page-title">Résultats & classement</h1><button class="btn secondary" type="button" data-scroll-results>Voir les résultats par manche ↓</button><section class="panel"><div class="eyebrow">Championnat</div><h2>Classement pilotes</h2><p class="muted">Total de points avec les ajustements de la commission.</p>${ranking}${other}</section><div class="section-title" id="mobile-round-results" tabindex="-1"><h2>Résultats par manche</h2></div>${sections||'<section class="panel"><p>Aucune qualification ni course importée.</p></section>'}`;
  }
  function safeMedia(input){
    const s=text(input);
    if(/^\/?assets\/mod-previews\/[0-9a-f]{64}\.(?:jpg|png)$/i.test(s))return '/'+s.replace(/^\/+/, '');
    if(s.length<=450000&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(s))return s;
    return '';
  }
  function safeUrl(input){try{const u=new URL(text(input));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch(_){return '';}}
  function skinImage(entrant,data){
    const valid=s=>typeof s==='string'&&s.length>0&&s.length<=128&&s===s.trim()&&!/[\\/\0<>:"|?*]/.test(s)&&!/^\.+$/.test(s)&&!/[. ]$/.test(s);
    const server=data.ahEntrantsServer||data.ahServer;
    if(!server||!valid(entrant?.car)||!valid(entrant?.skin))return '';
    return '/api/ah-skin-preview?'+new URLSearchParams({server,model:entrant.car,skin:entrant.skin});
  }
  function carsFor(ev){
    const data=ev?.data||{},selected=Array.isArray(data.modSelection?.cars)?data.modSelection.cars:[];
    let cars=Array.isArray(data.carSheets)&&data.carSheets.length?data.carSheets:selected;
    if(!cars.length&&text(data.eventInfo?.car))cars=text(data.eventInfo.car).split(/\s*\/\s*/).filter(Boolean).map((name,index)=>({id:'event-car-'+(index+1),name}));
    const entries=Array.isArray(data.ahEntrants)?data.ahEntrants:[];
    if(!cars.length&&!entries.some(e=>text(e?.car))&&isLola(ev))cars=[{id:'lola-t290',name:'Lola T290',brand:'Lola',category:'Prototypes historiques'}];
    cars=cars.filter(c=>c&&typeof c==='object').map(c=>({...c}));
    for(const entry of entries){const id=text(entry?.car);if(id&&!cars.some(c=>c.id===id||c.name===id))cars.push({id,name:readable(id)});}
    return cars.slice(0,12).map(car=>{
      const remote=entries.filter(e=>e?.car===(car.id||car.name)||e?.car===car.name).map(e=>({image:skinImage(e,data),name:text(e.name)||'Livrée',team:text(e.team)})).filter(e=>e.image);
      const local=(Array.isArray(car.liveries)?car.liveries:[]).filter(x=>x&&safeMedia(x.image)).map(x=>({...x,image:safeMedia(x.image)}));
      return {...car,liveries:[...remote,...local].slice(0,80)};
    });
  }
  function carView(ev){
    const data=ev?.data||{},cars=carsFor(ev),labels={bhp:'Puissance',torque:'Couple',weight:'Poids',topspeed:'Vitesse maximale',acceleration:'Accélération',pwratio:'Rapport poids / puissance',range:'Autonomie'};
    const cards=cars.map((car,i)=>{
      const name=value(car.name||car.id||'Voiture'),meta=[['Constructeur',car.brand],['Catégorie',car.category],['Année',car.year],['Pays',car.country],['Auteur du mod',car.author],['Version',car.version]].filter(([,v])=>value(v));
      const specs=Object.entries(car.specs&&typeof car.specs==='object'?car.specs:{}).filter(([k,v])=>labels[k]&&value(v));
      const description=text(data.sheetTranslations?.['car:'+car.id])||text(car.description),url=safeUrl(car.url),skins=car.liveries||[];
      const picture=skins.length?`<div class="livery"><img src="${esc(skins[0].image)}" alt="${esc(skins[0].name||name)}" loading="lazy" data-livery-image><p data-image-missing hidden>Aperçu de livrée indisponible.</p><label>Livrée <select data-livery-select>${skins.map(s=>`<option value="${esc(s.image)}">${esc([s.number?'N° '+s.number:'',s.name,s.team].filter(Boolean).join(' · '))}</option>`).join('')}</select></label></div>`:'';
      const curves=[['powerCurve','Puissance','bhp'],['torqueCurve','Couple','Nm']].map(([key,label,unit])=>{
        const points=(Array.isArray(car[key])?car[key]:[]).filter(p=>Number.isFinite(p?.rpm)&&Number.isFinite(p?.value)).slice(0,500).sort((a,b)=>a.rpm-b.rpm);
        return points.length?`<details class="session-detail"><summary>${esc(label)} moteur <span>${points.length} valeurs</span></summary><dl class="spec-list">${points.map(p=>`<div><dt>${esc(p.rpm)} tr/min</dt><dd>${esc(p.value)} ${unit}</dd></div>`).join('')}</dl></details>`:'';
      }).join('');
      return `<section class="panel car-panel"><div class="eyebrow">${cars.length>1?'Voiture '+(i+1):'Plateau engagé'}</div><h2>${esc(name)}</h2><p class="muted">${esc([car.brand,car.category,car.year].filter(Boolean).join(' · '))}</p>${picture}${meta.length?`<dl class="spec-list">${meta.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`:''}${specs.length?`<h3>Caractéristiques</h3><dl class="spec-list">${specs.map(([k,v])=>`<div><dt>${esc(labels[k])}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`:''}${curves}${description?`<h3>Présentation</h3><p>${esc(description)}</p>`:''}${!car.metadataAvailable&&!specs.length&&!description?'<p class="muted">Métadonnées du mod non disponibles : caractéristiques non renseignées.</p>':''}${url?`<a class="more-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Page du mod ↗</a>`:''}</section>`;
    }).join('');
    return `${back(ev)}<div class="eyebrow">${esc(ev.name)}</div><h1 class="page-title">Fiche voiture</h1>${cards||'<section class="panel"><p>Aucune voiture n’est encore associée à cet événement.</p></section>'}`;
  }
  // Même règle de fusion que le site : une fiche importée remplace sa manche
  // historique, plusieurs variantes d'une manche restent distinctes.
  function mergeCircuitRounds(base,extra){
    const byRound=new Map(),key=r=>Number.isFinite(Number(r?.round))&&Number(r.round)>0?'n'+Number(r.round):'k'+String(r?.id||r?.name||'');
    const same=(a,b)=>{
      if(!a||!b)return false;if(a.id&&b.id&&a.id===b.id)return true;
      const at=String(a.trackId||a.localTrackId||a.driverFolder||'').toLowerCase(),bt=String(b.trackId||b.localTrackId||b.driverFolder||'').toLowerCase();
      const al=String(a.layoutId||a.localLayoutId||'').toLowerCase(),bl=String(b.layoutId||b.localLayoutId||'').toLowerCase();
      const ad=String(a.date||'').slice(0,10),bd=String(b.date||'').slice(0,10);
      return !!at&&at===bt&&al===bl&&(!ad||!bd||ad===bd);
    };
    for(const r of base)if(r&&typeof r==='object')byRound.set(key(r),r);
    const counts=new Map();for(const r of extra){const n=Number(r?.round);if(Number.isFinite(n)&&n>0)counts.set(n,(counts.get(n)||0)+1);}
    extra.forEach((r,i)=>{
      if(!r||typeof r!=='object'||!r.name)return;
      const k=key(r),existing=byRound.get(k),n=Number(r.round);
      if(!existing){byRound.set(k,{...r,imported:true});return;}
      if((!existing.imported&&(counts.get(n)||0)===1)||same(existing,r)){byRound.set(k,{...existing,...r,imported:true});return;}
      for(const [ek,other] of byRound)if(same(other,r)){byRound.set(ek,{...other,...r,imported:true});return;}
      byRound.set(`${k}:${String(r.id||r.trackId||r.name||i)}`,{...r,imported:true});
    });
    const has=r=>Number.isFinite(Number(r.round))&&Number(r.round)>0;
    const sorted=[...byRound.values()].sort((a,b)=>has(a)&&has(b)&&Number(a.round)!==Number(b.round)?Number(a.round)-Number(b.round):has(a)!==has(b)?has(a)?-1:1:String(a.date||'').localeCompare(String(b.date||''))||(has(a)&&has(b)&&Number(a.round)===Number(b.round)?0:String(a.name||'').localeCompare(String(b.name||''))));
    const used=new Set(sorted.filter(has).map(r=>Number(r.round)));let next=1;
    return sorted.map(r=>{let n=Number(r.round);if(!has(r)){while(used.has(next))next++;n=next;used.add(n);}return {...r,round:n,label:r.label||`M${n}`};});
  }
  function circuitView(ev,base){
    const data=ev?.data||{},extra=Array.isArray(data.circuitRounds)?data.circuitRounds:[];
    const rounds=mergeCircuitRounds(isLola(ev)&&Array.isArray(base?.rounds)?base.rounds:[],extra);
    const sessions=Array.isArray(data.sessions)?data.sessions:[];
    const cards=rounds.map(r=>{
      const track=String(r.trackId||r.localTrackId||r.driverFolder||'').toLowerCase();
      const matching=sessions.filter(s=>track&&String(s?.track||'').toLowerCase()===track&&s.date);
      const days=[...new Set(matching.map(s=>String(s.date).slice(0,10)))];
      const day=days.length===1?days[0]:(r.imported?String(r.date||'').slice(0,10):'');
      const rows=[['Configuration',r.layout||r.layoutId||r.localLayoutId],['Longueur',r.lengthStr||r.officialLength],['Pays',r.country],['Ville',r.city],['Année',r.year],['Stands',r.pitboxes],['Auteur du mod',r.author],['Version',r.version]].filter(([,v])=>value(v));
      const translated=text(data.sheetTranslations?.['track:'+(r.driveFolderId||r.id||r.name)])||text(r.description),url=safeUrl(r.trackUrl);
      const path=text(r.outline?.path),box=text(r.outline?.viewBox)||'0 0 1000 560';
      const map=path.length<=30000&&/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]+$/.test(path)&&/^[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+$/.test(box)?`<svg class="mobile-track-map" viewBox="${esc(box)}" role="img" aria-label="Tracé ${esc(r.name||'du circuit')}"><path d="${esc(path)}" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/></svg>`:'';
      return `<section class="panel circuit-panel"><div class="eyebrow">${esc(r.label||'Circuit')}</div><h2>${esc(r.name||readable(track)||'Circuit')}</h2><p class="muted">${esc(dateLabel(day))}${matching.length?' · Sessions importées':''}</p>${map}${rows.length?`<dl class="spec-list">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`:''}${translated?`<h3>Présentation</h3><p>${esc(translated)}</p>`:''}${url?`<a class="more-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Page du mod ↗</a>`:''}</section>`;
    }).join('');
    return `${back(ev)}<div class="eyebrow">${esc(ev.name)}</div><h1 class="page-title">Fiches circuit</h1>${cards||'<section class="panel"><p>Aucune fiche circuit disponible pour cet événement.</p></section>'}`;
  }
  return {formatTime,resultStatus,resultView,carView,circuitView,carsFor,mergeCircuitRounds,safeMedia};
});

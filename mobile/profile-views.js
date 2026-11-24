'use strict';
(function(root,factory){const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;if(root)root.gdspMobileProfileViews=api;})(typeof window!=='undefined'?window:null,function(){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=ms=>{const n=Number(ms);if(!Number.isFinite(n)||n<=0||n>=99999999)return '—';return Math.floor(n/60000)+':'+((n%60000)/1000).toFixed(3).padStart(6,'0');};
  const date=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(d):'Date inconnue';};
  const url=(slug,id)=>'#driver='+encodeURIComponent(slug)+'&id='+encodeURIComponent(id);
  const globalUrl=id=>'#global-driver='+encodeURIComponent(id);
  const search='<label class="driver-search">Rechercher un pilote <input type="search" data-driver-search placeholder="Nom ou équipe" autocomplete="off"></label><p class="muted" data-search-empty hidden>Aucun pilote trouvé.</p>';
  const searchable=(name,team)=>esc((String(name||'')+' '+String(team||'')).toLocaleLowerCase('fr'));
  const labels={regularite:'Régularité',proprete:'Propreté',vitesse:'Vitesse au tour',resultats:'Résultats'};
  const levels={1:'Élite',2:'Confirmé',3:'Intermédiaire',4:'Débutant'};
  function levelBadge(level,large=false){
    const names={1:'lvl1-elite',2:'lvl2-confirme',3:'lvl3-inter',4:'lvl4-debut'},name=names[level];
    if(!name||!Number.isInteger(level))return '';
    return `<picture class="global-level-badge${large?' large':''}"><source type="image/webp" srcset="/assets/${name}.webp?v=27"><img src="/assets/${name}.png?v=26" alt="${esc('Niveau '+level+' · '+levels[level])}" width="${large?72:40}" height="${large?72:40}" loading="lazy"></picture>`;
  }
  const readable=s=>String(s||'Circuit inconnu').replace(/[_-]+/g,' ');
  function gauges(r,global){
    if(!r)return '<section class="panel"><h2>Niveau à déterminer</h2><p>Au moins deux courses exploitables sont nécessaires pour établir les quatre critères de cet événement.</p></section>';
    const bars=Object.entries(labels).map(([k,label])=>{const v=Number(r.details[k]);return `<div class="profile-gauge"><div><b>${esc(label)}</b><span>${Number.isFinite(v)?v.toFixed(0):'—'} / 100</span></div><div class="profile-bar" aria-hidden="true"><i style="width:${Number.isFinite(v)?Math.max(0,Math.min(100,v)):0}%"></i></div></div>`;}).join('');
    return `<section class="panel"><div class="eyebrow">Quatre critères</div><h2>Profil de performance</h2><p class="muted">${global?'Global : rythme, propreté Commission, vitesse et résultats pondérés sur les courses retenues.':'Évaluation indicative de l’événement : rythme, incidents détectés, vitesse et résultats. Le niveau 4 est le plus élevé dans l’événement ; cette échelle est distincte de celle du Global.'}</p>${bars}</section>`;
  }
  function history(rows,global){
    if(!rows.length)return '<section class="panel"><h2>Historique en course</h2><p>Aucune course enregistrée pour ce pilote.</p></section>';
    return `<div class="section-title"><h2>Historique en course</h2><span class="muted">${rows.length} course(s)</span></div>${rows.slice().reverse().map(r=>`<section class="panel race-card"><div class="eyebrow">${esc(date(r.date))}${global?' · '+esc(r.eventName||'Événement'):''}</div><h3>${esc(readable(r.track))}</h3><div class="profile-stats"><div><small>Arrivée</small><b>P${esc(r.position)}${r.status?' · '+esc(r.status):''}</b></div><div><small>Départ</small><b>${r.grid?'P'+esc(r.grid):'—'}</b></div><div><small>Delta</small><b>${r.delta==null?'—':(r.delta>0?'+':'')+esc(r.delta)}</b></div></div><dl class="spec-list"><div><dt>Meilleur tour course</dt><dd>${esc(time(r.best))}</dd></div><div><dt>Meilleur week-end</dt><dd>${esc(time(r.weekendBest))}${r.weekendSession?' · '+esc(r.weekendSession):''}</dd></div><div><dt>Moyenne course</dt><dd>${esc(time(r.avgRaceMs))}</dd></div><div><dt>Tours analysés · pit/exclus</dt><dd>${esc(r.laps??0)} · ${r.pitExcluded==null?'—':esc(r.pitExcluded)}</dd></div><div><dt>Δ rythme course</dt><dd>${r.consistency==null?'—':'+'+esc((r.consistency/1000).toFixed(2))+' s'}</dd></div><div><dt>Collisions brutes</dt><dd>${esc(r.collisions)}</dd></div></dl>${global&&r.eventSlug?`<a class="more-link" href="#event=${encodeURIComponent(r.eventSlug)}">Voir l’événement →</a>`:''}</section>`).join('')}<p class="muted">Δ rythme : écart moyen au meilleur tour, premier tour et tours aux stands exclus. Les collisions brutes sont des contacts enregistrés, pas des fautes attribuées.</p>`;
  }
  function stats(rows){
    if(!rows.length)return '';
    const avg=(a,k)=>a.reduce((n,x)=>n+x[k],0)/a.length,delta=rows.filter(x=>x.delta!=null);
    const best=Math.min(...rows.map(x=>x.position)),podiums=rows.filter(x=>x.position<=3).length,wins=rows.filter(x=>x.position===1).length;
    return `<section class="panel"><div class="profile-stats"><div><small>Courses</small><b>${rows.length}</b></div><div><small>Meilleur résultat brut</small><b>P${best}</b></div><div><small>Arrivée moyenne</small><b>P${avg(rows,'position').toFixed(1)}</b></div><div><small>Places gagnées / course</small><b>${delta.length?(avg(delta,'delta')>0?'+':'')+avg(delta,'delta').toFixed(1):'—'}</b></div><div><small>Collisions / course</small><b>${avg(rows,'collisions').toFixed(1)}</b></div><div><small>Victoires · podiums</small><b>${wins} · ${podiums}</b></div></div></section>`;
  }
  function portrait(rows,r,global){
    if(!rows.length)return '';
    const avg=(a,k)=>a.reduce((n,x)=>n+x[k],0)/a.length,known=rows.filter(x=>x.delta!=null),delta=known.length?avg(known,'delta'):null,pos=avg(rows,'position'),coll=avg(rows,'collisions');
    const positives=[],attention=[];
    if(global){
      if(pos<=5)positives.push(`Position moyenne dans le top ${Math.ceil(pos)} sur ${rows.length} courses.`);
      if(delta!==null&&delta>1)positives.push(`Progression moyenne de +${delta.toFixed(1)} place(s) entre le départ et l’arrivée.`);else if(delta!==null&&delta< -1)attention.push(`Recul moyen de ${Math.abs(delta).toFixed(1)} place(s) entre le départ et l’arrivée.`);
      if(coll<1)positives.push('Moins d’un incident de collision enregistré par course en moyenne.');else if(coll>=3)attention.push('Plusieurs incidents de collision par course en moyenne.');
      if(r?.details.proprete>=65&&r.conductReviewed===r.windowCount)positives.push('Propreté évaluée par la commission sur toute la fenêtre récente.');
      if(r?.details.regularite>=65)positives.push('Régularité de rythme solide.');if(r?.details.vitesse>=65)positives.push('Vitesse au tour parmi les plus rapides du plateau.');if(r?.details.regularite<=40)attention.push('Rythme irrégulier entre les tours.');
    }else{
      if(known.length>=2){if(delta>0.5)positives.push(`Progression moyenne de +${delta.toFixed(1)} place(s) entre le départ et l’arrivée.`);else if(delta<-.5)attention.push(`Recul moyen de ${Math.abs(delta).toFixed(1)} place(s) entre le départ et l’arrivée.`);else positives.push('Positions de départ globalement conservées en course.');}
      if(rows.length>=2){if(coll<1)positives.push('Moins d’un événement de collision enregistré par course en moyenne.');else if(coll>=3)attention.push('Plusieurs événements de collision enregistrés par course en moyenne.');if(pos<=5)positives.push('Position moyenne à l’arrivée dans les cinq premiers.');}
    }
    const list=a=>a.length?a.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>Pas assez de données ou aucun élément signalé.</li>';
    return `<section class="panel"><div class="eyebrow">Analyse indicative</div><h2>Portrait du pilote</h2><h3>Points forts</h3><ul>${list(positives)}</ul><h3>Points de vigilance</h3><ul>${list(attention)}</ul><p class="muted">Les collisions enregistrées ne déterminent pas à elles seules la responsabilité.</p></section>`;
  }
  function eventList(ev,computed){
    const slug=encodeURIComponent(ev.slug),drivers=computed.drivers||[];
    const warning=drivers.some(d=>d.serviceInResults)?'<section class="panel"><p>Un nom de service est également présent dans les résultats importés. Il reste visible ici : les résultats et classements n’ont pas été modifiés. Vérifie la session avant toute correction.</p></section>':'';
    return `<a class="back" href="#event=${slug}">← Retour à l’événement</a><div class="eyebrow">${esc(ev.name)}</div><h1 class="page-title">Pilotes</h1><p class="muted">Pilotes des résultats et engagés AssettoHosting. Sélectionne un pilote pour voir sa fiche.</p>${warning}${search}<div class="cards">${drivers.map(d=>`<a class="event-card" href="${esc(url(ev.slug,d.id))}" data-driver-item data-search="${searchable(d.name,d.team)}"><div><strong>${esc(d.name)}</strong><small>${esc(d.team||'Indépendant')}${d.entrant?' · Engagé':''}${d.serviceInResults?' · Service à vérifier dans les résultats':''}</small></div><span aria-hidden="true">→</span></a>`).join('')||'<section class="panel">Aucun pilote disponible pour cet événement.</section>'}</div>`;
  }
  function globalList(computed){
    const rows=computed.ratings||[];
    return `<a class="back" href="#home">← Retour à l’accueil</a><div class="eyebrow">Tous événements</div><h1 class="page-title">Classement global</h1><section class="panel"><p>Les pilotes apparaissent après <b>5 courses</b>. Le score combine rythme, propreté Commission, vitesse et résultats, selon les coefficients des événements.</p><p class="muted">Dix dernières courses : dès 10 départs, un joker sportif est retiré des autres critères, mais sa propreté reste comptée. Avant 10 courses ou avec des données partielles, le score est provisoire. Real Penalty : DT / Stop & Go non évalués sans journaux.</p></section>${search}<div class="cards">${rows.map((r,i)=>`<a class="event-card" href="${esc(globalUrl(r.id))}" data-driver-item data-search="${searchable(r.name,r.team)}"><span class="position">${i+1}</span>${levelBadge(r.level)}<div class="global-driver-name"><strong>${esc(r.name)}</strong><small>Niveau ${r.level} · ${esc(levels[r.level]||'')} · ${r.count} courses<br>${r.provisional?'Provisoire / partiel':'Confirmé'} · ${r.conductReviewed}/${r.windowCount} examens propreté</small></div><span class="global-score">${r.score.toFixed(0)}<small>/ 100</small></span></a>`).join('')||'<section class="panel">Pas encore assez de données : 5 courses minimum par pilote.</section>'}</div>`;
  }
  function audit(r){
    return `<section class="panel"><h2>Comment le score est calculé</h2><p>${r.sportingProvisional?'Provisoire':'10 courses atteintes'} · ${r.retainedCount}/${r.windowCount} retenues · propreté examinée ${r.conductReviewed}/${r.windowCount}${r.conductPending?' · '+r.conductPending+' décision(s) à qualifier':''}.</p><p class="muted">${r.joker?'Joker sportif : '+esc(r.joker.label)+'. Sa propreté reste comptée.':'Aucun joker avant 10 courses.'} Sans examen, 100 signifie seulement aucun retrait connu. Une décision non qualifiée est indisponible ; un axe sans données vaut 50 (neutre). Real Penalty : DT / Stop & Go non évalués.</p><details class="session-detail"><summary>Détail des courses retenues</summary>${r.window.map(x=>`<div class="audit-row"><b>${esc(x.label)}</b><small>${esc(date(x.date))} · ${x.joker?'Joker sportif':'Retenue'} · Propreté ${Number.isFinite(x.axes.proprete)?x.axes.proprete.toFixed(1)+'/100':'indisponible'}</small><small>${x.conduct.pending?'Décision à qualifier':x.conduct.reviewed?'Examinée : '+esc(x.conduct.reason||''):'Non examinée'}</small></div>`).join('')}</details></section>`;
  }
  function driverImage(ev,driver,drivers){
    const data=ev.data||{},photo=data.driverPhotos?.[driver.id];
    if(typeof photo==='string'&&photo.length<=450000&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(photo))return photo;
    const norm=s=>String(s||'').trim().toLocaleLowerCase('fr'),name=norm(driver.name);
    const matches=(Array.isArray(data.ahEntrants)?data.ahEntrants:[]).filter(e=>e&&norm(e.name)===name),sameName=drivers.filter(d=>d&&norm(d.name)===name);
    const entrant=matches.length===1&&sameName.length<=1&&(!driver.team||!matches[0].team||norm(driver.team)===norm(matches[0].team))?matches[0]:null;
    const model=entrant?.car||driver.model,skin=entrant?.skin||driver.skin;
    const sheet=(Array.isArray(data.carSheets)?data.carSheets:[]).find(c=>c&&c.id===model),local=(Array.isArray(sheet?.liveries)?sheet.liveries:[]).find(l=>l&&l.id===skin)?.image;
    if(typeof local==='string'&&/^assets\/mod-previews\/[0-9a-f]{64}\.(?:jpg|png)$/i.test(local))return '/'+local;
    if(typeof local==='string'&&local.length<=450000&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(local))return local;
    const valid=s=>typeof s==='string'&&s.length>0&&s.length<=128&&s===s.trim()&&!/[\\/\0<>:"|?*]/.test(s)&&!/^\.+$/.test(s)&&!/[. ]$/.test(s);
    const server=data.ahEntrantsServer||data.ahServer;
    return server&&valid(model)&&valid(skin)?'/api/ah-skin-preview?'+new URLSearchParams({server,model,skin}):'';
  }
  function profile(d,r,rows,options){
    const global=!!options.global,back=global?'#global':'#pilots='+encodeURIComponent(options.slug),context=global?'Profil inter-événements':options.eventName;
    const level=r?(global?`Niveau ${r.level} · ${levels[r.level]||''} · ${r.score.toFixed(0)} / 100${r.provisional?' · Provisoire / partiel':''}`:`Niveau ${r.level} / 4 · ${r.score.toFixed(1)} / 100 · indicatif`):'Niveau à déterminer';
    const src=String(options.photo||''),safePhoto=src.length<=450000&&(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)||/^\/assets\/mod-previews\/[0-9a-f]{64}\.(?:jpg|png)$/i.test(src)||/^\/api\/ah-skin-preview\?[A-Za-z0-9%+&=._~-]+$/.test(src));
    const photo=safePhoto?`<img class="profile-photo" data-profile-image src="${esc(src)}" alt="Aperçu de la voiture de ${esc(d.name)}"><p data-image-missing hidden>Aperçu de livrée indisponible.</p>`:'';
    return `<a class="back" href="${back}">← ${global?'Classement global':'Tous les pilotes'}</a><div class="profile-hero"><div class="eyebrow">${esc(context)}</div><h1 class="page-title">${esc(d.name)}</h1><p>${esc(d.team||'Pilote indépendant')}</p><div class="profile-level">${global&&r?levelBadge(r.level,true):''}<span class="pill">${esc(level)}</span></div>${photo}</div>${stats(rows)}${gauges(r,global)}${global&&r?audit(r):''}${portrait(rows,r,global)}${history(rows,global)}`;
  }
  return {eventList,globalList,profile,driverImage,url,globalUrl};
});

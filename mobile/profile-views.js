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
    const propreteNote=global
      ?'<p class="muted"><b>Propreté GLOBAL</b> — examen Commission en priorité (avertissement 5 · légère 10 · importante 20 · grave 35 · DQ de conduite 50 ; attente / place rendue validée : retrait ÷ 2, sauf faute grave, DQ de conduite ou acte volontaire). Sinon détection automatique GDSP : chaque cut +2 (pénalité serveur à partir de 3 cuts en double course / 5 en format 1 h) · choc arrière à fort delta de vitesse avec ≥ 1,5 s perdue pour la victime : retrait = secondes perdues ÷ 2 · côte à côte non comptabilisé. Sauf si la voiture heurtée revenait en piste dangereusement (dans ce cas, faute à elle) : non détectable automatiquement — la Commission tranche à l’examen. Décision non qualifiée : donnée indisponible, jamais convertie.</p>'
      :'<p class="muted"><b>Propreté · détection automatique</b> — choc arrière avec fort delta de vitesse : faute de la voiture arrière (≥ 1,5 s perdue pour la victime → (secondes perdues) ÷ 2 au responsable) ; sauf si la voiture heurtée revenait en piste dangereusement (dans ce cas sa faute — laissé à la Commission, non détectable automatiquement). Touchette &lt; 1,5 s → 0 ; côte à côte non comptabilisée ; cuts : +1 point par cut, le serveur pénalise à partir de 3 cuts en double course / 5 en format 1 h. 100 = aucun incident responsable détecté.</p>';
    return `<section class="panel"><div class="eyebrow">Quatre critères</div><h2>Profil de performance</h2><p class="muted">${global?'Global : rythme, propreté Commission, vitesse et résultats pondérés sur les courses retenues.':'Évaluation indicative de l’événement : rythme, incidents détectés, vitesse et résultats. Le niveau 4 est le plus élevé dans l’événement ; cette échelle est distincte de celle du Global.'}</p>${bars}${propreteNote}</section>`;
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
  const trueskillGuide=`<details class="session-detail"><summary>Comment lire les valeurs TrueSkill</summary><p class="muted">μ (mu) — compétence estimée, recalculée après chaque course admissible dans l’ordre chronologique (départ à 25).<br>σ (sigma) — incertitude sur le niveau : baisse à chaque course, remonte légèrement si une course manque. Petit σ = niveau établi.<br>Indice μ − 3σ — estimation prudente affichée : compétence moyenne moins trois fois l’incertitude. Favorise les pilotes établis sans écraser les progrès des rookies.<br>Courses — RACE réellement prises en compte (coefficient Global &gt; 0, corrections Commission). Minimum 5 pour apparaître, provisoire avant 10.<br>Confiance — élevée si σ ≤ 3, moyenne si σ ≤ 5, faible sinon ; une confiance faible ne veut pas dire pilote faible.<br>Coefficient — β course = 5,5 / √poids : une Cup (0,75) ou un Open (0,5) informent moins qu’un championnat (1), une Fiesta / Trackday (0) est ignorée.<br>Exclusions — DNF non qualifiés, DNS et véhicules de service (Broadcast, Pace Car) exclus ; DQ Commission incluse en bas ; DNF même classé, décisions Commission incluses.<br>L’indice est parallèle au classement officiel : il ne sert à aucune sanction.</p></details>`;
  function trueskillPanel(result){
    if(!result)return '';
    const rows=(result.ratings||[]).slice(0,10);
    if(!rows.length)return `<section class="panel"><details class="session-detail"><summary>Indice TrueSkill — expérimental</summary><p>Indice indisponible pour l’instant : minimum ${5} courses admissibles par pilote. ${result.diagnostics?result.diagnostics.coursesUsed+' course(s) rejouée(s), '+result.diagnostics.coursesSkipped+' ignorée(s).':''} Le classement officiel n’est pas affecté.</p></details></section>`;
    const items=rows.map((r,i)=>`<div class="result-row"><span class="position">${i+1}</span><div class="result-person"><b>${esc(r.name)}</b><small>${r.races} course(s) · confiance ${esc(r.confidence)} · σ ${r.sigma.toFixed(2)}${r.provisional?' · Provisoire':''}</small></div><div class="score"><b>${r.conservative.toFixed(1)}</b><small>μ − 3σ</small></div></div>`).join('');
    const skipped=(result.diagnostics&&result.diagnostics.coursesSkipped)||0;
    return `<section class="panel"><details class="session-detail"><summary>Indice TrueSkill — expérimental (μ − 3σ)</summary><p class="muted">Indicateur parallèle de niveau sur les courses RACE admissibles (coefficients Global &gt; 0, corrections Commission, DNF non qualifiés et DNS exclus, DQ sportives en bas). Il ne remplace pas le classement officiel et ne sert à aucune sanction. β = 5.5 à valider par benchmark · provisoire avant 10 courses.</p>${items}${trueskillGuide}<p class="muted">${result.diagnostics.coursesUsed} course(s) prise(s) en compte · ${skipped} ignorée(s).</p></details></section>`;
  }
  function trueskillPilotPanel(rating,result){
    if(!result||!rating)return '';
    const entry=(result.all||[]).find(x=>x.id===rating.id);
    if(!entry)return `<section class="panel"><h2>Indice TrueSkill — expérimental</h2><p>Pas assez de courses admissibles pour établir l’indice de ce pilote. Le classement officiel n’est pas affecté.</p></section>`;
    const last=entry.history[entry.history.length-1],delta=last?(last.deltaMu>=0?'+':'')+last.deltaMu.toFixed(2):'—';
    return `<section class="panel"><h2>Indice TrueSkill — expérimental</h2><p>μ = ${entry.mu.toFixed(2)} · σ = ${entry.sigma.toFixed(2)} · indice μ − 3σ = <b>${entry.conservative.toFixed(1)}</b> · ${entry.races} course(s) · confiance ${esc(entry.confidence)}${entry.provisional?' · <b>provisoire</b> (&lt; 10 courses)':''}</p><p class="muted">Dernière course : Δμ ${esc(delta)}. Cet indice n’entre pas dans le classement officiel et ne sert à aucune sanction.</p>${trueskillGuide}</section>`;
  }
  function globalList(computed){
    const rows=computed.ratings||[];
    return `<a class="back" href="#home">← Retour à l’accueil</a><div class="eyebrow">Tous événements</div><h1 class="page-title">Classement global</h1><section class="panel"><p>Les pilotes apparaissent après <b>5 courses</b>. Le score combine rythme, propreté Commission, vitesse et résultats, selon les coefficients des événements.</p><p class="muted">Dix dernières courses : dès 10 départs, un joker sportif est retiré des autres critères, mais sa propreté reste comptée. Propreté : examen Commission prioritaire, sinon détection automatique (cuts +2, choc arrière = pertes ÷ 2, côte à côte non compté). Avant 10 courses ou avec des données partielles, le score est provisoire. Real Penalty : DT / Stop & Go non évalués sans journaux.</p></section>${search}<div class="cards">${rows.map((r,i)=>`<a class="event-card" href="${esc(globalUrl(r.id))}" data-driver-item data-search="${searchable(r.name,r.team)}"><span class="position">${i+1}</span>${levelBadge(r.level)}<div class="global-driver-name"><strong>${esc(r.name)}</strong><small>Niveau ${r.level} · ${esc(levels[r.level]||'')} · ${r.count} courses<br>${r.provisional?'Provisoire / partiel':'Confirmé'} · ${r.conductReviewed}/${r.windowCount} examens propreté</small></div><span class="global-score">${r.score.toFixed(0)}<small>/ 100</small></span></a>`).join('')||'<section class="panel">Pas encore assez de données : 5 courses minimum par pilote.</section>'}</div>${trueskillPanel(computed.trueskill)}`;
  }
  function audit(r){
    return `<section class="panel"><h2>Comment le score est calculé</h2><p>${r.sportingProvisional?'Provisoire':'10 courses atteintes'} · ${r.retainedCount}/${r.windowCount} retenues · propreté Commission ${r.conductReviewed}/${r.windowCount} · détection auto ${r.conductAuto||0}/${r.windowCount}${r.conductPending?' · '+r.conductPending+' décision(s) à qualifier':''}.</p><p class="muted">${r.joker?'Joker sportif : '+esc(r.joker.label)+'. Sa propreté reste comptée.':'Aucun joker avant 10 courses.'} Propreté : examen Commission en priorité ; sinon détection automatique (cuts +2, choc arrière = pertes ÷ 2, côte à côte non compté). Une décision non qualifiée est indisponible ; un axe sans données vaut 50 (neutre). Real Penalty : DT / Stop & Go non évalués.</p><details class="session-detail"><summary>Détail des courses retenues</summary>${r.window.map(x=>`<div class="audit-row"><b>${esc(x.label)}</b><small>${esc(date(x.date))} · ${x.joker?'Joker sportif':'Retenue'} · Propreté ${Number.isFinite(x.axes.proprete)?x.axes.proprete.toFixed(1)+'/100':'indisponible'}</small><small>${x.conduct.pending?'Décision à qualifier':x.conduct.reviewed?'Examinée : '+esc(x.conduct.reason||''):x.conduct.auto?'Détection auto'+(x.conduct.cuts?' · '+x.conduct.cuts+' cut(s)':'')+(x.conduct.incidents?' · '+x.conduct.incidents+' choc(s)':''):'Détection auto (100)'}</small></div>`).join('')}</details></section>`;
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
    const trueskill=global&&options.trueskill?trueskillPilotPanel(r,options.trueskill):'';
    return `<a class="back" href="${back}">← ${global?'Classement global':'Tous les pilotes'}</a><div class="profile-hero"><div class="eyebrow">${esc(context)}</div><h1 class="page-title">${esc(d.name)}</h1><p>${esc(d.team||'Pilote indépendant')}</p><div class="profile-level">${global&&r?levelBadge(r.level,true):''}<span class="pill">${esc(level)}</span></div>${photo}</div>${stats(rows)}${gauges(r,global)}${global&&r?audit(r):''}${trueskill}${portrait(rows,r,global)}${history(rows,global)}`;
  }
  return {eventList,globalList,profile,driverImage,url,globalUrl};
});

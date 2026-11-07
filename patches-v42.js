/* GDSP v42 — distingue DNF / DNS / DQ.
 *  - DNF (abandon en course) : garde le(s) point(s) de pole (×2 sur manches d'1h),
 *    pas de points de place. Classé entre les finishers et les DQ/DNS.
 *  - DNS (absent/non-partant) : aucun point, marqué "DNS".
 *  - DQ (drapeau noir / faute) : aucun point, marqué "DQ".
 * À charger APRÈS patches-v41.js.
 */
(function(){
  'use strict';
  if(window.__GDSP_V42)return; window.__GDSP_V42=true;

  // ---- Élargir addAdjustment pour accepter dns:true ----
  const _addAdjustment_v42=window.addAdjustment;
  window.addAdjustment=function(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note,opts){
    opts=opts||{};
    if(opts.dnf||opts.dns){
      penMap[`${roundKey}:${sessionIdx}:${drvId}`]={
        timeAdd:0,dq:false,warning:false,
        dnf:!!opts.dnf,dns:!!opts.dns,
        note:note||(opts.dnf?'Abandon':'Absent')
      };
    }else{
      _addAdjustment_v42(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note,opts);
    }
    saveState();render();
  };

  // ---- Élargir applyCommissionToArr pour gérer dns ----
  const _applyCommission_v42=window.applyCommissionToArr;
  window.applyCommissionToArr=function(arr,sess,rIdx,sIdx){
    _applyCommission_v42(arr,sess,rIdx,sIdx);
    const rk=(rIdx>=0&&sIdx>=0)?(rIdx+':'+sIdx+':'):null;
    for(const k in penMap){
      if(rk&&!k.startsWith(rk))continue;
      const c1=k.indexOf(':');if(c1<0)continue;
      const c2=k.indexOf(':',c1+1);if(c2<0)continue;
      const rj=+k.slice(0,c1),sj=+k.slice(c1+1,c2),did=k.slice(c2+1);
      if(rk&&(rj!==rIdx||sj!==sIdx))continue;
      const adj=penMap[k];if(!adj)continue;
      const y=arr.find(x=>x.id===did);if(!y)continue;
      if(adj.dns){
        y.comDNS=true;y.comDNF=false;y.comDQ=false;y.comTimeAdd=0;y.comWarning=false;
      }else if(adj.dnf){
        y.comDNF=true;y.comDNS=false;y.comDQ=false;y.comTimeAdd=0;y.comWarning=false;
      }
    }
    return arr;
  };

  // ---- Trier correctement : finishers → DNF (par tours décroissants) → DNS / DQ ----
  const _sortSession_v42=window.sortSession;
  window.sortSession=function(sess){
    if(!sess)return [];
    // Appel à la v41 qui a déjà marqué comDNF ; mais elle traitait DNF comme finalDQ.
    // On surcharge ensuite :
    const [rIdx,sIdx]=findSessionIdx(sess);
    let arr=sess.results.map(x=>{
      let y={...x};
      let base=Number.isFinite(y.time)?y.time:10**18;
      let ns=Number(y.penaltyTime)||0;
      let et=base+ns/1e6;
      if(y.lapPenalty)et=10**18;
      if(Number.isFinite(y.efftime))et=y.efftime;
      y._eff=et;return y;
    });
    applyCommissionToArr(arr,sess,rIdx,sIdx);
    function isDQ(x){return !!(x.disqualified||x.comDQ||x.comDNS)}
    function isDNF(x){return !!x.comDNF && !isDQ(x)}
    arr.forEach(x=>{
      x._t=x._eff+(x.comTimeAdd||0);
      x._dq=false;          // par défaut pas déclassé
      x.finalDQ=false;
      // Pénalité DQ/DNS → temps infini + marqué finalDQ
      if(isDQ(x)){
        x._t=10**18;x._dq=true;x.finalDQ=true;
      }
      // DNF (abandon en course) : temps infini MAIS finalDQ=false → peut toucher la pole.
      // On met hasPenalty=true pour qu'il ne récupère PAS le bonus "pas de pénalité" du mérite.
      else if(isDNF(x)){
        x._t=10**18;x._dq=false;x.finalDQ=false;x.hasPenalty=true;
      }
      if(x.comDNS){x.hasPenalty=true}
      x.finalTime=x._t;
    });
    if(sess.type==='QUALIFY'){
      arr.sort((a,b)=>{
        const ab=Number.isFinite(a.best)&&a.best>0?a.best:10**18;
        const bb=Number.isFinite(b.best)&&b.best>0?b.best:10**18;
        return ab-bb;
      });return arr;
    }
    // Tri : finishers d'abord, puis DNF (tours décroissants), puis DQ/DNS (tours décroissants)
    function cls(x){
      if(x._dq)return 2;           // DQ/DNS
      if(isDNF(x))return 1;        // DNF
      return 0;                    // finisher
    }
    arr.sort((a,b)=>cls(a)-cls(b)||b.laps-a.laps||a._t-b._t);
    return arr;
  };

  // ---- Wrapper calculate() pour ajouter le(s) point(s) de pole aux DNF ----
  const _calculate_v42=window.calculate;
  window.calculate=function(){
    const ds=_calculate_v42();
    const cfg=pointsConfig();
    const polePts=cfg.polePoints||0;
    const doubleLong=cfg.doubleLongRaces!==false;
    const rs=rounds();
    for(let j=0;j<rs.length;j++){
      const r=rs[j];
      const races=r.sessions.filter(s=>s.type==='RACE');
      const mult=races.length===1&&doubleLong?2:1;
      for(const race of races){
        // La course a été triée par sortSession → race.results est dans l'ordre final.
        // Trouver le DNF en pole (grid===1, comDNF=true, pas comDQ/comDNS)
        const poleDNF=race.results.find(p=>p.grid===1&&p.comDNF&&!p.comDQ&&!p.comDNS);
        if(poleDNF){
          const d=ds.find(x=>x.id===poleDNF.id);
          if(d&&typeof d.rounds[j]==='number'){
            d.rounds[j]+=polePts*mult;
            d.total+=polePts*mult;
          }
        }
      }
    }
    // Recalculer total (joker+total)
    ds.forEach(d=>{
      const jokerCount=cfg.jokerCount||0;
      const jokerRounds=jokerCount>0?[...d.rounds].sort((a,b)=>b-a).slice(0,jokerCount):d.rounds;
      d.joker=jokerRounds.reduce((a,b)=>a+b,0);
      // total dépend de l'onglet ; on ne met à jour que eventTotal
      d.eventTotal=d.rounds.reduce((a,b)=>a+b,0);
    });
    return ds;
  };

  // ---- openAdjForm : ajouter le choix DNS ----
  window.openAdjForm=function(rj,sj,did){
    const choix=prompt(
      "Type d'ajustement :\n"+
      "  1 = Pénalité de temps (ex: +10, -5, +120s, etc.)\n"+
      "  2 = Abandon en course (DNF) — conserve le point de pole\n"+
      "  3 = Absent / Non-partant (DNS) — aucun point\n"+
      "  4 = Disqualification (DQ — drapeau noir)\n"+
      "  5 = Avertissement sans sanction\n"+
      "  0 = Annuler",
      '1');
    if(choix===null)return;
    const c=choix.trim();
    if(c==='0'||c==='')return;
    if(c==='2'){
      if(!confirm("Marquer en ABANDON (DNF) ? Le pilote ne marque pas de point de place mais conserve son point de pole s'il était en pole."))return;
      const note=prompt('Note / motif d\'abandon ?','')||'Abandon';
      addAdjustment(rj,sj,did,0,false,false,note,{dnf:true});return;
    }
    if(c==='3'){
      if(!confirm("Marquer ABSENT / NON-PARTANT (DNS) ? Aucun point (y compris la pole)."))return;
      const note=prompt('Note / motif ?','')||'Absent';
      addAdjustment(rj,sj,did,0,false,false,note,{dns:true});return;
    }
    if(c==='4'){
      if(!confirm('DQ (drapeau noir — disqualification, aucun point) ?'))return;
      const note=prompt('Note / motif ?','')||'';
      addAdjustment(rj,sj,did,0,true,false,note);return;
    }
    if(c==='5'){
      if(!confirm("Avertissement sans sanction (pas de déclassement) ?"))return;
      addAdjustment(rj,sj,did,0,false,true,'');return;
    }
    const ta=prompt("Ajustement temps en secondes (exemples : +10, -5, +120 pour 2 min, etc.) ?",'0');
    if(ta===null)return;
    const timeAdd=+ta||0;
    const note=prompt('Note / motif ?','')||'';
    addAdjustment(rj,sj,did,timeAdd,false,false,note);
  };

  // ---- Affichage "DNF"/"DNS"/"DQ" dans les tableaux ----
  function labelStatuses(){
    if(page!=='manches')return;
    const rs=rounds();const r=rs[round];if(!r)return;
    const s=r.sessions[sessionIndex];if(!s||s.type!=='RACE')return;
    const sorted=sortSession(s);
    const cells=document.querySelectorAll('.table-wrap tbody tr');
    cells.forEach(tr=>{
      const tds=tr.querySelectorAll('td');
      if(tds.length<5)return;
      const nameCell=tds[1];if(!nameCell)return;
      const nameText=(nameCell.textContent||'').trim();
      const p=sorted.find(x=>(x.name||'').trim()===nameText);
      if(!p)return;
      const last=tds[tds.length-1];const prev=tds[tds.length-2];
      if(p.comDNS){
        last.innerHTML='<span style="color:#888;font-weight:700">DNS</span>';
        if(prev)prev.textContent='—';
      }else if(p.comDNF){
        last.innerHTML='<span style="color:#c98306;font-weight:700">DNF</span>';
        if(prev)prev.textContent='—';
      }else if(p.comDQ||p.disqualified){
        last.innerHTML='<span style="color:#9c3021;font-weight:700">DQ</span>';
        if(prev)prev.textContent='—';
      }
    });
  }

  // ---- Affichage dans la table des ajustements ----
  function fixAdjLabels(){
    document.querySelectorAll('.panel table tbody tr').forEach(tr=>{
      const cells=tr.querySelectorAll('td');
      if(cells.length<6)return;
      const btn=tr.querySelector('button[onclick^="removeAdjustment"]');
      if(!btn)return;
      const m=btn.getAttribute('onclick').match(/removeAdjustment\('([^']+)'\)/);
      if(!m)return;const key=m[1];
      const adj=penMap[key];if(!adj)return;
      const labelCell=cells[3];if(!labelCell)return;
      if(adj.dns)labelCell.innerHTML='<span style="color:#888;font-weight:700">DNS</span>';
      else if(adj.dnf)labelCell.innerHTML='<span style="color:#c98306;font-weight:700">DNF</span>';
      else if(adj.dq)labelCell.innerHTML='<span style="color:#9c3021;font-weight:700">DQ</span>';
    });
  }

  // Enchaîner les post-render (après les wrappers v40/v41)
  const _render42=window.render;
  window.render=function(){_render42();setTimeout(()=>{labelStatuses();fixAdjLabels()},0)};

  // ============================================================
  //  Race consistency (Régularité) — nouvelle formule
  //  « Based on best lap minus average non-best. Pit laps, first lap
  //    and laps slower than 21 seconds are ignored. »
  //  Concrètement :
  //    1. Prendre tous les tours valides (time>0 et time<600000) d'un pilote sur la course
  //    2. Exclure : 1er tour, tours « pits » (>21s au-dessus du meilleur tour du pilote)
  //    3. Prendre le meilleur tour (best) du pilote dans cet ensemble
  //    4. Sur les tours RESTANTS (non-best), calculer la moyenne des écarts à best :
  //       consistency = moyenne( tour_time - best )   pour les tours valides non-best
  //    Plus cette valeur est petite, plus le pilote est régulier.
  //    Pit laps = détectés comme étant > 21s plus lent que best (formule iRacing).
  // ============================================================

  function raceConsistencyMs(lapsRaw){
    // lapsRaw = tableau de tours {time} en ms, dans l'ordre chronologique.
    // 1. Filtrer les temps valides, conserver l'ordre
    const all=(lapsRaw||[]).map(l=>Number(l&&l.time)).filter(t=>Number.isFinite(t)&&t>0&&t<600000);
    if(all.length<2)return null;
    // 2. Exclure le premier tour
    const rest=all.slice(1);
    if(rest.length<2)return null;
    // 3. Meilleur tour du pilote (sur rest, car le premier tour est exclu)
    const best=Math.min(...rest);
    if(!Number.isFinite(best)||best<=0)return null;
    // 4. Exclure les « pit laps » : tours > best + 21s (21 000 ms)
    const PIT_SLOW_MS=21*1000;
    const nonPit=rest.filter(t=>t-best<=PIT_SLOW_MS);
    if(nonPit.length<2)return null;
    // best peut avoir changé si on a éliminé un tour, recalculer
    const best2=Math.min(...nonPit);
    // 5. Moyenne des écarts à best, EXCLUANT le tour best lui-même
    const nonBest=nonPit.filter(t=>t>best2);
    if(nonBest.length===0)return 0; // tous les tours = best (improbable) → régularité parfaite
    const avgGap=nonBest.reduce((a,t)=>a+(t-best2),0)/nonBest.length;
    return avgGap; // en millisecondes
  }

  // ---- Remplacer la régularité dans globalPerformanceRatings() ----
  const _origGlobalPerf=window.globalPerformanceRatings;
  window.globalPerformanceRatings=function(){
    // On exécute la fonction originale, puis on recalcule les entrées nous-mêmes
    // et on remplace les régularités. Plus propre que dupliquer tout le code.
    // Stratégie : on re-exécute le travail en remplaçant le calcul de 'sd'.
    // Pour éviter de dupliquer, on monkey-patch le push sur entries dans la closure…
    // Plus simple : surcharger la fonction en entier via un copier/coller adapté.
    return globalPerfPatched();
  };

  function globalPerfPatched(){
    // Copie adaptée de globalPerformanceRatings() avec la nouvelle formule.
    const allRaces=[];
    const idName=new Map(),idTeam=new Map();
    for(const ev of events){
      const d=ev.data||{};
      const sessions=Array.isArray(d.sessions)?d.sessions:[];
      const races=sessions.filter(s=>s&&s.type==='RACE');
      for(const s of races){
        const ts=new Date(s.date).getTime();
        if(!isFinite(ts))continue;
        const lapsById={};
        (s.laps||[]).forEach(l=>{if(!l||!l.id)return;if(!lapsById[l.id])lapsById[l.id]=[];lapsById[l.id].push(l)});
        const collById={};
        (s.events||[]).forEach(e=>{
          if(!e||e.type!=='COLLISION_WITH_CAR')return;
          if(e.aid){collById[e.aid]=(collById[e.aid]||0)+1}
          if(e.bid){collById[e.bid]=(collById[e.bid]||0)+1}
        });
        const entries=[];
        (s.results||[]).forEach((r,i)=>{
          if(!r||!r.id)return;
          idName.set(r.id,r.name);idTeam.set(r.id,r.team||'');
          const myLaps=(lapsById[r.id]||[]).filter(l=>Number.isFinite(l.time)&&l.time>0&&l.time<600000);
          // NOUVELLE formule : cohérence de course
          const consistency=raceConsistencyMs(myLaps);
          const cuts=myLaps.reduce((n,l)=>n+(Number.isFinite(l.cuts)?Math.max(0,l.cuts):0),0);
          entries.push({
            id:r.id,name:r.name,pos:i+1,
            grid:(typeof r.grid==='number'&&r.grid>0)?r.grid:null,
            consistency,
            collisions:collById[r.id]||0,cuts,
            best:Number.isFinite(r.best)&&r.best>0?r.best:null
          });
        });
        if(entries.length>=3)allRaces.push({ts,entries});
      }
    }
    if(allRaces.length===0)return [];
    const now=Date.now();const HALF_LIFE=90*24*3600*1000;
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
    for(const rc of allRaces){
      const weight=Math.exp(-(now-rc.ts)/HALF_LIFE);
      const pcons=pct(rc.entries,'consistency',true); // +petit = mieux
      const pcln=pct(rc.entries.map(e=>({...e,clean:(e.collisions*3)+e.cuts})),'clean',true);
      const pspd=pct(rc.entries,'best',true); // best +petit = mieux
      const pres=pct(rc.entries,'pos',true);  // pos +petit = mieux
      rc.entries.forEach((e,i)=>{
        if(!pilot.has(e.id))pilot.set(e.id,{id:e.id,sumW:0,ax:{regularite:0,proprete:0,vitesse:0,resultats:0},positions:[],ts:[]});
        const p=pilot.get(e.id);
        const vals={regularite:pcons[i],proprete:pcln[i],vitesse:pspd[i],resultats:pres[i]};
        for(const k in vals){const v=vals[k]; if(Number.isFinite(v)){p.ax[k]+=v*weight;}}
        p.sumW+=weight;
        p.positions.push(e.pos);p.ts.push(rc.ts);
      });
    }
    const out=[];const GLOBAL_MIN_RACES=(window.GLOBAL_MIN_RACES??5);
    const globalHidden=(window.globalHidden||{});
    for(const [id,p]of pilot){
      if(p.sumW<=0)continue;
      const det={};for(const k in p.ax)det[k]=p.ax[k]/p.sumW;
      let prog=null;
      if(p.ts.length>=3){
        const idx=p.ts.map((t,i)=>({t,pos:p.positions[i]})).sort((a,b)=>a.t-b.t);
        const n=idx.length;const meanT=idx.reduce((a,x)=>a+x.t,0)/n;const meanP=idx.reduce((a,x)=>a+x.pos,0)/n;
        let num=0,den=0;
        idx.forEach(x=>{num+=(x.t-meanT)*(x.pos-meanP);den+=(x.t-meanT)**2});
        if(den>0){const slope=num/den;prog=-slope*30*24*3600*1000;}
      }
      p.prog=prog;p.races=p.ts.length;p.det=det;out.push(p);
    }
    const progVals=out.filter(x=>Number.isFinite(x.prog)).map(x=>x.prog);
    if(progVals.length>=2){
      out.forEach(p=>{
        if(!Number.isFinite(p.prog)){p.det.progression=50;return}
        const better=progVals.filter(v=>v>p.prog).length;const equal=progVals.filter(v=>v===p.prog).length;
        p.det.progression=100*(1-(better+(equal-1)/2)/(progVals.length-1));
      });
    }else{out.forEach(p=>p.det.progression=50)}
    const final=out.filter(p=>p.races>=GLOBAL_MIN_RACES && !globalHidden[p.id]).map(p=>{
      const ax=p.det;const score=(ax.regularite+ax.proprete+ax.vitesse+ax.resultats+ax.progression)/5;
      return {id:p.id,name:idName.get(p.id)||'?',team:idTeam.get(p.id)||'',score,details:ax,count:p.races,trend:p.prog||0};
    }).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
    const n=final.length;final.forEach((p,i)=>{const q=i/n;p.level=q<0.25?1:q<0.5?2:q<0.75?3:4;});
    return final;
  }

  // ---- Corriger le libellé d'explication sur la page GLOBAL ----
  const _global42=window.global;
  window.global=function(){
    let html=_global42();
    html=html.replace(
      /régularité des tours[^<]*<\/b>/i,
      'régularité de course (écart moyen au meilleur tour, 1<sup>er</sup> tour et tours aux stands exclus)</b>'
    );
    return html;
  };

  // ---- Corriger le calcul de régularité dans les fiches pilote event/open ----
  // Colonnes "σ" dans le tableau des courses d'un pilote (page event pilote)
  // et dans performanceRatings() (évaluation de performance intra-event).
  // On surcharge performanceRatings() avec la même formule.
  function perfRatingsPatched(){
    const pilots=new Map();
    const pct=(arr,id,key,lower=true)=>{
      let eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);
      if(!item||eligible.length<2)return null;
      let better=eligible.filter(x=>lower?x[key]<item[key]:x[key]>item[key]).length,
          equal=eligible.filter(x=>x[key]===item[key]).length;
      return 100*(1-(better+(equal-1)/2)/(eligible.length-1));
    };
    for(let race of sessions.filter(s=>s.type==='RACE')){
      let entries=race.results.map((r)=>{
        let laps=(race.laps||[]).filter(l=>l.id===r.id&&Number.isFinite(l.time)&&l.time>0&&l.time<600000);
        // NOUVELLE formule
        const consistency=raceConsistencyMs(laps);
        let name=(r.name||'').trim().toLowerCase();
        let collisions=(race.events||[]).filter(e=>[e.a,e.b].some(v=>String(v||'').trim().toLowerCase()===name)).length;
        let cuts=laps.reduce((n,l)=>n+(Number.isFinite(l.cuts)?Math.max(0,l.cuts):0),0);
        return {id:r.id,regularity:consistency,cleanliness:collisions+cuts,
                speed:Number.isFinite(r.best)&&r.best>0&&r.best<600000?r.best:null,
                result:race.results.indexOf(r)+1};
      });
      for(let e of entries){
        let v={regularite:pct(entries,e.id,'regularity'),proprete:pct(entries,e.id,'cleanliness'),
               vitesse:pct(entries,e.id,'speed'),resultats:pct(entries,e.id,'result')};
        if(Object.values(v).some(x=>x===null))continue;
        if(!pilots.has(e.id))pilots.set(e.id,[]);
        pilots.get(e.id).push(v);
      }
    }
    let out=[];
    for(let [id,items]of pilots){
      if(items.length<2)continue;
      let average=key=>items.reduce((a,x)=>a+x[key],0)/items.length,
          details={regularite:average('regularite'),proprete:average('proprete'),vitesse:average('vitesse'),resultats:average('resultats')},
          score=Object.values(details).reduce((a,b)=>a+b,0)/4;
      out.push({id,score,details,count:items.length});
    }
    out.sort((a,b)=>b.score-a.score);
    for(let i=0;i<out.length;i++){let rank=out.findIndex(x=>Math.abs(x.score-out[i].score)<1e-9);out[i].level=4-Math.min(3,Math.floor(rank*4/out.length));}
    return out;
  }
  window.performanceRatings=perfRatingsPatched;

  // ---- Corriger la colonne "σ" (écart-type) dans les tableaux fiche pilote ----
  // Remplacer l'affichage sd/1000 par notre nouvel écart moyen (en secondes).
  // On ne pousse pas jusque dans le HTML rendu (c'est complexe de patcher après),
  // mais on corrige le calcul en amont : on surcharge la fonction de rendu fiche pilote
  // en remplaçant le `sd/1000` (écart-type en s) par `consistency/1000` (gap moyen en s).
  // Pour rester simple, on surcharge fmt et on modifie le DOM après render…
  // Plus propre : on remplace la portion de rendu de la table de tours via un post-traitement.
  // On va utiliser un MutationObserver simple qui cible la colonne σ dans les tables pilotes.
  function recomputeDriverTableSigmas(){
    // Trouve les tableaux contenant une colonne "σ" et recalcul les valeurs
    document.querySelectorAll('table').forEach(tbl=>{
      const headerCells=tbl.querySelectorAll('thead th,tr:first-child td');
      let sigmaCol=-1;
      headerCells.forEach((th,i)=>{if(th.textContent.trim()==='σ')sigmaCol=i;});
      if(sigmaCol<0)return;
      const rows=tbl.querySelectorAll('tr');
      rows.forEach((row,ri)=>{
        if(ri===0)return; // header
        const cells=row.querySelectorAll('td');
        if(cells.length<=sigmaCol)return;
        // Chercher le driverId via le onclick ou le data-pid du parent
        // Plus direct : on récupère le pilote courant via globalDriverId/driverId/did
        // (ces variables sont portées par la page qui nous a rendus).
      });
    });
  }
  // Plus simple : patcher les fonctions qui calculent le sd affiché en surchargeant
  // la formule dans la closure. On va repatcher via la méthode utilisée : dans la
  // fonction piloteEvent du site.js (ligne ~930) et gpilote (ligne ~1538) le sd
  // est calculé localement. On utilise un Proxy sur console pour intercepter, non…
  // Le plus propre : après render(), parcourir les tables et recalculer depuis laps[].
  function patchSigmaColumn(){
    if(typeof driverId==='undefined'&&typeof globalDriverId==='undefined')return;
    // Les tables de tours par course sont rendues dans la page du pilote.
    // On va recalculer à partir des données de sessions.
    const id=(typeof driverId!=='undefined'?driverId:globalDriverId);
    document.querySelectorAll('table').forEach(tbl=>{
      const rows=[...tbl.querySelectorAll('tr')];
      if(rows.length<2)return;
      const hdr=rows[0].textContent||'';
      if(!/σ/.test(hdr))return;
      const sigmaIdx=[...rows[0].querySelectorAll('th,td')].findIndex(td=>/σ/.test(td.textContent));
      if(sigmaIdx<0)return;
      // Pour chaque ligne après l'entête, mapper à la session correspondante
      const raceList=(typeof sessions!=='undefined')?sessions.filter(s=>s&&s.type==='RACE'):[];
      for(let ri=1;ri<rows.length;ri++){
        const s=raceList[ri-1];if(!s)break;
        const myLaps=(s.laps||[]).filter(l=>l.id===id&&Number.isFinite(l.time)&&l.time>0&&l.time<600000);
        const c=raceConsistencyMs(myLaps);
        const cell=rows[ri].querySelectorAll('td')[sigmaIdx];
        if(cell){cell.textContent=(c!=null)?(c/1000).toFixed(2)+' s':'—';}
      }
    });
  }
  const _render42c=window.render;
  window.render=function(){
    const r=_render42c.apply(this,arguments);
    setTimeout(patchSigmaColumn,0);
    return r;
  };

  console.log('[GDSP v42b] DNF/DNS/DQ + Race consistency (best-minus-avg, pits/T1 exclus).');
})();

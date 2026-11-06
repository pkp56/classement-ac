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

  console.log('[GDSP v42] DNF (garde la pole) / DNS / DQ séparés.');
})();

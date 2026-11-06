/* GDSP v40 — correctifs pénalités et classement.
 * À charger APRÈS site.js : remplace 3 fonctions critiques pour :
 *  1. Tri déterministe des sessions (QUALIFY avant RACE, ordre ISO stable par date)
 *     → les indices de manche/session ne changent plus à chaque render, donc les
 *     pénalités enregistrées dans penMap s'appliquent à la bonne session.
 *  2. applyCommissionToArr : split de clé résistant aux ':' dans les id pilotes.
 *  3. sortSession : propage finalTime/finalDQ sur les clones (pour la cohérence
 *     avec finishStatus et le calcul des points).
 *  4. openAdj force adminTab='adjust' systématiquement.
 */
(function(){
  'use strict';

  // Ne patcher qu'une seule fois (idempotent au reload)
  if(window.__GDSP_V40)return; window.__GDSP_V40=true;

  // ---- 1. rounds() déterministe ----
  window.rounds = function(){
    let m={};
    sessions.filter(s=>s&&s.date).forEach(s=>{
      const d=String(s.date).slice(0,10);
      if(!m[d])m[d]=[];
      m[d].push(s);
    });
    return Object.entries(m).sort().map(([d,arr],i)=>{
      // QUALIFY en premier, puis RACE dans l'ordre de date ISO ; PRACTICE en dernier
      arr.sort((a,b)=>{
        const o={QUALIFY:0,RACE:1,PRACTICE:2};
        const ta=o[a.type]??9, tb=o[b.type]??9;
        if(ta!==tb)return ta-tb;
        return String(a.date).localeCompare(String(b.date));
      });
      return {date:d,sessions:arr,track:arr[0].track,number:i+1};
    });
  };

  // ---- 2. applyCommissionToArr : split de clé propre ----
  window.applyCommissionToArr = function(arr,sess,rIdx,sIdx){
    arr.forEach(y=>{y.comTimeAdd=0;y.comDQ=false;y.comWarning=false});
    const rk=(rIdx>=0&&sIdx>=0)?(rIdx+':'+sIdx+':'):null;
    for(const k in penMap){
      if(rk&&!k.startsWith(rk))continue;
      // La clé est de la forme "rj:sj:driverId" ; driverId peut contenir ':' → split sur les
      // deux premiers ':' uniquement.
      const c1=k.indexOf(':'); if(c1<0)continue;
      const c2=k.indexOf(':',c1+1); if(c2<0)continue;
      const rj=+k.slice(0,c1), sj=+k.slice(c1+1,c2), did=k.slice(c2+1);
      if(rk&&(rj!==rIdx||sj!==sIdx))continue;
      const rs2=rounds();
      if(!rk){const r=rs2[rj];if(!r||r.sessions[sj]!==sess)continue}
      const y=arr.find(x=>x.id===did);if(!y)continue;
      const adj=penMap[k];
      if(adj.dq){y.comDQ=true}
      else if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0){
        y.comTimeAdd=(y.comTimeAdd||0)+adj.timeAdd*1000;
      }
      if(adj.warning){y.comWarning=true}
    }
    return arr;
  };

  // ---- 3. sortSession : calque finalTime/finalDQ sur les CLONES après application
  //         des pénalités, de sorte que finishStatus/raceTime voient bien le temps
  //         pénalisé et que les points sont attribués dans le bon ordre.
  window.sortSession = function(sess){
    if(!sess)return [];
    const [rIdx,sIdx]=findSessionIdx(sess);
    let arr=sess.results.map(x=>{
      let y={...x};
      let base=Number.isFinite(y.time)?y.time:10**18;
      let ns=Number(y.penaltyTime)||0;
      let et=base+ns/1e6;
      if(y.lapPenalty)et=10**18;
      if(Number.isFinite(y.efftime))et=y.efftime;
      y._eff=et;
      return y;
    });
    applyCommissionToArr(arr,sess,rIdx,sIdx);
    function isDQ(x){return !!(x.disqualified||x.comDQ||x.lapPenalty)}
    arr.forEach(x=>{
      x._t=x._eff+(x.comTimeAdd||0);
      x._dq=isDQ(x);
      // Important : mettre à jour finalTime/finalDQ sur les clones avec les valeurs
      // pénalisées — finishStatus() et raceTime() lisent ces champs.
      x.finalTime=x._t;
      x.finalDQ=x._dq;
    });
    if(sess.type==='QUALIFY'){
      arr.sort((a,b)=>{
        const ab=Number.isFinite(a.best)&&a.best>0?a.best:10**18;
        const bb=Number.isFinite(b.best)&&b.best>0?b.best:10**18;
        return ab-bb;
      });
      return arr;
    }
    arr.sort((a,b)=>(a._dq?1:0)-(b._dq?1:0)||b.laps-a.laps||a._t-b._t);
    return arr;
  };

  // ---- 4. openAdj force adminTab ----
  window.openAdj=function(ri){selectedRaceAdj=ri;adminTab='adjust';render()};

  // ---- 5. Corriger le compteur "course(s)" dans les cartes manches
  //         (le code faisait r.sessions.length-1, ce qui donnait 0 pour les manches
  //          sans qualif : Riverside / Sebring). On remplace le texte en post-render
  //          en comptant réellement les sessions RACE et QUALIFY depuis rounds().
  function fixRaceCountBadges(){
    const rs=(typeof rounds==='function')?rounds():[];
    document.querySelectorAll('.admin-round').forEach(card=>{
      const btn=card.querySelector('button[onclick^="openAdj("]');
      if(!btn)return;
      const m=btn.getAttribute('onclick').match(/openAdj\((\d+)\)/);
      if(!m)return;
      const idx=+m[1];
      const r=rs[idx];if(!r)return;
      const races=r.sessions.filter(s=>s.type==='RACE').length;
      const quals=r.sessions.filter(s=>s.type==='QUALIFY').length;
      const info=quals?`${races} course(s) · ${quals} qualif`:`${races} course(s)`;
      const muted=card.querySelector('.muted');
      if(muted){
        // Première partie avant "·" = date (on la garde)
        const datePart=muted.textContent.split('·')[0].trim();
        muted.textContent=datePart+' · '+info;
      }
    });
  }
  const _render=window.render;
  if(_render){window.render=function(){_render();setTimeout(fixRaceCountBadges,0)}}

  console.log('[GDSP v40] correctifs chargés (pénalités multi-manches).');
})();

/* patches-v45.js — v60
 * - Rétablit openAdjForm multi-choix (Pénal./DNF<75%/DNS/DQ/Avertissement)
 * - Règle 75% classante : DNF ≥ 75% des tours marque les points de sa position,
 *   placé DERRIÈRE le dernier finisher.
 *   Critère finisher AC = T final >= temps final du vainqueur (chrono allumé
 *   jusqu'au drapeau). DNF = T final < winnerTime (chrono coupé avant checkered).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  const MIN_PCT=0.75;

  // Ré-applique les penMap sur la session EN COURS (puisque calculate() ne
  // lit que comDQ/comTimeAdd et ignore comDNF/comDNS/dns).
  function applyPenMap(){
    if(typeof penMap!=='object'||typeof rounds!=='function')return;
    const rs=rounds();
    rs.forEach((rd,rj)=>{
      rd.sessions.forEach((s,sj)=>{
        if(!s||!Array.isArray(s.results))return;
        s.results.forEach(r=>{
          if(!r)return;
          // Les valeurs comDNF/comDNS ne sont pas reset par site.js
          // (contrairement à comDQ/comTimeAdd/comWarning). On reset nous-même.
          r.comDNF=false;r.comDNS=false;
        });
      });
    });
    for(const k in penMap){
      const [rj,sj,did]=k.split(':');const adj=penMap[k];
      if(!adj)continue;
      const ri=+rj,si=+sj;
      const rd=rs[ri];if(!rd)continue;
      const s=rd.sessions[si];if(!s||!Array.isArray(s.results))continue;
      const drv=s.results.find(x=>x.id===did);if(!drv)continue;
      if(adj.dnf){drv.comDNF=true;}
      if(adj.dns){drv.comDNS=true;}
    }
  }

  // Marque automatiquement NC-DNF pour < 75% (pas de penMap dnf nécessaire).
  function autoNC_DNF(){
    if(typeof sessions==='undefined'||!Array.isArray(sessions))return;
    sessions.forEach(race=>{
      if(race.type!=='RACE'||!Array.isArray(race.results))return;
      const wl=Math.max(0,...race.results.map(r=>(r&&r.laps)||0));
      const ml=Math.ceil(wl*MIN_PCT);
      race.results.forEach(r=>{
        if(!r)return;
        // Ne surcharge pas un comDNF manuel
        if(!r.comDNF && (r.laps||0)>0 && (r.laps||0)<ml)r.comDNF=true;
      });
    });
  }

  function prepSessionBeforeSort(){
    applyPenMap();autoNC_DNF();
  }

  // Reclassement après sortForResults v42.
  function reclassify(arr){
    if(!arr||!arr.length)return arr;
    let wl=0,wt=1e18;
    for(const x of arr){
      if(x._dq||x.comDNS||x._t>=1e18)continue;
      const L=x.laps||0,T=x._t;
      if(L>wl||(L===wl&&T<wt)){wl=L;wt=T;}
    }
    if(wl===0||wt>=1e18)return arr;
    const ml=Math.ceil(wl*MIN_PCT);
    const fin=[],cls=[],nc=[],bak=[];
    for(const x of arr){
      if(x._dq||x.comDNS||(x.laps||0)<=0){bak.push(x);continue;}
      if(x._t>=1e18||x.comDNF){nc.push(x);continue;}
      const L=x.laps||0,T=x._t;
      if(T>=wt){fin.push(x);continue;}      // a vu le drapeau (finisher)
      if(L>=ml){cls.push(x);continue;}      // DNF classé
      nc.push(x);                           // NC-DNF
    }
    fin.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
    cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t); // dernier à abandonner en tête
    nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
    return [...fin,...cls,...nc,...bak];
  }

  function install(){
    if(typeof sortSession!=='function'||typeof rounds!=='function'||typeof calculate!=='function'||typeof addAdjustment!=='function'){setTimeout(install,80);return;}

    // openAdjForm multi-choix. Note: addAdjustment() original ne prend pas
    // dnf/dns. On étend le format stocké et c'est applyPenMap() ci-dessus
    // qui l'applique.
    window.addAdjustment=function(rj,sj,did,timeAdd,dq,warning,note,extra){
      const entry={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};
      if(extra){if(extra.dnf)entry.dnf=true;if(extra.dns)entry.dns=true;}
      penMap[`${rj}:${sj}:${did}`]=entry;
      if(typeof saveState==='function')saveState();
      if(typeof render==='function')render();
    };
    window.openAdjForm=function(rj,sj,did){
      const c=String(prompt("Ajustement :\n1=Pénalité temps\n2=DNF<75% (0pt)\n3=DNS (absent)\n4=DQ\n5=Avertissement\n0=Annuler",'1')||'').trim();
      if(!c||c==='0')return;
      if(c==='2'){if(!confirm("DNF non-classé (<75%) ?"))return;window.addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Abandon')||'Abandon',{dnf:true});return;}
      if(c==='3'){if(!confirm("DNS (absent) ?"))return;window.addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;}
      if(c==='4'){if(!confirm("DQ ?"))return;window.addAdjustment(rj,sj,did,0,true,false,prompt("Note ?",'')||'');return;}
      if(c==='5'){if(!confirm("Avertissement ?"))return;window.addAdjustment(rj,sj,did,0,false,true,'');return;}
      const ta=prompt("Temps (s) ?",'0');if(ta===null)return;
      window.addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
    };

    // Patch sortSession pour reclasser.
    const _ss=window.sortSession;
    window.sortSession=function(sess){prepSessionBeforeSort();const arr=_ss(sess);if(!sess||sess.type!=='RACE')return arr;try{return reclassify(arr);}catch(e){console.warn('[v60] reclassify',e);return arr;}};

    // Patch calculate pour ajouter points aux classés-DNF (que site.js ignore)
    // + attribuer la pole au pole-sitter même s'il est en DNF classé.
    const _calc=window.calculate;
    window.calculate=function(){
      prepSessionBeforeSort();
      const ds=_calc();
      if(typeof pointsConfig!=='function')return ds;
      const rs=rounds();const cfg=pointsConfig();
      const sc=cfg.pointsScale||(window.DEFAULT_POINTS&&window.DEFAULT_POINTS.pointsScale)||[];
      const polePts=cfg.polePoints||0;
      const dbl=cfg.doubleLongRaces!==false;
      rs.forEach((rd,j)=>{
        const races=(rd.sessions||[]).filter(s=>s.type==='RACE');
        const mult=(races.length===1&&dbl)?2:1;
        races.forEach((race,ri)=>{
          const rm=ri===0?mult:1;
          const arr=race.results;if(!arr||!arr.length)return;
          // recompute wl/wt à partir du tableau trié
          let wl=0,wt=1e18;
          for(const x of arr){if(x._dq||x.comDNS||x._t>=1e18)continue;const L=x.laps||0;if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}}
          if(wl===0)return;
          const ml=Math.ceil(wl*MIN_PCT);
          // trouver pole sitter classé
          let poleId=null;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&(x.laps||0)>=ml){poleId=x.id;break;}}
          let poleGiven=false;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&x._t<1e18&&x._t>=wt){poleGiven=true;break;}}
          for(let i=0;i<arr.length;i++){
            const x=arr[i];
            if(x._dq||x.comDNS||x._t>=1e18)continue;
            const L=x.laps||0;if(L<ml)continue;
            if(x._t<wt){ // classé-DNF : ajouter points (site.js ne l'a pas fait)
              const p=(i<sc.length?sc[i]*rm:0);
              const d=ds.find(dd=>dd.id===x.id);if(d){d.rounds[j]+=p;}
              if(!poleGiven && x.id===poleId){
                if(d)d.rounds[j]+=polePts*mult;
                poleGiven=true;
              }
            }
          }
        });
      });
      ds.forEach(d=>{d.total=d.rounds.reduce((a,b)=>a+b,0);});
      return ds;
    };
    console.log('[v60] installed.');
    try{if(window.calculate)window.calculate();if(window.render)window.render();}catch(e){console.warn('[v60] init',e)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

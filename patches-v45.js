/* patches-v45.js — v61
 *  1) openAdjForm multi-choix (Pénal./DNF<75%/DNS/DQ/Avertissement)
 *  2) Règle 75% classante : DNF ≥75% marque les points de sa position (derrière
 *     les finishers), DNF <75% = 0 pt. DNS/DQ = 0 pt.
 *     Critère finisher AC = T final >= T final vainqueur (a vu le drapeau).
 *  3) Patcher patchAll de v44 pour que comDNF/comDNS soient marqués SUR LES
 *     CLONES que v44 crée (sinon sortForResults ne les voit pas).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;
  const MIN_PCT=0.75;

  // Étendre addAdjustment pour supporter dnf/dns
  const _addAdj=window.addAdjustment;
  window.addAdjustment=function(rj,sj,did,timeAdd,dq,warning,note,extra){
    if(extra&&(extra.dnf||extra.dns)){
      const entry={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};
      if(extra.dnf)entry.dnf=true;
      if(extra.dns)entry.dns=true;
      if(typeof penMap==='object'){
        penMap[`${rj}:${sj}:${did}`]=entry;
        if(typeof saveState==='function')saveState();
        if(typeof render==='function')render();
      }
      return;
    }
    return _addAdj.apply(this,arguments);
  };

  // Appliquer comDNF/comDNS sur un tableau de résultats (puisque site.js ne
  // les reset PAS lui-même, on les met à la main sur les clones AVANT le tri).
  function markDNFOnArr(arr,rIdx,sIdx){
    if(!arr)return;
    // Reset sur chaque clone
    arr.forEach(y=>{y.comDNF=false;y.comDNS=false;});
    // 1) PenMap manuelle
    if(typeof penMap==='object'){
      for(const k in penMap){
        const [rj,sj,did]=k.split(':');
        if(+rj!==rIdx||+sj!==sIdx)continue;
        const y=arr.find(x=>x.id===did);if(!y)continue;
        const adj=penMap[k];
        if(adj.dnf)y.comDNF=true;
        if(adj.dns)y.comDNS=true;
      }
    }
    // 2) Auto NC-DNF : <75% des tours
    const wl=Math.max(0,...arr.map(y=>(y.laps)||0));
    const ml=Math.ceil(wl*MIN_PCT);
    arr.forEach(y=>{
      if((y.laps||0)>0 && (y.laps||0)<ml)y.comDNF=true;
      if(y.lapPenalty && !y.comDQ)y.comDNF=true;
    });
  }

  // Intercepter patchAll de v44 : il est appelé avant chaque calculate et
  // il remplace sess.results par des clones. On lui ajoute un post-traitement
  // qui marque comDNF/comDNS sur ces clones.
  function hookPatchAll(){
    // v44 ne l'expose pas ; on intercepte via le wrapper calculate/render que
    // v44 a installé. Plus simple : on intercepte la fonction applyCommissionToArr
    // de site.js qui est appelée sur CHAQUE tri et qui reçoit arr, rIdx, sIdx.
    const _applyCommission=window.applyCommissionToArr;
    if(!_applyCommission)return false;
    window.applyCommissionToArr=function(arr,sess,rIdx,sIdx){
      const ret=_applyCommission.apply(this,arguments);
      try{
        if(sess&&sess.type==='RACE'&&Array.isArray(arr)){
          markDNFOnArr(arr,rIdx,sIdx);
        }
      }catch(e){console.warn('[v61] markDNF error',e);}
      return ret;
    };
    return true;
  }

  // Après sortSession, reclasser correctement.
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
      if(T>=wt){fin.push(x);continue;}
      if(L>=ml){cls.push(x);continue;}
      nc.push(x);
    }
    fin.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
    cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t);
    nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
    return [...fin,...cls,...nc,...bak];
  }

  function install(){
    if(typeof sortSession!=='function'||typeof calculate!=='function'||typeof addAdjustment!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    // Hook applyCommissionToArr pour marquer comDNF sur les clones
    if(!hookPatchAll()){setTimeout(install,80);return;}

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

    const _ss=window.sortSession;
    window.sortSession=function(sess){
      const arr=_ss(sess);
      if(!sess||sess.type!=='RACE')return arr;
      try{return reclassify(arr);}catch(e){console.warn('[v61] reclassify',e);return arr;}
    };

    // Post-calcul : ajouter points aux classés-DNF (que site.js a ignorés) + pole
    const _calc=window.calculate;
    window.calculate=function(){
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
          let wl=0,wt=1e18;
          for(const x of arr){if(x._dq||x.comDNS||x._t>=1e18)continue;const L=x.laps||0;if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}}
          if(wl===0)return;
          const ml=Math.ceil(wl*MIN_PCT);
          let poleId=null;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&(x.laps||0)>=ml){poleId=x.id;break;}}
          let poleGiven=false;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&x._t<1e18&&x._t>=wt){poleGiven=true;break;}}
          for(let i=0;i<arr.length;i++){
            const x=arr[i];
            if(x._dq||x.comDNS||x._t>=1e18)continue;
            if((x.laps||0)<ml)continue;
            if(x._t<wt){ // classé-DNF : pas eu de points
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
    console.log('[v61] installed (hook applyCommissionToArr for comDNF on clones).');
    try{if(window.calculate)window.calculate();if(window.render)window.render();}catch(e){console.warn('[v61] init',e)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

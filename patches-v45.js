/* patches-v45.js — v58
 *  1) Rétablit openAdjForm multi-choix (1=temps, 2=DNF<75%, 3=DNS, 4=DQ, 5=Aver.)
 *  2) Applique la règle des 75% OFFICIELLE :
 *     - FINISHERS : tours du winner OU winner-1 avec T >= winnerTime.
 *     - CLASSÉS-DNF (≥ 75% des tours, pas passé sous le drapeau) : placés
 *       DERRIÈRE le dernier finisher, dans l'ordre d'abandon (tours desc,
 *       T desc → dernier à abandonner = mieux placé). Marquent les points de
 *       leur position.
 *     - NC-DNF (< 75%) : 0 point. DNS/DQ : 0 point.
 *  3) Pôle donné au premier en Q (meilleur tour) qui n'est ni banni, ni <2t.
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  const MIN_PCT=0.75;

  function classifyResults(race){
    const res=race.results||[];
    if(!res.length)return {ordered:res,winnerLaps:0,winnerTime:0,minLaps:0,nFinishers:0,nClassified:0};
    // _t est déjà en ms après v42 (eff+commission). On utilise _t quand dispo.
    const rawT=r=>Number.isFinite(r._t)?r._t:(Number.isFinite(r.time)?r.time:1e18);
    const isDQr=r=>!!(r.disqualified||r.comDQ||r.comDNS||r.finalDQ);
    // 1) Trouver le vrai vainqueur (max de tours, temps min parmi ceux-ci, pas DQ)
    let wl=0,wt=1e18;
    for(const r of res){
      if(isDQr(r))continue;
      const L=r.laps||0,T=rawT(r);
      if(L>wl||(L===wl&&T<wt)){wl=L;wt=T;}
    }
    if(wl===0)return {ordered:res,winnerLaps:0,winnerTime:0,minLaps:0,nFinishers:0,nClassified:0};
    const ml=Math.ceil(wl*MIN_PCT);
    const fin=[];   // finishers (w laps ou w-1 avec T>=wt)
    const cls=[];   // classés-DNF (≥ ml, pas finisher)
    const nc=[];    // < ml (0 pt)
    const bak=[];   // DQ/DNS
    for(const r of res){
      if(isDQr(r)){bak.push(r);r._v45cls='bak';continue;}
      const L=r.laps||0,T=rawT(r);
      if(L<=0){bak.push(r);r._v45cls='bak';continue;}
      // Critère VRAI d'AC : un pilote est finisher si son temps T >= temps vainqueur
    // (il a franchi la ligne sous le drapeau à damier, quel que soit le nb de
    // tours de retard). Un DNF a T < wt : son chrono a été coupé avant le checkered.
      if(T>=wt && L>=ml){fin.push(r);r._v45cls='fin';continue;}
      if(L>=ml){cls.push(r);r._v45cls='cls';continue;}
      nc.push(r);r._v45cls='nc';
    }
    fin.sort((a,b)=>{
      if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
      return rawT(a)-rawT(b);
    });
    cls.sort((a,b)=>{
      if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
      return rawT(b)-rawT(a);
    });
    // nc et bak dans un ordre cohérent (tours desc)
    nc.sort((a,b)=>(b.laps||0)-(a.laps||0));
    return {ordered:[...fin,...cls,...nc,...bak],winnerLaps:wl,winnerTime:wt,minLaps:ml,nFinishers:fin.length,nClassified:fin.length+cls.length};
  }

  function patchCalculation(){
    if(typeof calculate!=='function')return;
    // On intercepte le calcul des points : après que site.js a trié chaque
    // session via sortSession, on reclasse nous-même, et on attribue les
    // points selon la classification (finishers + classés-DNF).
    const _calc=window.calculate;
    window.calculate=function(){
      // D'abord marquer les NC-DNF (<75%) et reset
      if(Array.isArray(window.events)){
        for(const ev of window.events){
          const d=ev&&ev.data;if(!d||!Array.isArray(d.sessions))continue;
          const pm=d.penMap=d.penMap||{};
          if(typeof rounds!=='function')continue;
          const rs=rounds();
          rs.forEach((rd,rIdx)=>{
            rd.sessions.forEach((s,sIdx)=>{
              if(!s||s.type!=='RACE'||!Array.isArray(s.results))return;
              let wl=0;s.results.forEach(r=>{if(r&&(r.laps||0)>wl)wl=r.laps});
              const ml=Math.ceil(wl*MIN_PCT);
              s.results.forEach(r=>{
                if(!r||!r.id)return;
                const key=`${rIdx}:${sIdx}:${r.id}`;
                const ex=pm[key]||{};
                if(ex.dq||ex.dns)return;
                if(ex.dnf){r.comDNF=true;return;}
                if(r.laps>=ml){r.comDNF=false;}
              });
            });
          });
        }
      }
      // Appel du tri v42 (qui ne fait clsIdx++ que pour finishStatus.full)
      // On patch finishStatus en posant un flag _v45classed=true pour les cls-DNF
      // La façon la plus propre : recalculer les points NOUS-MÊME après le tri
      // initial de site.calculate en le re-parcourant. Comme _calc() ajoute déjà
      // les points dans map[].rounds, on NE VEUT PAS qu'il ajoute des points
      // aux cls-DNF. Donc on garde _calc tel quel, PUIS on ajoute les points
      // aux cls-DNF dans un second passage.
      //
      // Mieux : on intercepte chaque course et remplace le calcul dans la boucle
      // en surchargant race.results.forEach par notre propre version.
      // Plus simple : appeler _calc, puis recompleter.
      const ds=_calc();
      if(Array.isArray(window.events)){
        if(typeof rounds!=='function')return ds;
        const rs=rounds();
        const cfg=pointsConfig();
        const sc=cfg.pointsScale||DEFAULT_POINTS.pointsScale;
        const polePts=cfg.polePoints||0;
        const doubleLong=cfg.doubleLongRaces!==false;
        rs.forEach((r,j)=>{
          const races=r.sessions.filter(s=>s.type==='RACE');
          const multiplier=races.length===1&&doubleLong?2:1;
          races.forEach((race,ri)=>{
            const {ordered,nFinishers,nClassified}=classifyResults(race);
            // Les points ont déjà été attribués aux finishers par _calc.
            // On ajoute maintenant les points aux classés-DNF (positions nFinishers+1 ... nClassified).
            let poleHandled=false;
            // Vérifier si le pole a déjà été donné (par _calc)
            ordered.forEach((p,i)=>{
              const place=i+1;
              if(p._v45cls!=='cls'){
                if(place===1 && p.grid===1)poleHandled=true;
                return;
              }
              // Classé-DNF : donner les points de sa position
              const idx=place-1;
              if(idx<sc.length){
                const pts=sc[idx]*multiplier;
                // Trouver pilote dans ds
                const d=ds.find(x=>x.id===p.id);
                if(d){d.rounds[j]+=pts;}
              }
              // Pole : si le pole est un classé-DNF et pas encore donné
              if(!poleHandled && p.grid===1){
                const d=ds.find(x=>x.id===p.id);
                if(d){d.rounds[j]+=polePts*multiplier;}
                poleHandled=true;
              }
            });
            // Reset flags _v45cls
            ordered.forEach(p=>{delete p._v45cls;});
          });
        });
        // Recalculer total
        ds.forEach(d=>{d.total=d.rounds.reduce((a,b)=>a+b,0);});
      }
      return ds;
    };
  }

  // Wrapper sortSession : reclasser les résultats dans l'ordre correct
  function patchSortSession(){
    if(typeof window.sortSession!=='function')return;
    const _ss=window.sortSession;
    window.sortSession=function(sess){
      const arr=_ss(sess);
      if(!sess||sess.type!=='RACE')return arr;
      // Reclasser en se basant sur _t (produit par v42)
      const fakeRace={results:arr};
      const {ordered}=classifyResults(fakeRace);
      return ordered;
    };
  }

  function install(){
    if(typeof addAdjustment!=='function'||typeof sortSession!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    window.openAdjForm=function(rj,sj,did){
      const choix=prompt(
        "Type d'ajustement :\n"+
        "  1 = Pénalité de temps (+10, -5, +120s)\n"+
        "  2 = Abandon NON-CLASSÉ (DNF <75%) — 0 pt\n"+
        "  3 = Absent (DNS) — 0 pt\n"+
        "  4 = DQ (drapeau noir)\n"+
        "  5 = Avertissement\n"+
        "  0 = Annuler",'1');
      if(choix===null)return;
      const c=String(choix).trim();
      if(c==='0'||c==='')return;
      if(c==='2'){if(!confirm("DNF non-classé (<75%) ?"))return;addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Abandon')||'Abandon',{dnf:true});return;}
      if(c==='3'){if(!confirm("DNS ?"))return;addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;}
      if(c==='4'){if(!confirm("DQ ?"))return;addAdjustment(rj,sj,did,0,true,false,prompt("Note ?",'')||'');return;}
      if(c==='5'){if(!confirm("Avertissement ?"))return;addAdjustment(rj,sj,did,0,false,true,'');return;}
      const ta=prompt("Temps (s) ?",'0');if(ta===null)return;
      addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
    };

    patchSortSession();
    patchCalculation();

    if(window.render){
      const _r=window.render;
      window.render=function(){
        // Avant render, les données sont déjà prêtes via calculate() appelé
        // pendant le rendu. Rien à ajouter ici.
        return _r.apply(this,arguments);
      };
    }
    try{if(window.calculate)window.calculate();if(window.render)window.render();}catch(e){console.warn('[v58] init',e)}
    console.log('[v58] installed: classified DNF (>=75%) score points behind finishers.');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

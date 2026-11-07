/* patches-v45.js — v56
 *  1) Rétablit openAdjForm multi-choix (Pénalité temps / DNF / DNS / DQ / Avertissement).
 *  2) Détection automatique des abandons depuis le JSON AC, avec la règle officielle :
 *
 *     • Le vainqueur est celui qui a le plus grand nb de tours, et à nb de tours égal
 *       le plus petit temps total.
 *     • FINISHERS : même nb de tours que le vainqueur, OU vainqueur-1 tour MAIS temps
 *       total ≥ temps du vainqueur (il a coupé la ligne à 1 tour quand le leader a
 *       fini). Triés au temps croissant ; les 1-tour-down finissent derrière tous
 *       les pilotes au même nb de tours que le vainqueur.
 *     • CLASSÉS-DNF (≥ 75% des tours) : pilotes ayant abandonné mais bouclé au moins
 *       ⌈75% × winnerLaps⌉ tours. Placés DERRIÈRE le dernier finisher, dans l'ordre
 *       d'abandon : d'abord le plus de tours, puis à tours égaux le temps le plus
 *       ÉLEVÉ (dernier à abandonner = mieux placé). Marquent les points de leur position.
 *     • NC-DNF (< 75%) : 0 point de place (conservent la pole si concernés).
 *     • DNS (0 tour) / DQ : 0 point.
 *
 *     On injecte un efftime synthétique pour que le tri v42 positionne correctement
 *     les classés-DNF, puis on retrie la liste en sortie de sortSession() pour
 *     garantir l'ordre final.
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  const MIN_PCT=0.75;

  function classifyAC(results){
    if(!Array.isArray(results)||!results.length)return {finishers:[],classifiedDNF:[],ncDNF:[],back:[],winnerLaps:0,winnerTime:0,minLaps:0};
    let winnerLaps=0,winnerTime=1e18;
    results.forEach(r=>{
      if(!r)return;
      const L=r.laps||0;const T=Number.isFinite(r.time)?r.time:1e18;
      if(L>winnerLaps || (L===winnerLaps && T<winnerTime)){winnerLaps=L;winnerTime=T;}
    });
    const minLaps=Math.ceil(winnerLaps*MIN_PCT);
    const finishers=[],classifiedDNF=[],ncDNF=[],back=[];
    results.forEach(r=>{
      if(!r)return;
      const L=r.laps||0;
      const T=Number.isFinite(r.time)?r.time:1e18;
      const dq=r.disqualified||r.comDQ||r.comDNS||L<=0;
      if(L<=0||r.comDNS){back.push(r);return;}
      if(r.disqualified||r.comDQ){back.push(r);return;}
      if(L===winnerLaps){finishers.push(r);return;}
      if(L===winnerLaps-1 && T>=winnerTime){finishers.push(r);return;}
      if(L>=minLaps){classifiedDNF.push(r);return;}
      ncDNF.push(r);
    });
    return {finishers,classifiedDNF,ncDNF,back,winnerLaps,winnerTime,minLaps};
  }

  function penMs(raw){
    const v=Number(raw)||0;
    if(v<=0)return 0;
    if(v>=1e8)return v/1e6;
    if(v>=1e4)return v;
    return v*1000;
  }

  function autoDNF(){
    if(!Array.isArray(window.events))return;
    for(const ev of window.events){
      const d=ev&&ev.data;if(!d||!Array.isArray(d.sessions))continue;
      const pm=d.penMap=d.penMap||{};
      if(typeof rounds!=='function')continue;
      const rs=rounds();
      rs.forEach((rd,rIdx)=>{
        rd.sessions.forEach((s,sIdx)=>{
          if(!s||s.type!=='RACE'||!Array.isArray(s.results))return;
          const res=s.results;
          if(!res.length)return;
          // reset auto flags (keep manual)
          res.forEach(r=>{
            if(!r||!r.id)return;
            const key=`${rIdx}:${sIdx}:${r.id}`;
            const ex=pm[key]||{};
            if(!ex.dq&&!ex.dns&&!ex.dnf){r.comDNF=false;r.comDNS=false;r._classifiedDNF=false;}
          });
          const cls=classifyAC(res);
          // Injecter efftime synthétique pour que le tri v42 positionne bien les classés-DNF
          const lastFin=cls.finishers[cls.finishers.length-1];
          let base=1;
          if(lastFin){
            const srv=penMs(lastFin.penaltyTime);
            const kf=`${rIdx}:${sIdx}:${lastFin.id}`;
            const com=(pm[kf]&&pm[kf].timeAdd)?pm[kf].timeAdd*1000:0;
            base=(lastFin.time||1e18)+srv+com+1;
          }
          cls.classifiedDNF.forEach((r,k)=>{
            r.efftime=base+k;
            r._classifiedDNF=true;
            r.comDNF=false;r.comDNS=false;
          });
          // NC-DNF
          cls.ncDNF.forEach(r=>{
            const key=`${rIdx}:${sIdx}:${r.id}`;
            if(!pm[key])pm[key]={timeAdd:0,dq:false,warning:false,dnf:true,dns:false,note:`Abandon (${r.laps||0}/${cls.winnerLaps} t., < 75%)`};
            else if(!pm[key].dnf&&!pm[key].dq&&!pm[key].dns)pm[key].dnf=true;
            r.comDNF=true;r.comDNS=false;
          });
        });
      });
    }
  }

  function install(){
    if(typeof addAdjustment!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    window.openAdjForm=function(rj,sj,did){
      const choix=prompt(
        "Type d'ajustement :\n"+
        "  1 = Pénalité de temps (ex: +10, -5, +120s)\n"+
        "  2 = Abandon (DNF <75%) — 0 pt de place, conserve la pole\n"+
        "  3 = Absent (DNS) — aucun point\n"+
        "  4 = Disqualification (DQ)\n"+
        "  5 = Avertissement sans sanction\n"+
        "  0 = Annuler",'1');
      if(choix===null)return;
      const c=String(choix).trim();
      if(c==='0'||c==='')return;
      if(c==='2'){
        if(!confirm("Marquer ABANDON NON-CLASSÉ (DNF <75%) ? Le pilote ne marquera aucun point de place. (Les abandons ≥75% sont détectés automatiquement.)"))return;
        addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Abandon')||'Abandon',{dnf:true});return;
      }
      if(c==='3'){
        if(!confirm("Marquer ABSENT (DNS) ?"))return;
        addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;
      }
      if(c==='4'){if(!confirm('DQ ?'))return;addAdjustment(rj,sj,did,0,true,false,prompt('Note ?','')||'');return;}
      if(c==='5'){if(!confirm("Avertissement ?"))return;addAdjustment(rj,sj,did,0,false,true,'');return;}
      const ta=prompt("Ajustement temps en secondes ?",'0');if(ta===null)return;
      addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
    };

    // Post-trier sortSession pour garantir l'ordre final
    const _ss=window.sortSession;
    if(_ss){
      window.sortSession=function(sess){
        const arr=_ss(sess);
        if(!sess||sess.type!=='RACE')return arr;
        const fin=arr.filter(x=>!x._dq&&!x.comDNF&&!x.comDNS&&!x._classifiedDNF);
        const cls=arr.filter(x=>!x._dq&&!x.comDNF&&!x.comDNS&&x._classifiedDNF);
        const nc=arr.filter(x=>x.comDNF&&!x._dq&&!x.comDNS);
        const bak=arr.filter(x=>x._dq||x.comDNS);
        fin.sort((a,b)=>(b.laps-a.laps)||(a._t-b._t));
        cls.sort((a,b)=>(b.laps-a.laps)||(b._t-a._t));
        return [...fin,...cls,...nc,...bak];
      };
    }

    function wrap(n){
      const o=window[n];if(!o)return;
      window[n]=function(){try{autoDNF();}catch(e){console.warn('[v45]',e)}return o.apply(this,arguments);};
    }
    wrap('render');wrap('calculate');
    try{autoDNF();if(window.render)window.render();}catch(e){console.warn('[v45] init',e)}
    console.log('[v56] installed: 75% rule, classified DNF get points behind last finisher.');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

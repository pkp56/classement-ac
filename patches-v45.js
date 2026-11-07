/* patches-v45.js — v57
 *  1) Rétablit openAdjForm multi-choix.
 *  2) Auto-classement AC des abandons (règle 75%) :
 *     • Finishers : tours du winner OU winner-1 tour avec _t >= temps winner (passé drapeau)
 *     • Classés-DNF (≥75%) : au moins ⌈75%×W⌉ tours mais n'ont pas franchi la ligne
 *       d'arrivée → placés DERRIÈRE le dernier finisher, dans l'ordre d'abandon
 *       (tours desc puis temps desc), marquent les points.
 *     • NC-DNF (<75%) : 0 pt (comDNF=true)
 *     • DNS/DQ : 0 pt
 *  3) Pour éviter tout conflit avec v44 (qui écrase efftime), le reclassement
 *     final se fait en post-traitement de sortSession, directement en lisant
 *     laps/_t du tableau trié.
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  function markNC_DNF(sess,rs_fn){
    if(!Array.isArray(window.events))return;
    if(typeof rs_fn!=='function')rs_fn=window.rounds;
    if(typeof rs_fn!=='function')return;
    for(const ev of window.events){
      const d=ev&&ev.data;if(!d||!Array.isArray(d.sessions))continue;
      const pm=d.penMap=d.penMap||{};
      const rs=rs_fn();
      rs.forEach((rd,rIdx)=>{
        rd.sessions.forEach((s,sIdx)=>{
          if(!s||s.type!=='RACE'||!Array.isArray(s.results))return;
          // Seulement les NC-DNF (<75%) via comDNF=true, pour qu'ils soient 0pt.
          // Les classés-DNF (≥75%) ne sont PAS marqués comDNF ; ils sont traités
          // en post-tri de sortSession.
          const res=s.results;
          let wl=0;
          res.forEach(r=>{if(r&&(r.laps||0)>wl)wl=r.laps});
          const ml=Math.ceil(wl*0.75);
          res.forEach(r=>{
            if(!r||!r.id)return;
            const key=`${rIdx}:${sIdx}:${r.id}`;
            const ex=pm[key]||{};
            if(ex.dq||ex.dns)return;
            const L=r.laps||0;
            if(ex.dnf){r.comDNF=true;return;}
            if(L>0 && L<ml){
              // NC-DNF auto (<75%)
              if(!pm[key])pm[key]={timeAdd:0,dq:false,warning:false,dnf:true,dns:false,note:`Abandon (${L}/${wl} t., < 75%)`};
              r.comDNF=true;
            }else{
              // Ne pas toucher (classé-DNF géré en post-tri)
              r._classifiedDNF=false;
              if(!ex.dnf)r.comDNF=false;
            }
          });
        });
      });
    }
  }

  function postSort(sess,arr){
    if(!sess||sess.type!=='RACE'||!arr.length)return arr;
    // Déterminer le vainqueur et le seuil depuis le tableau déjÃ  trié (objets ont laps et _t)
    let winnerLaps=0,winnerT=1e18;
    for(const x of arr){
      if(x._dq||x.comDNF||x.comDNS)continue;
      const L=x.laps||0,T=(Number.isFinite(x._t)?x._t:1e18);
      if(L>winnerLaps || (L===winnerLaps && T<winnerT)){winnerLaps=L;winnerT=T;}
    }
    if(winnerLaps===0)return arr;
    const minLaps=Math.ceil(winnerLaps*0.75);
    const fin=[];    // finishers (mêmes tours ou winner-1 avec T>=winnerT)
    const cls=[];    // classés-DNF (>= minLaps mais pas finishers)
    const nc=[];     // NC-DNF (comDNF=true ou < minLaps)
    const bak=[];    // DQ/DNS
    for(const x of arr){
      if(x._dq||x.comDNS){bak.push(x);continue;}
      if(x.comDNF){nc.push(x);continue;}
      const L=x.laps||0;
      const T=Number.isFinite(x._t)?x._t:1e18;
      if(L<=0){bak.push(x);continue;}
      if(L===winnerLaps){fin.push(x);continue;}
      if(L===winnerLaps-1 && T>=winnerT){fin.push(x);continue;}
      if(L>=minLaps){cls.push(x);continue;}
      nc.push(x);
    }
    // Tri finishers : laps desc puis _t croissant
    fin.sort((a,b)=>{
      if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
      return (Number.isFinite(a._t)?a._t:1e18)-(Number.isFinite(b._t)?b._t:1e18);
    });
    // Tri classés-DNF : laps desc puis _t DESC (dernier à abandonner = mieux placé)
    cls.sort((a,b)=>{
      if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
      return (Number.isFinite(b._t)?b._t:0)-(Number.isFinite(a._t)?a._t:0);
    });
    // NC-DNF et back restent dans leur ordre v42
    return [...fin,...cls,...nc,...bak];
  }

  function install(){
    if(typeof addAdjustment!=='function'||typeof window.sortSession!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    // OpenAdjForm multi-choix
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
      if(c==='3'){if(!confirm("DNS (absent) ?"))return;addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;}
      if(c==='4'){if(!confirm("DQ ?"))return;addAdjustment(rj,sj,did,0,true,false,prompt("Note ?",'')||'');return;}
      if(c==='5'){if(!confirm("Avertissement ?"))return;addAdjustment(rj,sj,did,0,false,true,'');return;}
      const ta=prompt("Ajustement temps en secondes ?",'0');if(ta===null)return;
      addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
    };

    // Wrapper sortSession
    const _ss=window.sortSession;
    window.sortSession=function(sess){
      const arr=_ss(sess);
      try{return postSort(sess,arr);}catch(e){console.warn('[v57] postSort error',e);return arr;}
    };

    // Auto-marque NC-DNF (<75%) avant chaque calcul
    function wrap(n){
      const o=window[n];if(!o)return;
      window[n]=function(){try{markNC_DNF();}catch(e){console.warn('[v57] markNC error',e)}return o.apply(this,arguments);};
    }
    wrap('render');wrap('calculate');

    try{markNC_DNF();if(window.render)window.render();}catch(e){console.warn('[v57] init',e)}
    console.log('[v57] installed: 75% classified-DNF via post-sort (no efftime hack).');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

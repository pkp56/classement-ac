/* patches-v45.js — v54
 *  1) Rétablit l'option Abandon(DNF)/Absent(DNS)/Avertissement dans la
 *     fenêtre Commission (écrasée par site.js après v42).
 *  2) Détection automatique des abandons depuis les données JSON AC, avec
 *     application de la RÈGLE OFFICIELLE DES 75% :
 *
 *        • Un pilote qui a bouclé ≥ 75% des tours du vainqueur EST CLASSÉ :
 *          il est placé DERRIÈRE LE DERNIER FINISHER et marque les points de
 *          sa position. Les DNF classés sont triés entre eux par ordre
 *          d'abandon : le plus tard abandonné (plus de tours, puis temps le
 *          plus élevé) est le mieux placé.
 *          Ex. Sebring : 51R Sherman a fait 28/29 t. (97%) → classé 16ᵉ,
 *          marque les points de la 16ᵉ place (derrière les 15 finishers).
 *
 *        • Un pilote qui a bouclé < 75% des tours n'est PAS CLASSÉ (DNF jaune)
 *          → 0 point de place (conserve la pole si concerné).
 *
 *        • DNS (0 tour) ou DQ → 0 point, fond de grille.
 *
 *     La détection AC du "a abandonné avant le checkered" se fait par le
 *     critère : laps < winnerLaps ET totalTime < winnerTime (chrono stoppé
 *     avant la fin).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  const MIN_PCT=0.75;

  // Classement AC complet d'une liste de results (objets {laps,time}).
  // Retourne les 4 groupes dans l'ordre final.
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
      // Finisher : même nb de tours que winner, OU à 1 tour mais temps >= winnerTime
      if(L===winnerLaps){finishers.push(r);return;}
      if(L===winnerLaps-1 && T>=winnerTime){finishers.push(r);return;}
      // ≥75% → classé DNF (marque des points)
      if(L>=minLaps){classifiedDNF.push(r);return;}
      // <75% → non classé
      ncDNF.push(r);
    });
    finishers.sort((a,b)=>{
      const ta=Number.isFinite(a.time)?a.time:1e18;
      const tb=Number.isFinite(b.time)?b.time:1e18;
      return ta-tb;
    });
    // Classés-DNF triés par ordre d'abandon : + de tours d'abord, puis temps le
    // plus élevé (dernier à abandonner = mieux placé).
    classifiedDNF.sort((a,b)=>{
      if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
      const ta=Number.isFinite(a.time)?a.time:0;
      const tb=Number.isFinite(b.time)?b.time:0;
      return tb-ta;
    });
    return {finishers,classifiedDNF,ncDNF,back,winnerLaps,winnerTime,minLaps};
  }

  // Injecte efftime sur les résultats pour que le tri v42 positionne
  // correctement les classés-DNF (≥75%) derrière les finishers, tout en leur
  // donnant des points (cls=0, pas comDNF=true).
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

          // Nettoyer les fanions auto
          res.forEach(r=>{
            if(!r||!r.id)return;
            const key=`${rIdx}:${sIdx}:${r.id}`;
            const ex=pm[key]||{};
            if(!ex.dq&&!ex.dns&&!ex.dnf){
              r.comDNF=false;r.comDNS=false;r._classifiedDNF=false;
              // efftime sera repositionné ci-dessous si besoin
            }
          });

          const cls=classifyAC(res);

          // 1) Finishers : ne pas toucher à efftime (v44 le renseigne déjà correctement).
          // 2) Classified-DNF (≥75%) : injecter un efftime synthétique qui les
          //    place APRÈS le dernier finisher dans le tri v42.
          const lastFin=cls.finishers[cls.finishers.length-1];
          let base=0;
          if(lastFin){
            // Utiliser le temps effectif (après pénalités) du dernier finisher
            const srv_last=((lastFin.penaltyTime&&lastFin.penaltyTime>=1e8)?lastFin.penaltyTime/1e6:(lastFin.penaltyTime>=1e4?lastFin.penaltyTime:(lastFin.penaltyTime||0)*1000));
            const penKey_last=`${rIdx}:${sIdx}:${lastFin.id}`;
            const com_last=(pm[penKey_last]&&pm[penKey_last].timeAdd)?pm[penKey_last].timeAdd*1000:0;
            base=(lastFin.time||1e18)+srv_last+com_last;
          }else{
            base=1;
          }
          cls.classifiedDNF.forEach((r,k)=>{
            r.efftime=base+1+k; // croissant : k=0 mieux placé
            r._classifiedDNF=true;
            r.comDNF=false;r.comDNS=false;
          });

          // 3) NC-DNF (<75%) : marquer comDNF=true → 0 pt
          cls.ncDNF.forEach(r=>{
            const key=`${rIdx}:${sIdx}:${r.id}`;
            if(!pm[key])pm[key]={timeAdd:0,dq:false,warning:false,dnf:true,dns:false,note:`Abandon (${r.laps||0}/${cls.winnerLaps} t., < 75%)`};
            else if(!pm[key].dnf && !pm[key].dq && !pm[key].dns)pm[key].dnf=true;
            r.comDNF=true;r.comDNS=false;
          });
          // 4) back (DQ/DNS): laissé tel quel (v42 leur donne 0 pt)
        });
      });
    }
  }

  // ---- Rétablir openAdjForm multi-choix ----
  function install(){
    if(typeof addAdjustment!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    window.openAdjForm=function(rj,sj,did){
      const choix=prompt(
        "Type d'ajustement :\n"+
        "  1 = Pénalité de temps (ex: +10, -5, +120s, etc.)\n"+
        "  2 = Abandon en course (DNF) — pas de point de place, conserve la pole\n"+
        "  3 = Absent / Non-partant (DNS) — aucun point\n"+
        "  4 = Disqualification (DQ — drapeau noir)\n"+
        "  5 = Avertissement sans sanction\n"+
        "  0 = Annuler",
        '1');
      if(choix===null)return;
      const c=String(choix).trim();
      if(c==='0'||c==='')return;
      if(c==='2'){
        if(!confirm("Marquer en ABANDON (DNF <75%) ? 0 point de place, conserve la pole. (Les DNF ≥75% sont détectés automatiquement.)"))return;
        const note=prompt("Note / motif d'abandon ?",'Abandon')||'Abandon';
        addAdjustment(rj,sj,did,0,false,false,note,{dnf:true});return;
      }
      if(c==='3'){
        if(!confirm("Marquer ABSENT / NON-PARTANT (DNS) ? Aucun point (y compris la pole)."))return;
        const note=prompt('Note / motif ?','Absent')||'Absent';
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

    // Installer autoDNF dans le pipeline de rendu
    // On intercepte render() et calculate() : autoDNF() est appelé APRÈS tous
    // les autres patches (v44 qui pose efftime des pénalités serveur) grâce à
    // l'ordre d'installation des patches.
    function wrap(name){
      const orig=window[name];
      if(!orig)return;
      window[name]=function(){
        try{autoDNF();}catch(e){console.warn('[v45] autoDNF error',e)}
        return orig.apply(this,arguments);
      };
    }
    wrap('render');
    wrap('calculate');

    try{autoDNF();if(window.render)window.render();}catch(e){console.warn('[v45] init error',e)}
    console.log('[v45] installed: Commission DNF/DNS + auto-classement 75% (DNF≥75% classés, DNF<75% à 0 pt).');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

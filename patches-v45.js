/* patches-v45.js — v53
 *  1) Option « Abandon (DNF) » absente dans la Commission : site.js définissait
 *     window.openAdjForm APRÈS patches-v42 et écrasait la version multi-choix
 *     de v42. On la réinstalle APRÈS le chargement complet.
 *  2) DÉTECTION AUTOMATIQUE DES DNF par tours :
 *       - Courses 25 min (2 courses/manche) : pilote marqué DNF si tours < 75%
 *         des tours du vainqueur.
 *       - Courses 60 min (1 course/manche, double points) : même seuil 75%.
 *       - 0 tour = DNS (absent).
 *     Les marques manuelles de la Commission (DQ/DNS/DNF) n'écrasent pas l'auto-
 *     détection (DQ prime, puis DNS, puis DNF auto si sous le seuil).
 *     Un pilote au-dessus du seuil garde son statut finishers (même si comDNF
 *     avait été posé manuellement par erreur : on l'efface).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;

  const MIN_PCT=0.75;

  function install(){
    if(typeof addAdjustment!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    // ---- Réinstaller openAdjForm multi-choix (écrasé par site.js) ----
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
        if(!confirm("Marquer en ABANDON (DNF) ? Le pilote ne marque pas de point de place mais conserve son point de pole s'il était en pole."))return;
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

    // ---- Auto-DNF / Auto-DNS ----
    function autoDNF(){
      if(!Array.isArray(window.events))return;
      for(const ev of window.events){
        const d=ev&&ev.data;if(!d||!Array.isArray(d.sessions))continue;
        const pm=d.penMap=d.penMap||{};
        const rs=(typeof rounds==='function')?rounds():[];
        // Parcourir chaque manche et chaque session
        rs.forEach((rd,rIdx)=>{
          rd.sessions.forEach((s,sIdx)=>{
            if(!s||s.type!=='RACE'||!Array.isArray(s.results))return;
            const res=s.results;
            if(!res.length)return;
            const winnerLaps=Math.max(...res.map(r=>(r&&r.laps)||0));
            const minLaps=Math.ceil(winnerLaps*MIN_PCT);
            res.forEach(r=>{
              if(!r||!r.id)return;
              const key=`${rIdx}:${sIdx}:${r.id}`;
              const existing=pm[key]||{};
              if(existing.dq)return;        // DQ manuel prime
              if(existing.dns){r.comDNS=true;r.comDNF=false;return;}
              if(existing.dnf){r.comDNF=true;return;}
              const laps=r.laps||0;
              if(laps<=0){
                // DNS (absent, 0 tour)
                pm[key]={timeAdd:0,dq:false,warning:false,dnf:false,dns:true,note:'Absent (0 tour)'};
                r.comDNS=true;r.comDNF=false;
              }else if(laps<minLaps){
                // DNF automatique
                pm[key]={timeAdd:0,dq:false,warning:false,dnf:true,dns:false,note:`Abandon (${laps}/${winnerLaps} t., < 75%)`};
                r.comDNF=true;
              }else{
                // Finisher — ne devrait pas porter de marquage DNF/DNS hérité
                r.comDNF=false;
                if(!existing.dns)r.comDNS=false;
              }
            });
          });
        });
      }
    }

    // Patcher render/calculate
    const _origRender=window.render;
    if(_origRender){
      window.render=function(){
        try{autoDNF();}catch(e){console.warn('[v45] autoDNF error',e)}
        return _origRender.apply(this,arguments);
      };
    }
    const _origCalc=window.calculate;
    if(_origCalc){
      window.calculate=function(){
        try{autoDNF();}catch(e){console.warn('[v45] autoDNF error',e)}
        return _origCalc.apply(this,arguments);
      };
    }

    try{autoDNF();if(window.render)window.render();}catch(e){console.warn('[v45] init error',e)}
    console.log('[v45] installed: DNF/DNS en Commission + auto-DNF 75% tours.');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

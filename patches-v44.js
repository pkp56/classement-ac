/* patches-v44.js — v52 : corrige 3 bugs de calcul identifiés en comparant les
 * totaux du site avec le classement officiel Excel des 4 manches Lola T290 :
 *
 * BUG 1 (principal) : Pénalités temps Commission (comTimeAdd, en SECONDES)
 *   étaient ajoutées DIRECTEMENT à _eff (qui est en MILLESIMES). Une pénalité
 *   Commission de +5 s ajoutait donc 5 ms au lieu de 5000 ms → sans effet
 *   visible sur le classement. Toutes les sanctions timeAdd du DC (Thomas P.
 *   +5 s R2 Riverside, Assassins +5 s R1 Riverside, Neutraliz/LeNain +45 s,
 *   Tofusan +10 s R2 Mid-Ohio, Sherman +5 s R2 Mid-Ohio…) étaient ignorées.
 *
 *   Cause : v42 fait x._t = x._eff + (x.comTimeAdd||0) au lieu de *1000.
 *   Correction : forcer la multiplication par 1000 en écrivant x.comTimeAdd
 *   en ms avant le tri, en redéfinissant le map de sortForResults.
 *
 * BUG 2 : Les pénalités Commission en QUALIFICATION (+5s sur le meilleur tour,
 *   interdiction de qualif) n'étaient pas appliquées lors du tri Q (qui ne
 *   tenait compte que de BestLap). Un pilote sanctionné (fmherrou +5s à MT Q)
 *   ne reculait pas sur la grille.
 *
 * BUG 3 : Les pilotes n'ayant bouclé qu'1 tour en Q (tour de sortie / abandon)
 *   étaient classés devant ceux qui en avaient bouclé 2+, faussant la pole
 *   position (Streetbike P1 à MT Q au lieu de P11).
 *
 * Stratégie : intercepter le tri via Array.prototype.toSorted ne marche pas.
 * On intercepte plutôt en patchant les résultats AVANT render en marquant
 * les pénalités. Mais le plus propre est de wrapper l'appel à sortForResults
 * indirectement : on redéfinit le map/sort sur les tableaux results au moment
 * du calcul. En pratique une méthode PLUS SIMPLE :
 *
 *   → On re-calcule, juste après l'event "load", les pénalités Commission en
 *     ajoutant (timeAdd*1000) à l'efftime (champ prioritaire de v42), et on
 *     retriant les qualifs en pénalisant BestLap de timeAdd*1000 et en
 *     mettant DQ/laps<2 au fond.
 *
 *   → Au moment de calculate() (appelé par render), v42 lit les results déjà
 *     corrigés.
 */
(function(){
  'use strict';
  if(window.__gdspV44Installed)return;
  window.__gdspV44Installed=true;

  function acPenaltyMs(raw){
    const v=Number(raw)||0;
    if(v<=0)return 0;
    if(v>=1e8) return v/1e6;   // 5e9 → 5000 ms (format ticks*1e9)
    if(v>=1e4) return v;       // déjà en ms
    return v*1000;            // secondes → ms
  }

  function patchEvent(ev){
    if(!ev||!ev.data||!Array.isArray(ev.data.sessions))return;
    const penMap=ev.data.penMap||{};
    ev.data.sessions.forEach((sess,si)=>{
      if(!Array.isArray(sess.results))return;

      // === Pour Q : pénaliser BestLap de timeAdd*1000, mettre DQ/laps<2 au fond
      if(sess.type==='QUALIFY'){
        // Appliquer les pén Commission (penMap) sur BestLap
        sess.results.forEach(r=>{
          let penMs=0; let banned=false;
          for(const pk in penMap){
            const p=pk.split(':');
            if(p.length<3||Number(p[0])!==si||p[p.length-1]!==r.id)continue;
            const pv=penMap[pk];
            penMs += (pv.timeAdd||0)*1000;
            if(pv.dq) banned=true;
          }
          if(penMs && Number.isFinite(r.best)) r.best=r.best+penMs;
          if(banned){r.best=1e18;r._qBanned=true;}
        });
        // Re-trier : 2+ tours valides d'abord, puis 1 tour, puis DQ
        sess.results.sort((a,b)=>{
          const aOk=Number.isFinite(a.best)&&a.best<1e17&&(a.laps>=2);
          const bOk=Number.isFinite(b.best)&&b.best<1e17&&(b.laps>=2);
          if(aOk&&!bOk)return -1;
          if(!aOk&&bOk)return 1;
          if(!aOk&&!bOk){
            // Dans les non-valides, trier par laps décroissants puis best
            if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
            return (a.best||1e18)-(b.best||1e18);
          }
          return a.best-b.best;
        });
      }

      // === Pour tous les types : préparer efftime.
      // IMPORTANT : r.time = TotalTime d'Assetto Corsa, qui INCLUT DÉJÀ penaltyTime.
      // On n'ajoute DONC PAS penMs (ça double-comptait).
      // On ajoute juste les pénalités Commission (comTimeAdd, en secondes dans
      // le penMap, ajoutées en ms par v42 via x.comTimeAdd). Pour compenser le bug
      // v42 qui ajoute comTimeAdd en secondes (et non *1000), on utilise l'astuce
      // efftime = base + comT*1000 - comT.
      sess.results=sess.results.map(r=>{
        const x={...r};
        const base=Number.isFinite(x.time)?x.time:1e18;
        const comT=x.comTimeAdd||0;
        x.efftime=base+comT*1000-comT;
        if(x.lapPenalty)x.efftime=1e18;
        return x;
      });
    });
  }

  function patchAll(){
    if(!Array.isArray(window.events))return;
    window.events.forEach(patchEvent);
  }

  // Appliquer avant chaque render/calculate
  const _origRender=window.render;
  if(_origRender){
    window.render=function(){
      try{patchAll();}catch(e){console.warn('[v44] patch error',e)}
      return _origRender.apply(this,arguments);
    };
  }
  // Appliquer aussi avant calculate (appelé par d'autres chemins)
  const _origCalc=window.calculate;
  if(_origCalc){
    window.calculate=function(){
      try{patchAll();}catch(e){console.warn('[v44] patch error',e)}
      return _origCalc.apply(this,arguments);
    };
  }

  function install(){
    // S'exécuter dès que events est chargé
    if(Array.isArray(window.events)){
      try{patchAll();if(window.render)window.render();}catch(e){console.warn('[v44] init error',e)}
    }else{
      setTimeout(install,80);
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

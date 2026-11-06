/* GDSP v41 — ajoute un bouton ABANDON dans la Commission.
 * À charger APRÈS patches-v40.js.
 * Un abandon (ABD/DNF) :
 *   - reclasse le pilote en fin de grille (derrière les finishers, avec les DQ)
 *   - ne lui attribue aucun point
 *   - affiche "ABD" dans les résultats (contrairement à "DQ" qui est une faute)
 */
(function(){
  'use strict';
  if(window.__GDSP_V41)return; window.__GDSP_V41=true;

  // ---- Étendre applyCommissionToArr pour gérer dnf:true ----
  const _applyCommission = window.applyCommissionToArr;
  window.applyCommissionToArr = function(arr,sess,rIdx,sIdx){
    _applyCommission(arr,sess,rIdx,sIdx);
    // On relit penMap pour ajouter les ABD (dnf:true) → comDNF
    const rk=(rIdx>=0&&sIdx>=0)?(rIdx+':'+sIdx+':'):null;
    for(const k in penMap){
      if(rk&&!k.startsWith(rk))continue;
      const c1=k.indexOf(':');if(c1<0)continue;
      const c2=k.indexOf(':',c1+1);if(c2<0)continue;
      const rj=+k.slice(0,c1),sj=+k.slice(c1+1,c2),did=k.slice(c2+1);
      if(rk&&(rj!==rIdx||sj!==sIdx))continue;
      const adj=penMap[k];if(!adj||!adj.dnf)continue;
      const y=arr.find(x=>x.id===did);
      if(y){y.comDNF=true;y.comDQ=false;y.comTimeAdd=0;y.comWarning=false}
    }
    return arr;
  };

  // ---- Étendre sortSession pour traiter les DNF ----
  const _sortSession = window.sortSession;
  window.sortSession = function(sess){
    if(!sess)return [];
    const arr=_sortSession(sess);
    // _sortSession a déjà appliqué les pénalités et mis _t,_dq,finalTime,finalDQ
    // On ajoute le traitement des abandons.
    arr.forEach(x=>{
      if(x.comDNF){
        // Un abandon = pas classé, on force le temps à l'infini et on l'identifie.
        x._t=10**18;
        x.finalTime=x._t;
        x.finalDQ=true; // finishStatus() verra finalDQ=true → pas de points
        x._dnf=true;
        // Un abandon ne doit PAS être compté comme DQ faute : retirer comDQ si posé
        x.comDQ=false;x._dq=false;
      }
    });
    // Retrier : finishers → abandons (triés par tours décroissants) → DQ
    arr.sort((a,b)=>{
      const aOut=a._dnf?1:(a._dq?2:0);
      const bOut=b._dnf?1:(b._dq?2:0);
      if(aOut!==bOut)return aOut-bOut;
      return b.laps-a.laps||a._t-b._t;
    });
    return arr;
  };

  // ---- Remplacer openAdjForm pour proposer Abandon ----
  window.openAdjForm=function(rj,sj,did){
    // Menu : proposer plusieurs options via un prompt choix
    const choix=prompt(
      'Type d\'ajustement pour ce pilote :\n'+
      '  1 = Pénalité de temps (en secondes, ex: +10 ou -5)\n'+
      '  2 = Abandon (DNF / ABD)\n'+
      '  3 = Disqualification (DQ - drapeau noir)\n'+
      '  4 = Avertissement sans sanction\n'+
      '  0 = Annuler',
      '1');
    if(choix===null)return;
    const c=choix.trim();
    if(c==='0'||c==='')return;
    if(c==='2'){
      if(!confirm('Marquer ce pilote en ABANDON (ABD/DNF) ? Il sera déclassé et ne marquera pas de point.'))return;
      const note=prompt('Note / motif d\'abandon ?','')||'';
      addAdjustment(rj,sj,did,0,false,false,note,{dnf:true});
      return;
    }
    if(c==='3'){
      const dq=confirm('DQ (drapeau noir) ?');if(!dq)return;
      const note=prompt('Note / motif ?','')||'';
      addAdjustment(rj,sj,did,0,true,false,note);
      return;
    }
    if(c==='4'){
      if(!confirm('Avertissement sans sanction (pas de déclassement) ?'))return;
      addAdjustment(rj,sj,did,0,false,true,'');
      return;
    }
    // Défaut : pénalité de temps
    const ta=prompt('Ajustement temps en secondes (exemples : +10 pour ajouter 10s, -5 pour annuler 5s de pénalité serveur, +120 pour 2 minutes, etc.) ?','0');
    if(ta===null)return;
    const timeAdd=+ta||0;
    const dq=false;
    const warning=false;
    const note=prompt('Note / motif ?','')||'';
    addAdjustment(rj,sj,did,timeAdd,dq,warning,note);
  };

  // ---- Surcharger addAdjustment pour accepter un 5e param "opts" (dnf) ----
  const _addAdjustment=window.addAdjustment;
  window.addAdjustment=function(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note,opts){
    if(opts&&opts.dnf){
      penMap[`${roundKey}:${sessionIdx}:${drvId}`]={dnf:true,timeAdd:0,dq:false,warning:false,note:note||'Abandon'};
    }else{
      penMap[`${roundKey}:${sessionIdx}:${drvId}`]={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};
    }
    saveState();render();
  };

  // ---- Affichage "ABD" dans les tableaux de résultats (post-render) ----
  function labelDNFs(){
    // Parcourir toutes les lignes de résultats dans le panneau actif et repérer les
    // pilotes qui sont comDNF dans la session affichée. On ne peut pas lire les
    // données internes du rendu facilement ; on se base sur le temps <gapTo> et
    // la position : si gapTo renvoie "—" et que le pilote n'est pas en tête ET
    // qu'il y a un abandon correspondant dans penMap, on ajoute "ABD".
    // Plus robuste : repérer par le nom du pilote et l'état de sortSession.
    if(page!=='manches')return;
    const rs=rounds();
    const r=rs[round];if(!r)return;
    const rows=r.sessions.slice(0,sessionIndex+1);
    const s=r.sessions[sessionIndex];if(!s||s.type!=='RACE')return;
    const sorted=sortSession(s);
    // Les DNF sont les x avec x.comDNF=true ou x.finalDQ && temps=10^18 à la fin
    const dnfIds=new Set(sorted.filter(x=>x.comDNF).map(x=>x.id));
    const dqIds=new Set(sorted.filter(x=>!x.comDNF&&(x.disqualified||x.comDQ)).map(x=>x.id));
    // Dans le tableau, chercher les lignes dont le nom correspond à un pilote DNF/DQ
    const cells=document.querySelectorAll('.table-wrap tbody tr');
    cells.forEach(tr=>{
      const tds=tr.querySelectorAll('td');
      if(tds.length<5)return;
      // La cellule nom est la 2e colonne (indice 1). Chercher dans results le pilote.
      const nameCell=tds[1];
      if(!nameCell)return;
      const nameText=(nameCell.textContent||'').trim();
      // Récupérer le pilote dans sorted par nom
      const p=sorted.find(x=>(x.name||'').trim()===nameText);
      if(!p)return;
      const last=tds[tds.length-1];
      const prev=tds[tds.length-2];
      if(p.comDNF){
        last.innerHTML='<span style="color:#9c3021;font-weight:700">ABD</span>';
        if(prev)prev.textContent='—';
      }else if(p.comDQ||p.disqualified){
        last.innerHTML='<span style="color:#9c3021;font-weight:700">DQ</span>';
        if(prev)prev.textContent='—';
      }
    });
  }
  const _render2=window.render;
  window.render=function(){_render2();setTimeout(labelDNFs,0)};

  // ---- Affichage dans le tableau Commission (colonne ajustement) ----
  // Déjà géré car adjList est construit dans admin() ; on ne remplace pas admin() ici
  // pour ne pas le casser. On ajoute un post-traitement qui corrige la cellule label.
  function fixAdjList(){
    // La table d'ajustements n'a pas de data-attr simple ; on corrige en ajoutant
    // une ligne "ABD" là où le champ dnf=true est présent.
    document.querySelectorAll('.panel table tbody tr').forEach(tr=>{
      const cells=tr.querySelectorAll('td');
      if(cells.length<6)return;
      // Dernière cellule avant le bouton = ajustement ; chercher le onclick du bouton
      const btn=tr.querySelector('button[onclick^="removeAdjustment"]');
      if(!btn)return;
      const m=btn.getAttribute('onclick').match(/removeAdjustment\('([^']+)'\)/);
      if(!m)return;const key=m[1];
      const adj=penMap[key];if(!adj)return;
      const labelCell=cells[3];if(!labelCell)return;
      if(adj.dnf){labelCell.innerHTML='<span style="color:#9c3021;font-weight:700">ABD</span>'}
    });
  }
  // Wrapper render (appelé après le wrapper de v40 — les wrappers se chaînent)
  const _render3=window.render;
  window.render=function(){_render3();setTimeout(fixAdjList,0)};

  // ---- Patch calculate() pour que effDQ tienne compte de comDNF ----
  // calculate() est une fonction volumineuse définie dans site.js ; on ne la remplace
  // pas entièrement mais on wrap l'accès à effDQ en redéfinissant race.results dans
  // les boucles après sortSession. Comme sortSession remplace déjà sess.results par les
  // clones triés qui portent finalDQ=true sur les comDNF (cf. ci-dessus), il faut
  // simplement que effDQ() à l'intérieur de calculate() soit cohérent.
  // Or effDQ() dans calculate() est une fonction locale à calculate() qui teste
  // p.finalDQ||p.disqualified||p.comDQ. Puisque nos clones portent finalDQ=true
  // sur les comDNF, c'est OK. Mais il faut s'assurer que raceTime renvoie bien le
  // _t à 10^18 et non le temps de base — c'est fait via x.finalTime=x._t ci-dessus.

  // Petit correctif : dans le tableau des résultats course, les pilotes comDNF
  // n'ont pas de gap-to-leader affiché correctement car manche() utilise sa propre
  // fonction gapTo qui lit eff(a)/eff(b). gapTo lit p._t ou p.finalTime, et comme
  // on a mis _t=10^18 et _dq=false, il faut marquer ces pilotes comme non-classés
  // pour que gapTo renvoie "—" au lieu d'un énorme nombre de secondes.
  const _gapPatch = setInterval(()=>{
    if(!window.showevent)return;
    clearInterval(_gapPatch);
    // On wrap manche() pour que dans resultrows les pilotes comDNF soient affichés ABD
    const _manche=window.manche;
    window.manche=function(){
      const html=_manche();
      // Manche() a déjà rendu le HTML ; on retouche après coup (labelDNFs le fait déjà).
      return html;
    };
  },50);

  console.log('[GDSP v41] bouton Abandon ajouté.');
})();

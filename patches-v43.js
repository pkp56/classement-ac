// patches-v43.js — ajoute les « ? » dorés sur les profils GLOBAL.
// Le style des bulles est défini dans index.html pour que le script reste autonome.
// L'observateur est DÉCONNECTÉ pendant les mutations pour éviter une boucle
// infinie (insertAdjacentHTML → mutation → callback → insertAdjacentHTML → …)
// qui faisait planter l'onglet.
(function(){
  'use strict';
  if(window.__gdspV43Installed)return;
  window.__gdspV43Installed=true;

  const TIPS={
    regularite:`<b>Régularité inter-événements</b><br>Cohérence du rythme du pilote d'une course à l'autre (écart-type normalisé de ses meilleurs tours relatifs sur chaque meeting).<br>Plus le pilote est constant dans sa performance, plus son score est élevé.<br>Pondération récente : demi-vie 90 jours.`,
    progression:`<b>Progression</b><br>Pente de régression linéaire de la position en fonction du temps, toutes compétitions confondues.<br>100 = plus forte amélioration ; 0 = plus forte régression.<br>Moins de 3 courses → 50 (neutre).`
  };

  let mo=null;
  let running=false;

  function ensureTips(){
    if(running)return;
    running=true;
    try{
      const app=document.getElementById('app');
      if(!app||!mo)return;

      // === ARRÊTER d'observer avant de toucher au DOM ===
      mo.disconnect();

      const allB=app.querySelectorAll('b');
      allB.forEach(b=>{
        // Ne rien faire si la bulle v43 est déjà présente juste après <b>
        // (soit un .gdsp-v43 frère, soit un .gdsp-v43 dans le parent)
        let sib=b.nextSibling;
        while(sib && (sib.nodeType===3 /* text */ || (sib.classList && (sib.classList.contains('gdsp-v43')||sib.classList.contains('gdsp-tip'))))){
          if(sib.classList && sib.classList.contains('gdsp-v43'))return; // bulle déjà posée
          sib=sib.nextSibling;
        }

        const txt=b.textContent.trim();
        let key=null;
        if(txt==='Régularité inter-événements'){
          key='regularite';
        }else if(txt==='Progression'){
          // N'ajouter la bulle que sur les lignes de barre (même parent qu'un span « N / 100 »)
          const parent=b.parentElement;
          if(!parent)return;
          const hasScore=[...parent.children].some(c=>c!==b && /\d+\s*\/\s*100/.test(c.textContent||''));
          if(!hasScore)return;
          key='progression';
        }
        if(!key)return;

        // Insérer un espace + span.gdsp-tip APRÈS le <b>, en réutilisant le CSS de v42
        b.insertAdjacentText('afterend',' ');
        const sp=document.createElement('span');
        sp.className='gdsp-tip gdsp-v43';
        sp.innerHTML=`<i class="gdsp-i">?</i><span class="gdsp-bubble">${TIPS[key]}</span>`;
        b.insertAdjacentElement('afterend',sp);
      });
    }finally{
      running=false;
      // === RÉACTIVER l'observateur ===
      const app=document.getElementById('app');
      if(app && mo){
        mo.observe(app,{childList:true,subtree:true});
      }
    }
  }

  function install(){
    const app=document.getElementById('app');
    if(!app){setTimeout(install,80);return;}
    mo=new MutationObserver(()=>{
      if(mo._t)cancelAnimationFrame(mo._t);
      mo._t=requestAnimationFrame(ensureTips);
    });
    mo.observe(app,{childList:true,subtree:true});
    ensureTips();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

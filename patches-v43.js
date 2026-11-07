// patches-v43.js — v49 : ajoute les « ? » dorés manquants sur les barres
// « Régularité inter-événements » et « Progression » du profil GLOBAL.
// Utilise un MutationObserver pour ajouter les bulles d'aide après chaque render,
// en se chaînant proprement après patches-v42.js qui définit déjà .gdsp-tip/.gdsp-i/.gdsp-bubble.
(function(){
  'use strict';
  if(window.__gdspV43Installed)return;
  window.__gdspV43Installed=true;

  const TIPS={
    regularite:`<b>Régularité inter-événements</b><br>Cohérence du rythme du pilote d'une course à l'autre (écart-type normalisé de ses meilleurs tours relatifs sur chaque meeting).<br>Plus le pilote est constant dans sa performance, plus son score est élevé.<br>Pondération récente : demi-vie 90 jours.`,
    progression:`<b>Progression</b><br>Pente de régression linéaire de la position en fonction du temps, toutes compétitions confondues.<br>100 = plus forte amélioration ; 0 = plus forte régression.<br>Moins de 3 courses → 50 (neutre).`
  };
  function bubble(k){
    return `<span class="gdsp-tip"><i class="gdsp-i">?</i><span class="gdsp-bubble">${TIPS[k]}</span></span>`;
  }

  function ensureTips(){
    const app=document.getElementById('app');
    if(!app)return;
    const allB=app.querySelectorAll('b');
    allB.forEach(b=>{
      // Éviter de doubler si la bulle est déjà là
      if(b.nextElementSibling && b.nextElementSibling.classList && b.nextElementSibling.classList.contains('gdsp-tip'))return;
      const txt=b.textContent.trim();
      let key=null;
      if(txt==='Régularité inter-événements')key='regularite';
      else if(txt==='Progression'){
        // Seulement si on est dans une ligne de barre de critère (ligne flex avec un "N / 100" juste après)
        const parent=b.parentElement;
        if(!parent)return;
        const sibling=parent.querySelector('span');
        const nearScore=sibling && /\d+\s*\/\s*100/.test(sibling.textContent||'');
        // Éviter les "Progression moyenne" des points-faibles etc.
        if(!nearScore)return;
        key='progression';
      }
      if(!key)return;
      b.insertAdjacentHTML('afterend',' '+bubble(key));
    });
  }

  function install(){
    const app=document.getElementById('app');
    if(!app){setTimeout(install,80);return;}
    // Observer les changements du DOM
    const mo=new MutationObserver(()=>{
      // Debounce RAF
      if(install._t)cancelAnimationFrame(install._t);
      install._t=requestAnimationFrame(ensureTips);
    });
    mo.observe(app,{childList:true,subtree:true});
    // Premier passage
    ensureTips();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

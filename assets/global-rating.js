/* GDSP Global v2 — calcul pur partagé par le navigateur et les tests. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GDSPGlobalRating=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const AXES=['regularite','proprete','vitesse','resultats'];
  const SEVERITIES=Object.freeze({warning:5,minor:10,major:20,severe:35,dq:50});
  // Détection automatique GDSP (Global, en secours de la Commission) :
  // chaque cut +2 ; choc arrière à fort delta de vitesse : secondes perdues par la
  // victime ÷ 2 ; côte à côte et touchettes < 1,5 s : 0. La rentrée dangereuse de
  // la voiture heurtée n'est pas détectable ici : seule la Commission tranche.
  function autoConduct(detail){
    const cuts=Math.max(0,Number(detail&&detail.cuts)||0);
    const lossSec=Math.max(0,Number(detail&&detail.lossSec)||0);
    const incidents=Array.isArray(detail&&detail.incidents)?detail.incidents.length:0;
    const cutPoints=cuts*2,collisionPoints=lossSec/2;
    return {score:Math.max(0,100-cutPoints-collisionPoints),auto:true,cuts,lossSec,cutPoints,collisionPoints,incidents,deduction:cutPoints+collisionPoints};
  }
  function conduct(adjustment,auto){
    const a=adjustment||{},review=a.conduct;
    if(review&&review.version===1&&review.reviewed===true&&Array.isArray(review.incidents)){
      let deduction=0,returned=0;
      for(const incident of review.incidents){
        if(!incident||!Object.hasOwn(SEVERITIES,incident.severity))return {score:null,reviewed:false,pending:true,returned:0};
        let points=SEVERITIES[incident.severity];
        if(incident.returned===true){
          returned++;
          if(incident.severity!=='severe'&&incident.severity!=='dq'&&incident.intentional!==true)points/=2;
        }
        deduction+=points;
      }
      return {score:Math.max(0,100-deduction),reviewed:true,pending:false,returned,reason:String(review.reason||'')};
    }
    // DNF/DNS, pénalités techniques et corrections de points ne prouvent pas
    // une faute de conduite. Une décision non qualifiée n'est jamais convertie —
    // même pas via la détection automatique.
    const pending=!!(a.warning||a.dq||Number(a.timeAdd)!==0&&Number.isFinite(Number(a.timeAdd)));
    if(pending)return {score:null,reviewed:false,pending:true,returned:0};
    if(auto&&Number.isFinite(auto.score))return {score:auto.score,reviewed:false,pending:false,returned:0,auto:true,cuts:auto.cuts||0,lossSec:auto.lossSec||0,incidents:auto.incidents||0};
    return {score:100,reviewed:false,pending:false,returned:0};
  }
  function reviewSignature(value){
    if(Array.isArray(value))return '['+value.map(reviewSignature).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+reviewSignature(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function percentile(entries,key){
    const valid=entries.filter(e=>Number.isFinite(e[key]));
    return entries.map(e=>{
      if(valid.length<2||!Number.isFinite(e[key]))return null;
      const better=valid.filter(x=>x[key]<e[key]).length;
      const equal=valid.filter(x=>x[key]===e[key]).length;
      return 100*(1-(better+(equal-1)/2)/(valid.length-1));
    });
  }
  function average(values,fallback=50){
    const valid=values.filter(Number.isFinite);
    return valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:fallback;
  }
  function weightedAverage(entries,fallback=50){
    let sum=0,totalWeight=0;
    for(const e of entries){
      if(!e||!Number.isFinite(e.value))continue;
      const w=e.weight==null?1:Number(e.weight);
      if(!Number.isFinite(w)||w<=0)continue;
      sum+=e.value*w;
      totalWeight+=w;
    }
    return totalWeight>0?sum/totalWeight:fallback;
  }
  function aggregate(records,{minRaces=5,hidden={}}={}){
    const byPilot=new Map();
    for(const r of records){
      if(!r.id||!Number.isFinite(r.ts)||r.dns||r.started===false)continue;
      const w=r.weight==null?1:Number(r.weight);
      if(!Number.isFinite(w)||w<=0)continue;
      if(!byPilot.has(r.id))byPilot.set(r.id,new Map());
      // Un identifiant stable évite de compter deux fois une session importée.
      byPilot.get(r.id).set(r.key,r);
    }
    const output=[];
    for(const [id,unique] of byPilot){
      const all=[...unique.values()].sort((a,b)=>b.ts-a.ts||String(a.key).localeCompare(String(b.key)));
      if(all.length<minRaces||hidden[id])continue;
      const window=all.slice(0,10);
      const rawScore=r=>average(AXES.map(k=>Number.isFinite(r.axes[k])?r.axes[k]:50));
      // En cas d'égalité, joker sur la plus ancienne des courses à égalité.
      const worst=window.length===10?window.reduce((a,b)=>rawScore(a)<rawScore(b)?a:b):null;
      const retained=window.filter(r=>r!==worst);
      const details=Object.fromEntries(AXES.map(k=>[k,weightedAverage((k==='proprete'?window:retained).map(r=>({value:r.axes[k],weight:r.weight})))]));
      // Toute la propreté des dix courses reste : un joker sportif ne gomme
      // ni la sanction, ni une décision encore à qualifier.
      const score=average(AXES.map(k=>details[k]));
      const pending=window.filter(r=>r.conduct.pending).length;
      const reviewed=window.filter(r=>r.conduct.reviewed).length;
      const autoCount=window.filter(r=>r.conduct.auto).length;
      const evaluated=reviewed+autoCount+window.filter(r=>Number.isFinite(r.axes.proprete)&&!r.conduct.reviewed&&!r.conduct.auto).length;
      const missing=window.some(r=>['regularite','vitesse'].some(k=>!Number.isFinite(r.axes[k])));
      output.push({id,name:all[0].name||'?',team:all[0].team||'',score,details:{...details,progression:50},
        count:all.length,windowCount:window.length,retainedCount:retained.length,
        provisional:window.length<10||pending>0||evaluated<window.length||missing,
        sportingProvisional:window.length<10,conductPending:pending,conductReviewed:reviewed,conductAuto:autoCount,
        returned:window.reduce((s,r)=>s+(r.conduct.returned||0),0),trend:0,
        joker:worst?{key:worst.key,label:worst.label,date:worst.date}:null,
        window:window.map(r=>({key:r.key,label:r.label,date:r.date,axes:r.axes,conduct:r.conduct,joker:r===worst}))});
    }
    return output.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  }
  return {SEVERITIES,conduct,autoConduct,percentile,aggregate,reviewSignature};
});

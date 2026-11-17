/* GDSP Global v2 — calcul pur partagé par le navigateur et les tests. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GDSPGlobalRating=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const AXES=['regularite','proprete','vitesse','resultats'];
  const SEVERITIES=Object.freeze({warning:5,minor:10,major:20,severe:35,dq:50});
  function conduct(adjustment){
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
    // une faute de conduite. Une décision non qualifiée n'est jamais convertie.
    const pending=!!(a.warning||a.dq||Number(a.timeAdd)!==0&&Number.isFinite(Number(a.timeAdd)));
    return {score:pending?null:100,reviewed:false,pending,returned:0};
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
  function aggregate(records,{minRaces=5,hidden={}}={}){
    const byPilot=new Map();
    for(const r of records){
      if(!r.id||!Number.isFinite(r.ts)||r.dns||r.started===false)continue;
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
      const details=Object.fromEntries(AXES.map(k=>[k,average((k==='proprete'?window:retained).map(r=>r.axes[k]))]));
      // Toute la propreté des dix courses reste : un joker sportif ne gomme
      // ni la sanction, ni une décision encore à qualifier.
      const score=average(AXES.map(k=>details[k]));
      const pending=window.filter(r=>r.conduct.pending).length;
      const reviewed=window.filter(r=>r.conduct.reviewed).length;
      const missing=window.some(r=>['regularite','vitesse'].some(k=>!Number.isFinite(r.axes[k])));
      output.push({id,name:all[0].name||'?',team:all[0].team||'',score,details:{...details,progression:50},
        count:all.length,windowCount:window.length,retainedCount:retained.length,
        provisional:window.length<10||pending>0||reviewed<window.length||missing,
        sportingProvisional:window.length<10,conductPending:pending,conductReviewed:reviewed,
        returned:window.reduce((s,r)=>s+(r.conduct.returned||0),0),trend:0,
        joker:worst?{key:worst.key,label:worst.label,date:worst.date}:null,
        window:window.map(r=>({key:r.key,label:r.label,date:r.date,axes:r.axes,conduct:r.conduct,joker:r===worst}))});
    }
    return output.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  }
  return {SEVERITIES,conduct,percentile,aggregate,reviewSignature};
});

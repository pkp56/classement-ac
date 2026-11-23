'use strict';
// Adaptateur mobile pour le moteur de résultats partagé avec le site PC
// (patches-v71.js). Les calculs utilisent des copies, jamais les données reçues.
var sessions=[],penMap={},eventContext=null;
var DEFAULT_POINTS={pointsScale:[41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],polePoints:1,doubleLongRaces:true,longRaceMinutes:60,minPercentDistance:0.75,jokerCount:5,globalCoef:1.0};
function pointsConfig(){return Object.assign({},DEFAULT_POINTS,eventContext&&eventContext.pointsConfig||{});}
function rounds(){
  const byDate=new Map(),typeOrder={QUALIFY:0,RACE:1,PRACTICE:2};
  sessions.filter(s=>s&&s.date).forEach(s=>{
    const key=String(s.date).slice(0,10);
    if(!byDate.has(key))byDate.set(key,[]);
    byDate.get(key).push(s);
  });
  return [...byDate.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,list],i)=>{
    list.sort((a,b)=>(typeOrder[a.type]??9)-(typeOrder[b.type]??9)||String(a.date||'').localeCompare(String(b.date||'')));
    return {date,sessions:list,track:String(list[0].track||''),number:i+1};
  });
}
function findSessionIdx(sess){const rs=rounds();for(let i=0;i<rs.length;i++){const j=rs[i].sessions.indexOf(sess);if(j>=0)return [i,j];}return [-1,-1];}
function allDrivers(){
  const map=new Map();
  for(const s of sessions)for(const r of s.results){if(!map.has(r.id))map.set(r.id,{...r});}
  return [...map.values()].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
}
function jokerTotal(scores){
  const values=Array.isArray(scores)?scores.filter(Number.isFinite):[];
  const configured=Number(pointsConfig().jokerCount)||0;
  const lola=eventContext&&['lola-t290-gdsp-championnat-2026','lola-t290-2026'].includes(eventContext.slug);
  const keep=lola?(values.length>1?values.length-1:values.length):(configured>0?Math.min(configured,values.length):values.length);
  return [...values].sort((a,b)=>b-a).slice(0,keep).reduce((a,b)=>a+b,0);
}
window.gdspMobileResults={
  calculate(ev){
    if(typeof window.calculate!=='function'||typeof window.sessionPoints!=='function')throw new Error('Moteur de résultats indisponible.');
    const data=ev&&ev.data&&typeof ev.data==='object'?ev.data:{};
    const manual=data.manualDrivers&&typeof data.manualDrivers==='object'?data.manualDrivers:{};
    eventContext={slug:ev.slug,pointsConfig:ev.points_config||{}};
    penMap=data.penMap&&typeof data.penMap==='object'?data.penMap:{};
    sessions=(Array.isArray(data.sessions)?data.sessions:[]).filter(s=>s&&typeof s==='object').map(s=>({
      ...s,results:(Array.isArray(s.results)?s.results:[]).filter(r=>r&&typeof r==='object').map(r=>{
        const driver=manual[r.id];return driver?{...r,name:driver.name,team:driver.team||''}:{...r};
      })
    }));
    const standings=window.calculate().sort((a,b)=>b.total-a.total||String(a.name||'').localeCompare(String(b.name||'')));
    const teams=new Map(),count=rounds().length;
    for(const d of standings){
      const name=String(d.team||'').trim();if(!name||/indépendant/i.test(name))continue;
      const key=name.toLocaleLowerCase('fr');if(!teams.has(key))teams.set(key,{name,rounds:Array(count).fill(0),pointsAdj:0,count:0});
      const team=teams.get(key);team.count++;team.pointsAdj+=d.pointsAdj||0;
      for(let j=0;j<count;j++)team.rounds[j]+=d.rounds[j]||0;
    }
    const teamStandings=[...teams.values()].map(t=>({...t,joker:jokerTotal(t.rounds)+t.pointsAdj})).sort((a,b)=>b.joker-a.joker);
    const resultRounds=rounds().map(r=>({...r,sessions:r.sessions.filter(s=>s.type==='QUALIFY'||s.type==='RACE').map(s=>{
      const points=window.sessionPoints(s);
      return {...s,results:s.results.map(p=>({...p,points:points.get(p.id)||0}))};
    })}));
    return {standings,teamStandings,rounds:resultRounds};
  }
};

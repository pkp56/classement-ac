/* Moteur de profils mobile. Les fonctions ci-dessous sont des copies exactes
 * de site.js : tests/site-boot.test.js vérifie leur parité à chaque changement.
 * GDSPGlobalRating (assets/global-rating.js) reste la source des règles Global. */
(function(root){
'use strict';
let sessions=[],penMap={},events=[],globalHidden={},eventConfig={};
const GLOBAL_MIN_RACES=5;
const pointsConfig=()=>Object.assign({minPercentDistance:0.75},eventConfig);
const eventKindMeta=kind=>({coef:({championship:1,endurance:1,cup:0.75,open:0.5,fiesta:0,trackday:0,archive:1})[kind]??1});
function eventGlobalWeight(ev){
  const raw=ev&&ev.points_config&&ev.points_config.globalCoef;
  if(raw!==undefined&&raw!==null&&raw!==''){
    const n=Number(raw);
    if(Number.isFinite(n)&&n>=0)return n;
  }
  return eventKindMeta(ev&&ev.kind).coef;
}

const FAULT_SIDE_Z=1.0;      // |Z| >= 1.0 m → choc latéral / côte à côte → 0-0
const FAULT_REAR_X=0.4;      // |X| >= 0.4 m → choc avant/arrière franc
const FAULT_LOSS_MIN=1.5;    // perte minimale de la victime (en s) pour compter la faute
const FAULT_DIVISOR=2;       // points de faute = secondes perdues / 2
const FAULT_CUT_WEIGHT=1;    // +1 point par cut de piste
const PIT_SLOW_MS=21000;     // tour > meilleur tour + 21 s considéré comme tour stand / sortie

function groupSessionsByDate(sessList){
  const m={};
  (sessList||[]).filter(s=>s&&s.date).forEach(s=>(m[String(s.date).slice(0,10)]??=[]).push(s));
  return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).map(([dt,ss],idx)=>({
    date:dt,sessions:ss,ts:new Date(ss[0].date||dt).getTime(),roundIndex:idx
  }));
}

// Régularité (Race Consistency type iRacing) : moyenne(tour - best) en ms, 1er tour et tours > best+21s exclus.
function raceConsistencyMs(lapsRaw){
  const all=(lapsRaw||[]).map(l=>Number(l&&(Number.isFinite(l.LapTime)?l.LapTime:l.time))).filter(t=>Number.isFinite(t)&&t>0&&t<600000);
  if(all.length<3)return null;
  const rest=all.slice(1);
  const best1=Math.min(...rest);
  if(!Number.isFinite(best1)||best1<=0)return null;
  const nonPit=rest.filter(t=>t-best1<=PIT_SLOW_MS);
  if(nonPit.length<2)return null;
  const best2=Math.min(...nonPit);
  const nonBest=nonPit.filter(t=>t>best2);
  if(nonBest.length===0)return 0;
  return nonBest.reduce((a,t)=>a+(t-best2),0)/nonBest.length;
}

// Barème v45 du critère Résultats (variable selon la taille de grille N ; DNF/DNS/DQ = 0).
function scoreResultsV45(N,P,isOut){
  if(isOut)return 0.0;
  if(N<=1)return 50.0;
  const pos=Math.max(1,Math.min(N,P));
  const amplitude=N>=28?100:10+(90*(N-2)/26);
  const s=Math.max(0,Math.min(100,50+amplitude*(N+1-2*pos)/(2*(N-1))));
  return Math.round(s*10)/10;
}

// Tri d'une session en appliquant les décisions Commission de son événement (sans muter la source).
function sortSessionForPerf(sess,rIdx,sIdx,evPenMap,minPct=0.75){
  if(!sess||!Array.isArray(sess.results))return [];
  const arr=sess.results.map(r=>({...r,comTimeAdd:0,comDQ:false,comDNF:false,comDNS:false,comWarning:false}));
  if(evPenMap&&typeof evPenMap==='object'&&rIdx>=0&&sIdx>=0){
    const prefix=`${rIdx}:${sIdx}:`;
    for(const k in evPenMap){
      if(!k.startsWith(prefix))continue;
      const did=k.slice(prefix.length);
      const y=arr.find(x=>x.id===did);if(!y)continue;
      const adj=evPenMap[k];if(!adj)continue;
      if(adj.dq)y.comDQ=true;
      if(adj.dns)y.comDNS=true;
      if(adj.dnf)y.comDNF=true;
      if(adj.warning)y.comWarning=true;
      if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0)y.comTimeAdd+=(adj.timeAdd*1000);
    }
  }
  if(sess.type==='QUALIFY'){
    arr.forEach(x=>{
      x._dq=!!(x.disqualified||x.comDQ||x.comDNS);
      const b=Number.isFinite(x.best)&&x.best>0?x.best:1e18;
      x._adjustedBest=b<1e17?Math.max(1,b+(x.comTimeAdd||0)):1e18;
    });
    arr.sort((a,b)=>{
      const aOk=!a._dq&&(a.laps||0)>=2&&a._adjustedBest<1e17;
      const bOk=!b._dq&&(b.laps||0)>=2&&b._adjustedBest<1e17;
      if(aOk!==bOk)return aOk?-1:1;
      return a._adjustedBest-b._adjustedBest||(b.laps||0)-(a.laps||0);
    });
    return arr;
  }
  arr.forEach(x=>{
    const base=Number.isFinite(x.time)&&x.time>0?x.time:1e18;
    x._eff=base;
    x._t=base<1e17?base+(x.comTimeAdd||0):1e18;
    x._dq=!!(x.disqualified||x.comDQ||x.comDNS);
    if(x._dq||x.comDNF||(x.laps||0)<=0)x._t=1e18;
  });
  const maxLaps=Math.max(0,...arr.filter(x=>!x._dq&&!x.comDNS).map(x=>x.laps||0));
  const minLaps=Math.ceil(maxLaps*(Number.isFinite(minPct)?minPct:0.75));
  arr.forEach(x=>{
    if(!x._dq&&!x.comDNS&&(x.laps||0)<minLaps){x.comDNF=true;x._t=1e18;}
  });
  let wl=0,wt=1e18;
  for(const x of arr){
    if(x._dq||x.comDNS||x.comDNF||x._t>=1e17)continue;
    const L=x.laps||0;
    if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}
  }
  const fin=[],cls=[],nc=[],dq=[];
  for(const x of arr){
    if(x._dq||x.comDNS){dq.push(x);continue;}
    if(x.comDNF||x._t>=1e17||(x.laps||0)<minLaps){x.comDNF=true;nc.push(x);continue;}
    if(wl>0&&wt<1e17&&x._t>=wt)fin.push(x);
    else if(wl>0&&(x.laps||0)>=minLaps)cls.push(x);
    else{x.comDNF=true;nc.push(x);}
  }
  fin.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
  cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t);
  nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
  dq.sort((a,b)=>(b.laps||0)-(a.laps||0));
  return [...fin,...cls,...nc,...dq];
}

// Option 3 : score de fautes sur une course (cuts + chocs arrière causant >= 1,5 s de perte à la victime).
function raceFoulScores(race){
  const lapsById={};
  const byCarId={},byName={};
  (race.results||[]).forEach(r=>{
    if(!r)return;
    if(r.CarId!=null&&r.id)byCarId[r.CarId]=r.id;
    if(r.DriverName&&r.id)byName[String(r.DriverName).trim().toLowerCase()]=r.id;
    if(r.name&&r.id)byName[String(r.name).trim().toLowerCase()]=r.id;
  });
  (race.laps||[]).forEach(l=>{
    if(!l)return;
    const lid=l.id||(l.CarId!=null?byCarId[l.CarId]:null);
    if(!lid)return;
    if(!lapsById[lid])lapsById[lid]=[];
    lapsById[lid].push(l);
  });
  function driverPaceMs(id){
    const ls=(lapsById[id]||[]).map(l=>Number(Number.isFinite(l.LapTime)?l.LapTime:l.time)).filter(t=>Number.isFinite(t)&&t>0&&t<600000);
    if(ls.length<3)return null;
    const rest=ls.slice(1);
    const best=Math.min(...rest);
    const nonPit=rest.filter(t=>t-best<=PIT_SLOW_MS);
    return nonPit.length>=2?Math.min(...nonPit):best;
  }
  function resolveId(ev,which){
    const cid=ev[which==='a'?'CarId':'OtherCarId'];
    if(cid!=null&&byCarId[cid])return byCarId[cid];
    const idKey=which==='a'?'aid':'bid',nKey=which==='a'?'a':'b';
    if(ev[idKey])return ev[idKey];
    const nm=ev[nKey];
    if(nm){const k=String(nm).trim().toLowerCase();if(byName[k])return byName[k];}
    return null;
  }
  function evTsSec(ev){
    const raw=Number.isFinite(ev.Timestamp)?ev.Timestamp:ev.timestamp;
    if(!Number.isFinite(raw))return null;
    return raw>1e11?raw/1000:raw;
  }
  function lapTsSec(l){
    const raw=Number.isFinite(l.Timestamp)?l.Timestamp:l.timestamp;
    if(!Number.isFinite(raw))return null;
    return raw>1e11?raw/1000:raw;
  }
  const scores=new Map();
  const add=(id,pts)=>{if(!id||!Number.isFinite(pts))return;scores.set(id,(scores.get(id)||0)+pts);};

  // 1) Cuts de piste (+1 pt / cut)
  (race.results||[]).forEach(r=>{
    if(!r||!r.id)return;
    let c=0;
    (lapsById[r.id]||[]).forEach(l=>{
      const v=Number.isFinite(l.cuts)?l.cuts:(Number.isFinite(l.Cuts)?l.Cuts:0);
      c+=Math.max(0,v);
    });
    add(r.id,FAULT_CUT_WEIGHT*c);
  });

  // 2) Collisions voiture-contre-voiture (Option 3)
  const evs=(race.events||[]).filter(e=>e&&(e.type==='COLLISION_WITH_CAR'||e.Type==='COLLISION_WITH_CAR'||(!e.type&&!e.Type&&(e.a||e.aid||e.CarId!=null))));
  const seenPairs=new Set();
  for(let i=0;i<evs.length;i++){
    const a=evs[i];
    const aid=resolveId(a,'a'),bid=resolveId(a,'b');
    if(!aid||!bid||aid===bid)continue;
    const tsA=evTsSec(a);
    let b=null;
    for(let j=i+1;j<evs.length;j++){
      const o=evs[j];
      const oid=resolveId(o,'a'),ooid=resolveId(o,'b');
      if(!oid||!ooid)continue;
      const tsO=evTsSec(o);
      const closeEnough=(tsA==null||tsO==null)?true:Math.abs(tsO-tsA)<=2.5;
      if(((oid===aid&&ooid===bid)||(oid===bid&&ooid===aid))&&closeEnough){b=o;break;}
    }
    const pairKey=[aid,bid].sort().join('-')+':'+(tsA!=null?Math.round(tsA):i);
    if(seenPairs.has(pairKey))continue;
    seenPairs.add(pairKey);

    let rp=a.RelPosition||a.relPos||null;
    let refAid=aid,refBid=bid;
    if((!rp||rp.X==null||rp.Z==null)&&b&&(b.RelPosition||b.relPos)){
      rp=b.RelPosition||b.relPos;
      refAid=resolveId(b,'a');refBid=resolveId(b,'b');
    }
    if(!rp||rp.X==null||rp.Z==null)continue;
    const rx=Number(rp.X),rz=Number(rp.Z);
    if(!Number.isFinite(rx)||!Number.isFinite(rz))continue;
    if(Math.abs(rz)>=FAULT_SIDE_Z)continue; // côte à côte → 0-0

    let culpritId=null,victimId=null;
    if(rx>=FAULT_REAR_X){culpritId=refAid;victimId=refBid;}
    else if(rx<=-FAULT_REAR_X){culpritId=refBid;victimId=refAid;}
    if(!culpritId||!victimId)continue;

    const vLaps=lapsById[victimId]||[];
    if(!vLaps.length)continue;
    let victimLap=null;
    if(tsA!=null){
      for(const L of vLaps){
        const lts=lapTsSec(L);
        if(lts!=null&&lts>=tsA-5){victimLap=L;break;}
      }
    }
    if(!victimLap)victimLap=vLaps[vLaps.length-1];
    const vPaceMs=driverPaceMs(victimId);
    const lapRaw=victimLap&&(Number.isFinite(victimLap.LapTime)?victimLap.LapTime:victimLap.time);
    if(!Number.isFinite(lapRaw)||lapRaw<=0||!Number.isFinite(vPaceMs)||vPaceMs<=0)continue;
    const lapSec=lapRaw>1000?lapRaw/1000:lapRaw;
    const paceSec=vPaceMs>1000?vPaceMs/1000:vPaceMs;
    const lossSec=lapSec-paceSec;
    if(lossSec>=FAULT_LOSS_MIN)add(culpritId,lossSec/FAULT_DIVISOR);
  }
  return scores;
}

// Meilleur tour du week-end (Q + R) : Map<id, {best, bestSession:'Q'|'R'}>
function weekendBestLaps(rd,rIdx=-1,evPenMap=null){
  const best=new Map();
  (rd.sessions||[]).forEach((s,sIdx)=>{
    if(!s||(s.type!=='RACE'&&s.type!=='QUALIFY'))return;
    const sorted=sortSessionForPerf(s,rIdx,sIdx,evPenMap);
    const tag=s.type==='QUALIFY'?'Q':'R';
    for(const r of sorted){
      if(!r||!r.id||r._dq||r.comDNS)continue;
      const rawBest=(s.type==='QUALIFY'&&Number.isFinite(r._adjustedBest)&&r._adjustedBest<1e17)?r._adjustedBest:r.best;
      const b=Number.isFinite(rawBest)&&rawBest>0&&rawBest<600000?rawBest:null;
      if(b==null)continue;
      const cur=best.get(r.id);
      if(!cur||b<cur.best)best.set(r.id,{best:b,bestSession:tag});
    }
  });
  return best;
}

function globalLevelForScore(score){
  const displayedScore=Math.round(score);
  return displayedScore>=81?1:displayedScore>=61?2:displayedScore>=41?3:4;
}
function globalPerformanceRatings(){
  const records=[];
  for(const ev of events){
    const weight=eventGlobalWeight(ev);
    if(!(weight>0))continue;
    const data=ev.data||{},pm=data.penMap||{};
    const evSessions=Array.isArray(data.sessions)?data.sessions:[];
    const minPct=ev.points_config?.minPercentDistance??0.75;
    for(const [ri,rd] of groupSessionsByDate(evSessions).entries()){
      const best=weekendBestLaps(rd,ri,pm);
      let raceNumber=0;
      rd.sessions.forEach((session,si)=>{
        if(session.type!=='RACE')return;
        raceNumber++;
        const sorted=sortSessionForPerf(session,ri,si,pm,minPct);
        const participants=sorted.filter(r=>!r.comDNS&&((r.laps||0)>0||(session.laps||[]).some(l=>l.id===r.id)));
        const entries=participants.map(r=>({id:r.id,
          consistency:raceConsistencyMs((session.laps||[]).filter(l=>l.id===r.id)),
          best:best.get(r.id)?.best??null}));
        const consistency=GDSPGlobalRating.percentile(entries,'consistency');
        const speed=GDSPGlobalRating.percentile(entries,'best');
        participants.forEach((r,i)=>{
          const review=GDSPGlobalRating.conduct(pm[`${ri}:${si}:${r.id}`]);
          const label=`${ev.name||ev.slug} · M${ri+1} C${raceNumber}`;
          records.push({id:r.id,name:r.name,team:r.team,key:`${ev.slug}:${session.date}:${session.track}:${session.type}`,
            ts:Date.parse(session.date),date:session.date,label,weight,conduct:review,
            axes:{regularite:consistency[i],proprete:review.score,vitesse:speed[i],
              resultats:scoreResultsV45(participants.length,i+1,!!(r._dq||r.comDQ||r.comDNF||r.disqualified))}});
        });
      });
    }
  }
  const list=GDSPGlobalRating.aggregate(records,{minRaces:GLOBAL_MIN_RACES,hidden:globalHidden});
  list.forEach(r=>r.level=globalLevelForScore(r.score));
  return list;
}
function performanceRatings(){
  const pilots=new Map();
  const pct=(arr,id,key,lower=true)=>{
    const eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);
    if(!item||eligible.length<2)return null;
    const better=eligible.filter(x=>lower?x[key]<item[key]:x[key]>item[key]).length,
          equal=eligible.filter(x=>x[key]===item[key]).length;
    return 100*(1-(better+(equal-1)/2)/(eligible.length-1));
  };
  const pctFoul=(arr,id,key)=>{
    const eligible=arr.filter(x=>Number.isFinite(x[key])),item=eligible.find(x=>x.id===id);
    if(!item)return null;
    if(item[key]<=0)return 100;
    if(eligible.length<2)return null;
    const better=eligible.filter(x=>x[key]<item[key]).length,
          equal=eligible.filter(x=>x[key]===item[key]).length;
    return 100*(1-(better+(equal-1)/2)/(eligible.length-1));
  };
  const cfg=pointsConfig();
  const minPct=typeof cfg.minPercentDistance==='number'?cfg.minPercentDistance:0.75;
  const evRounds=groupSessionsByDate(sessions);
  evRounds.forEach((rd,rIdx)=>{
    const raceSessions=[];
    rd.sessions.forEach((s,sIdx)=>{if(s&&s.type==='RACE')raceSessions.push({s,sIdx});});
    if(!raceSessions.length)return;
    const bestMap=weekendBestLaps(rd,rIdx,penMap);
    const pilotAgg=new Map();
    for(const {s,sIdx} of raceSessions){
      const sorted=sortSessionForPerf(s,rIdx,sIdx,penMap,minPct);
      const N=sorted.length;
      const lapsById={};
      (s.laps||[]).forEach(l=>{if(!l||!l.id)return;if(!lapsById[l.id])lapsById[l.id]=[];lapsById[l.id].push(l);});
      const foulScores=raceFoulScores({...s,results:sorted});
      sorted.forEach((r,idx)=>{
        if(!r||!r.id)return;
        const myLaps=(lapsById[r.id]||[]).filter(l=>Number.isFinite(l.time)&&l.time>0&&l.time<600000);
        const consistency=raceConsistencyMs(myLaps);
        const isOut=!!(r._dq||r.comDQ||r.comDNS||r.disqualified||r.comDNF);
        const resScore=scoreResultsV45(N,idx+1,isOut);
        const fouls=foulScores.get(r.id)??0;
        if(!pilotAgg.has(r.id))pilotAgg.set(r.id,{id:r.id,n:0,consS:0,consN:0,foulS:0,foulN:0,resS:0,resN:0});
        const p=pilotAgg.get(r.id);
        p.n++;
        if(consistency!=null){p.consS+=consistency;p.consN++;}
        p.foulS+=fouls;p.foulN++;
        p.resS+=resScore;p.resN++;
      });
    }
    const entries=[];
    for(const [id,p] of pilotAgg){
      const b=bestMap.get(id);
      entries.push({
        id,
        raceCount:p.n,
        regularity:p.consN?p.consS/p.consN:null,
        foul:p.foulN?p.foulS/p.foulN:0,
        best:b?b.best:null,
        bestSession:b?b.bestSession:null,
        resScore:p.resN?p.resS/p.resN:0
      });
    }
    for(const e of entries){
      const v={
        regularite:pct(entries,e.id,'regularity',true),
        proprete:pctFoul(entries,e.id,'foul'),
        vitesse:pct(entries,e.id,'best',true),
        resultats:e.resScore
      };
      if(v.regularite===null&&v.vitesse===null&&v.proprete===null)continue;
      for(const k in v)if(v[k]===null)v[k]=50;
      if(!pilots.has(e.id))pilots.set(e.id,{items:[],races:0});
      const rec=pilots.get(e.id);
      rec.items.push(v);
      rec.races+=(e.raceCount||1);
    }
  });
  const out=[];
  for(const [id,rec] of pilots){
    const items=rec.items;
    if(rec.races<2&&items.length<2)continue;
    const average=key=>items.reduce((a,x)=>a+x[key],0)/items.length;
    const details={regularite:average('regularite'),proprete:average('proprete'),vitesse:average('vitesse'),resultats:average('resultats')};
    const score=Object.values(details).reduce((a,b)=>a+b,0)/4;
    out.push({id,score,details,count:rec.races});
  }
  out.sort((a,b)=>b.score-a.score);
  for(let i=0;i<out.length;i++){const rank=out.findIndex(x=>Math.abs(x.score-out[i].score)<1e-9);out[i].level=4-Math.min(3,Math.floor(rank*4/out.length));}
  return out;
}

function cloneSessions(data,manual){
 return (Array.isArray(data?.sessions)?data.sessions:[]).filter(s=>s&&typeof s==='object').map(s=>({...s,results:(Array.isArray(s.results)?s.results:[]).filter(Boolean).map(r=>{const edit=manual&&data.manualDrivers?.[r.id];return edit?{...r,name:edit.name,team:edit.team||''}:{...r};})}));
}
function eventDrivers(ev){
 const found=new Map();for(const s of sessions)for(const r of s.results)if(r.id&&!found.has(r.id))found.set(r.id,{id:r.id,name:r.name||'Pilote',team:r.team||'',model:r.model||'',skin:r.skin||''});
 const names=new Set([...found.values()].map(d=>String(d.name).trim().toLocaleLowerCase('fr')));
 function shaShort(input){let h=2166136261;for(let i=0;i<input.length;i++){h^=input.charCodeAt(i);h=Math.imul(h,16777619)}return ('00000000'+(h>>>0).toString(16)).slice(-8)+input.slice(0,4)}
 for(const e of Array.isArray(ev.data?.ahEntrants)?ev.data.ahEntrants:[]){const name=String(e?.name||'').trim(),key=name.toLocaleLowerCase('fr');if(!name||names.has(key))continue;names.add(key);const id='ah-entrant-'+shaShort(key);found.set(id,{id,name,team:e.team||'',model:e.car||'',skin:e.skin||'',entrant:true});}
 return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function historyFromGroups(groups,id,sortedSessions){
 const history=[];
 groups.forEach(rd=>{
  const list=sortedSessions?[...rd.sessions].sort((a,b)=>({QUALIFY:0,RACE:1,PRACTICE:2}[a.type]??9)-({QUALIFY:0,RACE:1,PRACTICE:2}[b.type]??9)||String(a.date||'').localeCompare(String(b.date||''))):rd.sessions;
  const best=weekendBestLaps(rd,rd.roundIndex,rd.penMap);
  list.forEach((s,i)=>{if(s.type!=='RACE')return;const arr=sortSessionForPerf(s,rd.roundIndex,i,rd.penMap),idx=arr.findIndex(r=>r.id===id);if(idx<0)return;
   const r=arr[idx],name=String(r.name||'').trim().toLowerCase(),laps=(s.laps||[]).filter(l=>l.id===id&&Number.isFinite(l.time)&&l.time>0&&l.time<600000),consistency=raceConsistencyMs(laps);
   const rest=laps.slice(1),bestLap=rest.length?Math.min(...rest.map(l=>l.time)):null,clean=rest.filter(l=>bestLap!=null&&l.time-bestLap<=PIT_SLOW_MS);
   const avgRaceMs=clean.length>=2?clean.reduce((sum,l)=>sum+l.time,0)/clean.length:null,pitExcluded=rest.length>=2?rest.length-clean.length:null;
   history.push({date:s.date,track:s.track,eventName:rd.eventName,eventSlug:rd.eventSlug,position:idx+1,grid:r.grid||null,delta:typeof r.grid==='number'&&r.grid>0?r.grid-(idx+1):null,collisions:(s.events||[]).filter(e=>[e.a,e.b].some(v=>String(v||'').trim().toLowerCase()===name)).length,best:r.best,weekendBest:best.get(id)?.best??null,weekendSession:best.get(id)?.bestSession??null,consistency,avgRaceMs,pitExcluded,laps:laps.length,status:r.comDNS?'DNS':r._dq?'DQ':r.comDNF?'DNF':''});
  });
 });return history;
}
root.gdspMobileProfiles={
 event(ev){
  sessions=cloneSessions(ev.data,true);penMap=ev.data?.penMap||{};eventConfig=ev.points_config||{};
  const drivers=eventDrivers(ev),ratings=performanceRatings(),groups=groupSessionsByDate(sessions).map((rd,i)=>({...rd,roundIndex:i,penMap,eventName:ev.name,eventSlug:ev.slug}));
  return {drivers,ratings,history:id=>historyFromGroups(groups,id,true)};
 },
 global(input,hidden){
  events=input.map(ev=>({...ev,data:{...ev.data,sessions:cloneSessions(ev.data,false)}}));globalHidden=hidden||{};
  const ratings=globalPerformanceRatings();const groups=[];
  for(const ev of events){if(!(eventGlobalWeight(ev)>0))continue;groupSessionsByDate(ev.data.sessions).forEach((rd,i)=>groups.push({...rd,roundIndex:i,penMap:ev.data.penMap||{},eventName:ev.name,eventSlug:ev.slug}));}
  groups.sort((a,b)=>a.date.localeCompare(b.date));
  return {ratings,history:id=>historyFromGroups(groups,id,false)};
 }
};
})(typeof window!=='undefined'?window:globalThis);

/* =========================================================================
 * GDSP — règles de classement et pénalités Commission
 * Chargé après site.js. Le rendu HTML des résultats reste dans site.js.
 * =========================================================================
 * - Les métadonnées de pénalité AC sont ignorées : time est déjà le temps brut.
 * - Seules les sanctions penMap modifient le classement (secondes converties
 *   en millisecondes ; DQ, DNS, DNF et avertissements restent distincts).
 * - En course, classement officiel avec seuil de 75 % des tours.
 * - En qualification, le temps ajusté sert au tri sans modifier le temps source.
 * - Le point de pole revient au meilleur qualifié, jamais au pilote placé P1 sur une grille.
 * - Le championnat Lola T290 garde le double barème de sa manche à course unique.
 */
(function(){
'use strict';
if(window.__gdspResultsV81)return; window.__gdspResultsV81=true;

const DEFAULT_MIN_PCT = 0.75;
const TARGET_CHAMP_SLUG = 'lola-t290-gdsp-championnat-2026';

/* ---------- utilitaires ---------- */

// Les JSON Assetto Corsa fournissent penaltyTime en ticks, mais time est déjà
// le temps brut attendu par les classements. On ignore donc ces métadonnées sans
// soustraire leur valeur du temps. Seules les pénalités Commission (penMap) comptent.
function stripServerPens(){
  if(!Array.isArray(sessions))return;
  sessions.forEach(sess=>{
    (sess.results||[]).forEach(r=>{
      if(!r)return;
      r.penaltyTime=0;
      r.lapPenalty=0;
      r.hasPenalty=false;
    });
  });
  const rs=typeof rounds==='function'?rounds():null;
  if(penMap&&rs){
    rs.forEach((rd,rj)=>{
      (rd.sessions||[]).forEach((s,sj)=>{
        (s.results||[]).forEach(r=>{
          if(!r||!r.id)return;
          const a=penMap[`${rj}:${sj}:${r.id}`];
          if(a&&(a.timeAdd||a.dq||a.dnf||a.dns||a.warning))r.hasPenalty=true;
        });
      });
    });
  }
}

/* ---------- applyCommissionToArr (remplacé) ----------
 * Lit penMap et pose les flags + comTimeAdd (en ms) sur les clones. */
function myApplyCommissionToArr(arr,rIdx,sIdx){
  arr.forEach(y=>{
    y.comDQ=false; y.comDNF=false; y.comDNS=false;
    y.comWarning=false; y.comTimeAdd=0;
  });
  const pm=penMap; if(!pm||rIdx<0||sIdx<0)return arr;
  const prefix=`${rIdx}:${sIdx}:`;
  for(const k in pm){
    if(!k.startsWith(prefix))continue;
    const did=k.slice(prefix.length);
    const y=arr.find(x=>x.id===did); if(!y)continue;
    const a=pm[k];
    if(a.dq){y.comDQ=true;continue;}
    if(a.dns){y.comDNS=true;continue;}
    if(a.dnf){y.comDNF=true;}
    if(typeof a.timeAdd==='number'&&a.timeAdd!==0){
      y.comTimeAdd=(y.comTimeAdd||0)+a.timeAdd*1000;
    }
    if(a.warning){y.comWarning=true;}
  }
  return arr;
}
window.applyCommissionToArr=myApplyCommissionToArr;

/* ---------- sortSession (REMPLACÉ, source de vérité du tri) ---------- */
function mySortSession(sess){
  if(!sess)return[];
  const[rIdx,sIdx]=findSessionIdx(sess);
  // Cloner les résultats. Les métadonnées AC ne sont pas ajoutées au temps ;
  // la Commission est appliquée séparément à partir de penMap.
  const arr=(sess.results||[]).map(x=>{
    const y={...x};
    const base=Number.isFinite(y.time)?y.time:1e18;
    y._eff=base;
    return y;
  });
  // Appliquer les pénalités Commission
  myApplyCommissionToArr(arr,rIdx,sIdx);

  // Marquer DQ/finalTime
  arr.forEach(x=>{
    x._t=x._eff+(x.comTimeAdd||0);
    x._dq=false; x.finalDQ=false;
    if(x.disqualified||x.comDQ||x.comDNS){x._t=1e18;x._dq=true;x.finalDQ=true;}
    x.finalTime=x._t;
  });

  // ---- Qualifications ----
  if(sess.type==='QUALIFY'){
    // La pénalité s'applique au meilleur temps affiché et au tri, sans modifier
    // best dans la session source (un nouveau rendu ne la cumulera donc pas).
    arr.forEach(x=>{
      const best=Number.isFinite(x.best)&&x.best>0?x.best:1e18;
      x._adjustedBest=x._dq?1e18:best+(x.comTimeAdd||0);
    });
    arr.sort((a,b)=>{
      const aOk=Number.isFinite(a._adjustedBest)&&a._adjustedBest>0&&a._adjustedBest<1e17&&(a.laps>=2);
      const bOk=Number.isFinite(b._adjustedBest)&&b._adjustedBest>0&&b._adjustedBest<1e17&&(b.laps>=2);
      if(aOk&&!bOk)return -1;
      if(!aOk&&bOk)return 1;
      if(!aOk&&!bOk){
        if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
        return (a._adjustedBest||1e18)-(b._adjustedBest||1e18);
      }
      return a._adjustedBest-b._adjustedBest;
    });
    return arr;
  }

  // ---- Course : marquer les DNF auto (<75% des tours du leader virtuel) ----
  // IMPORTANT : on calcule d'abord wlInit sur les TEMPS BRUTS (avant ajout comT),
  // car c'est le nombre de tours effectués sur piste qui compte, pas le temps
  // final après pénalité.
  const wlInit=Math.max(0,...arr.map(y=>y.laps||0));
  const mlInit=Math.ceil(wlInit*DEFAULT_MIN_PCT);
  arr.forEach(y=>{
    if(!y.comDNF && !y._dq && (y.laps||0)>0 && (y.laps||0)<mlInit){
      y.comDNF=true;
    }
    if(y.comDNF){y._t=1e18;y._dq=false;y.finalDQ=false;y.hasPenalty=true;y.finalTime=y._t;}
  });

  // ---- TRI PRINCIPAL par temps final _t (APRÈS application de comTimeAdd) ----
  // D'abord trier tous les non-DQ/non-DNF par tours DESC puis _t ASC pour
  // identifier correctement le vainqueur et les finishers.
  arr.sort((a,b)=>{
    function isOut(x){return x._dq||x.comDNS||x._t>=1e18;}
    const aOut=isOut(a),bOut=isOut(b);
    if(aOut&&!bOut)return 1;
    if(!aOut&&bOut)return -1;
    if(aOut&&bOut){
      // DQ/DNS tout au fond
      if(a.comDNS&&!b.comDNS)return 1;
      if(!a.comDNS&&b.comDNS)return -1;
      return (b.laps||0)-(a.laps||0)||a._t-b._t;
    }
    return (b.laps||0)-(a.laps||0)||a._t-b._t;
  });

  // ---- Reclassement 75% ----
  let wl=0,wt=1e18;
  for(const x of arr){
    if(x._dq||x.comDNS||x._t>=1e18)continue;
    const L=x.laps||0,T=x._t;
    if(L>wl||(L===wl&&T<wt)){wl=L;wt=T;}
  }
  const fin=[],cls=[],nc=[],bak=[];
  if(wl>0&&wt<1e18){
    const ml=Math.ceil(wl*DEFAULT_MIN_PCT);
    for(const x of arr){
      if(x._dq){bak.push(x);continue;}          // DQ tout au fond
      if(x.comDNS){bak.push(x);continue;}
      if((x.laps||0)<=0){bak.push(x);continue;}
      if(x._t>=1e18||x.comDNF){nc.push(x);continue;}
      const L=x.laps||0,T=x._t;
      if(T>=wt){fin.push(x);continue;}          // finisher (temps >= vainqueur)
      if(L>=ml){cls.push(x);continue;}          // classé-DNF (≥75%)
      nc.push(x);                                // NC (<75%)
    }
    // fin déjà trié (par le sort principal) : tours DESC, _t ASC
    // cls : tours DESC, _t DESC (ceux qui ont le plus de tours / temps le
    //       plus proche du leader sont devant)
    cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t);
    nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
    // Dans bak : DQ puis DNS, puis les nuls (0 tours)
    bak.sort((a,b)=>{
      const dnsA=a.comDNS?1:0,dnsB=b.comDNS?1:0;
      if(dnsA!==dnsB)return dnsB-dnsA; // DQ avant DNS
      return (b.laps||0)-(a.laps||0);
    });
    return[...fin,...cls,...nc,...bak];
  }else{
    return arr; // déjà trié
  }
}
window.sortSession=mySortSession;

/* ---------- calculate(): classement et attribution des points ---------- */
function v81_calculate(){
  stripServerPens();
  const rs=rounds();
  const all=allDrivers();
  const warnCount=new Map();
  for(const k in penMap){const a=penMap[k];const did=k.split(':')[2];if(a.warning)warnCount.set(did,(warnCount.get(did)||0)+1);}
  const map=new Map(all.map(d=>[d.id,{...d,rounds:Array(rs.length).fill(0),merit:Array(rs.length).fill(0),details:[],warnings:warnCount.get(d.id)||0}]));
  // Retrier toutes les sessions (applique notre sortSession)
  rs.forEach(r=>{(r.sessions||[]).forEach(s=>{if(s.type==='RACE'||s.type==='QUALIFY')s.results=mySortSession(s);});});
  const cfg=pointsConfig();const sc=cfg.pointsScale||DEFAULT_POINTS.pointsScale;
  const polePts=cfg.polePoints||0;
  const dbl=cfg.doubleLongRaces!==false;
  const minPct=cfg.minPercentDistance||DEFAULT_MIN_PCT;

  function isDQ(p){return p._dq||p.comDNS||p.comDQ||p.disqualified;}
  function isClassed(p,wl,wt,ml){
    if(isDQ(p))return false;
    if(!Number.isFinite(p._t)||p._t>=1e18)return false;
    if((p.laps||0)<ml)return false;
    return true;
  }

  for(let j=0;j<rs.length;j++){
    const r=rs[j];
    const races=(r.sessions||[]).filter(s=>s.type==='RACE');
    const mult=races.length===1&&dbl?2:1;
    const qual=(r.sessions||[]).find(s=>s.type==='QUALIFY');
    const qualPole=qual?(qual.results||[]).find(x=>!isDQ(x)&&!x.comDNF&&Number.isFinite(x._adjustedBest)&&x._adjustedBest>0&&x._adjustedBest<1e17&&(x.laps||0)>=2):null;
    races.forEach((race,ri)=>{
      const rm=ri===0?mult:1;
      const arr=race.results;
      let wl=0,wt=1e18;
      for(const x of arr){if(isDQ(x)||x._t>=1e18)continue;const L=x.laps||0;if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}}
      if(wl===0)return;
      const ml=Math.max(1,Math.ceil(wl*minPct));
      // Meilleur tour en course (parmi classés)
      let best=Infinity,bestId=null;
      for(const x of arr){if(!isClassed(x,wl,wt,ml))continue;if(Number.isFinite(x.best)&&x.best>0&&x.best<best){best=x.best;bestId=x.id;}}
      let clsIdx=0;
      arr.forEach((p)=>{
        const d=map.get(p.id);if(!d)return;
        let pts=0;
        if(isClassed(p,wl,wt,ml)){
          clsIdx++;
          pts=(sc[clsIdx-1]||0)*rm;
        }
        d.rounds[j]+=pts;
        // Mérite
        if(pts>0){
          let mm=2*rm;
          if(typeof p.grid==='number'&&p.grid>0){
            const place=clsIdx;
            const gain=p.grid-place;
            if(gain>=6)mm+=3*rm;
            else if(gain>=4)mm+=2*rm;
            else if(gain>=2)mm+=1*rm;
          }
          d.merit[j]+=mm;
        }
        // Meilleur tour / pas de pénalité / qualif battue
        if(isClassed(p,wl,wt,ml)){
          if(p.id===bestId)d.merit[j]+=1*rm;
          // Pas de pénalité
          if(!p.hasPenalty&&!p.disqualified&&!p.comDQ&&!(p.comTimeAdd>0)&&!p.comDNF&&!p.comWarning){
            d.merit[j]+=1*rm;
          }
        }
      });
    });
    // Le bonus est attribué une seule fois par manche au meilleur qualifié,
    // indépendamment des grilles de départ des courses.
    if(qualPole&&polePts){
      const d=map.get(qualPole.id);
      if(d)d.rounds[j]+=polePts*mult;
    }
  }

  // Joker
  return [...map.values()].map(d=>({
    ...d,
    total:d.rounds.reduce((a,b)=>a+b,0),
    joker:jokerTotal(d.rounds),
    meritTotal:d.merit.reduce((a,b)=>a+b,0)
  }));
}
window.calculate=v81_calculate;

// Points affichés par session : la pole est portée par la qualification,
// les courses reçoivent uniquement leurs points de classement.
function v81_sessionPoints(sess){
  const out=new Map();
  if(!sess)return out;
  const cfg=pointsConfig();
  const scale=cfg.pointsScale||DEFAULT_POINTS.pointsScale;
  const polePts=cfg.polePoints||0;
  const dbl=cfg.doubleLongRaces!==false;
  const minPct=cfg.minPercentDistance||DEFAULT_MIN_PCT;
  const rs=rounds();
  const [rIdx]=findSessionIdx(sess);
  const r=rs[rIdx];
  if(!r)return out;
  const races=(r.sessions||[]).filter(s=>s.type==='RACE');
  const mult=races.length===1&&dbl?2:1;
  const isDQ=p=>p._dq||p.comDNS||p.comDQ||p.disqualified;

  if(sess.type==='QUALIFY'){
    const pole=mySortSession(sess).find(p=>!isDQ(p)&&!p.comDNF&&(p.laps||0)>=2&&Number.isFinite(p._adjustedBest)&&p._adjustedBest>0&&p._adjustedBest<1e17);
    if(pole&&polePts)out.set(pole.id,polePts*mult);
    (sess.results||[]).forEach(p=>{if(!out.has(p.id))out.set(p.id,0);});
    return out;
  }
  if(sess.type!=='RACE')return out;

  const ri=races.indexOf(sess);
  if(ri<0)return out;
  const rm=ri===0?mult:1;
  const arr=mySortSession(sess);
  let wl=0,wt=1e18;
  for(const p of arr){
    if(isDQ(p)||p._t>=1e18)continue;
    const laps=p.laps||0;
    if(laps>wl||(laps===wl&&p._t<wt)){wl=laps;wt=p._t;}
  }
  const minLaps=Math.max(1,Math.ceil(wl*minPct));
  let classifiedPosition=0;
  for(const p of arr){
    let pts=0;
    if(wl>0&&!isDQ(p)&&Number.isFinite(p._t)&&p._t<1e18&&(p.laps||0)>=minLaps){
      classifiedPosition++;
      pts=(scale[classifiedPosition-1]||0)*rm;
    }
    out.set(p.id,pts);
  }
  return out;
}
window.sessionPoints=v81_sessionPoints;

/* ---------- Configuration et chargement ---------- */
// Le championnat Lola T290 conserve le double barème de sa manche à course
// unique. Les autres événements gardent leur propre configuration.
const _pointsConfigV81=window.pointsConfig;
if(typeof _pointsConfigV81==='function'){
  window.pointsConfig=function(){
    const cfg=_pointsConfigV81.apply(this,arguments);
    if(eventContext&&eventContext.slug===TARGET_CHAMP_SLUG)cfg.doubleLongRaces=true;
    return cfg;
  };
}

// Nettoyer les métadonnées AC dès qu'un événement est chargé. La navigation
// reste gérée par site.js : les visiteurs arrivent sur l'accueil, pas aux résultats.
const _loadEventV81=window.loadEvent;
if(typeof _loadEventV81==='function'){
  window.loadEvent=async function(){
    const ev=await _loadEventV81.apply(this,arguments);
    if(ev)stripServerPens();
    return ev;
  };
}
const _loadLegacyV81=window.loadRemoteLegacy;
if(typeof _loadLegacyV81==='function'){
  window.loadRemoteLegacy=async function(){
    const result=await _loadLegacyV81.apply(this,arguments);
    if(result)stripServerPens();
    return result;
  };
}

})();

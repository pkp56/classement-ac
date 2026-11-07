/* =========================================================================
 * patches-v75.js — CLASSEMENT REPARTI DE ZÉRO
 * =========================================================================
 * Règles implémentées (source de vérité unique) :
 *
 * 1. Pénalités SERVEUR AC (penaltyTime / hasPenalty / lapPenalty) sont
 *    COMPLÈTEMENT IGNORÉES : on retire la pénalité temps du champ time pour
 *    retrouver le temps brut de piste, puis on remet hasPenalty/lapPenalty
 *    à false/0. Seul le "badge rouge" "Time penalty: Xs" reste affiché dans
 *    le tableau "officiel" si le JSON le contient — mais ça n'influe NI sur
 *    le temps final NI sur le classement.
 *
 * 2. Seules les pénalités COMMISSION (penMap) comptent :
 *      - timeAdd (en secondes) → ajouté au temps final (en ms : ×1000)
 *      - dq=true  → disqualification (DQ), aucun point, dernier de tableau
 *      - dns=true → absent (DNS), aucun point, dernier de tableau
 *      - dnf=true → non-classé (<75% des tours), marque DNF, pas de points
 *                   de place MAIS peut toucher la pole s'il était en P1 grille
 *                   et a accompli ≥75% des tours
 *      - warning=true → affiché "Aver." dans la colonne Pénal., aucun effet
 *                        sur le temps/points ; 2 avertissements → 1 pénalité
 *                        auto (laissé de côté pour l'instant — non demandé).
 *
 * 3. Classement course (reclassement 75%) :
 *      - Finisher : a accompli au moins 75% des tours du vainqueur ET a un
 *        temps final ≥ temps du vainqueur (même si meilleur au tour, pas
 *        devancé) ; trié par tours décroissants PUIS temps final croissant.
 *      - Classé-DNF : ≥75% des tours MAIS temps < temps du vainqueur (a
 *        terminé en avance de phase / coupure drapeau / DNF auto) ; trié par
 *        tours décroissants PUIS temps final DÉCROISSANT. Ils peuvent
 *        marquer la pole si P1 grille.
 *      - NC : <75% des tours ; trié par tours décroissants puis temps croissant.
 *      - DQ/DNS : tout en bas.
 *
 * 4. Qualifications : tri par meilleur tour + pénalités Commission ajoutées
 *    au meilleur tour (en ms). Pilotes avec <2 tours ou DQ au fond.
 *
 * 5. Points : barème pointsConfig() (defaut 25/21/18/...), multiplier ×2 si
 *    manche d'1 seule course (endurance, doubleLongRaces=true forcé).
 *    Bonus pole, mérite (dépassements, meilleur tour, progrès, pas de
 *    pénalité) conservés.
 *
 * 6. Colonne "Pénal." affichée en orange dans chaque tableau de course/qualif
 *    (Aver. / +Ns / DNF / DNS / DQ).
 *
 * Ce script REMPLACE complètement sortSession(), applyCommissionToArr() et
 * les parties critiques de calculate() et manche() ; il ne s'appuie SUR
 * AUCUN des patches v40-v44 qui doivent être désactivés dans index.html.
 * ========================================================================= */
(function(){
'use strict';
if(window.__gdspV71)return; window.__gdspV71=true;
console.log('[v75] classement reparti de zero');

const DEFAULT_MIN_PCT = 0.75;

/* ---------- rounds() déterministe (QUALIFY avant RACE avant PRACTICE) ---------- */
window.rounds=function(){
  let m={};
  (window.sessions||[]).filter(s=>s&&s.date).forEach(s=>{
    const d=String(s.date).slice(0,10);
    if(!m[d])m[d]=[];
    m[d].push(s);
  });
  return Object.entries(m).sort().map(([d,arr],i)=>{
    arr.sort((a,b)=>{
      const o={QUALIFY:0,RACE:1,PRACTICE:2};
      return (o[a.type]??9)-(o[b.type]??9)||String(a.date||'').localeCompare(String(b.date||''));
    });
    return{date:d,sessions:arr,track:arr[0].track,number:i+1};
  });
};

/* ---------- utilitaires ---------- */

// Conversion robuste penaltyTime AC vers millisecondes :
//   - format ticks ×1e9 (5e9 = 5s) → /1e6
//   - déjà en ms (≥1e4) → direct
//   - en secondes → ×1000
function acPenaltyMs(raw){
  const v=Number(raw)||0;
  if(v<=0)return 0;
  if(v>=1e8) return v/1e6;
  if(v>=1e4) return v;
  return v*1000;
}

// Retirer les pénalités SERVEUR AC des sessions globales pour que time
// reflète EXACTEMENT le temps brut de piste.
function stripServerPens(){
  if(!Array.isArray(window.sessions))return;
  window.sessions.forEach(sess=>{
    (sess.results||[]).forEach(r=>{
      if(!r)return;
      if(r.penaltyTime){
        const ms=acPenaltyMs(r.penaltyTime);
        if(Number.isFinite(r.time)&&ms>0) r.time=Math.max(0,r.time-ms);
        r.penaltyTime=0;
      }
      r.lapPenalty=0;
      // hasPenalty sera repositionné à true s'il y a une commission
      r.hasPenalty=false;
    });
  });
  // Marquer hasPenalty=true pour les pilotes concernés par penMap
  const pm=window.penMap;const rs=typeof rounds==='function'?rounds():null;
  if(pm&&rs){
    rs.forEach((rd,rj)=>{
      (rd.sessions||[]).forEach((s,sj)=>{
        (s.results||[]).forEach(r=>{
          if(!r||!r.id)return;
          const a=pm[`${rj}:${sj}:${r.id}`];
          if(a&&(a.timeAdd||a.dq||a.dnf||a.dns||a.warning)) r.hasPenalty=true;
        });
      });
    });
  }
}

// Trouver les indices (roundIdx, sessionIdx) compatibles avec le penMap
// (mêmes indices utilisés par renderAdjPanel de site.js : rj=r.number-1,
// sj = position DANS rd.sessions, 0=Q, 1=R1, 2=R2...).
function myFindSessionIdx(sess){
  if(typeof rounds!=='function')return[-1,-1];
  const rs=rounds();
  for(let i=0;i<rs.length;i++){
    const j=(rs[i].sessions||[]).indexOf(sess);
    if(j>=0)return[i,j];
  }
  return[-1,-1];
}
window.findSessionIdx=myFindSessionIdx;

/* ---------- applyCommissionToArr (remplacé) ----------
 * Lit penMap et pose les flags + comTimeAdd (en ms) sur les clones. */
function myApplyCommissionToArr(arr,rIdx,sIdx){
  arr.forEach(y=>{
    y.comDQ=false; y.comDNF=false; y.comDNS=false;
    y.comWarning=false; y.comTimeAdd=0;
  });
  const pm=window.penMap; if(!pm||rIdx<0||sIdx<0)return arr;
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
  const[rIdx,sIdx]=myFindSessionIdx(sess);
  // Cloner tous les résultats à partir du temps BRUT (stripServerPens a
  // déjà retiré penaltyTime serveur).
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
    // Appliquer les pénalités commission au meilleur tour (timeAdd s)
    arr.forEach(x=>{
      const ta=(x.comTimeAdd||0); // en ms (timeAdd*1000 déjà)
      if(ta>0&&Number.isFinite(x.best)&&x.best>0&&x.best<1e17){
        x.best=x.best+ta;
      }
      if(x._dq) x.best=1e18;
    });
    arr.sort((a,b)=>{
      const aOk=Number.isFinite(a.best)&&a.best>0&&a.best<1e17&&(a.laps>=2);
      const bOk=Number.isFinite(b.best)&&b.best>0&&b.best<1e17&&(b.laps>=2);
      if(aOk&&!bOk)return -1;
      if(!aOk&&bOk)return 1;
      if(!aOk&&!bOk){
        if((b.laps||0)!==(a.laps||0))return (b.laps||0)-(a.laps||0);
        return (a.best||1e18)-(b.best||1e18);
      }
      return a.best-b.best;
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

/* ---------- calculate() : wrapper qui ajoute points aux classés-DNF ----------
 * On NE REMPLACE PAS calculate ; on le laisse appeler mySortSession (qu'on
 * vient de remplacer). Cependant calculate() de site.js remet d'abord
 * comTimeAdd à 0 sur les results — c'est sur les CLONES de la course
 * précédente (car calculate a appelé sess.results=sortSession(sess) qui
 * remplace results par les clones avec comTimeAdd).
 *
 * Pour éviter que ce reset ne casse nos comTimeAdd, on wrap calculate pour
 * :
 *   1) stripServerPens() avant,
 *   2) forcer doubleLongRaces=true,
 *   3) après calcul, ajouter les points aux classés-DNF que site.js ignore
 *      (ceux qui sont en cls : T<wt, L≥ml).
 */
/* =========================================================================
 * calculate() COMPLÈTEMENT REMPLACÉE — plus aucun recours à site.js pour
 * le calcul des points. Source de vérité unique : mySortSession + v75_calculate.
 * ========================================================================= */
function v75_calculate(){
  stripServerPens();
  const rs=rounds();
  const all=allDrivers();
  const warnCount=new Map();
  for(const k in penMap){const a=penMap[k];const did=k.split(':')[2];if(a.warning)warnCount.set(did,(warnCount.get(did)||0)+1);}
  const map=new Map(all.map(d=>[d.id,{...d,rounds:Array(rs.length).fill(0),merit:Array(rs.length).fill(0),details:[],warnings:warnCount.get(d.id)||0}]));
  // Retrier toutes les sessions (applique notre sortSession)
  rs.forEach(r=>{(r.sessions||[]).forEach(s=>{if(s.type==='RACE'||s.type==='QUALIFY')s.results=mySortSession(s);});});
  const cfg=pointsConfig();const sc=cfg.pointsScale||(window.DEFAULT_POINTS&&window.DEFAULT_POINTS.pointsScale)||[];
  const polePts=cfg.polePoints||0;
  const dbl=cfg.doubleLongRaces!==false;
  const minPct=cfg.minPercentDistance||DEFAULT_MIN_PCT;
  const jokerCount=cfg.jokerCount||0;

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
    const qual=(r.sessions||[]).find(s=>s.type==='QUALIFY');
    const mult=races.length===1&&dbl?2:1;
    races.forEach((race,ri)=>{
      const rm=ri===0?mult:1;
      const arr=race.results;
      let wl=0,wt=1e18;
      for(const x of arr){if(isDQ(x)||x._t>=1e18)continue;const L=x.laps||0;if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}}
      if(wl===0)return;
      const ml=Math.max(1,Math.ceil(wl*minPct));
      // Trouver poleId : P1 grille ET ≥ml ET non-DQ
      let poleId=null;
      for(const x of arr){if(x.grid===1&&!isDQ(x)&&(x.laps||0)>=ml){poleId=x.id;break;}}
      let poleGiven=false;
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
          // Pole au P1 grille classé (y.c. classé-DNF si ≥ml)
          if(!poleGiven&&p.id===poleId){pts+=polePts*rm;poleGiven=true;}
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
  }

  // Joker
  return [...map.values()].map(d=>{
    const jokerRounds=jokerCount>0?[...d.rounds].sort((a,b)=>b-a).slice(0,jokerCount):d.rounds;
    return{...d,total:d.rounds.reduce((a,b)=>a+b,0),joker:jokerRounds.reduce((a,b)=>a+b,0),meritTotal:d.merit.reduce((a,b)=>a+b,0)};
  });
}
window.calculate=v75_calculate;

/* ---------- manche() : wrapper pour corriger les écarts et ajouter Pénal. ----------
 * Problème : site.js eff()/gapTo() utilise x._t si fini, sinon recalcul en ajoutant
 * comTimeAdd à x.finalTime qui peut ne pas contenir la bonne valeur. On wrappe
 * manche() pour (1) remplacer les écarts erronés par les écarts basés sur NOS
 * _t, et (2) ajouter la colonne Pénal.
 */
const _origManche=window.manche;
window.manche=function(){
  const html=_origManche.apply(this,arguments);
  try{
    const rs=rounds();if(!rs||typeof round!=='number'||round>=rs.length)return html;
    const r=rs[round];if(!r||typeof sessionIndex!=='number'||sessionIndex>=r.sessions.length)return html;
    const s=r.sessions[sessionIndex];if(!s)return html;
    // Utiliser s.results qui a déjà été trié par sortSession() (appelé par manche
    // elle-même) — mais pour être sûr, on retrie via notre version.
    const sorted=mySortSession(s);
    // Également remettre s.results = sorted pour la cohérence
    s.results=sorted;
    const winner=sorted[0];
    function penLbl(x){
      const tags=[];
      if(x.comDQ)tags.push('DQ');
      else if(x.comDNS)tags.push('DNS');
      else if(x.comDNF)tags.push('DNF');
      if(typeof x.comTimeAdd==='number'&&x.comTimeAdd>0)tags.push('+'+Math.round(x.comTimeAdd/1000)+'s');
      if(x.comWarning)tags.push('Aver.');
      return tags.join(', ');
    }
    function fmtGap(x,ref){
      if(!ref||x.laps!==ref.laps)return '—';
      if(x._dq||x.comDNF||x.comDNS)return '—';
      if(!Number.isFinite(x._t)||!Number.isFinite(ref._t)||x._t>=1e17||ref._t>=1e17)return '—';
      const d=(x._t-ref._t)/1000;
      return d>0?'+'+d.toFixed(3)+' s':'—';
    }
    // Construire notre propre tableau de résultats CORRECTS, avec colonne Pénal
    // et écarts justes. Pour ne pas trop complexifier, on REGÉNÈRE les lignes
    // de résultat (mais on garde l'en-tête, les controls etc).
    // Plus simple : remplacer la table de résultats à l'intérieur du panel.
    // En fait on fait la modif cellule par cellule sur le HTML généré.
    let out=html;
    const hdr='<th>Meilleur tour</th>';
    const hpos=out.lastIndexOf(hdr);
    if(hpos>=0){
      // Remplacer l'en-tête pour insérer Pénal.
      out=out.slice(0,hpos+hdr.length)+'<th>Pénal.</th>'+out.slice(hpos+hdr.length);
      // Et modifier les en-têtes Écart/tête et Écart/préc si elles y sont
      out=out.replace('<th>Écart / tête</th><th>Écart / préc.</th>','<th>Écart / tête</th><th>Écart / préc.</th>');
    }
    // Maintenant remplacer chaque ligne de résultat. La regex match les <tr>
    // qui contiennent un meilleur tour (format m:ss.fff)
    let idx=0;
    out=out.replace(/<tr><td class="pos">[\s\S]*?<\/tr>/g,function(match){
      // Ne matcher que les lignes de résultats (elles contiennent un temps
      // au format 1:xx.xxx meilleur tour)
      if(!/:\d\d\.\d{3}/.test(match))return match;
      const x=sorted[idx];
      idx++;
      if(!x)return match;
      const lbl=penLbl(x);
      const penCell=lbl?`<td style="color:#e57a47;font-weight:600">${lbl}</td>`:`<td class="muted">—</td>`;
      // Insérer la cellule Pénal après le 5e <td>
      let pos=0,count=0;
      while(count<5){const nd=match.indexOf('</td>',pos);if(nd<0)break;pos=nd+5;count++;}
      let newRow=match.slice(0,pos)+penCell+match.slice(pos);
      // Puis remplacer les deux derniers <td> (écart/tête et écart/préc)
      // On récupère le précédent
      const prev=idx>=2?sorted[idx-2]:null;
      const gapHead=fmtGap(x,winner);
      const gapPrev=fmtGap(x,prev);
      // Remplacer les deux dernières cellules : elles finissent par </tr>.
      // On trouve le dernier <td et l'avant-dernier.
      const tds=[];
      let scan=0;
      while(true){
        const st=newRow.indexOf('<td',scan);if(st<0)break;
        const en=newRow.indexOf('</td>',st);if(en<0)break;
        tds.push({start:st,end:en+5});scan=en+5;
      }
      if(tds.length>=2){
        const last2=tds[tds.length-2], last1=tds[tds.length-1];
        // gap/tête = avant-dernière cellule ; gap/préc = dernière
        newRow=newRow.slice(0,last2.start)+`<td>${gapHead}</td>`+newRow.slice(last2.end,last1.start)+`<td>${gapPrev}</td>`+newRow.slice(last1.end);
      }
      return newRow;
    });
    return out;
  }catch(e){console.warn('[v75] manche wrap',e);return html;}
};

/* ---------- addAdjustment étendu (dnf/dns/warning) - remplace v41 ---------- */
const _addAdj_v71=window.addAdjustment;
window.addAdjustment=function(roundKey,sessionIdx,drvId,timeAdd,dq,warning,note,opts){
  opts=opts||{};
  if(opts.dnf||opts.dns){
    window.penMap[`${roundKey}:${sessionIdx}:${drvId}`]={
      timeAdd:0,dq:false,warning:false,
      dnf:!!opts.dnf,dns:!!opts.dns,
      note:note||(opts.dnf?'Abandon':'Absent')
    };
    if(window.saveState)window.saveState();
    if(window.render)window.render();
    return;
  }
  return _addAdj_v71.apply(this,arguments);
};

/* ---------- openAdjForm multi-choix (remplacer la version site.js) ---------- */
window.openAdjForm=function(rj,sj,did){
  const c=String(prompt("Ajustement :\n1=Pénalité temps\n2=DNF non-classé (<75%)\n3=DNS (absent)\n4=DQ\n5=Avertissement\n0=Annuler",'1')||'').trim();
  if(!c||c==='0')return;
  if(c==='2'){if(!confirm("DNF non-classé (<75%) ?"))return;addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Abandon')||'Abandon',{dnf:true});return;}
  if(c==='3'){if(!confirm("DNS (absent) ?"))return;addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;}
  if(c==='4'){if(!confirm("DQ ?"))return;addAdjustment(rj,sj,did,0,true,false,prompt("Note ?",'')||'');return;}
  if(c==='5'){if(!confirm("Avertissement ?"))return;addAdjustment(rj,sj,did,0,false,true,'');return;}
  const ta=prompt("Temps (s) ?",'0');if(ta===null)return;
  addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
};

/* Forcer doubleLongRaces (sécurité si calculate n'est pas passé par nous) */
const _pc0=window.pointsConfig;
if(_pc0){window.pointsConfig=function(){const c=_pc0();c.doubleLongRaces=true;return c;};}

/* ---------- Forcer le chargement du championnat Lola T290 2026 ----------
 * Le backend expose /api/events ce qui met site.js en mode multi (hub).
 * Comme on n'utilise qu'un seul championnat (International Series Lola T290),
 * on force son chargement direct et on affiche la page classement. */
const V71_CHAMP_SLUG='lola-t290-gdsp-championnat-2026';
async function v75_boot(){
  try{
    // Forcer le mode multi (loadEvent fonctionne dans ce mode)
    window.backendMulti=true;
    window.page='classement';
    window.eventtab='resultats';
    window.round=0;
    window.sessionIndex=1;
    // Charger les événements si pas encore fait
    if(!Array.isArray(window.events)||!window.events.length){
      try{
        const r=await fetch('/api/events',{cache:'no-store'});
        if(r.ok){const j=await r.json();window.events=Array.isArray(j.events)?j.events:[];}
      }catch(e){}
    }
    // Charger explicitement le championnat courant
    if(typeof window.loadEvent==='function'){
      await window.loadEvent(V71_CHAMP_SLUG);
      localStorage.setItem('gdsp_last_event',V71_CHAMP_SLUG);
      // Post-chargement : si on n'est pas dans l'admin, aller sur l'onglet
      // "RÉSULTATS" pour voir les manches immédiatement.
      if(window.page!=='admin'){
        window.page='manches';
        window.eventtab='resultats';
        window.round=0;window.sessionIndex=1;
      }
    }
    stripServerPens();
    if(window.render)window.render();
  }catch(e){console.warn('[v75] boot',e);if(window.render)window.render();}
}
// Lancer plusieurs fois (avant/après load) pour être sûr de passer après le
// bootstrap IIFE de site.js
setTimeout(v75_boot,100);
setTimeout(v75_boot,500);
setTimeout(v75_boot,2000);

})();

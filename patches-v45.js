/* patches-v45.js — v69
 *
 * Règle 75% classante, suppression des pénalités serveur, application des
 * pénalités Commission, doubleLongRaces=true, colonne "Pénal." dans les résultats.
 *
 * Cette version ne DÉPEND PLUS de v44 pour la gestion du temps : elle recalcule
 * elle-même _eff/_t sur chaque tri, en appliquant UNIQUEMENT les pénalités
 * Commission (timeAdd*1000 ms), en ignorant penaltyTime/hasPenalty/lapPenalty
 * du JSON (déjà inclus dans TotalTime).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;
  const MIN_PCT=0.75;

  // ------------- Outils -------------
  function penMs(v){
    v=Number(v)||0;
    if(v>=1e8)return v/1e6;
    if(v>=1e4)return v;
    return v*1000;
  }

  // Enlever les pénalités SERVEUR des sessions :
  //  - enlever penaltyTime (en recalculant le temps brut si besoin)
  //  - hasPenalty=true seulement si une commission existe
  //  - lapPenalty=0
  // Appelé au début de chaque tri.
  function stripServerPens(){
    if(typeof sessions==='undefined'||!Array.isArray(sessions))return;
    sessions.forEach(sess=>{
      (sess.results||[]).forEach(r=>{
        if(!r)return;
        if(r.penaltyTime){
          const ms=penMs(r.penaltyTime);
          if(Number.isFinite(r.time)&&ms>0)r.time=Math.max(0,r.time-ms);
          r.penaltyTime=0;
        }
        r.lapPenalty=0;
        r.hasPenalty=false;
      });
    });
    if(typeof penMap==='object'&&typeof rounds==='function'){
      const rs=rounds();
      rs.forEach((rd,rj)=>{
        rd.sessions.forEach((s,sj)=>{
          (s.results||[]).forEach(r=>{
            if(!r||!r.id)return;
            const k=`${rj}:${sj}:${r.id}`;const adj=penMap[k];
            if(adj&&(adj.timeAdd||adj.dq||adj.dnf||adj.dns||adj.warning))r.hasPenalty=true;
          });
        });
      });
    }
  }

  // Construire les clones triables pour une session (Q ou RACE).
  // Pour les courses : calcule _t = time + comTimeAdd (commission, en ms), puis
  // reclassement finishers / classés-DNF / NC / DQ-DNS.
  function mySortSession(sess){
    if(!sess)return[];
    const[rIdx,sIdx]=findSessionIdx(sess);
    const arr=(sess.results||[]).map(x=>({...x}));
    // Reset flags
    arr.forEach(y=>{y.comDNF=false;y.comDNS=false;y.comDQ=false;y.comWarning=false;y.comTimeAdd=0;});
    // Appliquer commission
    if(typeof penMap==='object'){
      for(const k in penMap){
        const[rj,sj,did]=k.split(':');
        if(+rj!==rIdx||+sj!==sIdx)continue;
        const y=arr.find(x=>x.id===did);if(!y)continue;
        const adj=penMap[k];
        if(adj.dq)y.comDQ=true;
        if(adj.dns)y.comDNS=true;
        if(adj.warning)y.comWarning=true;
        if(typeof adj.timeAdd==='number'&&adj.timeAdd!==0){
          y.comTimeAdd=(y.comTimeAdd||0)+adj.timeAdd*1000;
        }
      }
    }
    // Calculer _eff et _t
    arr.forEach(x=>{
      const base=Number.isFinite(x.time)?x.time:1e18;
      x._eff=base;  // temps brut sans penalty serveur
      x._t=x._eff+(x.comTimeAdd||0);
      x._dq=false;x.finalDQ=false;
      if(x.disqualified||x.comDQ||x.comDNS){x._t=1e18;x._dq=true;x.finalDQ=true;}
      else if(x.comDNF){x._t=1e18;x._dq=false;x.finalDQ=false;x.hasPenalty=true;}
      x.finalTime=x._t;
    });
    if(sess.type==='QUALIFY'){
      arr.sort((a,b)=>{
        const aOk=Number.isFinite(a.best)&&a.best>0&&a.best<1e17&&(a.laps>=2)&&!a._dq;
        const bOk=Number.isFinite(b.best)&&b.best>0&&b.best<1e17&&(b.laps>=2)&&!b._dq;
        if(aOk&&!bOk)return -1;if(!aOk&&bOk)return 1;
        if(!aOk&&!bOk){if((b.laps||0)!==(a.laps||0))return(b.laps||0)-(a.laps||0);return(a.best||1e18)-(b.best||1e18);}
        return a.best-b.best;
      });
      return arr;
    }
    // Auto NC-DNF (<75% des tours)
    const wlInit=Math.max(0,...arr.map(y=>(y.laps)||0));
    const mlInit=Math.ceil(wlInit*MIN_PCT);
    arr.forEach(y=>{
      if(!y.comDNF && !y._dq && (y.laps||0)>0 && (y.laps||0)<mlInit)y.comDNF=true;
      // remettre _t à 1e18 si comDNF a été ajouté
      if(y.comDNF){y._t=1e18;y._dq=false;y.finalDQ=false;y.finalTime=y._t;y.hasPenalty=true;}
    });
    // Reclassement 75%
    let wl=0,wt=1e18;
    for(const x of arr){
      if(x._dq||x.comDNS||x._t>=1e18)continue;
      const L=x.laps||0,T=x._t;
      if(L>wl||(L===wl&&T<wt)){wl=L;wt=T;}
    }
    const fin=[],cls=[],nc=[],bak=[];
    if(wl>0&&wt<1e18){
      const ml=Math.ceil(wl*MIN_PCT);
      for(const x of arr){
        if(x._dq||x.comDNS||(x.laps||0)<=0){bak.push(x);continue;}
        if(x._t>=1e18||x.comDNF){nc.push(x);continue;}
        const L=x.laps||0,T=x._t;
        if(T>=wt){fin.push(x);continue;}
        if(L>=ml){cls.push(x);continue;}
        nc.push(x);
      }
      fin.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
      cls.sort((a,b)=>(b.laps||0)-(a.laps||0)||b._t-a._t);
      nc.sort((a,b)=>(b.laps||0)-(a.laps||0)||a._t-b._t);
      return [...fin,...cls,...nc,...bak];
    }else{
      arr.sort((a,b)=>{function cl(x){if(x._dq)return 2;if(x.comDNF)return 1;return 0;}return cl(a)-cl(b)||(b.laps||0)-(a.laps||0)||a._t-b._t;});
      return arr;
    }
  }

  // ------------- Setup -------------
  // Override findSessionIdx pour renvoyer des indices COMPATIBLES avec penMap
  // (mêmes indices utilisés par rounds: ri = 0-based du round, si = index DANS le round
  // avec Q=0, R1=1, R2=2... car penMap est construit comme ça par addAdjustment
  // de site.js ligne 1057).
  function myFindSessionIdx(sess){
    if(typeof rounds!=='function')return[-1,-1];
    const rs=rounds();
    for(let i=0;i<rs.length;i++){
      const j=rs[i].sessions.indexOf(sess);
      if(j>=0)return[i,j];
    }
    return[-1,-1];
  }
  // Remplacer la fonction globale
  window.findSessionIdx=myFindSessionIdx;

  function install(){
    if(typeof addAdjustment==='undefined'||typeof rounds!=='function'||typeof calculate!=='function'){
      setTimeout(install,80);return;
    }

    // openAdjForm multi-choix
    const _addAdj=window.addAdjustment;
    window.addAdjustment=function(rj,sj,did,timeAdd,dq,warning,note,extra){
      if(extra&&(extra.dnf||extra.dns)){
        const entry={timeAdd:+timeAdd||0,dq:!!dq,warning:!!warning,note:note||''};
        if(extra.dnf)entry.dnf=true;
        if(extra.dns)entry.dns=true;
        if(typeof penMap==='object'){
          penMap[`${rj}:${sj}:${did}`]=entry;
          if(typeof saveState==='function')saveState();
          if(typeof render==='function')render();
        }
        return;
      }
      return _addAdj.apply(this,arguments);
    };
    window.openAdjForm=function(rj,sj,did){
      const c=String(prompt("Ajustement :\n1=Pénalité temps\n2=DNF<75% (0pt)\n3=DNS (absent)\n4=DQ\n5=Avertissement\n0=Annuler",'1')||'').trim();
      if(!c||c==='0')return;
      if(c==='2'){if(!confirm("DNF non-classé (<75%) ?"))return;window.addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Abandon')||'Abandon',{dnf:true});return;}
      if(c==='3'){if(!confirm("DNS (absent) ?"))return;window.addAdjustment(rj,sj,did,0,false,false,prompt("Note ?",'Absent')||'Absent',{dns:true});return;}
      if(c==='4'){if(!confirm("DQ ?"))return;window.addAdjustment(rj,sj,did,0,true,false,prompt("Note ?",'')||'');return;}
      if(c==='5'){if(!confirm("Avertissement ?"))return;window.addAdjustment(rj,sj,did,0,false,true,'');return;}
      const ta=prompt("Temps (s) ?",'0');if(ta===null)return;
      window.addAdjustment(rj,sj,did,+ta||0,false,false,prompt('Note ?','')||'');
    };

    // Remplacer sortSession par NOTRE version (indépendante de v40/v42/v44)
    window.sortSession=mySortSession;

    // Forcer doubleLongRaces
    const _pc=window.pointsConfig;
    if(_pc){window.pointsConfig=function(){const c=_pc();c.doubleLongRaces=true;return c;};}

    // Wrapper calculate : strip + points aux classés-DNF + pole
    const _calc=window.calculate;
    window.calculate=function(){
      stripServerPens();
      const ds=_calc();
      if(typeof pointsConfig!=='function')return ds;
      const rs=rounds();const cfg=pointsConfig();
      const sc=cfg.pointsScale||(window.DEFAULT_POINTS&&window.DEFAULT_POINTS.pointsScale)||[];
      const polePts=cfg.polePoints||0;
      const dbl=cfg.doubleLongRaces!==false;
      rs.forEach((rd,j)=>{
        const races=(rd.sessions||[]).filter(s=>s.type==='RACE');
        const mult=(races.length===1&&dbl)?2:1;
        races.forEach((race,ri)=>{
          const rm=ri===0?mult:1;
          // Récupérer la liste triée (avec nos reclassements) — _calc a déjà appelé
          // sortSession qui a été remplacé par mySortSession. race.results contient
          // donc les CLONES dans l'ordre. Mais _calc utilise le tableau trié renvoyé
          // par sortSession ; race.results a été remplacé par sortSession au début
          // de calculate site.js.
          const arr=race.results;if(!arr||!arr.length)return;
          let wl=0,wt=1e18;
          for(const x of arr){if(x._dq||x.comDNS||x._t>=1e18)continue;const L=x.laps||0;if(L>wl||(L===wl&&x._t<wt)){wl=L;wt=x._t;}}
          if(wl===0)return;
          const ml=Math.ceil(wl*MIN_PCT);
          let poleId=null;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&(x.laps||0)>=ml){poleId=x.id;break;}}
          let poleGiven=false;
          for(const x of arr){if(x.grid===1&&!x._dq&&!x.comDNS&&x._t<1e18&&x._t>=wt){poleGiven=true;break;}}
          for(let i=0;i<arr.length;i++){
            const x=arr[i];
            if(x._dq||x.comDNS||x._t>=1e18)continue;
            if((x.laps||0)<ml)continue;
            if(x._t<wt){
              const p=(i<sc.length?sc[i]*rm:0);
              const d=ds.find(dd=>dd.id===x.id);if(d){d.rounds[j]+=p;}
              if(!poleGiven && x.id===poleId){if(d)d.rounds[j]+=polePts*mult;poleGiven=true;}
            }
          }
        });
      });
      ds.forEach(d=>{d.total=d.rounds.reduce((a,b)=>a+b,0);});
      return ds;
    };

    // Wrapper render : strip avant
    const _r=window.render;
    if(_r){window.render=function(){stripServerPens();return _r.apply(this,arguments);};}

    // Colonne "Pénal." dans manche()
    const _manche=window.manche;
    if(_manche){
      window.manche=function(){
        const html=_manche.apply(this,arguments);
        try{
          const rs=rounds();if(!rs||typeof round!=='number'||round>=rs.length)return html;
          const r=rs[round];if(!r||typeof sessionIndex!=='number'||sessionIndex>=r.sessions.length)return html;
          const s=r.sessions[sessionIndex];if(!s)return html;
          const sorted=Array.isArray(s.results)&&s.results[0]&&typeof s.results[0]._t!=='undefined'?s.results:mySortSession(s);
          function penLbl(x){
            const tags=[];
            if(x.comDQ)tags.push('DQ');
            if(x.comDNS)tags.push('DNS');
            if(x.comDNF&&!x.comDQ&&!x.comDNS)tags.push('DNF');
            if(typeof x.comTimeAdd==='number'&&x.comTimeAdd>0)tags.push('+'+Math.round(x.comTimeAdd/1000)+'s');
            if(x.comWarning)tags.push('Aver.');
            return tags.join(', ');
          }
          let out=html;
          const hdr='<th>Meilleur tour</th>';
          const hpos=out.lastIndexOf(hdr);
          if(hpos>=0)out=out.slice(0,hpos+hdr.length)+'<th>Pénal.</th>'+out.slice(hpos+hdr.length);
          let idx=0;
          out=out.replace(/<tr><td class="pos">[\s\S]*?<\/tr>/g,function(match){
            if(!/:\d\d\.\d{3}/.test(match))return match;
            const x=sorted[idx++];if(!x)return match;
            const lbl=penLbl(x);
            const cell=lbl?`<td style="color:#e57a47;font-weight:600">${lbl}</td>`:`<td class="muted">—</td>`;
            let pos=0,count=0;
            while(count<5){const nd=match.indexOf('</td>',pos);if(nd<0)break;pos=nd+5;count++;}
            return match.slice(0,pos)+cell+match.slice(pos);
          });
          return out;
        }catch(e){console.warn('[v69] pen-col',e);return html;}
      };
    }

    console.log('[v69] installed (self-contained sortSession, no v44 dependency for pen).');
    stripServerPens();
    try{if(window.calculate)window.calculate();if(window.render)window.render();}catch(e){console.warn('[v69] init',e)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

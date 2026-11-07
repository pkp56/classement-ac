/* patches-v45.js — v67
 *  1) openAdjForm multi-choix (Pénal./DNF<75%/DNS/DQ/Avertissement)
 *  2) Règle 75% classante : DNF ≥75% marque les points de sa position (derrière
 *     les finishers), DNF <75% = 0 pt. DNS/DQ = 0 pt.
 *     Critère finisher AC = T final >= T final vainqueur (a vu le drapeau).
 *  3) Supprime TOUTES les pénalités serveur du JSON (penaltyTime/hasPenalty/
 *     lapPenalty) : time est remis au temps brut. Seules les pénalités
 *     Commission (penMap) sont appliquées.
 *  4) Force doubleLongRaces=true (course 1h = ×2).
 *  5) Colonne "Pénal." dans le tableau des résultats de chaque manche
 *     affiche les pénalités Commission (+5s, DNF, DNS, DQ, Aver.).
 */
(function(){
  'use strict';
  if(window.__gdspV45Installed)return;
  window.__gdspV45Installed=true;
  const MIN_PCT=0.75;

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

  function penMs(v){
    v=Number(v)||0;
    if(v>=1e8)return v/1e6;
    if(v>=1e4)return v;
    return v*1000;
  }

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
        // hasPenalty : true uniquement si une pénalité COMMISSION existe pour ce pilote
        // (timeAdd>0, dq, dnf, dns, warning). On le détermine à partir du penMap.
        r.hasPenalty=false;
      });
    });
    // Marquer hasPenalty=true pour les pilotes avec une commission
    if(typeof penMap==='object'&&typeof rounds==='function'){
      const rs=rounds();
      rs.forEach((rd,rj)=>{
        rd.sessions.forEach((s,sj)=>{
          if(!s||!(s.results||[]).length)return;
          s.results.forEach(r=>{
            const k=`${rj}:${sj}:${r.id}`;const adj=penMap[k];
            if(adj&&(adj.timeAdd||adj.dq||adj.dnf||adj.dns||adj.warning))r.hasPenalty=true;
          });
        });
      });
    }
  }

  function markDNFOnArr(arr,rIdx,sIdx){
    if(!arr)return;
    arr.forEach(y=>{y.comDNF=false;y.comDNS=false;});
    if(typeof penMap==='object'){
      for(const k in penMap){
        const [rj,sj,did]=k.split(':');
        if(+rj!==rIdx||+sj!==sIdx)continue;
        const y=arr.find(x=>x.id===did);if(!y)continue;
        const adj=penMap[k];
        if(adj.dnf)y.comDNF=true;
        if(adj.dns)y.comDNS=true;
      }
    }
    const wl=Math.max(0,...arr.map(y=>(y.laps)||0));
    const ml=Math.ceil(wl*MIN_PCT);
    arr.forEach(y=>{
      if((y.laps||0)>0 && (y.laps||0)<ml)y.comDNF=true;
      if(y.lapPenalty && !y.comDQ)y.comDNF=true;
    });
  }

  function hookApplyCommission(){
    const _applyCommission=window.applyCommissionToArr;
    if(!_applyCommission)return false;
    window.applyCommissionToArr=function(arr,sess,rIdx,sIdx){
      const ret=_applyCommission.apply(this,arguments);
      try{
        if(sess&&sess.type==='RACE'&&Array.isArray(arr)){markDNFOnArr(arr,rIdx,sIdx);}
      }catch(e){console.warn('[v67] markDNF error',e);}
      return ret;
    };
    return true;
  }

  function reclassify(arr){
    if(!arr||!arr.length)return arr;
    let wl=0,wt=1e18;
    for(const x of arr){
      if(x._dq||x.comDNS||x._t>=1e18)continue;
      const L=x.laps||0,T=x._t;
      if(L>wl||(L===wl&&T<wt)){wl=L;wt=T;}
    }
    if(wl===0||wt>=1e18)return arr;
    const ml=Math.ceil(wl*MIN_PCT);
    const fin=[],cls=[],nc=[],bak=[];
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
  }

  function install(){
    if(typeof sortSession!=='function'||typeof calculate!=='function'||typeof addAdjustment!=='function'||typeof rounds!=='function'){setTimeout(install,80);return;}

    stripServerPens();
    const _origR=window.render;if(_origR){window.render=function(){stripServerPens();return _origR.apply(this,arguments);};}
    const _origCalc0=window.calculate;if(_origCalc0){window.calculate=function(){stripServerPens();return _origCalc0.apply(this,arguments);};}

    if(!hookApplyCommission()){setTimeout(install,80);return;}

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

    const _ss=window.sortSession;
    window.sortSession=function(sess){
      const arr=_ss(sess);
      if(!sess||sess.type!=='RACE')return arr;
      try{return reclassify(arr);}catch(e){console.warn('[v67] reclassify',e);return arr;}
    };

    const _calc=window.calculate;
    window.calculate=function(){
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

    const _pc=window.pointsConfig;
    if(_pc){window.pointsConfig=function(){const c=_pc();c.doubleLongRaces=true;return c;};}

    // --- Colonne "Pénal." dans le tableau résultats de manche() ---
    const _manche=window.manche;
    if(_manche){
      window.manche=function(){
        const html=_manche.apply(this,arguments);
        try{
          const rs=rounds();if(!rs||typeof round!=='number'||round>=rs.length)return html;
          const r=rs[round];if(!r||typeof sessionIndex!=='number'||sessionIndex>=r.sessions.length)return html;
          const s=r.sessions[sessionIndex];if(!s)return html;
          const sorted=(typeof sortSession==='function')?sortSession(s):(s.results||[]);
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
          if(hpos>=0){
            out=out.slice(0,hpos+hdr.length)+'<th>Pénal.</th>'+out.slice(hpos+hdr.length);
          }
          let idx=0;
          out=out.replace(/<tr><td class="pos">[\s\S]*?<\/tr>/g,function(match){
            if(!/:\d\d\.\d{3}/.test(match))return match;  // pas une ligne de résultats (ex: collisions)
            const x=sorted[idx++];if(!x)return match;
            const lbl=penLbl(x);
            const cell=lbl?`<td style="color:#e57a47;font-weight:600">${lbl}</td>`:`<td class="muted">—</td>`;
            // Insérer après le 5e </td> → colonne "Meilleur tour"
            let pos=0,count=0;
            while(count<5){const nd=match.indexOf('</td>',pos);if(nd<0)break;pos=nd+5;count++;}
            return match.slice(0,pos)+cell+match.slice(pos);
          });
          return out;
        }catch(e){console.warn('[v67] pen-col error',e);return html;}
      };
    }

    console.log('[v67] installed.');
    try{if(window.calculate)window.calculate();if(window.render)window.render();}catch(e){console.warn('[v67] init',e)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();

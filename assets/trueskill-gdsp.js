/* GDSP Global — adaptateur des sessions courantes vers les courses TrueSkill.
 *
 * Ce module ne connaît ni le DOM ni les bases : il transforme la structure
 *événementielle du site (events → sessions RACE → sortSessionForPerf) en
 * courses admissibles pour GDSPTrueSkill.replay. Les fonctions métier déjà
 * vérifiées du site (groupSessionsByDate, sortSessionForPerf,
 * eventGlobalWeight) lui sont injectées par l'appelant, PC ou mobile, afin
 * de garantir une parité PC/mobile exacte.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GDSPTrueSkillAdapter=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';

  function defaultServiceOf(entrant){
    try{
      if(typeof GDSPEntrantRoles!=='undefined'&&GDSPEntrantRoles.serviceRole)return GDSPEntrantRoles.serviceRole(entrant)||'';
    }catch(_){}
    try{
      if(typeof window!=='undefined'&&window.GDSPEntrantRoles&&window.GDSPEntrantRoles.serviceRole)return window.GDSPEntrantRoles.serviceRole(entrant)||'';
    }catch(_){}
    return '';
  }

  /**
   * @param {Array} events catalogue complet (PC : variable globale `events`,
   *   mobile : idem côté profile-engine).
   * @param {Object} helpers {groupSessionsByDate, sortSessionForPerf, eventGlobalWeight, serviceOf?}
   * @returns courses prêtes pour GDSPTrueSkill.replay, incluant les courses
   *   non admissibles (globalWeight <= 0 exclues ici, coefficient nulle) ; le
   *   moteur re-vérifie les coefficients.
   */
  function buildCourses(events,helpers){
    if(!helpers||typeof helpers.groupSessionsByDate!=='function'||typeof helpers.sortSessionForPerf!=='function'||typeof helpers.eventGlobalWeight!=='function'){
      throw new TypeError('buildCourses attend {groupSessionsByDate, sortSessionForPerf, eventGlobalWeight}.');
    }
    const serviceOf=typeof helpers.serviceOf==='function'?helpers.serviceOf:defaultServiceOf;
    const courses=[];
    for(const ev of events||[]){
      const weight=Number(helpers.eventGlobalWeight(ev));
      if(!(weight>0))continue;
      const data=ev&&ev.data||{};
      const evSessions=Array.isArray(data.sessions)?data.sessions:[];
      const penMap=data.penMap||{};
      const minPct=(ev.points_config&&ev.points_config.minPercentDistance)??0.75;
      helpers.groupSessionsByDate(evSessions).forEach((rd,roundIndex)=>{
        let raceNumber=0;
        rd.sessions.forEach((session,sessionIndex)=>{
          if(!session||session.type!=='RACE')return;
          raceNumber++;
          const sorted=helpers.sortSessionForPerf(session,roundIndex,sessionIndex,penMap,minPct)||[];
          const laps=Array.isArray(session.laps)?session.laps:[];
          const participants=sorted.filter(r=>!r.comDNS&&((r.laps||0)>0||laps.some(l=>l&&l.id===r.id)));
          const entries=[];
          let position=0;
          for(const r of sorted){
            position++;
            if(!participants.includes(r))continue;
            const service=serviceOf(r);
            let outcome;
            if(service)outcome='service';
            else if(r.comDNF)outcome='dnf_unqualified';
            else if(r.comDQ)outcome='dq_sporting';
            else if(r.disqualified)outcome='dq_unqualified';
            else outcome='classified';
            entries.push({id:r.id,name:r.name,team:r.team||'',rank:position,outcome});
          }
          const label=`${ev.name||ev.slug} · M${roundIndex+1} C${raceNumber}`;
          courses.push({
            key:`${ev.slug}:${session.date}:${session.track||''}:${session.type}`,
            raceKey:`${ev.slug}:${roundIndex+1}:RACE${raceNumber}`,
            eventSlug:ev.slug,
            eventName:ev.name||ev.slug,
            eventKind:ev.kind||'',
            date:session.date,
            track:session.track||'',
            label,
            globalWeight:weight,
            entries
          });
        });
      });
    }
    courses.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||String(a.key).localeCompare(String(b.key),'fr'));
    return courses;
  }

  return {buildCourses};
});

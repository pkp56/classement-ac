/* GDSP Global — moteur TrueSkill expérimental.
 *
 * Port JavaScript propre, compatible navigateur et Node, du modèle décrit par
 * Herbrich, Minka et Graepel, "TrueSkill: A Bayesian Skill Rating System",
 * NIPS 2006. Le calcul reprend le graphe factoriel et le passage de messages
 * gaussiens, y compris les facteurs de troncature pour les victoires et les
 * égalités.
 *
 * Le module ne lit ni les bases, ni les sessions, ni la Commission. Le code
 * appelant fournit des courses déjà nettoyées : coefficients Global, résultats
 * sportifs et nature des DNF/DNS/DQ sont des décisions d'entrée.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GDSPTrueSkill=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';

  const INITIAL_MU=25;
  const INITIAL_SIGMA=INITIAL_MU/3;
  const DEFAULT_BETA=INITIAL_SIGMA/2;
  const DEFAULT_SIGMA_DRIFT=INITIAL_SIGMA/100;
  const DEFAULT_DRAW_PROBABILITY=0.10;
  const EPSILON=1e-12;

  // Numerical Recipes 2e : erfc, puis son inverse par Newton.
  function erfc(x){
    const z=Math.abs(x),t=1/(1+z/2);
    const r=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+t*(-0.82215223+t*0.17087277)))))))));
    return x>=0?r:2-r;
  }
  function ierfc(x){
    if(x>=2)return -100;
    if(x<=0)return 100;
    const xx=x<1?x:2-x;
    let t=Math.sqrt(-2*Math.log(xx/2));
    let r=-0.70711*((2.30753+t*0.27061)/(1+t*(0.99229+t*0.04481))-t);
    for(let j=0;j<2;j++){
      const err=erfc(r)-xx;
      r+=err/(1.12837916709551257*Math.exp(-(r*r))-r*err);
    }
    return x<1?r:-r;
  }
  const normalPdf=x=>Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);
  const normalCdf=x=>0.5*erfc(-x/Math.SQRT2);
  const normalPpf=p=>{
    if(!(p>0&&p<1))throw new RangeError('normalPpf attend une probabilité strictement comprise entre 0 et 1.');
    return -Math.SQRT2*ierfc(2*p);
  };
  const vWin=(t,e)=>normalPdf(t-e)/normalCdf(t-e);
  const wWin=(t,e)=>{const v=vWin(t,e);return v*(v+t-e);};
  const vDraw=(t,e)=>(normalPdf(-e-t)-normalPdf(e-t))/(normalCdf(e-t)-normalCdf(-e-t));
  const wDraw=(t,e)=>{
    const pMinus=normalPdf(e-t),pPlus=normalPdf(e+t),den=normalCdf(e-t)-normalCdf(-e-t);
    const v=vDraw(t,e);
    return v*v+((e-t)*pMinus+(e+t)*pPlus)/den;
  };

  class Gaussian{
    constructor({mu,sigma,pi,tau}={}){
      if(pi!==undefined){
        if(!(pi>=0)||!Number.isFinite(tau))throw new RangeError('Gaussian : précision et tau invalides.');
        this.pi=pi;this.tau=tau;
      }else if(mu!==undefined){
        if(!(Number.isFinite(mu)&&Number.isFinite(sigma)&&sigma>0))throw new RangeError('Gaussian : moyenne ou écart-type invalide.');
        this.pi=1/(sigma*sigma);this.tau=this.pi*mu;
      }else{
        this.pi=0;this.tau=0;
      }
    }
    static infinity(){return new Gaussian();}
    muSigma(){
      if(this.pi===0)return [0,Infinity];
      return [this.tau/this.pi,Math.sqrt(1/this.pi)];
    }
    mul(other){
      if(!(other instanceof Gaussian))throw new TypeError('mul attend une Gaussian.');
      return new Gaussian({pi:this.pi+other.pi,tau:this.tau+other.tau});
    }
    div(other){
      if(!(other instanceof Gaussian))throw new TypeError('div attend une Gaussian.');
      return new Gaussian({pi:this.pi-other.pi,tau:this.tau-other.tau});
    }
  }

  class Variable{
    constructor(){this.value=Gaussian.infinity();this.factors=new Map();}
    attachFactor(factor){this.factors.set(factor,Gaussian.infinity());}
    updateMessage(factor,message){
      const old=this.factors.get(factor);
      if(!old)throw new Error('Facteur non attaché.');
      this.value=this.value.div(old).mul(message);
      this.factors.set(factor,message);
    }
    updateValue(factor,value){
      const old=this.factors.get(factor);
      if(!old)throw new Error('Facteur non attaché.');
      this.factors.set(factor,value.mul(old).div(this.value));
      this.value=value;
    }
    getMessage(factor){
      const value=this.factors.get(factor);
      if(!value)throw new Error('Facteur non attaché.');
      return value;
    }
  }

  class Factor{
    constructor(variables){this.variables=variables;for(const variable of variables)variable.attachFactor(this);}
  }
  class PriorFactor extends Factor{
    constructor(variable,param){super([variable]);this.param=param;}
    start(){this.variables[0].updateValue(this,this.param);}
  }
  class LikelihoodFactor extends Factor{
    constructor(meanVariable,valueVariable,variance){
      super([meanVariable,valueVariable]);
      this.mean=meanVariable;this.value=valueVariable;this.variance=variance;
    }
    updateValue(){
      const y=this.mean.value,fy=this.mean.getMessage(this),den=y.pi-fy.pi;
      const a=1/(1+this.variance*den);
      this.value.updateMessage(this,new Gaussian({pi:a*den,tau:a*(y.tau-fy.tau)}));
    }
    updateMean(){
      const x=this.value.value,fx=this.value.getMessage(this),den=x.pi-fx.pi;
      const a=1/(1+this.variance*den);
      this.mean.updateMessage(this,new Gaussian({pi:a*den,tau:a*(x.tau-fx.tau)}));
    }
  }
  class SumFactor extends Factor{
    constructor(sumVariable,termVariables,coeffs){
      if(termVariables.length!==coeffs.length)throw new RangeError('SumFactor : nombre de termes et coefficients différents.');
      super([sumVariable,...termVariables]);
      this.sum=sumVariable;this.terms=termVariables;this.coeffs=coeffs.slice();
    }
    internalUpdate(variable,y,fy,a){
      const precisionTerms=a.map((_,j)=>y[j].pi-fy[j].pi);
      for(const value of precisionTerms)if(!(value>0))throw new RangeError('Précision non finie dans SumFactor.');
      const newPi=1/a.reduce((sum,value,j)=>sum+(value*value)/precisionTerms[j],0);
      const newTau=newPi*a.reduce((sum,value,j)=>sum+value*(y[j].tau-fy[j].tau)/precisionTerms[j],0);
      variable.updateMessage(this,new Gaussian({pi:newPi,tau:newTau}));
    }
    updateSum(){
      const y=this.terms.map(term=>term.value),fy=this.terms.map(term=>term.getMessage(this));
      this.internalUpdate(this.sum,y,fy,this.coeffs);
    }
    updateTerm(index){
      const b=this.coeffs,a=[];
      for(let i=0;i<b.length;i++)if(i!==index)a.push(-b[i]/b[index]);
      a.splice(index,0,1/b[index]);
      const variables=this.terms.slice();variables[index]=this.sum;
      const y=variables.map(variable=>variable.value),fy=variables.map(variable=>variable.getMessage(this));
      this.internalUpdate(this.terms[index],y,fy,a);
    }
  }
  class TruncateFactor extends Factor{
    constructor(variable,win,epsilon){super([variable]);this.variable=variable;this.win=win;this.epsilon=epsilon;}
    update(){
      const x=this.variable.value,fx=this.variable.getMessage(this),c=x.pi-fx.pi,d=x.tau-fx.tau;
      if(!(c>0))throw new RangeError('Facteur de troncature : précision invalide.');
      const sqrtC=Math.sqrt(c),t=d/sqrtC,e=this.epsilon*sqrtC;
      const V=this.win?vWin(t,e):vDraw(t,e),W=this.win?wWin(t,e):wDraw(t,e);
      if(!(1-W>0))throw new RangeError('Facteur de troncature : divergence inattendue.');
      this.variable.updateValue(this,new Gaussian({pi:c/(1-W),tau:(d+sqrtC*V)/(1-W)}));
    }
  }

  function drawMargin(drawProbability,beta){
    if(!(drawProbability>=0&&drawProbability<1))throw new RangeError('drawProbability doit être compris entre 0 inclus et 1 exclu.');
    const p=(drawProbability+1)/2;
    return normalPpf(p)*Math.sqrt(2)*beta;
  }
  function raceEpsilon(options,beta){
    if(options.epsilon!=null){
      if(!(Number.isFinite(options.epsilon)&&options.epsilon>=0))throw new RangeError('epsilon invalide.');
      return options.epsilon;
    }
    const drawProbability=options.drawProbability??DEFAULT_DRAW_PROBABILITY;
    return drawMargin(drawProbability,beta);
  }
  function orderRanking(rows){
    const ranks=[];
    let i=0;
    while(i<rows.length){
      let j=i+1;
      while(j<rows.length&&rows[j].rank===rows[i].rank)j++;
      ranks.push(...Array(j-i).fill(i+1));
      i=j;
    }
    return ranks;
  }
  function adjustRace(players,options={}){
    if(!Array.isArray(players)||players.length<2)throw new RangeError('Une course doit contenir au moins deux participants.');
    const beta=Number.isFinite(options.beta)&&options.beta>0?options.beta:DEFAULT_BETA;
    const sigmaDrift=Number.isFinite(options.sigmaDrift)&&options.sigmaDrift>=0?options.sigmaDrift:DEFAULT_SIGMA_DRIFT;
    const epsilon=raceEpsilon(options,beta);
    const ordered=players.map(player=>({...player,skill:[Number(player.mu),Number(player.sigma)]})).sort((a,b)=>a.rank-b.rank||String(a.id).localeCompare(String(b.id),'fr'));
    if(ordered.some(player=>!Number.isFinite(player.mu)||!Number.isFinite(player.sigma)||player.sigma<=0||!Number.isFinite(player.rank)))throw new RangeError('Participant TrueSkill invalide.');

    const skills=ordered.map(()=>new Variable()),performances=ordered.map(()=>new Variable()),teams=ordered.map(()=>new Variable()),differences=ordered.slice(0,-1).map(()=>new Variable());
    const priorFactors=skills.map((variable,i)=>new PriorFactor(variable,new Gaussian({mu:ordered[i].mu,sigma:ordered[i].sigma+sigmaDrift})));
    const likelihoodFactors=skills.map((skill,i)=>new LikelihoodFactor(skill,performances[i],beta*beta));
    const perfToTeamFactors=performances.map((performance,i)=>new SumFactor(teams[i],[performance],[1]));
    const differenceFactors=differences.map((difference,i)=>new SumFactor(difference,[teams[i],teams[i+1]],[1,-1]));
    const truncateFactors=differences.map((difference,i)=>new TruncateFactor(difference,ordered[i].rank!==ordered[i+1].rank,epsilon));

    for(const factor of priorFactors)factor.start();
    for(const factor of likelihoodFactors)factor.updateValue();
    for(const factor of perfToTeamFactors)factor.updateSum();
    for(let iteration=0;iteration<5;iteration++){
      for(const factor of differenceFactors)factor.updateSum();
      for(const factor of truncateFactors)factor.update();
      for(const factor of differenceFactors){factor.updateTerm(0);factor.updateTerm(1);}
    }
    for(const factor of perfToTeamFactors)factor.updateTerm(0);
    for(const factor of likelihoodFactors)factor.updateMean();

    return ordered.map((player,i)=>{
      const [mu,sigma]=skills[i].value.muSigma();
      return {...player,before:{mu:player.mu,sigma:player.sigma},after:{mu,sigma},deltaMu:mu-player.mu,influences:null};
    });
  }

  const INCLUDED_OUTCOMES=new Set(['classified','dq_sporting','dnf_commission']);
  const EXCLUSION_REASONS={service:'Véhicule de service',dns:'DNS',dnf_unqualified:'DNF non qualifié par la Commission',dq_unqualified:'DQ non qualifiée par la Commission',excluded_commission:'Exclu par la Commission',zero_weight:'Coefficient Global nul'};
  const finiteWeight=value=>Number.isFinite(value)?Math.max(0,value):1;
  function normalizeEntries(course){
    const entries=Array.isArray(course.entries)?course.entries:[];
    const excluded=[],seen=new Set(),includedByOrder=[];
    for(const raw of entries){
      if(!raw||typeof raw!=='object')continue;
      const id=String(raw.id||'').trim(),name=String(raw.name||'').trim();
      const key=id||name,outcome=String(raw.outcome||'classified');
      const reason=raw.service?EXCLUSION_REASONS.service:(INCLUDED_OUTCOMES.has(outcome)?'':EXCLUSION_REASONS[outcome]||'Résultat non classable');
      if(reason){excluded.push({id,name,reason});continue;}
      if(!id||!name){excluded.push({id,name,reason:'Identité absente'});continue;}
      if(seen.has(id)){excluded.push({id,name,reason:'Identifiant dupliqué'});continue;}
      seen.add(id);
      const rank=raw.rank==null?NaN:Number(raw.rank);
      includedByOrder.push({...raw,id,name,rank:Number.isFinite(rank)?rank:NaN});
    }
    return {includedByOrder,excluded};
  }
  function prepareCourse(course,index,hidden={}){
    const result=normalizeEntries(course,index);
    const included=[];
    for(const entry of result.includedByOrder){
      if(hidden[entry.id]){result.excluded.push({id:entry.id,name:entry.name,reason:'Exclusion Global administration'});continue;}
      included.push(entry);
    }
    if(included.length<2)return {ready:false,reason:'Moins de deux participants notables',excluded:result.excluded,index};
    const ranksPresent=included.filter(entry=>Number.isFinite(entry.rank)&&entry.rank>0).length;
    if(ranksPresent>0&&ranksPresent!==included.length)return {ready:false,reason:'Rangs fournis pour seulement une partie du peloton',excluded:result.excluded,index};
    if(ranksPresent===0)included.forEach((entry,i)=>{entry.rank=i+1;});
    included.sort((a,b)=>a.rank-b.rank||String(a.id).localeCompare(String(b.id),'fr'));
    const ranks=orderRanking(included);
    included.forEach((entry,i)=>{entry.rank=ranks[i];});
    const weight=finiteWeight(Number(course.globalWeight));
    if(weight<=0)return {ready:false,reason:'Coefficient Global nul',excluded:[...result.excluded,...included.map(entry=>({id:entry.id,name:entry.name,reason:EXCLUSION_REASONS.zero_weight}))],index};
    return {ready:true,course,included,excluded:result.excluded,index,weight};
  }
  function confidenceForSigma(sigma){return sigma<=3?'Élevée':sigma<=5?'Moyenne':'Faible';}
  function replay(courses,options={}){
    if(!Array.isArray(courses))throw new TypeError('replay attend un tableau de courses.');
    const beta=Number.isFinite(options.beta)&&options.beta>0?options.beta:DEFAULT_BETA;
    const sigmaDrift=Number.isFinite(options.sigmaDrift)&&options.sigmaDrift>=0?options.sigmaDrift:DEFAULT_SIGMA_DRIFT;
    const drawProbability=options.drawProbability??DEFAULT_DRAW_PROBABILITY;
    const minRaces=Math.max(1,Math.floor(Number(options.minRaces)||5));
    const hidden=options.hidden&&typeof options.hidden==='object'?options.hidden:{};
    const baseBeta=Number.isFinite(options.beta)&&options.beta>0?options.beta:beta;
    const state=new Map(),diagnostics={coursesUsed:0,coursesSkipped:0,skipped:[],warnings:[]};
    const sorted=[...courses].map((course,index)=>({...course,_index:index})).sort((a,b)=>(Date.parse(a.date)||0)-(Date.parse(b.date)||0)||String(a.key||'').localeCompare(String(b.key||''),'fr')||a._index-b._index);
    for(const rawCourse of sorted){
      const prepared=prepareCourse(rawCourse,rawCourse._index,hidden);
      if(!prepared.ready){diagnostics.coursesSkipped++;diagnostics.skipped.push({key:rawCourse.key||'',date:rawCourse.date||'',index:prepared.index,reason:prepared.reason,excluded:prepared.excluded});continue;}
      const betaForRace=baseBeta/Math.sqrt(prepared.weight);
      const players=prepared.included.map(entry=>{
        const current=state.get(entry.id)||{id:entry.id,name:entry.name,team:entry.team||'',mu:INITIAL_MU,sigma:INITIAL_SIGMA,races:0,exclusions:[],history:[]};
        current.name=entry.name;current.team=entry.team||'';
        return {...current,rank:entry.rank};
      });
      let updates;
      try{updates=adjustRace(players,{beta:betaForRace,sigmaDrift,drawProbability});}
      catch(error){diagnostics.coursesSkipped++;diagnostics.skipped.push({key:rawCourse.key||'',date:rawCourse.date||'',index:prepared.index,reason:'Calcul impossible : '+error.message,excluded:prepared.excluded});continue;}
      for(const update of updates){
        const rating=state.get(update.id)||{id:update.id,name:update.name,team:update.team||'',mu:INITIAL_MU,sigma:INITIAL_SIGMA,races:0,exclusions:[],history:[]};
        rating.name=update.name;rating.team=update.team||'';
        rating.mu=update.after.mu;rating.sigma=update.after.sigma;rating.races++;
        rating.history.push({key:rawCourse.key||'',date:rawCourse.date||'',label:rawCourse.label||'',weight:prepared.weight,rank:update.rank,beforeMu:update.before.mu,beforeSigma:update.before.sigma,afterMu:update.after.mu,afterSigma:update.after.sigma,deltaMu:update.deltaMu,conservative:update.after.mu-3*update.after.sigma});
        state.set(update.id,rating);
      }
      diagnostics.coursesUsed++;
    }
    const all=[...state.values()].map(rating=>({...rating,conservative:rating.mu-3*rating.sigma,confidence:confidenceForSigma(rating.sigma),provisional:rating.races<10,displayable:rating.races>=minRaces})).sort((a,b)=>b.conservative-a.conservative||a.name.localeCompare(b.name,'fr'));
    return {ratings:all.filter(rating=>rating.displayable),all,diagnostics,parameters:{initialMu:INITIAL_MU,initialSigma:INITIAL_SIGMA,beta:baseBeta,sigmaDrift,drawProbability,minRaces}};
  }

  return {INITIAL_MU,INITIAL_SIGMA,DEFAULT_BETA,DEFAULT_SIGMA_DRIFT,DEFAULT_DRAW_PROBABILITY,INCLUDED_OUTCOMES,normalPdf,normalCdf,normalPpf,adjustRace,replay};
});

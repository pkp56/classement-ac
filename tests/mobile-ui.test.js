'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../mobile/mobile.js'),'utf8');
function browser(fetch){
  const listeners={},content={innerHTML:'',querySelector(){return null;},addEventListener(name,fn){listeners['content:'+name]=fn;}},output={innerHTML:'',textContent:''};
  const nav=['home','events','live','more'].map(value=>({dataset:{nav:value},attrs:{},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]}}));
  const sandbox={document:{getElementById:id=>id==='content'?content:id==='update-output'?output:null,querySelectorAll:()=>nav},location:{hash:'#home',origin:'https://gdsp.example'},window:{addEventListener:(k,fn)=>{listeners[k]=fn},confirm:()=>true},navigator:{onLine:true,serviceWorker:{register:()=>Promise.resolve()}},fetch,URL,URLSearchParams,Date,Intl,Promise,Set,Map,setTimeout:()=>1,clearTimeout:()=>{}};
  sandbox.AbortController=AbortController;
  sandbox.window.gdspMobileProfileViews=require('../mobile/profile-views');
  sandbox.window.gdspMobileEventViews=require('../mobile/event-views');
  sandbox.window.gdspMobileResults={calculate:()=>({standings:[],rounds:[]})};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {sandbox,content,output,listeners,nav};
}
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
const tick=()=>new Promise(r=>setImmediate(r));
test('mobile : accueil, choix événement, données distinctes et live',async()=>{
  const calls=[];
  const b=browser(async url=>{
    calls.push(url);
    if(url==='/api/events')return reply({events:[{slug:'cup',name:'Coupe',kind:'cup'},{slug:'old',name:'Old',kind:'archive'}]});
    if(url==='/api/events/cup')return reply({slug:'cup',name:'Coupe',kind:'cup',data:{eventInfo:{briefing:'Bienvenue'},ahEntrants:[{name:'Alice',car:'car_id'}]}});
    if(url==='/api/live/status')return reply({enabled:false,status:{status:'offline'}});
    throw Error('unexpected '+url);
  });
  await tick();assert.match(b.content.innerHTML,/La passion de la course/);assert.match(b.content.innerHTML,/Coupe/);assert.doesNotMatch(b.content.innerHTML,/>Old</);
  b.sandbox.location.hash='#event=cup';await b.listeners.hashchange();assert.match(b.content.innerHTML,/Bienvenue/);assert.match(b.content.innerHTML,/Alice/);assert.equal(b.nav[1].attrs['aria-current'],'page');
  b.sandbox.location.hash='#live';await b.listeners.hashchange();assert.match(b.content.innerHTML,/Direct indisponible/);
  assert.deepEqual(calls,['/api/events','/api/events/cup','/api/live/status']);
});
test('mobile : archives visibles et vues événement sans cadre intégré',async()=>{
  const b=browser(async url=>url==='/api/events'?reply({events:[
    {slug:'cup',name:'Cup',kind:'cup'},
    {slug:'lola-t290-2026',name:'Ancienne Lola',kind:'championship'},
    {slug:'lola-t290-gdsp-championnat-2026',name:'Lola archivée',kind:'archive'},
    {slug:'deleted',name:'Effacé',points_config:{_deleted:true}}
  ]}):url==='/api/events/cup'?reply({slug:'cup',name:'Cup',data:{eventInfo:{car:'Alfa'}}}):reply({enabled:false,status:{status:'offline'}}));
  await tick();assert.doesNotMatch(b.content.innerHTML,/Lola archivée|Ancienne Lola|Effacé/);
  b.sandbox.location.hash='#events';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Archives/);assert.match(b.content.innerHTML,/Lola archivée/);
  assert.doesNotMatch(b.content.innerHTML,/Ancienne Lola|Effacé/);
  b.sandbox.location.hash='#detail=cup';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Résultats & classement/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
  assert.equal(b.nav[1].attrs['aria-current'],'page');
  b.sandbox.location.hash='#car=cup';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Fiche voiture/);assert.match(b.content.innerHTML,/Alfa/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
  b.sandbox.location.hash='#circuit=cup';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Fiches circuit/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
  b.sandbox.location.hash='#service=admin';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/href="\/admin" target="_blank"/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
  assert.equal(b.nav[3].attrs['aria-current'],'page');
  b.sandbox.location.hash='#service=live';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Live timing/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
  assert.equal(b.nav[2].attrs['aria-current'],'page');
});
test('global mobile : chargement de tous les événements et refus d’un classement partiel',async()=>{
  let fail=false;const events=[{slug:'one',name:'One',kind:'cup'},{slug:'two',name:'Two',kind:'archive'}];
  const b=browser(async url=>{
    if(url==='/api/events')return reply({events});if(url==='/api/global-exclusions')return reply({ids:{hidden:true}});
    if(url==='/api/events/one')return reply({...events[0],data:{sessions:[]}});
    if(url==='/api/events/two')return fail?reply({},503):reply({...events[1],data:{sessions:[]}});
    throw Error(url);
  });
  let input;b.sandbox.window.gdspMobileProfiles={global:(ev,hidden)=>{input={ev,hidden};return {ratings:[],history:()=>[]};}};
  await tick();b.sandbox.location.hash='#global';await b.listeners.hashchange();assert.match(b.content.innerHTML,/Classement global/);assert.equal(input.ev.length,2);assert.equal(input.hidden.hidden,true);
  fail=true;b.sandbox.location.hash='#global-driver=un';await b.listeners.hashchange();assert.match(b.content.innerHTML,/tous les événements n’ont pas pu être chargés/);assert.doesNotMatch(b.content.innerHTML,/Pas encore assez de données/);
});
test('fiches pilotes : itinéraire événement et identifiant encodé',async()=>{
  const b=browser(async url=>url==='/api/events'?reply({events:[]}):reply({slug:'cup',name:'Cup',data:{}}));
  const driver={id:'a&b',name:'Alice',team:'Team'};
  b.sandbox.window.gdspMobileProfiles={event:()=>({drivers:[driver],ratings:[],history:()=>[]})};
  await tick();b.sandbox.location.hash='#pilots=cup';await b.listeners.hashchange();assert.match(b.content.innerHTML,/#driver=cup&amp;id=a%26b/);
  b.sandbox.location.hash='#driver=cup&id=a%26b';await b.listeners.hashchange();assert.match(b.content.innerHTML,/Alice/);assert.match(b.content.innerHTML,/Aucune course enregistrée/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
});
test('télémétrie mobile : session obligatoire et synthèse protégée sans cadre',async()=>{
  const b=browser(async()=>reply({events:[]}));await tick();let authenticated=false,reads=0;
  b.sandbox.window.gdspAuth={session:async()=>({authenticated}),fetch:async url=>{assert.equal(url,'/api/telemetry/summary');reads++;return reply({rows:3,cars:[{car:'Alfa <GT>',track:'Spa',laps:3,bestLapMs:93200,fuelPerLap:2.3}]});}};
  b.sandbox.location.hash='#service=telemetry';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Connecte-toi/);assert.equal(reads,0);
  authenticated=true;await b.listeners.hashchange();assert.equal(reads,1);assert.match(b.content.innerHTML,/Alfa &lt;GT&gt;/);assert.match(b.content.innerHTML,/1:33.200/);assert.match(b.content.innerHTML,/2.3 L/);assert.doesNotMatch(b.content.innerHTML,/<iframe/);
});
test('mobile : erreur de réseau visible, aucune donnée ancienne présentée',async()=>{
  const b=browser(async()=>{throw Error('offline')});b.sandbox.navigator.onLine=false;await tick();
  assert.match(b.content.innerHTML,/hors ligne/);assert.match(b.content.innerHTML,/Réessayer/);
});
test('mobile : confirmation explicite, clé jamais conservée dans la page après envoi',async()=>{
  const calls=[],target='b'.repeat(40),key='C'.repeat(43);
  const b=browser(async()=>reply({events:[]}));await tick();
  b.sandbox.window.gdspAuth={session:async()=>({authenticated:true}),fetch:async(url,options)=>{
    calls.push([url,options]);
    if(url==='/api/admin/mobile-update')return reply({enabled:true,pending:false});
    if(url==='/api/admin/mobile-update/check')return reply({available:true,target});
    if(url==='/api/admin/mobile-update/apply')return reply({queued:true});
    throw Error(url);
  }};
  b.sandbox.location.hash='#more';await b.listeners.hashchange();assert.match(b.content.innerHTML,/Vérifier les mises à jour/);
  const button={disabled:false,closest(selector){return selector==='[data-update-check]'?this:null}};
  await b.listeners['content:click']({target:button});assert.match(b.output.innerHTML,/Installer cette version/);
  assert.doesNotMatch(b.output.innerHTML,new RegExp(key));
  const form={id:'mobile-update-form',elements:{key:{value:key}}};
  await b.listeners['content:submit']({target:form,preventDefault(){}});
  assert.equal(form.elements.key.value,'');assert.match(b.output.textContent,/Demande transmise/);
  assert.deepEqual(JSON.parse(calls.find(([url])=>url==='/api/admin/mobile-update/apply')[1].body),{target,key});
  assert.doesNotMatch(b.output.textContent,new RegExp(key));
});

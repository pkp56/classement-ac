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
  const sandbox={document:{getElementById:id=>id==='content'?content:id==='update-output'?output:null,querySelectorAll:()=>nav},location:{hash:'#home',origin:'https://gdsp.example'},window:{addEventListener:(k,fn)=>{listeners[k]=fn},confirm:()=>true},navigator:{onLine:true,serviceWorker:{register:()=>Promise.resolve()}},fetch,URL,URLSearchParams,Date,Intl,Promise,Set,Map};
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
test('mobile : archives visibles et vues complètes restent dans la coque mobile',async()=>{
  const b=browser(async url=>url==='/api/events'?reply({events:[
    {slug:'cup',name:'Cup',kind:'cup'},
    {slug:'lola-t290-2026',name:'Ancienne Lola',kind:'championship'},
    {slug:'lola-t290-gdsp-championnat-2026',name:'Lola archivée',kind:'archive'},
    {slug:'deleted',name:'Effacé',points_config:{_deleted:true}}
  ]}):reply({enabled:false,status:{status:'offline'}}));
  await tick();assert.doesNotMatch(b.content.innerHTML,/Lola archivée|Ancienne Lola|Effacé/);
  b.sandbox.location.hash='#events';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/Archives/);assert.match(b.content.innerHTML,/Lola archivée/);
  assert.doesNotMatch(b.content.innerHTML,/Ancienne Lola|Effacé/);
  b.sandbox.location.hash='#detail=cup';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/<iframe[^>]+src="\/evenements\/cup"/);
  assert.equal(b.nav[1].attrs['aria-current'],'page');
  b.sandbox.location.hash='#service=admin';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/<iframe[^>]+src="\/admin"/);
  assert.equal(b.nav[3].attrs['aria-current'],'page');
  b.sandbox.location.hash='#service=live';await b.listeners.hashchange();
  assert.match(b.content.innerHTML,/<iframe[^>]+src="\/live-timing"/);
  assert.equal(b.nav[2].attrs['aria-current'],'page');
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

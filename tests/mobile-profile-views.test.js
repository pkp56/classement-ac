'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const views=require('../mobile/profile-views');
const rating={id:'ID&1',name:'<Alice>',team:'Team',level:2,score:68.4,count:10,windowCount:10,retainedCount:9,conductReviewed:1,conductPending:1,provisional:true,sportingProvisional:false,details:{regularite:40,proprete:50,vitesse:80,resultats:90},joker:{label:'Course <A>'},window:[{label:'Course <A>',date:'2026-01-01',joker:true,axes:{proprete:null},conduct:{pending:true}}]};
const history=[{date:'2026-01-01',track:'spa',eventName:'Coupe <A>',eventSlug:'cup',position:2,grid:4,delta:2,collisions:1,best:90000,weekendBest:88000,weekendSession:'Q',consistency:1500}];
test('global : cartes accessibles, recherche, statut provisoire et sécurité',()=>{
 const html=views.globalList({ratings:[rating]});assert.match(html,/\/assets\/lvl2-confirme\.webp\?v=27/);assert.match(html,/alt="Niveau 2 · Confirmé"/);assert.match(html,/&lt;Alice&gt;/);assert.doesNotMatch(html,/<Alice>/);assert.match(html,/#global-driver=ID%261/);assert.match(html,/Provisoire \/ partiel/);assert.match(html,/data-driver-search/);assert.match(html,/5 courses/);assert.doesNotMatch(html,/<iframe/);
});
test('fiche globale : audit, joker, propreté non qualifiée et historique',()=>{
 const html=views.profile(rating,rating,history,{global:true});assert.match(html,/\/assets\/lvl2-confirme\.png\?v=26/);assert.match(html,/Course &lt;A&gt;/);assert.match(html,/Joker sportif/);assert.match(html,/Décision à qualifier/);assert.match(html,/indisponible/);assert.match(html,/1:28.000/);assert.match(html,/\+1.50 s/);assert.match(html,/href="#event=cup"/);assert.doesNotMatch(html,/<iframe/);
});
test('visuel pilote : correspondance unique et chemins locaux contrôlés',()=>{
 const d={id:'id1',name:'Alice',team:'A',model:'alfa',skin:'racing'};
 const ev={data:{ahServer:'https://example.test:1234',ahEntrants:[{name:'Alice',team:'A',car:'alfa',skin:'racing'}],carSheets:[{id:'alfa',liveries:[{id:'racing',image:'assets/mod-previews/'+'b'.repeat(64)+'.jpg'}]}]}};
 assert.equal(views.driverImage(ev,d,[d]),'/assets/mod-previews/'+'b'.repeat(64)+'.jpg');
 ev.data.carSheets=[];assert.match(views.driverImage(ev,d,[d]),/^\/api\/ah-skin-preview\?/);
 ev.data.ahEntrants[0].car='../secret';assert.equal(views.driverImage(ev,d,[d]),'');
 ev.data.ahEntrants=[{name:'Alice',car:'other',skin:'x'},{name:'Alice',car:'other2',skin:'y'}];
 assert.match(views.driverImage(ev,d,[d]),/model=alfa/);
});
test('fiche événement : pilote sans course, saisies dangereuses et retour',()=>{
 const ev={slug:'cup',name:'Cup'};const d={id:'a&b',name:'Alice <img>',team:'A'};
 const list=views.eventList(ev,{drivers:[d]});assert.match(list,/#driver=cup&amp;id=a%26b/);assert.doesNotMatch(list,/<img>/);
 const html=views.profile(d,null,[],{slug:'cup',eventName:ev.name,photo:'data:image/png;base64,xyz" onerror="alert(1)'});assert.match(html,/Niveau à déterminer/);assert.match(html,/Aucune course enregistrée/);assert.doesNotMatch(html,/<img|onerror/);assert.match(html,/#pilots=cup/);
});

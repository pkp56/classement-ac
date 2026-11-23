'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const views=require('../mobile/event-views');

test('résultats mobiles : vrai classement, points, sanctions et absence de cadre PC',()=>{
  const ev={slug:'cup',name:'Cup <script>',data:{}};
  const computed={standings:[{name:'Alice',team:'A',total:42}],rounds:[{number:1,date:'2026-09-23',track:'riverside',sessions:[{type:'RACE',results:[{name:'Alice',laps:5,finalTime:123000,points:41},{name:'Bob',laps:4,comDQ:true,points:0}]}]}]};
  const html=views.resultView(ev,computed);
  assert.match(html,/Cup &lt;script&gt;/);assert.match(html,/Alice/);assert.match(html,/42/);assert.match(html,/41/);assert.match(html,/DQ/);assert.match(html,/2:03\.000/);assert.doesNotMatch(html,/<iframe/);
  assert.match(views.resultView(ev,{standings:[],rounds:[]}),/Aucune qualification ni course importée/);
});

test('fiche voiture mobile : données de l’événement, livrées locales sûres et traduction',()=>{
  const image='assets/mod-previews/'+'a'.repeat(64)+'.jpg';
  const ev={slug:'cup',name:'Cup',data:{sheetTranslations:{'car:alfa':'Description française'},carSheets:[{id:'alfa',name:'Alfa <GT>',brand:'Alfa',year:1967,metadataAvailable:true,specs:{bhp:'180 bhp',weight:'700 kg'},liveries:[{image,name:'Écurie'},{image:'https://evil.invalid/x',name:'Intrus'}],powerCurve:[{rpm:1000,value:10}]}]}};
  const html=views.carView(ev);
  assert.match(html,/Alfa &lt;GT&gt;/);assert.match(html,/180 bhp/);assert.match(html,/Description française/);assert.match(html,/data-livery-select/);assert.match(html,/1000 tr\/min/);
  assert.doesNotMatch(html,/evil\.invalid|<iframe/);assert.match(html,new RegExp('/assets/mod-previews/'+'a'.repeat(64)));
  assert.match(views.carView({slug:'lola-t290-gdsp-championnat-2026',name:'Lola',data:{}}),/Lola T290/);
});

test('fiche circuit mobile : fiche importée prioritaire et date réelle des sessions',()=>{
  const ev={slug:'lola-t290-gdsp-championnat-2026',name:'Lola',data:{sessions:[{track:'spa',date:'2026-09-09T21:00:00Z'}],circuitRounds:[{round:1,id:'spa',name:'Spa à jour',driverFolder:'spa',lengthStr:'7 km'}]}};
  const base={rounds:[{round:1,id:'spa',name:'Spa ancien',driverFolder:'spa',date:'2025-01-01',outline:{path:'M0 0 L10 10',viewBox:'0 0 100 100'}}]};
  const html=views.circuitView(ev,base);
  assert.match(html,/Spa à jour/);assert.doesNotMatch(html,/Spa ancien/);assert.match(html,/9 septembre 2026/);assert.match(html,/7 km/);assert.match(html,/<svg/);assert.doesNotMatch(html,/<iframe/);
  base.rounds[0].outline.path='M0 0" onload="alert(1)';assert.doesNotMatch(views.circuitView(ev,base),/<svg/);
});

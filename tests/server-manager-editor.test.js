'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/server-manager-editor.js'),'utf8'),sandbox);
const editor=sandbox.window.gdspServerEditor;
test('Brouillon sépare les séances, météo, voitures et signale les options CSP non modifiables',()=>{
 const data={settings:{SERVER:{NAME:'Serveur <test>',TRACK:'sugo',CONFIG_TRACK:'',MAX_CLIENTS:'2'},PRACTICE:{TIME:'20'}},extra:{sessions:{PRACTICE:'active',QUALIFY:'inactive',RACE:'absente'},inactiveSessions:{QUALIFY:{TIME:'15'}},weather:{WEATHER_0:{GRAPHICS:'clear',BASE_TEMPERATURE_AMBIENT:'21'}},csp:{trackId:'sugo',encodedInTrack:false}},slots:[{id:0,model:'car_a',skin:'red',reserved:true}]};
 const html=editor.render(data,{tracks:[{id:'sugo',layouts:['gp']}],cars:[{id:'car_a',skins:['red']}]});
 assert.match(html,/Brouillon :/);assert.match(html,/Serveur &lt;test&gt;/);assert.doesNotMatch(html,/Serveur <test>/);
 assert.match(html,/Essais[\s\S]+Active/);assert.match(html,/Qualifications[\s\S]+Désactivée/);
 assert.match(html,/Place 1 · réservée/);assert.match(html,/Température ambiante/);assert.match(html,/Options CSP et scripts/);
 assert.doesNotMatch(html,/UDP_PORT|ADMIN_PASSWORD|GUID/);
});
test('Un circuit CSP encodé ne propose pas une modification destructrice',()=>{
 const html=editor.render({settings:{SERVER:{TRACK:'csp/2144/../sugo'}},extra:{csp:{encodedInTrack:true,trackId:'sugo'}},slots:[]},null);
 assert.match(html,/value="sugo" disabled/);assert.match(html,/CSP est encodé/);
});
test('Le brouillon relève seulement les changements, sans appliquer',()=>{
 const container={querySelectorAll:()=>[{disabled:false,value:'new',dataset:{cmOriginal:'old',cmSection:'SERVER',cmKey:'NAME'}},{disabled:false,value:'red',dataset:{cmOriginal:'red',cmSlot:'0',cmSlotField:'skin'}},{disabled:true,value:'new',dataset:{cmOriginal:'old',cmSection:'SERVER',cmKey:'TRACK'}}]};
 const changes=editor.collect(container);assert.equal(changes.length,1);assert.equal(changes[0].section,'SERVER');assert.equal(changes[0].after,'new');
});

test('Les options CSP sont visibles sans exécuter le contenu HTML',()=>{
 const html=editor.render({settings:{},extra:{},slots:[],cspWelcome:{available:true,config:'[SCRIPT_2]\n<script>alert(1)</script>'}},null);
 assert.match(html,/data-cm-csp/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert/);
});

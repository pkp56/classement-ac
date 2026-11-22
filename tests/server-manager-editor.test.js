'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/server-manager-editor.js'),'utf8'),sandbox);
const editor=sandbox.window.gdspServerEditor;
test('Brouillon sépare les séances, météo, voitures et signale les options CSP non modifiables',()=>{
 const data={settings:{SERVER:{NAME:'Serveur <test>',TRACK:'sugo',CONFIG_TRACK:'',MAX_CLIENTS:'2'},PRACTICE:{TIME:'20'}},extra:{sessions:{PRACTICE:'active',QUALIFY:'inactive',RACE:'absente'},inactiveSessions:{QUALIFY:{TIME:'15'}},weather:{WEATHER_0:{GRAPHICS:'clear',BASE_TEMPERATURE_AMBIENT:'21'}},csp:{trackId:'sugo',encodedInTrack:false}},slots:[{id:0,model:'car_a',skin:'red',reserved:true}]};
 const html=editor.render(data,{tracks:[{id:'sugo',layouts:['gp']}],cars:[{id:'car_a',skins:['red']}]});
 assert.match(html,/Brouillon :/);assert.match(html,/Serveur &lt;test&gt;/);assert.doesNotMatch(html,/Serveur <test>/);
 assert.match(html,/Essais[\s\S]+Active/);assert.match(html,/Qualifications[\s\S]+Désactivée/);
 assert.match(html,/Place 1 · réservée/);assert.match(html,/Température ambiante/);assert.match(html,/Options CSP et scripts/);assert.match(html,/href="\/race-control.html"/);
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

test('CRLF du CSP identique aux retours navigateur ne déclenche pas de modification',()=>{
 assert.equal(editor.cspChanged('[SCRIPT_2]\nSCRIPT=x\n','[SCRIPT_2]\r\nSCRIPT=x\r\n'),false);
 assert.equal(editor.cspChanged('[SCRIPT_2]\nSCRIPT=y\n','[SCRIPT_2]\r\nSCRIPT=x\r\n'),true);
});
test('Une modification des dégâts ne transmet pas le CSP inchangé',async()=>{
 const buttons={};for(const id of ['#cm-preview-btn','#cm-check-btn','#cm-save-btn'])buttons[id]={disabled:false,addEventListener(_name,fn){this.click=fn;}};
 const csp={value:''},out={textContent:''};
 const field={disabled:false,value:'95',dataset:{cmOriginal:'100',cmSection:'SERVER',cmKey:'DAMAGE_MULTIPLIER'}};
 const container={addEventListener(){},querySelector(selector){return buttons[selector]||({'[data-cm-csp]':csp,'#cm-preview':out})[selector]||null;},querySelectorAll(selector){return selector==='[data-cm-original]'?[field]:[];}};
 let payload;const original='\n[SCRIPT_2]\r\nSCRIPT=x\r\n';
 editor.attach(container,null,{revision:'config',entryRevision:'entry',slots:[],cspWelcome:{available:true,config:original,revision:'welcome'}},async x=>{payload=x;return {configChanges:[],slotChanges:[],weatherChanges:[]};},async()=>{},'local2');
 assert.equal(csp.value,'\n[SCRIPT_2]\nSCRIPT=x\n');
 await buttons['#cm-check-btn'].click({target:buttons['#cm-check-btn']});
 assert.equal(payload.configChanges[0].value,'95');assert.equal(Object.hasOwn(payload,'cspConfig'),false);
});
test('La variante est proposée même si CONFIG_TRACK est absent du préréglage',()=>{
 const html=editor.render({settings:{SERVER:{TRACK:'sugo'}},extra:{csp:{trackId:'sugo'}},slots:[]},{tracks:[{id:'sugo',layouts:['east','west']}],cars:[]});
 assert.match(html,/data-cm-key="CONFIG_TRACK" data-cm-original="" data-cm-layout/);
 assert.match(html,/value="east"/);assert.match(html,/value="west"/);
});
test('Liste des voitures autorisées et places limitées, sans effacer une place existante',()=>{
 const html=editor.render({settings:{SERVER:{CARS:'car_a;car_b'}},extra:{},slots:[{id:0,model:'car_c',skin:'',skinEditable:true}]},{cars:[{id:'car_a',skins:[]},{id:'car_b',skins:[]},{id:'car_c',skins:[]}],tracks:[]});
 assert.match(html,/data-cm-allowed/);assert.match(html,/value="car_c"[^>]*>car_c<\/option>/);
 assert.match(html,/value="car_c" selected disabled>car_c \(actuelle, non autorisée\)/);
 assert.match(html,/data-cm-add-model/);assert.match(html,/data-cm-cars/);
});
test('La modification des voitures autorisées filtre les choix des places et conserve la valeur précédente',()=>{
 let onChange;const hidden={value:''};let html='';
 const select={tagName:'SELECT',disabled:false,value:'car_b',hasAttribute:()=>false,set innerHTML(v){html=v},get innerHTML(){return html}};
 const container={addEventListener(_name,fn){onChange=fn},querySelector(s){return s==='[data-cm-cars]'?hidden:null},querySelectorAll(s){return s.includes('data-cm-slot-field')?[select]:[]}};
 editor.attach(container,{cars:[]},{},()=>{},()=>{},'local1');
 onChange({target:{matches:s=>s==='[data-cm-allowed]',selectedOptions:[{value:'car_a'}]}});
 assert.equal(hidden.value,'car_a');assert.equal(select.value,'car_b');assert.match(html,/car_b \(actuelle, non autorisée\)/);assert.match(html,/value="car_a"/);
});

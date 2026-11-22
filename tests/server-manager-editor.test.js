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
test('Le bouton ajoute explicitement des places au brouillon, sans écriture implicite',async()=>{
 const buttons={};for(const id of ['#cm-preview-btn','#cm-check-btn','#cm-save-btn','#cm-add-slot-btn'])buttons[id]={disabled:false,addEventListener(_event,fn){this.click=fn;}};
 const out={textContent:''},added={innerHTML:''},model={value:'car_a'},skin={value:'red'};let onClick;
 const items={'#cm-preview':out,'#cm-added-slots':added,'[data-cm-add-model]':model,'[data-cm-add-skin]':skin};
 const container={addEventListener(type,fn){if(type==='click')onClick=fn;},querySelector(s){return buttons[s]||items[s]||null;},querySelectorAll(){return []}};
 let calls=0,payload;
 editor.attach(container,{cars:[{id:'car_a',skins:['red']}]},{slots:[{id:0}],settings:{SERVER:{CARS:'car_a'}},revision:'r',entryRevision:'e'},async p=>{calls++;payload=p;return {configChanges:[],slotChanges:[],weatherChanges:[]}},async()=>{throw Error('save imprévu')},'local1');
 await buttons['#cm-check-btn'].click({target:buttons['#cm-check-btn']});assert.equal(calls,0);assert.match(out.textContent,/Aucun changement/);
 buttons['#cm-add-slot-btn'].click();buttons['#cm-add-slot-btn'].click();assert.match(added.innerHTML,/Place ajoutée au brouillon/);
 buttons['#cm-preview-btn'].click();assert.equal((out.textContent.match(/Nouvelle place/g)||[]).length,2);
 await buttons['#cm-check-btn'].click({target:buttons['#cm-check-btn']});assert.equal(calls,1);assert.equal(payload.entryChanges.length,2);assert.equal(payload.entryChanges[0].id,1);assert.equal(payload.entryChanges[1].id,2);
 onClick({target:{closest:()=>({dataset:{cmUndoAdd:'0'}})}});
 await buttons['#cm-check-btn'].click({target:buttons['#cm-check-btn']});assert.equal(payload.entryChanges.length,1);assert.equal(payload.entryChanges[0].id,1);
});

test('Préparation Cup : manche structurée et validations conservatrices',()=>{
 const event={kind:'cup',name:'Cup',data:{customCalendar:{'2026-12-03':{track:'ks_monza66',layout:'junior',trackName:'Monza Junior'}},carSheets:[{id:'alfa',name:'Alfa'}],eventInfo:{formatText:'texte libre'}}};
 const inventory={tracks:[{id:'ks_monza66',layouts:['junior']}],cars:[{id:'alfa',skins:['white']} ]};
 const preset={extra:{sessions:{QUALIFY:'active',RACE:'active'}},slots:[{id:0,model:'alfa',skin:'white',reserved:true,skinEditable:true},{id:1,model:'old',skin:'red',reserved:false,skinEditable:true}]};
 const plan=editor.cupDraft(preset,inventory,event,0,'alfa','20','10','15');
 assert.equal(plan.round.track,'ks_monza66');assert.equal(plan.round.layout,'junior');assert.equal(plan.additions,18);assert.equal(plan.slots.join(','),'1');
 assert.equal(preset.slots[1].model,'old','le brouillon pur ne modifie pas les places');
 const html=editor.render({settings:{},extra:{},slots:[]},inventory,event);assert.match(html,/Préparer une manche/);assert.match(html,/Monza Junior/);assert.match(html,/setup fixe, la grille inversée/);
 assert.throws(()=>editor.cupDraft(preset,inventory,event,0,'alfa','','10','15'),/Renseigne/);
 assert.throws(()=>editor.cupDraft(preset,{tracks:[],cars:inventory.cars},event,0,'alfa','20','10','15'),/non trouvé/);
 assert.throws(()=>editor.cupDraft({...preset,slots:[{...preset.slots[1],id:0,reserved:true}]},inventory,event,0,'alfa','20','10','15'),/réservée/);
 assert.throws(()=>editor.cupDraft({...preset,slots:[{...preset.slots[1],id:0,cspSkin:true}]},inventory,event,0,'alfa','20','10','15'),/protégée/);
 assert.throws(()=>editor.cupDraft({...preset,extra:{sessions:{QUALIFY:'absente',RACE:'active'}}},inventory,event,0,'alfa','20','10','15'),/absente/);
 assert.equal(editor.cupOptions({...event,kind:'open'}).rounds.length,0);
});

test('Bouton Cup prépare puis transmet seulement les modifications au contrôle existant',async()=>{
 sandbox.Event=class {constructor(type){this.type=type}};
 const buttons={};for(const id of ['#cm-preview-btn','#cm-check-btn','#cm-save-btn','#cm-cup-prepare','#cm-add-slot-btn'])buttons[id]={disabled:false,addEventListener(_n,fn){this.click=fn;}};
 const inputs=[],listeners={};
 function field(section,key,value,extra={}){const el={value,disabled:false,dataset:{cmSection:section,cmKey:key,cmOriginal:value},...extra};inputs.push(el);return el;}
 const track=field('SERVER','TRACK','old',{tagName:'SELECT',options:[{value:'old'},{value:'monza'}]}),layout=field('SERVER','CONFIG_TRACK','oldlayout'),hidden=field('SERVER','CARS','old'),max=field('SERVER','MAX_CLIENTS','1'),qe=field('QUALIFY','ENABLED','0'),re=field('RACE','ENABLED','1'),qt=field('__CM_QUALIFY_OFF','TIME','5');
 const model={value:'old',disabled:false,dataset:{cmSlot:'0',cmSlotField:'model',cmOriginal:'old'},tagName:'SELECT',hasAttribute(){return false}};inputs.push(model);
 const skin={value:'red',disabled:false,dataset:{cmSlot:'0',cmSlotField:'skin',cmOriginal:'red'},tagName:'SELECT'};inputs.push(skin);
 const allowed={options:[{value:'old',selected:true},{value:'alfa',selected:false}],get selectedOptions(){return this.options.filter(x=>x.selected)},matches(s){return s==='[data-cm-allowed]'}};
 const mode={value:'laps',dataset:{original:'laps'}},race={value:'5',dataset:{original:'5'}},out={textContent:''},result={textContent:''},added={innerHTML:''};
 const els={'[data-cm-track]':track,'[data-cm-layout]':layout,'[data-cm-allowed]':allowed,'[data-cm-cars]':hidden,'[data-race-mode]':mode,'[data-race-value]':race,'#cm-preview':out,'#cm-cup-result':result,'#cm-added-slots':added,'[data-cup-round]':{value:'0'},'[data-cup-car]':{value:'alfa'},'[data-cup-places]':{value:'2'},'[data-cup-qualify]':{value:'10'},'[data-cup-race]':{value:'15'}};
 const container={addEventListener(type,fn){listeners[type]=fn},querySelector(q){
   if(buttons[q]||els[q])return buttons[q]||els[q];
   let m=q.match(/^\[data-cm-section="([^"]+)"\]\[data-cm-key="([^"]+)"\]$/);if(m)return inputs.find(e=>e.dataset.cmSection===m[1]&&e.dataset.cmKey===m[2])||null;
   m=q.match(/^\[data-cm-slot="(\d+)"\]\[data-cm-slot-field="([^"]+)"\]$/);if(m)return inputs.find(e=>e.dataset.cmSlot===m[1]&&e.dataset.cmSlotField===m[2])||null;
   return null;
 },querySelectorAll(q){if(q==='[data-cm-original]')return inputs;if(q.includes('[data-cm-slot-field="model"]'))return [model];return [];}};
 for(const el of [track,allowed,model]){el.dispatchEvent=()=>listeners.change?.({target:el});if(!el.matches)el.matches=s=>s==='[data-cm-track]'&&el===track;}
 const event={kind:'cup',name:'Cup',data:{customCalendar:{'2026-12-03':{track:'monza',layout:'junior'}},carSheets:[{id:'alfa'}]}};
 const inventory={tracks:[{id:'monza',layouts:['junior']}],cars:[{id:'alfa',skins:['white']}]};
 const data={revision:'r',entryRevision:'e',settings:{SERVER:{CARS:'old'}},extra:{sessions:{QUALIFY:'inactive',RACE:'active'}},slots:[{id:0,model:'old',skin:'red',skinEditable:true}]};
 let payload;editor.attach(container,inventory,data,async p=>{payload=p;return {configChanges:[],slotChanges:[],weatherChanges:[]}},async()=>{throw Error('ecriture non demandee')},'local2',event);
 buttons['#cm-cup-prepare'].click();assert.match(result.textContent,/Brouillon préparé/);assert.equal(payload,undefined);
 await buttons['#cm-check-btn'].click({target:buttons['#cm-check-btn']});
 assert.equal(payload.configChanges.find(x=>x.key==='TRACK').value,'monza');assert.equal(payload.configChanges.find(x=>x.key==='CONFIG_TRACK').value,'junior');
 assert.equal(payload.configChanges.find(x=>x.key==='CARS').value,'alfa');assert.equal(payload.configChanges.find(x=>x.key==='MAX_CLIENTS').value,'2');
 assert.equal(payload.configChanges.find(x=>x.section==='QUALIFY'&&x.key==='ENABLED').value,'1');assert.equal(payload.configChanges.find(x=>x.key==='TIME').value,'10');
 assert.equal(payload.raceMode.mode,'time');assert.equal(payload.raceMode.value,'15');assert.equal(payload.entryChanges.length,2);assert.equal(payload.entryChanges[1].operation,'add');
});

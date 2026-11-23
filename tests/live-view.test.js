'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Live : deux tableaux distincts, carte récente et archive sans tableau en direct',async()=>{
 const page=fs.readFileSync(path.join(__dirname,'../live-timing.html'),'utf8');
 const code=page.slice(page.lastIndexOf('<script>')+8,page.lastIndexOf('</script>')).replace('})();',"window.__liveTest={render:render,history:function(v){viewingHistory=v;}};})();");
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',style:{},dataset:{},value:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return elements.get(id);};
 const storage={};
 class Source{addEventListener(){} close(){}}
 const blank={status:{status:'waiting',mode:'offline'},server:{},session:{},cars:[],events:[],updatedAt:new Date().toISOString()};
 const response=data=>({ok:true,json:async()=>data});
 const sandbox={localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>{storage[k]=v;}},document:{getElementById:get},location:{search:'',origin:'https://example.test',href:'https://example.test/live-timing'},history:{replaceState(){}},navigator:{},URL,URLSearchParams,EventSource:Source,setInterval(){},setTimeout(){},clearInterval(){},console,fetch:async url=>response(url.includes('/api/live/map')?{available:true,track:'monza',layout:'gp',sourceTrack:'monza',sourceLayout:'gp',path:'M0 0 L100 100 Z',projection:{scale:1,originX:20,originY:30}}:url.includes('/api/live/config')?{localSources:[],httpSources:[]}:url.includes('/api/live/sessions')?{history:true,sessions:[]}:url.includes('/api/live/sectors')?{drivers:[]}:blank)};
 sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(code,sandbox);await new Promise(r=>setImmediate(r));
 const live={status:{status:'live',mode:'acsp'},server:{name:'CM2',track:'monza',trackConfig:'gp'},session:{type:'practice'},updatedAt:new Date().toISOString(),events:[],bestLaps:[],cars:[{name:'Alice',connected:true,worldPosition:{x:10,z:20},laps:1},{name:'Bob',connected:false,laps:2}],storedTimes:[{name:'Alice',model:'lola',laps:1,connected:true},{name:'Bob',model:'alfa',laps:2,connected:false,bestLap:'1:30.000',averageLapMs:95000}]};
 sandbox.__liveTest.render(live);await new Promise(r=>setImmediate(r));
 assert.match(get('standings').innerHTML,/Alice/);assert.doesNotMatch(get('standings').innerHTML,/Bob/);
 assert.match(get('storedStandings').innerHTML,/Bob/);assert.doesNotMatch(get('storedStandings').innerHTML,/Alice/);
 assert.match(get('storedStandings').innerHTML,/1:35.000/);assert.doesNotMatch(get('storedStandings').innerHTML,/Tour en cours|Delta|Écart|Dernier tour/);
 get('columnSettings').listeners.change({target:{dataset:{id:'delta',action:'visible'},checked:false}});
 get('columnSettings').listeners.change({target:{dataset:{id:'driver',action:'width'},value:'220'}});
 get('columnSettings').listeners.click({target:{dataset:{id:'driver',action:'up'}}});
 sandbox.__liveTest.render(live);assert.doesNotMatch(get('standings').innerHTML,/<th>Delta<\/th>/);assert.match(get('standings').innerHTML,/data-column="driver"[\s\S]*?data-column="position"/);assert.match(get('standings').innerHTML,/width:220px/);assert.match(storage['gdsp-live-columns-v1'],/220/);
 assert.match(get('trackMap').innerHTML,/cx="30.0" cy="50.0"/);assert.match(get('trackMap').innerHTML,/Alice/);assert.doesNotMatch(get('trackMap').innerHTML,/Bob/);
 sandbox.__liveTest.history(true);sandbox.__liveTest.render(live);
 assert.equal(get('liveStandingsPanel').style.display,'none');assert.equal(get('liveSidebar').style.display,'none');assert.match(get('storedStandings').innerHTML,/Alice/);assert.match(get('storedStandings').innerHTML,/Bob/);
});

test('En-têtes : déplacement et redimensionnement persistent malgré les mises à jour du direct',async()=>{
 const page=fs.readFileSync(path.join(__dirname,'../live-timing.html'),'utf8');
 const code=page.slice(page.lastIndexOf('<script>')+8,page.lastIndexOf('</script>')).replace('})();',"window.__liveTest={render:render};})();");
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',style:{},dataset:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},contains(){return true;},setPointerCapture(){this.captured=true;},hasPointerCapture(){return this.captured;},releasePointerCapture(){this.captured=false;},querySelector(){return this.table;},querySelectorAll(){return this.cols;}});return elements.get(id);};
 let hit=null;const storage={};class Source{addEventListener(){} close(){}}
 const blank={status:{status:'waiting',mode:'offline'},server:{},session:{},cars:[],events:[],updatedAt:new Date().toISOString()};
 const sandbox={localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>{storage[k]=v;}},document:{getElementById:get,elementFromPoint(){return hit;}},location:{search:'',origin:'https://example.test',href:'https://example.test/live-timing'},history:{replaceState(){}},navigator:{},URL,URLSearchParams,EventSource:Source,setInterval(){},setTimeout(){},clearInterval(){},console,fetch:async url=>({ok:true,json:async()=>url.includes('/api/live/config')?{localSources:[],httpSources:[]}:url.includes('/api/live/sessions')?{history:true,sessions:[]}:url.includes('/api/live/sectors')?{drivers:[]}:blank})};
 sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(code,sandbox);await new Promise(r=>setImmediate(r));
 const live={...blank,cars:[{name:'Alice',connected:true}]};sandbox.__liveTest.render(live);
 const panel=get('standings');panel.table={style:{}};panel.cols=Array.from({length:15},()=>({style:{}}));
 function header(id){return {dataset:{column:id},classList:{add(){},remove(){}},getBoundingClientRect(){return {left:100,width:100};},closest(selector){return selector==='th[data-column]'?this:null;}};}
 const driver=header('driver'),position=header('position');hit=position;
 const event=(target,x,y=0)=>({target,clientX:x,clientY:y,pointerId:1,isPrimary:true,pointerType:'mouse',button:0,preventDefault(){}});
 panel.listeners.pointerdown(event(driver,200));const previous=panel.innerHTML;sandbox.__liveTest.render({...live,cars:[{name:'Alice nouvelle',connected:true}]});assert.equal(panel.innerHTML,previous);
 panel.listeners.pointermove(event(driver,110));panel.listeners.pointerup(event(driver,110));
 assert.match(panel.innerHTML,/Alice nouvelle/);assert.match(panel.innerHTML,/data-column="driver"[\s\S]*?data-column="position"/);
 assert.equal(JSON.parse(storage['gdsp-live-columns-v1'])[0].id,'driver');
 const handle={closest(selector){return selector==='th[data-column]'?driver:selector==='.column-resize'?this:null;}};
 panel.listeners.pointerdown(event(handle,200));panel.listeners.pointermove(event(handle,270));assert.equal(panel.cols[0].style.width,'250px');panel.listeners.pointerup(event(handle,270));
 assert.equal(JSON.parse(storage['gdsp-live-columns-v1'])[0].width,250);assert.match(panel.innerHTML,/width:250px/);
 panel.listeners.pointerdown(event(handle,200));panel.listeners.pointermove(event(handle,900));panel.listeners.pointercancel(event(handle,900));assert.equal(JSON.parse(storage['gdsp-live-columns-v1'])[0].width,250);assert.match(panel.innerHTML,/width:250px/);
});

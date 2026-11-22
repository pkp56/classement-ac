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
 sandbox.__liveTest.render(live);assert.doesNotMatch(get('standings').innerHTML,/<th>Delta<\/th>/);assert.match(get('standings').innerHTML,/<th>Pilote<\/th><th>#<\/th>/);assert.match(get('standings').innerHTML,/width:220px/);assert.match(storage['gdsp-live-columns-v1'],/220/);
 assert.match(get('trackMap').innerHTML,/cx="30.0" cy="50.0"/);assert.match(get('trackMap').innerHTML,/Alice/);assert.doesNotMatch(get('trackMap').innerHTML,/Bob/);
 sandbox.__liveTest.history(true);sandbox.__liveTest.render(live);
 assert.equal(get('liveStandingsPanel').style.display,'none');assert.equal(get('liveSidebar').style.display,'none');assert.match(get('storedStandings').innerHTML,/Alice/);assert.match(get('storedStandings').innerHTML,/Bob/);
});

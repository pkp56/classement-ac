'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {patchWeather}=require('../tools/server-manager/weather'),{prepare}=require('../tools/server-manager/plan');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const config='[SERVER]\r\nTRACK=sugo\r\nPASSWORD=secret\r\n[WEATHER_0]\r\nGRAPHICS=clear\r\n[WEATHER_1]\r\nGRAPHICS=rain\r\n[OTHER]\r\nPRESERVE=1\r\n';
const entry='[CAR_0]\nMODEL=car_a\nSKIN=red\n';
test('Ajout et retrait préservent les sections voisines et au moins une météo',()=>{
 const x=patchWeather(config,[{operation:'remove',id:1}]);assert.doesNotMatch(x,/WEATHER_1/);assert.match(x,/WEATHER_0/);assert.match(x,/\[OTHER\]\r\nPRESERVE=1/);
 const y=patchWeather(x,[{operation:'add',id:1,graphics:'3_clear'}]);assert.match(y,/\[WEATHER_1\]\r\nGRAPHICS=3_clear/);
 assert.throws(()=>patchWeather(config,[{operation:'remove',id:0}]),/dernière/);
 assert.throws(()=>patchWeather(x,[{operation:'remove',id:0}]),/moins une/);
 assert.throws(()=>patchWeather(x,[{operation:'add',id:1,graphics:'x\nPASSWORD=bad'}]),/invalide/);
});
test('La préparation météo présente uniquement les valeurs autorisées',()=>{
 const p=prepare({config,entry,configRevision:hash(config),entryRevision:hash(entry),inventory:{cars:[],tracks:[]},weatherChanges:[{operation:'remove',id:1}]});
 assert.equal(p.weatherChanges[0].before.GRAPHICS,'rain');assert.equal(p.weatherChanges[0].after,null);assert.doesNotMatch(JSON.stringify(p),/secret/);
});

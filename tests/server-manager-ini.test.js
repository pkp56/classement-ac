'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {patchIni}=require('../tools/server-manager/ini');
const sample='[SERVER]\r\nNAME=Ancien\r\nUDP_PORT=9601\r\nUDP_PLUGIN_LOCAL_PORT=12003\r\nPASSWORD=secret\r\n[__CM_SERVER]\r\nCONFIG=conserver\r\n[PRACTICE]\r\nTIME=20\r\n';
test('Une modification ciblée conserve ports, secrets, réglages CM et fins de ligne',()=>{
 const updated=patchIni(sample,[{section:'SERVER',key:'NAME',value:'Nouveau'},{section:'PRACTICE',key:'TIME',value:30}]);
 assert.equal(updated,sample.replace('NAME=Ancien','NAME=Nouveau').replace('TIME=20','TIME=30'));
});
test('Les ports, réglages CM, valeurs injectées et doublons sont refusés',()=>{
 for (const update of [{section:'SERVER',key:'UDP_PORT',value:1},{section:'SERVER',key:'UDP_PLUGIN_LOCAL_PORT',value:1},{section:'SERVER',key:'PASSWORD',value:'x'},{section:'__CM_SERVER',key:'CONFIG',value:'x'},{section:'SERVER',key:'NAME',value:'x\nUDP_PORT=1'}]) assert.throws(()=>patchIni(sample,[update]));
 assert.throws(()=>patchIni(sample,[{section:'SERVER',key:'TRACK',value:'monza'}]),/absent/);
 assert.throws(()=>patchIni(sample.replace('NAME=Ancien','NAME=Ancien\r\nNAME=autre'),[{section:'SERVER',key:'NAME',value:'x'}]),/ambigu/);
});

test('La lecture ne retourne ni mots de passe, ni ports, ni sections internes',()=>{
 const {inspectIni}=require('../tools/server-manager/ini');
 assert.deepEqual(inspectIni(sample),{SERVER:{NAME:'Ancien'},PRACTICE:{TIME:'20',ENABLED:'1'}});
});
test('Validation des valeurs et conservation des fins de ligne mixtes et du BOM',()=>{
 const text='\uFEFF[SERVER]\r\nNAME=A\nUDP_PORT=9600\r[PRACTICE]\rTIME=10';
 assert.equal(patchIni(text,[{section:'server',key:'NAME',value:'B'}]),text.replace('NAME=A','NAME=B'));
 for(const value of ['../../secret','bad/path','x\nNAME=oops'])assert.throws(()=>patchIni('[SERVER]\nTRACK=monza\n',[{section:'SERVER',key:'TRACK',value}]));
 assert.throws(()=>patchIni(sample,[{section:'PRACTICE',key:'TIME',value:'-200'}]));
 assert.throws(()=>patchIni('[SERVER]\nNAME=A\n[SERVER]\nX=1\n',[{section:'SERVER',key:'NAME',value:'B'}]),/ambigu/);
});

test('Ne pas écraser le nom CM ni la configuration CSP encodée dans le circuit',()=>{
 assert.equal(patchIni('[SERVER]\nTRACK=csp/2144/../monza\n',[{section:'SERVER',key:'TRACK',value:'sugo'}]),'[SERVER]\nTRACK=csp/2144/../sugo\n');
 assert.throws(()=>patchIni('[SERVER]\nTRACK=csp/bad/../monza\n',[{section:'SERVER',key:'TRACK',value:'sugo'}]),/CSP/);
 assert.throws(()=>patchIni('[SERVER]\nNAME=visible\n[__CM_SERVER]\nNAME=nom_cm\n',[{section:'SERVER',key:'NAME',value:'autre'}]),/Content Manager/);
});

test('IS_OPEN suit les états CM différents pour une course et les autres séances',()=>{
 const race='[RACE]\nIS_OPEN=0\n';
 assert.equal(patchIni(race,[{section:'RACE',key:'IS_OPEN',value:2}]),'[RACE]\nIS_OPEN=2\n');
 assert.throws(()=>patchIni('[PRACTICE]\nIS_OPEN=0\n',[{section:'PRACTICE',key:'IS_OPEN',value:2}]));
});

test('Repère les séances CM désactivées, la météo et le circuit CSP sans données privées',()=>{
 const {inspectExtra}=require('../tools/server-manager/ini');
 const r=inspectExtra('[SERVER]\nTRACK=csp/2144/../monza\nPASSWORD=secret\n[__CM_QUALIFY_OFF]\nNAME=Qualif\nTIME=15\n[WEATHER_0]\nGRAPHICS=clear\nBASE_TEMPERATURE_AMBIENT=21\n');
 assert.equal(r.sessions.QUALIFY,'inactive');assert.equal(r.inactiveSessions.QUALIFY.TIME,'15');
 assert.equal(r.weather.WEATHER_0.BASE_TEMPERATURE_AMBIENT,'21');assert.equal(r.csp.trackId,'monza');assert.doesNotMatch(JSON.stringify(r),/secret/);
});

test('Modification météo et activation CM préservent les autres valeurs et options WeatherFX',()=>{
 const {preview,inspect}=require('../tools/server-manager/draft');
 const text='[SERVER]\nTRACK=sugo\n[__CM_QUALIFY_OFF]\nNAME=Q\nTIME=15\nCUSTOM=conserve\n[WEATHER_0]\nGRAPHICS=clear_type=1\n__CM_GRAPHICS=clear\nBASE_TEMPERATURE_AMBIENT=21\n';
 const changes=[{section:'__CM_QUALIFY_OFF',key:'TIME',value:'25'},{section:'QUALIFY',key:'ENABLED',value:'1'},{section:'WEATHER_0',key:'BASE_TEMPERATURE_AMBIENT',value:'23'}];
 const result=patchIni(text,changes);assert.match(result,/\[QUALIFY\]\nNAME=Q\nTIME=25\nCUSTOM=conserve/);assert.match(result,/GRAPHICS=clear_type=1\n__CM_GRAPHICS=clear\nBASE_TEMPERATURE_AMBIENT=23/);
 const plan=preview(text,inspect(text).revision,changes);assert.equal(plan.changes.length,3);assert.equal(plan.changes[0].after,'25');
 assert.throws(()=>patchIni(text,[{section:'WEATHER_0',key:'GRAPHICS',value:'rain'}]),/WeatherFX/);
 assert.throws(()=>patchIni(text,[{section:'WEATHER_0',key:'BASE_TEMPERATURE_AMBIENT',value:'999'}]),/météo/);
 assert.throws(()=>patchIni(text+'[QUALIFY]\nTIME=2\n',[{section:'QUALIFY',key:'ENABLED',value:'1'}]),/ambigu/);
});

test('Protège le mode de course et les valeurs de durée conservées par CM',()=>{
 const text='[RACE]\nLAPS=10\nTIME=0\n__CM_TIME_OFF=15\n';
 assert.throws(()=>patchIni(text,[{section:'RACE',key:'TIME',value:'30'}]),/Durée inactive/);
 assert.throws(()=>patchIni(text,[{section:'RACE',key:'LAPS',value:'0'}]),/Changement de mode/);
 assert.match(patchIni(text,[{section:'RACE',key:'LAPS',value:'12'}]),/LAPS=12\nTIME=0\n__CM_TIME_OFF=15/);
});

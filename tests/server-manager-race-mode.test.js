'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {patchRaceMode}=require('../tools/server-manager/race-mode');
test('Bascule tours vers temps en préservant les valeurs CM et autres données',()=>{
 const input='[RACE]\r\nTIME=0\r\nLAPS=10\r\n__CM_TIME_OFF=25\r\nWAIT_TIME=60\r\n[OTHER]\r\nKEY=1\r\n';
 const output=patchRaceMode(input,{mode:'time',value:'25'});
 assert.match(output,/TIME=25\r\nLAPS=0\r\nWAIT_TIME=60\r\n__CM_LAPS_OFF=10\r\n\[OTHER\]/);assert.doesNotMatch(output,/__CM_TIME_OFF/);
 const restored=patchRaceMode(output,{mode:'laps',value:'10'});assert.match(restored,/TIME=0\r\nLAPS=10/);assert.match(restored,/__CM_TIME_OFF=25/);assert.doesNotMatch(restored,/__CM_LAPS_OFF/);
});
test('Refuse valeurs et sessions ambiguës',()=>{
 assert.throws(()=>patchRaceMode('[RACE]\nLAPS=5\nTIME=0\n',{mode:'laps',value:'2.5'}),/invalide/);
 assert.throws(()=>patchRaceMode('[RACE]\nLAPS=5\nTIME=0\n[__CM_RACE_OFF]\nLAPS=0\nTIME=1\n',{mode:'time',value:'12'}),/ambiguë/);
});

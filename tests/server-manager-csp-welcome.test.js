'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {decodeWelcome,encodeWelcome}=require('../tools/server-manager/csp-welcome');
test('Préserve le message et les scripts CSP au format Content Manager',()=>{
 const cfg='[SCRIPT_1]\nSCRIPT=https://gdsp.duckdns.org/csp/rolling_start.lua\n[SCRIPT_2]\nSCRIPT=https://gdsp.duckdns.org/csp/telemetry.lua\n';
 const encoded=encodeWelcome('Bienvenue',cfg);assert.match(encoded,/\$CSP0:/);assert.deepEqual(decodeWelcome(encoded),{message:'Bienvenue',config:cfg});
 const edited=encodeWelcome(decodeWelcome(encoded).message,cfg+'REQUIRED=0\n');assert.match(decodeWelcome(edited).config,/SCRIPT_1[\s\S]*SCRIPT_2/);
});
test('Refuse données malformées et fichiers trop longs sans les réécrire',()=>{
 assert.throws(()=>decodeWelcome('Hi\t'.repeat(32)+'$CSP0:broken'),/CSP/);
 assert.throws(()=>encodeWelcome('x'.repeat(2040),''),/trop long/);
 assert.throws(()=>encodeWelcome('hello $CSP0:foo','abc'),/invalide/);
});

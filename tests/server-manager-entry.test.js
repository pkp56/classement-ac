'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {inspectEntries,patchEntries}=require('../tools/server-manager/entry-list');
const ini='[CAR_0]\r\nMODEL=car_a\r\nSKIN=red\r\nGUID=123456secret\r\nDRIVERNAME=Private\r\n[SOMETHING]\r\nX=1\r\n[CAR_1]\r\nMODEL=car_b\r\nSKIN=blue\r\nGUID=\r\n';
test('Liste les places sans exposer identifiants ni noms privés',()=>{
 assert.deepEqual(inspectEntries(ini),[{id:0,model:'car_a',skin:'red',cspSkin:false,skinEditable:true,reserved:true},{id:1,model:'car_b',skin:'blue',cspSkin:false,skinEditable:true,reserved:false}]);
});
test('Modification ciblée conserve pilotes, positions et autres sections',()=>{
 assert.equal(patchEntries(ini,[{id:1,model:'car_c',skin:'yellow'}]),ini.replace('MODEL=car_b','MODEL=car_c').replace('SKIN=blue','SKIN=yellow'));
});
test('Refuse sections ou champs ambigus et identifiants non sûrs',()=>{
 assert.throws(()=>inspectEntries(ini+'[CAR_1]\nMODEL=other\n'),/ambigu/);
 assert.throws(()=>patchEntries(ini,[{id:0,model:'../../x'}]),/invalide/);
 assert.throws(()=>patchEntries(ini,[{id:9,model:'ok'}]),/absente/);
 assert.throws(()=>patchEntries(ini,[{id:0,model:'car_b\nGUID='}]),/invalide/);
});

test('Préserve les options CSP encodées dans les skins',()=>{
 const text='[CAR_0]\nMODEL=car_a\nSKIN=red/AB_4\nGUID=secret\n';
 assert.equal(inspectEntries(text)[0].skin,'red');assert.equal(inspectEntries(text)[0].cspSkin,true);
 assert.match(patchEntries(text,[{id:0,skin:'blue'}]),/SKIN=blue\/AB_4/);
 assert.throws(()=>patchEntries(text,[{id:0,model:'car_b'}]),/options CSP/);
});

test('Ajoute une place et supprime seulement les dernières places non réservées',()=>{
 const added=patchEntries(ini,[{id:2,operation:'add',model:'car_c',skin:'green'}]);
 assert.match(added,/\[CAR_2\]\r\nMODEL=car_c\r\nSKIN=green\r\n/);assert.match(added,/GUID=123456secret/);
 const removed=patchEntries(ini,[{id:1,operation:'remove'}]);assert.doesNotMatch(removed,/\[CAR_1\]/);assert.match(removed,/GUID=123456secret/);
 assert.throws(()=>patchEntries(ini,[{id:0,operation:'remove'}]),/données à conserver|dernières/);
 assert.throws(()=>patchEntries(ini.replace('GUID=\r\n','GUID=other-secret\r\n'),[{id:1,operation:'remove'}]),/données à conserver/);
 assert.throws(()=>patchEntries(ini.replace('SKIN=blue','SKIN=blue/CSP'),[{id:1,operation:'remove'}]),/données à conserver/);
 assert.throws(()=>patchEntries(ini,[{id:5,operation:'add',model:'car_c',skin:''}]),/numérotation/i);
});

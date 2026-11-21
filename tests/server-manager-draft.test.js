'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {inspect,preview}=require('../tools/server-manager/draft');
const original='[SERVER]\r\nNAME=CM 1\r\nTRACK=sugo\r\nUDP_PORT=9600\r\nPASSWORD=secret\r\n[__CM_SERVER]\r\nDATA=private\r\n';
test('Aperçu sur copie : les secrets et les ports sont absents, aucun fichier écrit',()=>{
 const snapshot=inspect(original);
 const draft=preview(original,snapshot.revision,[{section:'SERVER',key:'TRACK',value:'monza'}]);
 assert.deepEqual(draft.changes,[{section:'SERVER',key:'TRACK',before:'sugo',after:'monza'}]);
 assert.doesNotMatch(JSON.stringify(draft),/secret|9600|private/);
 assert.equal(inspect(original).settings.SERVER.TRACK,'sugo');
});
test('Un aperçu doit correspondre exactement à la version lue',()=>{
 const old=inspect(original).revision;
 assert.throws(()=>preview(original.replace('sugo','imola'),old,[{section:'SERVER',key:'TRACK',value:'monza'}]),/changé/);
 assert.throws(()=>preview(original,old,[{section:'SERVER',key:'UDP_PORT',value:3}]),/non autorisé/);
 assert.throws(()=>preview(original,old,[]),/invalide/);
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const roles=require('../assets/entrant-roles');
const {summarizeChampionship}=require('../tools/lib/assettohosting-preview');

test('service : noms explicites et variantes courantes, sans exclusion par sous-chaîne ou modèle seul',()=>{
  for(const name of ['Broadcast','BROADCAST #1','GDSP Broadcast','PaceCar','Pace Car 2','Safety Car','Voiture de sécurité','GDSP Pace Car'])assert.ok(roles.serviceRole({name}),name);
  for(const name of ['Broadcaster Bob','The Broadcast Racer','Pacecarlover','Alice Safety','Bob'])assert.equal(roles.serviceRole({name,car:'dodge_monaco_police'}),'',name);
  const list=[{name:'Broadcast'},{name:'PaceCar'},{name:'Alice'}],before=JSON.stringify(list);
  assert.deepEqual(roles.drivers(list).map(x=>x.name),['Alice']);assert.deepEqual(roles.services(list).map(x=>x.name),['Broadcast','PaceCar']);assert.equal(JSON.stringify(list),before);
});

test('aperçu AssettoHosting conserve les informations et laisse le choix à l’administrateur',()=>{
 const j={Name:'Lola',Classes:[{Entrants:[{Name:'Broadcast',Model:'camera'},{Name:'PaceCar',Model:'safety'},{Name:'Alice',Model:'lola'}]}]};
 const out=summarizeChampionship(j,'https://fr2.assettohosting.com:50648','11111111-1111-1111-1111-111111111111');
 assert.deepEqual(out.entrants.map(e=>e.name),['Broadcast','PaceCar','Alice']);assert.equal(roles.services(out.entrants).length,2);
});

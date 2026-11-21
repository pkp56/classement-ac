'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {prepare}=require('../tools/server-manager/plan');
const config='[SERVER]\nNAME=Server\nTRACK=sugo\nCONFIG_TRACK=\nCARS=car_a;car_b\nMAX_CLIENTS=1\nUDP_PORT=9600\nPASSWORD=private\n';
const entry='[CAR_0]\nMODEL=car_a\nSKIN=blue\nGUID=private-guid\n';
const h=s=>crypto.createHash('sha256').update(s).digest('hex');
const args={config,entry,configRevision:h(config),entryRevision:h(entry),inventory:{tracks:[{id:'monza',layouts:['gp']}],cars:[{id:'car_b',skins:['red']} ]}};
test('Prévisualise les deux fichiers sans révéler de secrets et sans les modifier',()=>{
 const plan=prepare({...args,configChanges:[{section:'SERVER',key:'TRACK',value:'monza'},{section:'SERVER',key:'CONFIG_TRACK',value:'gp'}],entryChanges:[{id:0,model:'car_b',skin:'red'}]});
 assert.equal(plan.configChanges.length,2);assert.equal(plan.slotChanges[0].after.model,'car_b');assert.doesNotMatch(JSON.stringify(plan),/private|9600/);
});
test('Refuse contenu absent et modifications concurrentes',()=>{
 assert.throws(()=>prepare({...args,entryRevision:h('other'),entryChanges:[{id:0,model:'car_b',skin:'red'}]}),/changé/);
 assert.throws(()=>prepare({...args,configChanges:[{section:'SERVER',key:'TRACK',value:'missing'}]}),/introuvable/);
 assert.throws(()=>prepare({...args,entryChanges:[{id:0,model:'car_b',skin:'missing'}]}),/introuvable/);
});

test('Valide la cohérence des places même lorsque seule la liste ou la limite change',()=>{
 assert.throws(()=>prepare({...args,configChanges:[{section:'SERVER',key:'CARS',value:'car_b'}]}),/voiture des places/);
 assert.throws(()=>prepare({...args,configChanges:[{section:'SERVER',key:'MAX_CLIENTS',value:'2'}]}),/places est insuffisant/);
 assert.throws(()=>prepare({...args,configChanges:[{section:'SERVER',key:'CARS',value:'car_a;missing'}]}),/Voiture autorisée introuvable/);
});

test('Conserve l’encodage CSP du circuit tout en validant le nouveau circuit installé',()=>{
 const c=config.replace('TRACK=sugo','TRACK=csp/2144/../AB_12/../sugo');
 const p=prepare({...args,config:c,configRevision:h(c),configChanges:[{section:'SERVER',key:'TRACK',value:'monza'}]});
 assert.equal(p.configChanges[0].after,'csp/2144/../AB_12/../monza');
});

test('Aperçu ajout et suppression ne divulgue jamais les données réservées',()=>{
 const args2={...args,inventory:{tracks:[],cars:[{id:'car_a',skins:['blue']},{id:'car_b',skins:['red']} ]}};
 const p=prepare({...args2,entryChanges:[{id:1,operation:'add',model:'car_b',skin:'red'}]});
 assert.equal(p.slotChanges[0].before,null);assert.equal(p.slotChanges[0].after.model,'car_b');assert.doesNotMatch(JSON.stringify(p),/private/);
 const two=entry+'[CAR_1]\nMODEL=car_b\nSKIN=red\nGUID=\n';
 const q=prepare({...args2,entry:two,entryRevision:h(two),entryChanges:[{id:1,operation:'remove'}]});assert.equal(q.slotChanges[0].after,null);
});
test('Une variante peut être ajoutée si CONFIG_TRACK est absent sans toucher aux autres lignes',()=>{
 const missing=config.replace('CONFIG_TRACK=\n','');
 const plan=prepare({...args,config:missing,configRevision:h(missing),configChanges:[{section:'SERVER',key:'TRACK',value:'monza'},{section:'SERVER',key:'CONFIG_TRACK',value:'gp'}]});
 assert.ok(plan.configChanges.some(c=>c.key==='CONFIG_TRACK'&&c.after==='gp'));
 const {patchIni}=require('../tools/server-manager/ini');
 assert.equal(patchIni(missing,[{section:'SERVER',key:'CONFIG_TRACK',value:'gp'}]),missing.replace('[SERVER]\n','[SERVER]\nCONFIG_TRACK=gp\n'));
 assert.throws(()=>patchIni(missing+'\n[SERVER]\n',[{section:'SERVER',key:'CONFIG_TRACK',value:'gp'}]),/ambigu/);
 assert.throws(()=>prepare({...args,config:missing,configRevision:h(missing),configChanges:[{section:'SERVER',key:'TRACK',value:'monza'},{section:'SERVER',key:'CONFIG_TRACK',value:'wrong'}]}),/introuvable/);
});

'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {readPreset}=require('../tools/server-manager/presets');
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-presets-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const [id,track] of [['SERVER_00','sugo'],['SERVER_01','monza']]){
  const dir=path.join(root,'presets',id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'server_cfg.ini'),`[SERVER]\nTRACK=${track}\nUDP_PORT=9600\nPASSWORD=secret\n`);
  await fs.writeFile(path.join(dir,'entry_list.ini'),'[CAR_0]\nMODEL=car_a\nSKIN=red\nGUID=secretguid\n');
 }
 return root;
}
test('Lecture séparée des deux serveurs sans exposer secrets ni ports',async t=>{
 const root=await setup(t),a=await readPreset(root,'local1'),b=await readPreset(root,'local2');
 assert.equal(a.settings.SERVER.TRACK,'sugo');assert.equal(b.settings.SERVER.TRACK,'monza');
 assert.doesNotMatch(JSON.stringify([a,b]),/secret|9600/);
 await assert.rejects(readPreset(root,'../../SERVER_00'),/inconnu/);
});
test('Refuse les fichiers symboliques et configurations manquantes',async t=>{
 const root=await setup(t),f=path.join(root,'presets/SERVER_01/server_cfg.ini');
 await fs.unlink(f);
 try{await fs.symlink(path.join(root,'presets/SERVER_00/server_cfg.ini'),f);}catch(e){if(e.code==='EPERM'){t.skip('Liens symboliques non autorisés sur ce Windows');return;}throw e;}
 await assert.rejects(readPreset(root,'local2'),/non sûr/);
 await assert.rejects(readPreset('', 'local1'),/non configuré/);
});

'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {inventory}=require('../tools/server-manager/inventory');
test('Inventaire uniquement de répertoires installés et layouts reconnus',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-content-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'cars','car_a','skins','red'),{recursive:true});
 await fs.mkdir(path.join(root,'tracks','track_a','ui'),{recursive:true});
 await fs.writeFile(path.join(root,'tracks','track_a','models_gp.ini'),'');
 await fs.writeFile(path.join(root,'tracks','track_a','models.ini'),'');
 try{await fs.symlink(path.join(root,'cars','car_a'),path.join(root,'cars','unsafe_link'),'dir');}catch(e){if(e.code!=='EPERM')throw e;}
 assert.deepEqual(await inventory(root),{cars:[{id:'car_a',skins:['red']}],tracks:[{id:'track_a',layouts:['gp']}]});
});
test('Contenu absent et racine non configurée',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-content-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 assert.deepEqual(await inventory(root),{cars:[],tracks:[]});
 await assert.rejects(inventory(''),/non configuré/);
});
test('Deux racines : fusion par identifiant, variantes et skins, sans masquer une racine indisponible',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-multi-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const a=path.join(base,'a'),b=path.join(base,'b');
 await fs.mkdir(path.join(a,'tracks','track_a'),{recursive:true});await fs.mkdir(path.join(b,'tracks','track_a'),{recursive:true});
 await fs.writeFile(path.join(a,'tracks','track_a','models_gp.ini'),'');await fs.writeFile(path.join(b,'tracks','track_a','models_short.ini'),'');
 await fs.mkdir(path.join(a,'cars','car_a','skins','red'),{recursive:true});await fs.mkdir(path.join(b,'cars','car_a','skins','blue'),{recursive:true});
 await fs.mkdir(path.join(b,'tracks','track_b'),{recursive:true});await fs.mkdir(path.join(b,'cars','car_b'),{recursive:true});
 const result=await inventory(a,b);
 assert.deepEqual(result.tracks,[{id:'track_a',layouts:['gp','short']},{id:'track_b',layouts:[]}]);
 assert.deepEqual(result.cars,[{id:'car_a',skins:['blue','red']},{id:'car_b',skins:[]}]);
 await assert.rejects(inventory(a,path.join(base,'absent')));
});

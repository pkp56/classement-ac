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

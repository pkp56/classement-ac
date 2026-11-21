'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {saveBackup}=require('../tools/server-manager/backups');
test('Sauvegarde séparée, privée, sans exposer les données ou écraser une copie précédente',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-backup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const publicRoot=path.join(root,'public'),backupRoot=path.join(root,'private');await fs.mkdir(publicRoot);await fs.mkdir(backupRoot);
 const args={publicRoot,backupRoot,id:'local1',config:Buffer.from('PASSWORD=secret'),entry:Buffer.from('GUID=private')};
 const a=await saveBackup(args),b=await saveBackup(args);assert.notEqual(a.name,b.name);assert.doesNotMatch(JSON.stringify(a),/secret|private/);
 assert.equal(await fs.readFile(path.join(backupRoot,a.name,'server_cfg.ini'),'utf8'),'PASSWORD=secret');
 assert.equal(await fs.readFile(path.join(backupRoot,b.name,'entry_list.ini'),'utf8'),'GUID=private');
 await assert.rejects(saveBackup({...args,backupRoot:publicRoot}),/interdite/);
 await assert.rejects(saveBackup({...args,id:'../../etc'}),/inconnu/);
 const link=path.join(root,'link');try{await fs.symlink(backupRoot,link,'dir');await assert.rejects(saveBackup({...args,backupRoot:link}),/non sûr/);}catch(e){if(e.code!=='EPERM')throw e;}
});

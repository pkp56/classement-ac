'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {assertDirectLaunchSafe}=require('../tools/server-manager/direct-launch');
test('Refuse un lancement direct en présence de plugin ou wrapper Content Manager',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-launch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'presets','SERVER_00');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'entry_list.ini'),'');
 const cfg=path.join(dir,'server_cfg.ini');await fs.writeFile(cfg,'[SERVER]\nTRACK=sugo\n[__CM_PLUGIN]\nACTIVE=1\n');
 await assert.rejects(assertDirectLaunchSafe(root,'local1'),/plugin CM/);
 await fs.writeFile(cfg,'[SERVER]\nTRACK=sugo\n[__CM_PLUGIN]\nACTIVE=0\n');await assertDirectLaunchSafe(root,'local1');
 await fs.writeFile(path.join(dir,'cm_wrapper_params.json'),'{}');await assert.rejects(assertDirectLaunchSafe(root,'local1'),/wrapper CM/);
});

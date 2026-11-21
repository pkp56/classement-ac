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

test('Essai sur serveur 1 demande une confirmation et ne change aucun fichier',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-plugin-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'presets','SERVER_00');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'entry_list.ini'),'[CAR_0]\nMODEL=car\n');
 const cfg=path.join(dir,'server_cfg.ini');const config='[SERVER]\nUDP_PLUGIN_ADDRESS=127.0.0.1:12000\nUDP_PLUGIN_LOCAL_PORT=12001\nPASSWORD=secret\n[__CM_PLUGIN]\nACTIVE=1\nREAL_CONDITIONS=0\nREAL_CONDITIONS_PARAMS=conserver\n';
 await fs.writeFile(cfg,config);const collector={bindState:'listening',options:{listenPort:12000,pluginPort:12001,host:'127.0.0.1'}};
 await assert.rejects(assertDirectLaunchSafe(root,'local1',{collector}),e=>e.code==='CM_PLUGIN_TEST_CONFIRM');
 assert.deepEqual(await assertDirectLaunchSafe(root,'local1',{collector,allowWithoutCmPlugin:true}),{withoutCmPlugin:true});
 assert.equal(await fs.readFile(cfg,'utf8'),config);
 await assert.rejects(assertDirectLaunchSafe(root,'local1',{collector:{...collector,bindState:'error'},allowWithoutCmPlugin:true}),/plugin CM/);
 for(const unsafe of [
  config.replace('REAL_CONDITIONS=0','REAL_CONDITIONS=1'),
  config+'EXTRA_PLUGIN_0_ADDRESS=localhost:1234\n',
  config.replace('UDP_PLUGIN_LOCAL_PORT=12001','UDP_PLUGIN_LOCAL_PORT=12002'),
  config.replace('127.0.0.1:12000','192.168.1.1:12000'),
  config.replace('ACTIVE=1','ACTIVE=1\nACTIVE=0'),
  config.replace('[__CM_PLUGIN]','AUTH_PLUGIN_ADDRESS=http://example.org\n[__CM_PLUGIN]')
 ]){
  await fs.writeFile(cfg,unsafe);await assert.rejects(assertDirectLaunchSafe(root,'local1',{collector,allowWithoutCmPlugin:true}),/plugin CM/);
 }
 await fs.writeFile(cfg,config);await fs.writeFile(path.join(dir,'cm_wrapper_params.json'),'{}');
 await assert.rejects(assertDirectLaunchSafe(root,'local1',{collector,allowWithoutCmPlugin:true}),/wrapper CM/);
});

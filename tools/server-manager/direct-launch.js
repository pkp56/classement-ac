'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {readFiles}=require('./presets');
const {inspectDirectLaunch,inspectPluginTest}=require('./ini');
async function assertDirectLaunchSafe(root,id,{allowWithoutCmPlugin=false,collector=null}={}){
 const {config}=await readFiles(root,id);
 const dir=path.join(await fs.realpath(root),'presets',id==='local1'?'SERVER_00':'SERVER_01');
 try{await fs.lstat(path.join(dir,'cm_wrapper_params.json'));throw Error('Configuration wrapper CM détectée : lancement depuis Content Manager nécessaire.');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 if(!inspectDirectLaunch(config)){
  const available=id==='local1'&&collector?.bindState==='listening'&&inspectPluginTest(config,collector.options);
  if(!available)throw Error('Le plugin CM est actif ou ambigu : lancement depuis Content Manager nécessaire.');
  if(!allowWithoutCmPlugin){const e=Error('Essai sans plugin CM : confirmation supplementaire necessaire.');e.code='CM_PLUGIN_TEST_CONFIRM';throw e;}
  return {withoutCmPlugin:true};
 }
 return {withoutCmPlugin:false};
}
module.exports={assertDirectLaunchSafe};

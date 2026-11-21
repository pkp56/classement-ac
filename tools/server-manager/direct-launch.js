'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {readFiles}=require('./presets');
const {inspectDirectLaunch}=require('./ini');
async function assertDirectLaunchSafe(root,id){
 const {config}=await readFiles(root,id);
 if(!inspectDirectLaunch(config))throw Error('Le plugin CM est actif ou ambigu : lancement depuis Content Manager nécessaire.');
 const dir=path.join(await fs.realpath(root),'presets',id==='local1'?'SERVER_00':'SERVER_01');
 try{await fs.lstat(path.join(dir,'cm_wrapper_params.json'));throw Error('Configuration wrapper CM détectée : lancement depuis Content Manager nécessaire.');}
 catch(e){if(e.code!=='ENOENT')throw e;}
}
module.exports={assertDirectLaunchSafe};

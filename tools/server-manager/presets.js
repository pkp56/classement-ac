'use strict';
// Catalogue strictement en lecture seule. Rien ne peut démarrer ou arrêter un
// processus, ni modifier les fichiers. Le chemin est choisi côté administrateur
// système, jamais à partir des données d'une requête HTTP.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const draft=require('./draft');
const {inspectEntries}=require('./entry-list');
const {inspectExtra}=require('./ini');
const IDS=Object.freeze({local1:'SERVER_00',local2:'SERVER_01'});
const MAX=1024*1024;
async function checkedRead(dir,filename){
 const target=path.join(dir,filename),st=await fs.lstat(target);
 if(!st.isFile()||st.isSymbolicLink()||st.size>MAX)throw new Error('Fichier absent ou non sûr');
 const data=await fs.readFile(target);
 if(data.length>MAX||data.includes(0))throw new Error('Fichier invalide ou trop volumineux');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
 return text;
}
async function readFiles(root,id){
 if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('Chemin serveur non configuré');
 if(!Object.hasOwn(IDS,id))throw new Error('Serveur inconnu');
 const serverRoot=await fs.realpath(root),presetsPath=path.join(serverRoot,'presets'),presetPath=path.join(presetsPath,IDS[id]);
 for(const p of [presetsPath,presetPath]){
   const stat=await fs.lstat(p);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Dossier non sûr');
 }
 const [config,entry]=await Promise.all([checkedRead(presetPath,'server_cfg.ini'),checkedRead(presetPath,'entry_list.ini')]);
 return {config,entry};
}
async function readPreset(root,id){
 const {config,entry}=await readFiles(root,id);
 const safe=draft.inspect(config);
 return {id,revision:safe.revision,entryRevision:crypto.createHash('sha256').update(entry,'utf8').digest('hex'),settings:safe.settings,extra:inspectExtra(config),slots:inspectEntries(entry)};
}
module.exports={readPreset,readFiles};

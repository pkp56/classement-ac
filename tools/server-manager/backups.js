'use strict';
// Sauvegarde appelée par le module d’écriture expérimentale.
// Le dossier de sauvegarde doit être créé et sécurisé par l'administrateur
// Windows : chmod ne configure pas les ACL NTFS.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const MAX=1024*1024;
function isInside(parent,child){const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
async function durableWrite(filename,data){
 const file=await fs.open(filename,'wx',0o600);
 try{await file.writeFile(data);await file.sync();}finally{await file.close();}
 const copied=await fs.readFile(filename);
 if(copied.length!==data.length||!crypto.timingSafeEqual(crypto.createHash('sha256').update(copied).digest(),crypto.createHash('sha256').update(data).digest()))throw new Error('Vérification de sauvegarde échouée');
}
async function saveBackup({backupRoot,publicRoot,id,config,entry,welcome}){
 if(!path.isAbsolute(backupRoot||'')||!path.isAbsolute(publicRoot||''))throw new Error('Chemins non configurés');
 if(!['local1','local2'].includes(id))throw new Error('Serveur inconnu');
 if(!Buffer.isBuffer(config)||!Buffer.isBuffer(entry)||config.length>MAX||entry.length>MAX||(welcome!==undefined&&(!Buffer.isBuffer(welcome)||welcome.length>2039)))throw new Error('Données invalides');
 const rootInfo=await fs.lstat(backupRoot);
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('Dossier de sauvegarde non sûr');
 const root=await fs.realpath(backupRoot),publicPath=await fs.realpath(publicRoot);
 if(isInside(publicPath,root))throw new Error('Sauvegarde interdite dans le dossier public');
 const name=`${id}-${Date.now()}-${crypto.randomUUID()}`,dest=path.join(root,name);
 await fs.mkdir(dest,{mode:0o700});
 try{
   await durableWrite(path.join(dest,'server_cfg.ini'),config);
   await durableWrite(path.join(dest,'entry_list.ini'),entry);
   if(welcome!==undefined)await durableWrite(path.join(dest,'cm_welcome.txt'),welcome);
   return {id,name}; // Pas de chemin complet ni de contenu sensible.
 }catch(error){
   await fs.rm(dest,{recursive:true,force:true}).catch(()=>{});
   throw error;
 }
}
module.exports={saveBackup};

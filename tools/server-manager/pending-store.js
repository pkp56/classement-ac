'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
function store(root){
 if(!path.isAbsolute(root||''))throw Error('Dossier privé non configuré.');
 function marker(id,suffix){if(!['local1','local2'].includes(id))throw Error('Serveur inconnu.');return path.join(root,id+suffix);}
 async function exists(p){try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 return {
  has:id=>exists(marker(id,'.start-pending')),
  async mark(id){await fs.mkdir(marker(id,'.start-pending'),{mode:0o700});},
  async clear(id){await fs.rmdir(marker(id,'.start-pending')).catch(e=>{if(e.code!=='ENOENT')throw e;});},
  async assertSafe(id){if(await exists(marker(id,'.pending')))throw Error('Une sauvegarde nécessite une restauration manuelle.');}
 };
}
module.exports={store};

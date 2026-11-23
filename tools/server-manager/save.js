'use strict';
// Sauvegarde expérimentale : l'utilisateur doit fermer CM et arrêter l'instance.
// Le marqueur durable bloque toute nouvelle écriture après une interruption.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {readFiles}=require('./presets');
const {prepare}=require('./plan');
const {patchIni}=require('./ini');
const {patchEntries}=require('./entry-list');
const {saveBackup}=require('./backups');
const {inventory}=require('./inventory');
const IDS=Object.freeze({local1:'SERVER_00',local2:'SERVER_01'});
function inside(parent,child){const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
async function writeTemp(dir,name,text,mode){
 const file=path.join(dir,`.gdsp-${name}-${crypto.randomUUID()}.tmp`);
 const h=await fs.open(file,'wx',mode);
 try{await h.writeFile(text,'utf8');await h.sync();}catch(e){await h.close();await fs.rm(file,{force:true}).catch(()=>{});throw e;}
 await h.close();return file;
}
async function save(args,{checkState,loadInventory=inventory,replace=fs.rename}={}){
 const {root,contentRoot,extraContentRoot,backupRoot,publicRoot,id,confirmation,configRevision,entryRevision,configChanges=[],entryChanges=[],weatherChanges=[],raceMode,cspConfig,welcomeRevision}=args;
 if(!Object.hasOwn(IDS,id)||confirmation!==id)throw Error('Confirmation du serveur nécessaire.');
 if(![root,contentRoot,backupRoot,publicRoot].every(x=>typeof x==='string'&&path.isAbsolute(x)))throw Error('Chemins non configurés.');
 if(typeof checkState!=='function')throw Error('Vérification des processus indisponible.');
 const backupStat=await fs.lstat(backupRoot);
 if(!backupStat.isDirectory()||backupStat.isSymbolicLink())throw Error('Dossier de sauvegarde non sûr.');
 const [realBackup,realPublic,realServer]=await Promise.all([fs.realpath(backupRoot),fs.realpath(publicRoot),fs.realpath(root)]);
 if(inside(realPublic,realBackup)||inside(realServer,realBackup)||inside(realBackup,realServer)||inside(realPublic,realServer))throw Error('Dossier de sauvegarde non sûr.');
 const marker=path.join(realBackup,`${id}.pending`);
 try{await fs.mkdir(marker,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('Une opération est en cours ou nécessite une restauration manuelle.');throw e;}
 let changed=false,temps=[];
 try{
  if(await require('./pending-store').store(realBackup).has(id))throw Error('Un lancement précédent n’a pas encore été vérifié.');
  const state=await checkState(id);
  if(!state)throw Error('Ferme Content Manager et arrête le serveur avant toute modification.');
  const files=await readFiles(root,id),inv=await loadInventory(contentRoot,extraContentRoot);
  const hasCsp=cspConfig!==undefined;
  const welcome=hasCsp?await require('./welcome-store').readWelcome(root,id,files.config):null;
  const nextWelcome=hasCsp?require('./welcome-store').prepareWelcome(welcome,welcomeRevision,cspConfig):null;
  const plan=prepare({...files,inventory:inv,configRevision,entryRevision,configChanges,entryChanges,weatherChanges,raceMode,hasCsp});
  plan.cspChanged=hasCsp&&nextWelcome!==welcome.local;
  if(!plan.configChanges.length&&!plan.slotChanges.length&&!plan.weatherChanges.length&&!plan.raceChange&&!plan.cspChanged)throw Error('Aucune modification effective.');
  const configAfterFields=configChanges.length?patchIni(files.config,configChanges):files.config;
  const configAfterWeather=weatherChanges.length?require('./weather').patchWeather(configAfterFields,weatherChanges):configAfterFields;
  const nextConfig=raceMode?require('./race-mode').patchRaceMode(configAfterWeather,raceMode):configAfterWeather;
  const nextEntry=entryChanges.length?patchEntries(files.entry,entryChanges):files.entry;
  const backup=await saveBackup({backupRoot:realBackup,publicRoot:realPublic,id,config:Buffer.from(files.config,'utf8'),entry:Buffer.from(files.entry,'utf8'),...(plan.cspChanged?{welcome:Buffer.from(welcome.local,'utf8')}:{})});
  // Le nom permet une restauration manuelle, sans divulguer de chemin dans l'API.
  const manifest=await fs.open(path.join(marker,'backup.txt'),'wx',0o600);
  try{await manifest.writeFile(backup.name+'\n','utf8');await manifest.sync();}finally{await manifest.close();}
  const dir=path.join(realServer,'presets',IDS[id]);
  if(nextConfig!==files.config){const stat=await fs.lstat(path.join(dir,'server_cfg.ini'));temps.push({file:await writeTemp(dir,'config',nextConfig,stat.mode&0o777),target:path.join(dir,'server_cfg.ini')});}
  if(nextEntry!==files.entry){const stat=await fs.lstat(path.join(dir,'entry_list.ini'));temps.push({file:await writeTemp(dir,'entry',nextEntry,stat.mode&0o777),target:path.join(dir,'entry_list.ini')});}
  if(plan.cspChanged){
    for(const target of [welcome.localPath,welcome.livePath]){const stat=await fs.lstat(target);temps.push({file:await writeTemp(path.dirname(target),'welcome',nextWelcome,stat.mode&0o777),target});}
  }
  if(!(await checkState(id)))throw Error('Ferme Content Manager et arrête le serveur avant toute modification.');
  const fresh=await readFiles(root,id);
  if(fresh.config!==files.config||fresh.entry!==files.entry)throw Error('Les fichiers ont changé : recharge avant de modifier.');
  if(plan.cspChanged){const current=await require('./welcome-store').readWelcome(root,id,fresh.config);if(current.revision!==welcome.revision)throw Error('Le message CSP a changé : recharge avant de modifier');}
  // L'interruption entre les deux renommages exige une restauration manuelle.
  // Conserver le marqueur dès qu'un renommage peut avoir eu lieu.
  changed=true;
  for(const temp of temps)await replace(temp.file,temp.target);
  const verify=await readFiles(root,id);
  if(verify.config!==nextConfig||verify.entry!==nextEntry)throw Error('Vérification après écriture échouée.');
  if(plan.cspChanged){const written=await require('./welcome-store').readWelcome(root,id,verify.config);if(written.local!==nextWelcome)throw Error('Vérification CSP après écriture échouée.');}
  await fs.rm(marker,{recursive:true});changed=false;
  return {ok:true,backupCreated:true,plan};
 }catch(e){
  if(changed){const failure=Error('Écriture non confirmée : restauration manuelle nécessaire avant toute nouvelle modification.');failure.code='RECOVERY_REQUIRED';throw failure;}
  throw e;
 }finally{
  for(const temp of temps)await fs.rm(temp.file,{force:true}).catch(()=>{});
  if(!changed)await fs.rm(marker,{recursive:true,force:true}).catch(()=>{});
 }
}
module.exports={save};

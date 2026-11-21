'use strict';
// Contrôleur expérimental : aucune implémentation système n'est branchée à une
// API. L'adaptateur doit prouver l'identité du processus lors de l'arrêt.
const path=require('node:path');
const crypto=require('node:crypto');
const {identify}=require('./process-identity');
const IDS=Object.freeze({local1:'SERVER_00',local2:'SERVER_01'});
class ServerController{
 constructor(root,adapter,pendingStore=null){
  if(typeof root!=='string'||!path.win32.isAbsolute(root)||!adapter||typeof adapter.list!=='function'||typeof adapter.start!=='function'||typeof adapter.stopVerified!=='function')throw new Error('Configuration du contrôleur invalide');
  this.root=path.win32.normalize(root);this.adapter=adapter;this.busy=false;this.pending=new Set();this.pendingStore=pendingStore;
 }
 async exclusive(fn){if(this.busy)throw new Error('Une opération serveur est déjà en cours.');this.busy=true;try{return await fn();}finally{this.busy=false;}}
 validate(id,confirmation){
  if(!Object.hasOwn(IDS,id))throw new Error('Serveur inconnu.');
  if(confirmation!==id)throw new Error('Confirmation explicite du serveur nécessaire.');
 }
 async snapshot(){
  const processes=await this.adapter.list();
  const state=identify({root:this.root,processes});
  if(state.ambiguous)throw new Error('Identification ambiguë : aucune action autorisée.');
  for(const id of Object.keys(IDS)){
   if(state.servers[id].length===1){this.pending.delete(id);if(this.pendingStore)await this.pendingStore.clear(id);}
  }
  return {state,processes};
 }
 async start(id,confirmation){
  this.validate(id,confirmation);
  return this.exclusive(async()=>{
   const {state}=await this.snapshot();
   if(state.servers[id].length)throw new Error('Ce serveur est déjà en marche.');
   if(this.pending.has(id)||(this.pendingStore&&await this.pendingStore.has(id)))throw new Error('Un lancement précédent n’a pas encore été vérifié.');
   if(this.pendingStore)await this.pendingStore.assertSafe(id);
   const dir=path.win32.join(this.root,'presets',IDS[id]);
   // Chemins calculés depuis une racine autorisée, jamais fournis par le client.
   const exe=path.win32.join(this.root,'acServer.exe');
   const args=['-c',path.win32.join(dir,'server_cfg.ini'),'-e',path.win32.join(dir,'entry_list.ini')];
   if(this.pendingStore)await this.pendingStore.mark(id);
   this.pending.add(id);
   await this.adapter.start({exe,args,cwd:this.root,id});
   // La création du processus ne prouve pas que le serveur a démarré.
   return {accepted:true,message:'Lancement demandé : vérifier l’état et le lobby.'};
  });
 }
 async stop(id,confirmation){
  this.validate(id,confirmation);
  return this.exclusive(async()=>{
   const {state,processes}=await this.snapshot(),found=state.servers[id];
   if(this.pending.has(id)||(this.pendingStore&&await this.pendingStore.has(id)))throw new Error('Lancement en attente : arrêt impossible à identifier.');
   if(found.length!==1)throw new Error('Ce serveur ne tourne pas ou son identité est incertaine.');
   const current=processes.find(p=>p.pid===found[0].pid&&p.creationTime===found[0].creationTime);
   if(!current||typeof current.commandLine!=='string')throw new Error('Identité du processus indisponible.');
   const fingerprint=crypto.createHash('sha256').update(current.commandLine,'utf8').digest('hex');
   // L'adaptateur doit ouvrir le processus et revalider son PID, sa date,
   // son exécutable et l'empreinte avant l'arrêt ; refuser au moindre doute.
   await this.adapter.stopVerified({pid:current.pid,creationTime:current.creationTime,executablePath:path.win32.join(this.root,'acServer.exe'),commandHash:fingerprint});
   return {accepted:true,message:'Arrêt demandé : vérifier que le serveur est bien arrêté.'};
  });
 }
}
module.exports={ServerController};

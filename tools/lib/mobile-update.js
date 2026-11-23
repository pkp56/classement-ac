'use strict';
// Opt-in Windows uniquement : un compte admin navigateur peut demander le
// commit courant de main, jamais une commande, un dépôt ou une branche arbitraire.
// La tâche séparée valide de nouveau tous les prérequis avant d'agir.
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const crypto=require('node:crypto');
const exec=promisify(execFile);
const REPOSITORY='https://github.com/pkp56/classement-ac.git';
const TASK='GDSP Mobile Update';
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
function verifyUpdateKey(key,hash){
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(key)||typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash))return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(key,'utf8').digest(),Buffer.from(hash,'hex'));
}
function createMobileUpdate({root,enabled=()=>false,run=exec,now=()=>Date.now()}){
  const folder=path.join(root,'data','mobile-updates'),requestFile=path.join(folder,'request.json'),statusFile=path.join(folder,'status.json');
  const call=async(program,args)=>{
    const out=await run(program,args,{cwd:root,timeout:25000,maxBuffer:1024*1024,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    return String(out.stdout||'').trim();
  };
  function requireEnabled(){if(!enabled())throw Object.assign(new Error('Mise à jour mobile désactivée sur ce PC.'),{status:503});}
  async function check(){
    requireEnabled();
    try{
      const branch=await call('git',['branch','--show-current']);
      if(branch!=='main')throw Object.assign(new Error('Le dépôt Windows doit être sur main.'),{status:409});
      const origin=(await call('git',['remote','get-url','origin'])).replace(/\/$/,'');
      if(origin!==REPOSITORY)throw Object.assign(new Error('Origine Git non reconnue : intervention locale nécessaire.'),{status:409});
      if(await call('git',['status','--porcelain']))throw Object.assign(new Error('Le dépôt contient des modifications locales : intervention locale nécessaire.'),{status:409});
      const current=(await call('git',['rev-parse','HEAD'])).toLowerCase();
      const result=await call('git',['ls-remote','--refs',REPOSITORY,'refs/heads/main']);
      const match=result.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/i),target=match&&match[1].toLowerCase();
      if(!sha(current)||!sha(target))throw new Error();
      return {current,target,available:current!==target};
    }catch(e){if(e.status)throw e;throw Object.assign(new Error('Vérification Git impossible sur le PC serveur.'),{status:503});}
  }
  async function status(){
    if(!enabled())return {enabled:false};
    let pending=false,queued;try{queued=JSON.parse(await fs.readFile(requestFile,'utf8'));pending=true;}catch(e){if(e.code!=='ENOENT')pending=true;}
    let state;try{state=JSON.parse(await fs.readFile(statusFile,'utf8'));}catch(_){}
    // Ne pas exposer les chemins ou sorties de commandes, même en cas d'erreur.
    const allowed=['queued','running','completed','failed'];
    const out={enabled:true,pending};
    if(state&&allowed.includes(state.state)&&(!pending||state.target===queued?.target)){
      out.state=state.state;
      if(sha(state.target))out.target=state.target;
      if(typeof state.message==='string'&&state.message.length<300)out.message=state.message;
    }else if(pending)out.state='queued';
    return out;
  }
  async function request(target){
    requireEnabled();
    if(!sha(target))throw Object.assign(new Error('Version invalide.'),{status:400});
    const latest=await check();
    if(target!==latest.target)throw Object.assign(new Error('La version a changé. Vérifie à nouveau.'),{status:409});
    if(!latest.available)throw Object.assign(new Error('Le site est déjà à jour.'),{status:409});
    await fs.mkdir(folder,{recursive:true});
    try{await fs.writeFile(requestFile,JSON.stringify({target,requestedAt:new Date(now()).toISOString()}),{flag:'wx',mode:0o600});}
    catch(e){if(e.code==='EEXIST')throw Object.assign(new Error('Une mise à jour est déjà en attente.'),{status:409});throw e;}
    try{await call('schtasks.exe',['/Run','/TN',TASK]);}
    catch(_){
      // Ne pas effacer une demande qu'une tâche aurait déjà pu lire.
      throw Object.assign(new Error('Impossible de confirmer le lancement de la tâche Windows. Vérifie le PC avant de réessayer.'),{status:503});
    }
    return {queued:true,target};
  }
  return {check,status,request};
}
module.exports={createMobileUpdate,verifyUpdateKey,REPOSITORY,TASK};

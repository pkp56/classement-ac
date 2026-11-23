'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createMobileUpdate,verifyUpdateKey,REPOSITORY,TASK}=require('../tools/lib/mobile-update');
const old='a'.repeat(40),target='b'.repeat(40);
async function setup(t,overrides={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-update-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let state={branch:'main',origin:REPOSITORY,dirty:'',head:old,remote:target,taskFail:false,...overrides};const calls=[];
  const run=async(bin,args)=>{
    calls.push([bin,args]);
    if(bin==='schtasks.exe'){if(state.taskFail)throw Error('failed');return {stdout:'ok'};}
    const cmd=args.join(' ');
    if(cmd==='branch --show-current')return {stdout:state.branch};
    if(cmd==='remote get-url origin')return {stdout:state.origin};
    if(cmd==='status --porcelain')return {stdout:state.dirty};
    if(cmd==='rev-parse HEAD')return {stdout:state.head};
    if(cmd===`ls-remote --refs ${REPOSITORY} refs/heads/main`)return {stdout:state.remote+'\trefs/heads/main'};
    throw Error('Unexpected command '+cmd);
  };
  const api=createMobileUpdate({root,enabled:()=>state.enabled!==false,run,now:()=>Date.parse('2026-11-20T10:00:00Z')});
  return {api,state,calls,root};
}
test('scripts Windows : UTF-8 avec BOM pour les messages de Windows PowerShell 5',async()=>{
  for(const name of ['Run-GDSPMobileUpdate.ps1','Install-GDSPMobileUpdateTask.ps1']){
    const bytes=await fs.readFile(path.join(__dirname,'../tools/windows',name));
    assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf');
  }
});
test('agent Windows : la fusion refuse aussi les collisions avec les fichiers ignorés',async()=>{
  const script=await fs.readFile(path.join(__dirname,'../tools/windows/Run-GDSPMobileUpdate.ps1'),'utf8');
  assert.match(script, /'merge','--ff-only','--no-overwrite-ignore',\$target/);
  assert.match(script, /Git -arguments @\('branch','--show-current'\)/);
  assert.doesNotMatch(script, /\bGit @\(/);
  assert.match(script, /function Git \{[\s\S]*?\$ErrorActionPreference = 'Continue'[\s\S]*?\$LASTEXITCODE -ne 0/);
});
test('clé distincte : format aléatoire et vérification à temps constant',()=>{
  const key=crypto.randomBytes(32).toString('base64url');const hash=crypto.createHash('sha256').update(key).digest('hex');
  assert.ok(verifyUpdateKey(key,hash));assert.equal(verifyUpdateKey(key+'x',hash),false);assert.equal(verifyUpdateKey('mauvaise',hash),false);assert.equal(verifyUpdateKey(key,'x'.repeat(64)),false);
});
test('aperçu fixe : dépôt propre, origine et branche imposées',async t=>{
  const {api,state,calls}=await setup(t);assert.deepEqual(await api.check(),{current:old,target,available:true});
  state.dirty=' M .env.local';await assert.rejects(api.check(),/modifications locales/);state.dirty='';
  state.origin='http://127.0.0.1/';await assert.rejects(api.check(),/Origine Git/);state.origin=REPOSITORY;
  state.branch='experimental';await assert.rejects(api.check(),/sur main/);state.branch='main';state.enabled=false;
  await assert.rejects(api.check(),/désactivée/);assert.deepEqual(await api.status(),{enabled:false});
  assert.ok(calls.every(([bin])=>bin==='git'));
});
test('déclenchement : cible validée, une seule demande et tâche fixe',async t=>{
  const {api,state,calls,root}=await setup(t);
  await assert.rejects(api.request('HEAD; erase'),/Version invalide/);
  await assert.rejects(api.request('c'.repeat(40)),/version a changé/);
  assert.deepEqual(await api.request(target),{queued:true,target});
  const disk=JSON.parse(await fs.readFile(path.join(root,'data/mobile-updates/request.json'),'utf8'));
  assert.deepEqual(disk,{target,requestedAt:'2026-11-20T10:00:00.000Z'});
  assert.deepEqual(calls.at(-1),['schtasks.exe',['/Run','/TN',TASK]]);
  assert.equal((await api.status()).pending,true);
  await assert.rejects(api.request(target),/déjà en attente/);
  state.remote=old;await assert.rejects(api.request(target),/version a changé/);
});
test('demandes simultanées : un seul lancement de la tâche',async t=>{
  const {api,calls}=await setup(t);
  const results=await Promise.allSettled([api.request(target),api.request(target)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(calls.filter(([bin])=>bin==='schtasks.exe').length,1);
});
test('tâche non confirmée : la demande reste en attente pour éviter un double lancement',async t=>{
  const {api}=await setup(t,{taskFail:true});
  await assert.rejects(api.request(target),/Impossible de confirmer/);
  assert.equal((await api.status()).pending,true);
});

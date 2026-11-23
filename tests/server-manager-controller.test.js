'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {ServerController}=require('../tools/server-manager/controller');
const root='C:\\AC\\server';
function processFor(preset,pid){const dir=root+'\\presets\\'+preset;return {pid,creationTime:'2026-11-21T10:00:00Z',executablePath:root+'\\acServer.exe',commandLine:`"${root}\\acServer.exe" -c "${dir}\\server_cfg.ini" -e "${dir}\\entry_list.ini"`};}
function adapter(processes){return {list:async()=>processes,start:async x=>x,stopVerified:async x=>x};}
test('Démarre uniquement le préréglage explicitement confirmé',async()=>{
 const a=adapter([processFor('SERVER_00',10)]);let launched;a.start=async x=>{launched=x;};const controller=new ServerController(root,a);
 await assert.rejects(controller.start('local1','local1'),/déjà/);
 await assert.rejects(controller.start('local2','local1'),/Confirmation/);
 await controller.start('local2','local2');assert.equal(launched.args[1],root+'\\presets\\SERVER_01\\server_cfg.ini');assert.equal(launched.args[3],root+'\\presets\\SERVER_01\\entry_list.ini');
 await assert.rejects(controller.start('local2','local2'),/pas encore été vérifié/);
});
test('Arrêt cible seulement l’instance choisie et passe une empreinte à revérifier',async()=>{
 const a=adapter([processFor('SERVER_00',10),processFor('SERVER_01',20)]);let target;a.stopVerified=async x=>{target=x};
 await new ServerController(root,a).stop('local2','local2');assert.equal(target.pid,20);assert.match(target.commandHash,/^[a-f0-9]{64}$/);
});
test('Aucune opération quand la situation est ambiguë ou une autre opération est en cours',async()=>{
 const a=adapter([processFor('SERVER_00',10),processFor('SERVER_00',11)]);let called=false;a.start=async()=>{called=true};
 const c=new ServerController(root,a);await assert.rejects(c.start('local2','local2'),/ambiguë/);assert.equal(called,false);
 let release;const blocked={list:()=>new Promise(r=>{release=r}),start:async()=>{},stopVerified:async()=>{}};const d=new ServerController(root,blocked);
 const first=d.start('local1','local1');await assert.rejects(d.start('local2','local2'),/déjà en cours/);release([]);await first;
});

test('Un lancement en attente survit à la reconstruction du contrôleur et bloque une répétition',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-pending-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const pending=require('../tools/server-manager/pending-store').store(dir),processes=[],a=adapter(processes);
 await new ServerController(root,a,pending).start('local1','local1');
 assert.equal(await pending.has('local1'),true);
 await assert.rejects(new ServerController(root,a,pending).start('local1','local1'),/pas encore été vérifié/);
 processes.push(processFor('SERVER_00',10));
 await new ServerController(root,a,pending).snapshot();assert.equal(await pending.has('local1'),false);
 await fs.mkdir(path.join(dir,'local2.pending'));
 await assert.rejects(new ServerController(root,a,pending).start('local2','local2'),/restauration/);
});

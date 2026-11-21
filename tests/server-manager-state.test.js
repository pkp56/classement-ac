'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readProcessState}=require('../tools/server-manager/process-state');
const root='C:\\AC\\server';
const p={pid:5,executablePath:root+'\\acServer.exe',creationTime:'2026-11-21T10:00:00Z',commandLine:'"C:\\AC\\server\\acServer.exe" -c "C:\\AC\\server\\presets\\SERVER_00\\server_cfg.ini" -e "C:\\AC\\server\\presets\\SERVER_00\\entry_list.ini"'};
test('État Windows sans exposer chemin, ligne de commande ou PID',async()=>{
 let args;const state=await readProcessState(root,{platform:'win32',run:async(...a)=>{args=a;return {stdout:JSON.stringify([p])}}});
 assert.deepEqual(state,{available:true,servers:{local1:'running',local2:'stopped'}});
 assert.doesNotMatch(JSON.stringify(state),/AC\\\\server|pid|commandLine/);
 assert.equal(args[0],'powershell.exe');assert.ok(!args[1].some(x=>x.includes(root)));
});
test('État inconnu, erreurs et plateforme non prise en charge bloquent les actions',async()=>{
 assert.equal((await readProcessState(root,{platform:'linux'})).available,false);
 assert.equal((await readProcessState(root,{platform:'win32',run:async()=>({stdout:'invalid'})})).available,false);
 assert.equal((await readProcessState(root,{platform:'win32',run:async()=>({stdout:JSON.stringify([{...p,commandLine:null}])})})).available,false);
 assert.equal((await readProcessState(root,{platform:'win32',run:async()=>{throw Error('secret')}})).available,false);
});

test('L’écriture est refusée si CM est ouvert, si le serveur tourne ou si la vérification échoue',async()=>{
 const {canEdit}=require('../tools/server-manager/windows-safety');
 const state=async()=>({available:true,servers:{local1:'stopped',local2:'running'}});
 const closed=async()=>({stdout:'CLOSED\n'}),open=async()=>({stdout:'OPEN\n'}),fail=async()=>{throw Error('échec')};
 assert.equal(await canEdit('C:\\AC\\server','local1',{platform:'win32',state,run:closed}),true);
 assert.equal(await canEdit('C:\\AC\\server','local2',{platform:'win32',state,run:closed}),false);
 assert.equal(await canEdit('C:\\AC\\server','local1',{platform:'win32',state,run:open}),false);
 assert.equal(await canEdit('C:\\AC\\server','local1',{platform:'win32',state,run:fail}),false);
 assert.equal(await canEdit('C:\\AC\\server','local1',{platform:'linux',state,run:closed}),false);
});

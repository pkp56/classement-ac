'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createWindowsAdapter}=require('../tools/server-manager/windows-adapter');
test('Adaptateur Windows utilise une commande fixe et transporte l’identité sans interpolation',async()=>{
 const calls=[],run=async(...args)=>{calls.push(args);return {stdout:calls.length===1?'[]':'STOP_REQUESTED\n'};};
 const a=createWindowsAdapter({platform:'win32',run});assert.deepEqual(await a.list(),[]);
 await a.stopVerified({pid:123,creationTime:'date',executablePath:'C:\\AC\\acServer.exe',commandHash:'a'.repeat(64)});
 const [exe,args,opts]=calls[1];assert.equal(exe,'powershell.exe');assert.equal(args[args.length-2],'-Command');assert.doesNotMatch(args.at(-1),/C:\\AC/);
 assert.equal(JSON.parse(Buffer.from(opts.env.GDSP_STOP_IDENTITY,'base64')).pid,123);
 assert.match(args.at(-1),/\$deltaTicks -gt 9/);assert.match(args.at(-1),/\$cimDate -ne \$pdata\.creationTime/);
 assert.match(args.at(-1),/TerminateProcess\(\$handle, 0\)/);
 await assert.rejects(a.stopVerified({pid:0}),/Identité invalide/);
});
test('Démarrage sans shell et refus hors Windows',async()=>{
 let received;const launch=(...args)=>{received=args;const p=new EventEmitter();p.unref=()=>{};process.nextTick(()=>p.emit('spawn'));return p;};
 const a=createWindowsAdapter({platform:'win32',launch});await a.start({exe:'acServer.exe',args:['-c','one','-e','two'],cwd:'C:\\AC'});
 assert.equal(received[2].shell,false);assert.equal(received[2].detached,true);
 await assert.rejects(createWindowsAdapter({platform:'linux'}).list(),/Windows/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {readWelcome}=require('../tools/server-manager/welcome-store');
test('Refuse chemin externe, fichier lié et versions CM et serveur différentes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-welcome-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'presets','SERVER_00'),cfg=path.join(root,'cfg');await fs.mkdir(dir,{recursive:true});await fs.mkdir(cfg);
 const local=path.join(dir,'cm_welcome.txt'),live=path.join(cfg,'welcome_SERVER_00.txt');await fs.writeFile(local,'hello');await fs.writeFile(live,'different');
 const config='[SERVER]\nWELCOME_MESSAGE=cfg/welcome_SERVER_00.txt\n[DATA]\nWELCOME_PATH=presets/SERVER_00/cm_welcome.txt\n';
 await assert.rejects(readWelcome(root,'local1',config),/diffèrent/);
 await fs.writeFile(live,'hello');assert.equal((await readWelcome(root,'local1',config)).decoded.message,'hello');
 await assert.rejects(readWelcome(root,'local1',config.replace('presets/SERVER_00/cm_welcome.txt','../../other')),/non pris en charge/);
 await fs.unlink(local);try{await fs.symlink(live,local);await assert.rejects(readWelcome(root,'local1',config),/non sûr/);}catch(e){if(e.code!=='EPERM')throw e;}
});

test('Retour navigateur normalisé conserve exactement les octets du message CSP',()=>{
 const {encodeWelcome}=require('../tools/server-manager/csp-welcome');const {prepareWelcome}=require('../tools/server-manager/welcome-store');
 const csp='[SCRIPT_2]\r\nSCRIPT=https://example.org/telemetry.lua\r\n',local=encodeWelcome('Bonjour',csp);
 const old={revision:'rev',local,decoded:{message:'Bonjour',config:csp}};
 assert.equal(prepareWelcome(old,'rev',csp.replace(/\r\n/g,'\n')),local);
 assert.notEqual(prepareWelcome(old,'rev',csp.replace('telemetry','autre')),local);
});

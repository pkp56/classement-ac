'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {save}=require('../tools/server-manager/save');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-save-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'server'),contentRoot=path.join(base,'content'),backupRoot=path.join(base,'private'),publicRoot=path.join(base,'public'),dir=path.join(root,'presets','SERVER_00');
 await fs.mkdir(dir,{recursive:true});await fs.mkdir(contentRoot);await fs.mkdir(backupRoot);await fs.mkdir(publicRoot);
 const config='[SERVER]\nTRACK=sugo\nCONFIG_TRACK=\nCARS=car_a;car_b\nMAX_CLIENTS=1\nUDP_PORT=9600\nPASSWORD=secret\n',entry='[CAR_0]\nMODEL=car_a\nSKIN=blue\nGUID=secret-guid\n';
 await fs.writeFile(path.join(dir,'server_cfg.ini'),config);await fs.writeFile(path.join(dir,'entry_list.ini'),entry);
 const args={root,contentRoot,backupRoot,publicRoot,id:'local1',confirmation:'local1',configRevision:hash(config),entryRevision:hash(entry),configChanges:[{section:'SERVER',key:'TRACK',value:'monza'}],entryChanges:[{id:0,model:'car_b',skin:'red'}]};
 const opts={checkState:async()=>true,loadInventory:async()=>({tracks:[{id:'monza',layouts:[]}],cars:[{id:'car_a',skins:['blue']},{id:'car_b',skins:['red']}]})};return {args,opts,config,entry,dir};
}
test('Sauvegarde les originaux avant modification ciblée et conserve les secrets et ports',async t=>{
 const f=await fixture(t),r=await save(f.args,f.opts);assert.equal(r.backupCreated,true);assert.doesNotMatch(JSON.stringify(r),/secret|9600/);
 const saved=await fs.readdir(f.args.backupRoot);assert.equal(saved.length,1);assert.equal(await fs.readFile(path.join(f.args.backupRoot,saved[0],'server_cfg.ini'),'utf8'),f.config);assert.equal(await fs.readFile(path.join(f.args.backupRoot,saved[0],'entry_list.ini'),'utf8'),f.entry);
 assert.match(await fs.readFile(path.join(f.dir,'server_cfg.ini'),'utf8'),/TRACK=monza[\s\S]*UDP_PORT=9600[\s\S]*PASSWORD=secret/);assert.match(await fs.readFile(path.join(f.dir,'entry_list.ini'),'utf8'),/MODEL=car_b[\s\S]*GUID=secret-guid/);
});
test('Refuse serveur actif, révision périmée et reprise non résolue sans rien modifier',async t=>{
 const f=await fixture(t);await assert.rejects(save(f.args,{...f.opts,checkState:async()=>false}),/arrête/);
 await assert.rejects(save({...f.args,entryRevision:'wrong'},f.opts),/changé/);
 await fs.mkdir(path.join(f.args.backupRoot,'local1.pending'));await assert.rejects(save(f.args,f.opts),/restauration manuelle/);
 assert.equal(await fs.readFile(path.join(f.dir,'server_cfg.ini'),'utf8'),f.config);assert.equal(await fs.readFile(path.join(f.dir,'entry_list.ini'),'utf8'),f.entry);
});
test('Refuse un changement externe avant le remplacement et ne détruit pas ce changement',async t=>{
 const f=await fixture(t);let count=0;
 await assert.rejects(save(f.args,{...f.opts,checkState:async()=>{if(++count===2){await fs.writeFile(path.join(f.dir,'entry_list.ini'),f.entry+'; externe\n');}return true;}}),/fichiers ont changé/);
 assert.match(await fs.readFile(path.join(f.dir,'entry_list.ini'),'utf8'),/externe/);
});

test('Préserve le BOM UTF-8 et les retours Windows dans la sauvegarde et les fichiers',async t=>{
 const f=await fixture(t),config='\uFEFF'+f.config.replace(/\n/g,'\r\n'),entry='\uFEFF'+f.entry.replace(/\n/g,'\r\n');
 await fs.writeFile(path.join(f.dir,'server_cfg.ini'),config);await fs.writeFile(path.join(f.dir,'entry_list.ini'),entry);
 await save({...f.args,configRevision:hash(config),entryRevision:hash(entry)},f.opts);
 const saved=await fs.readFile(path.join(f.dir,'server_cfg.ini'),'utf8');assert.ok(saved.startsWith('\uFEFF'));assert.ok(saved.includes('TRACK=monza\r\n'));
 const backup=(await fs.readdir(f.args.backupRoot))[0];assert.equal(await fs.readFile(path.join(f.args.backupRoot,backup,'server_cfg.ini'),'utf8'),config);
});

test('Sauvegarde et applique ensemble nouvelle place et météo sans modifier le second serveur',async t=>{
 const f=await fixture(t),config=f.config+'[WEATHER_0]\nGRAPHICS=clear\n';
 await fs.writeFile(path.join(f.dir,'server_cfg.ini'),config);
 const second=path.join(f.args.root,'presets','SERVER_01');await fs.mkdir(second,{recursive:true});await fs.writeFile(path.join(second,'server_cfg.ini'),'[SERVER]\nPASSWORD=other\n');
 const args={...f.args,configRevision:hash(config),configChanges:[{section:'SERVER',key:'MAX_CLIENTS',value:'2'}],entryChanges:[{id:1,operation:'add',model:'car_b',skin:'red'}],weatherChanges:[{operation:'add',id:1,graphics:'3_clear'}]};
 const r=await save(args,f.opts);assert.equal(r.plan.slotChanges[0].after.model,'car_b');assert.equal(r.plan.weatherChanges[0].after.GRAPHICS,'3_clear');
 assert.match(await fs.readFile(path.join(f.dir,'server_cfg.ini'),'utf8'),/MAX_CLIENTS=2[\s\S]+\[WEATHER_1\]/);
 assert.match(await fs.readFile(path.join(f.dir,'entry_list.ini'),'utf8'),/\[CAR_1\]\nMODEL=car_b/);
 assert.equal(await fs.readFile(path.join(second,'server_cfg.ini'),'utf8'),'[SERVER]\nPASSWORD=other\n');
});

test('Édite les Extra options CSP dans les deux messages, protège le texte et sauvegarde l’original',async t=>{
 const f=await fixture(t),{encodeWelcome,decodeWelcome}=require('../tools/server-manager/csp-welcome'),{readWelcome}=require('../tools/server-manager/welcome-store');
 const config=f.config+'WELCOME_MESSAGE=cfg/welcome_SERVER_00.txt\n[DATA]\nWELCOME_PATH=presets/SERVER_00/cm_welcome.txt\n';
 const content=encodeWelcome('Bienvenue pilote','[SCRIPT_1]\nSCRIPT=https://example.org/rolling.lua\n[SCRIPT_2]\nSCRIPT=https://example.org/telemetry.lua\n');
 await fs.writeFile(path.join(f.dir,'server_cfg.ini'),config);await fs.writeFile(path.join(f.dir,'cm_welcome.txt'),content);await fs.mkdir(path.join(f.args.root,'cfg'));await fs.writeFile(path.join(f.args.root,'cfg','welcome_SERVER_00.txt'),content);
 const old=await readWelcome(f.args.root,'local1',config),csp=old.decoded.config+'REQUIRED=0\n';
 const args={...f.args,configRevision:hash(config),configChanges:[],entryChanges:[],cspConfig:csp,welcomeRevision:old.revision};
 const result=await save(args,f.opts);assert.equal(result.plan.cspChanged,true);assert.doesNotMatch(JSON.stringify(result),/Bienvenue|telemetry/);
 const local=await fs.readFile(path.join(f.dir,'cm_welcome.txt'),'utf8'),live=await fs.readFile(path.join(f.args.root,'cfg','welcome_SERVER_00.txt'),'utf8');
 assert.equal(local,live);assert.deepEqual(decodeWelcome(local),{message:'Bienvenue pilote',config:csp});
 const backup=(await fs.readdir(f.args.backupRoot))[0];assert.equal(await fs.readFile(path.join(f.args.backupRoot,backup,'cm_welcome.txt'),'utf8'),content);
 await assert.rejects(save(args,f.opts),/message CSP a changé/);
});

test('Active une course CM et change sa limite en préservant les réglages internes',async t=>{
 const f=await fixture(t),config=f.config+'[__CM_RACE_OFF]\nLAPS=10\nTIME=0\n__CM_TIME_OFF=30\nWAIT_TIME=40\n';
 await fs.writeFile(path.join(f.dir,'server_cfg.ini'),config);
 const r=await save({...f.args,configRevision:hash(config),configChanges:[{section:'RACE',key:'ENABLED',value:'1'}],entryChanges:[],raceMode:{mode:'time',value:'30'}},f.opts);
 assert.equal(r.plan.raceChange.mode,'time');const written=await fs.readFile(path.join(f.dir,'server_cfg.ini'),'utf8');
 assert.match(written,/\[RACE\]\nLAPS=0\nTIME=30\nWAIT_TIME=40\n__CM_LAPS_OFF=10/);
});

test('Interruption après un remplacement : conserve sauvegarde et bloque la suite',async t=>{
 const f=await fixture(t);let count=0;
 await assert.rejects(save(f.args,{...f.opts,replace:async(a,b)=>{if(++count===2)throw Error('échec simulé');await fs.rename(a,b);}}),e=>e.code==='RECOVERY_REQUIRED');
 const names=await fs.readdir(f.args.backupRoot);assert.ok(names.includes('local1.pending'));
 const backup=(await fs.readFile(path.join(f.args.backupRoot,'local1.pending','backup.txt'),'utf8')).trim();
 assert.equal(await fs.readFile(path.join(f.args.backupRoot,backup,'server_cfg.ini'),'utf8'),f.config);assert.equal(await fs.readFile(path.join(f.args.backupRoot,backup,'entry_list.ini'),'utf8'),f.entry);
 await assert.rejects(save(f.args,f.opts),/restauration manuelle/);
});

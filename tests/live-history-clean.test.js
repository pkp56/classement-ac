'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {emptyArchive}=require('../tools/live-timing/clean-empty-history');
function row(id){return {id, snapshot:{storedTimes:[],cars:[],bestLaps:[],events:[],collisions:[]},classification:[],best_laps:[],events:[]};}
test('Nettoyage : seules les archives explicitement vides sont reconnues',()=>{
 assert.equal(emptyArchive(row(1)),true);
 for(const [field,value] of [['storedTimes',[{laps:1}]],['cars',[{laps:1}]],['events',[{kind:'lap'}]],['collisions',[{}]]]){const r=row(1);r.snapshot[field]=value;assert.equal(emptyArchive(r),false);}
 for(const field of ['classification','best_laps','events']){const r=row(1);r[field]=[{}];assert.equal(emptyArchive(r),false);}
 const old=row(1);delete old.snapshot.storedTimes;assert.equal(emptyArchive(old),false);
 const uncertain=row(1);uncertain.classification=null;assert.equal(emptyArchive(uncertain),false);
});
test('Aperçu sans écriture puis sauvegarde complète et suppression sélective du fichier',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-clean-'));try{
 const file=path.join(dir,'history.json'),backup=path.join(dir,'backup');const good=row(2);good.snapshot.storedTimes=[{name:'A',laps:1,bestLapMs:90000}];good.classification=[{laps:1}];const old=row(3);delete old.snapshot.storedTimes;
 const original=JSON.stringify([row(1),good,old]);fs.writeFileSync(file,original);
 const env={...process.env,LIVE_HISTORY_FILE:file,GDSP_LIVE_CLEAN_BACKUP_DIR:backup,DATABASE_URL:'',LIVE_DATABASE_URL:''};
 const script=path.join(__dirname,'../tools/live-timing/clean-empty-history.js');
 let result=spawnSync(process.execPath,[script],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(file,'utf8'),original);assert.match(result.stdout,/explicitement vides : 1/);
 result=spawnSync(process.execPath,[script,'--apply'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(file)),[good,old]);assert.equal(fs.readFileSync(path.join(backup,fs.readdirSync(backup)[0]),'utf8'),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

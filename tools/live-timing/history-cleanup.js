'use strict';
// Les formats incomplets et les séances sans fin connue ne sont pas supprimés.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {FileLiveHistory,PgLiveHistory}=require('./history');
function noTime(row){
  if(!row || typeof row!=='object' || Array.isArray(row))return false;
  if(typeof row.laps!=='number' || row.laps!==0)return false;
  for(const k of ['bestLapMs','lastLapMs','averageLapMs','totalMs','bestLap','lastLap','averageLap','total']){
    const v=row[k];if(v!=null && v!=='' && v!==0 && v!=='—')return false;
  }
  return true;
}
function noLapArchive(row){
  const s=row && row.snapshot;
  if(!row || !row.ended_at || !s || typeof s!=='object' || Array.isArray(s))return false;
  if(!Array.isArray(s.cars) || !Array.isArray(row.classification) || !Array.isArray(row.best_laps) || row.best_laps.length)return false;
  if(s.storedTimes!=null && (!Array.isArray(s.storedTimes) || s.storedTimes.length))return false;
  if(!s.cars.every(noTime) || !row.classification.every(noTime))return false;
  if(s.bestLaps!=null && (!Array.isArray(s.bestLaps)||s.bestLaps.length))return false;
  for(const list of [s.events,row.events]){
    if(!Array.isArray(list) || list.some(e=>!e || typeof e.kind!=='string' || e.kind==='lap'))return false;
  }
  return true;
}
function fingerprint(row){return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');}
function publicRow(row){return {id:String(row.id),fingerprint:fingerprint(row),started_at:row.started_at,server_name:row.server_name,track:row.track,session_type:row.session_type,source:row.snapshot?.archiveSource||null};}
function backupDirectory(root,siteRoot){
  if(!root || !path.isAbsolute(root))throw new Error('Dossier de sauvegarde privé non configuré (GDSP_AC_BACKUP_ROOT).');
  const real=fs.realpathSync(root),site=fs.realpathSync(siteRoot);
  const rel=path.relative(site,real);
  if(!rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)))throw new Error('Le dossier de sauvegarde doit être hors du site.');
  if(!fs.statSync(real).isDirectory())throw new Error('Dossier de sauvegarde invalide.');
  return real;
}
function backup(rows,dir){
  const filename='live-archives-supprimees-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+'.json';
  fs.writeFileSync(path.join(dir,filename),JSON.stringify(rows,null,2),{flag:'wx',mode:0o600});return filename;
}
function validateSelection(rows,selection){
  if(!Array.isArray(selection)||selection.length<1||selection.length>500)throw new Error('Sélection invalide.');
  const map=new Map(rows.map(r=>[String(r.id),r])),seen=new Set();
  return selection.map(item=>{
    if(!item || typeof item.id!=='string' || !/^\d+$/.test(item.id) || typeof item.fingerprint!=='string' || seen.has(item.id))throw new Error('Sélection invalide.');
    seen.add(item.id);const row=map.get(item.id);
    if(!row || !noLapArchive(row) || fingerprint(row)!==item.fingerprint)throw new Error('Une archive a changé ou ne peut plus être supprimée. Actualise l’aperçu.');
    return row;
  });
}
async function listRows(store,client){
  if(store instanceof FileLiveHistory)return store.rows.slice();
  if(store instanceof PgLiveHistory)return (await (client||store.pool).query('SELECT * FROM gdsp_live_sessions ORDER BY id')).rows;
  throw new Error('Stockage historique inconnu.');
}
async function preview(store){const rows=(await listRows(store)).filter(noLapArchive);return {count:rows.length,items:rows.slice(0,500).map(publicRow)};}
async function remove(store,selection,backupRoot,siteRoot){
  const dir=backupDirectory(backupRoot,siteRoot);
  if(store instanceof FileLiveHistory){
    const selected=validateSelection(store.rows,selection), ids=new Set(selected.map(r=>String(r.id)));
    const filename=backup(selected,dir), previous=store.rows;
    store.rows=previous.filter(r=>!ids.has(String(r.id)));
    try{store._persist();}catch(e){store.rows=previous;throw e;}
    store.byId=new Map(store.rows.map(r=>[r.id,r]));
    return {deleted:selected.length,backup:filename};
  }
  if(store instanceof PgLiveHistory){
    const client=await store.pool.connect();
    try{
      await client.query('BEGIN');await client.query('LOCK TABLE gdsp_live_sessions IN ACCESS EXCLUSIVE MODE');
      const selected=validateSelection(await listRows(store,client),selection);
      const filename=backup(selected,dir);
      const result=await client.query('DELETE FROM gdsp_live_sessions WHERE id=ANY($1::bigint[])',[selected.map(r=>String(r.id))]);
      if(result.rowCount!==selected.length)throw new Error('Nombre de suppressions inattendu.');
      await client.query('COMMIT');return {deleted:result.rowCount,backup:filename};
    }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
  }
  throw new Error('Stockage historique inconnu.');
}
module.exports={noLapArchive,preview,remove};

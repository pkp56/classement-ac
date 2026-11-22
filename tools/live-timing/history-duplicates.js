'use strict';
// Doublons PROBABLES uniquement : fenêtres closes contiguës de moins de 30 s,
// même source et mêmes données de résultat complètes. Jamais sur l'heure seule.
const {FileLiveHistory,PgLiveHistory}=require('./history');
const {fingerprint,backupDirectory,backup,listRows}=require('./history-cleanup');
function stable(v){if(Array.isArray(v))return v.map(stable);if(v && typeof v==='object' && !(v instanceof Date))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v;}
function time(v){if(!v)return NaN;return new Date(v).getTime();}
function signature(r){
 const s=r?.snapshot, session=s?.session, src=s?.archiveSource;
 if(!r || !s || !session || !['local1','local2'].includes(src) || !r.server_name || !r.track || !r.session_type || session.index==null || !r.ended_at)return null;
 const a=time(r.started_at),b=time(r.ended_at),seen=time(r.last_seen_at);
 if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(seen)||b<a||b-a>30000||seen>b+1000||seen<a)return null;
 if(!Array.isArray(s.storedTimes)||!s.storedTimes.length || !Array.isArray(s.cars)||s.cars.length || !Array.isArray(r.classification)||!r.classification.length) return null;
 for(const list of [s.events,s.collisions,s.bestLaps,r.events,r.best_laps])if(!Array.isArray(list)||list.length)return null;
 if(s.storedTimes.some(x=>!x || !x.name || !x.model || !Number.isFinite(x.laps) || x.laps<1 || !(x.bestLapMs>0 || x.lastLapMs>0)))return null;
 const {status,updatedAt,serverTimeMs,...snap}=s;
 const {elapsed,elapsedMs,remaining,remainingMs,...stableSession}=session;
 const content={source:src,server:r.server_name,track:r.track,layout:r.track_config||'',type:r.session_type,snapshot:{...snap,session:stableSession},processStart:status?.startedAt||null,classification:r.classification,drivers:r.drivers};
 return JSON.stringify(stable(content));
}
function findGroups(rows){
 const sorted=rows.slice().sort((a,b)=>time(a.started_at)-time(b.started_at));
 const groups=[];let group=[];let key=null;
 function finish(){if(group.length>=2)groups.push(group);group=[];key=null;}
 for(const r of sorted){
  const k=signature(r),prev=group[group.length-1];
  if(!k){finish();continue;}
  if(!prev||k!==key||Math.abs(time(prev.ended_at)-time(r.started_at))>1000){finish();group=[r];key=k;}
  else group.push(r);
 }
 finish();return groups;
}
function describe(group){return {keep:{id:String(group[0].id),fingerprint:fingerprint(group[0])},remove:group.slice(1).map(r=>({id:String(r.id),fingerprint:fingerprint(r)})),started_at:group[0].started_at,ended_at:group.at(-1).ended_at,source:group[0].snapshot.archiveSource,server_name:group[0].server_name,track:group[0].track,track_config:group[0].track_config,session_type:group[0].session_type};}
async function preview(store){const groups=[];let count=0;for(const group of findGroups(await listRows(store))){if(group.length>501 || groups.length>=100 || count+group.length-1>500)continue;groups.push(describe(group));count+=group.length-1;}return {groups,count};}
function validate(rows,selection){
 if(!Array.isArray(selection)||!selection.length||selection.length>100 || selection.reduce((n,g)=>n+(Array.isArray(g?.remove)?g.remove.length:501),0)>500)throw Error('Sélection invalide.');
 const current=findGroups(rows).map(describe),selected=[],seen=new Set();
 for(const wanted of selection){
  if(!wanted?.keep || !Array.isArray(wanted.remove)||!wanted.remove.length)throw Error('Sélection invalide.');
  const match=current.find(g=>JSON.stringify(g.keep)===JSON.stringify(wanted.keep) && JSON.stringify(g.remove)===JSON.stringify(wanted.remove));
  if(!match)throw Error('Les archives ont changé ou ne sont plus des doublons probables. Actualise l’aperçu.');
  for(const item of [match.keep,...match.remove]){if(!/^\d+$/.test(item.id)||seen.has(item.id))throw Error('Sélection invalide.');seen.add(item.id);}
  selected.push(match);
 }
 const keepIds=new Set(selected.map(g=>g.keep.id)),deleteIds=new Set(selected.flatMap(g=>g.remove.map(r=>r.id)));
 return {saved:rows.filter(r=>keepIds.has(String(r.id))||deleteIds.has(String(r.id))),deleteIds};
}
async function remove(store,selection,backupRoot,siteRoot){
 const dir=backupDirectory(backupRoot,siteRoot);
 if(store instanceof FileLiveHistory){
  const {saved,deleteIds}=validate(store.rows,selection),filename=backup(saved,dir),previous=store.rows;
  store.rows=previous.filter(r=>!deleteIds.has(String(r.id)));
  try{store._persist();}catch(e){store.rows=previous;throw e;}
  store.byId=new Map(store.rows.map(r=>[r.id,r]));return {deleted:deleteIds.size,backup:filename};
 }
 if(store instanceof PgLiveHistory){
  const client=await store.pool.connect();
  try{await client.query('BEGIN');await client.query('LOCK TABLE gdsp_live_sessions IN ACCESS EXCLUSIVE MODE');
   const {saved,deleteIds}=validate(await listRows(store,client),selection),filename=backup(saved,dir);
   const result=await client.query('DELETE FROM gdsp_live_sessions WHERE id=ANY($1::bigint[])',[[...deleteIds]]);
   if(result.rowCount!==deleteIds.size)throw Error('Nombre de suppressions inattendu.');
   await client.query('COMMIT');return {deleted:result.rowCount,backup:filename};
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
 }
 throw Error('Stockage historique inconnu.');
}
module.exports={findGroups,preview,remove,signature};

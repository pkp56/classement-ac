'use strict';
// Mise à jour ciblée selon le format de ServerRaceSessionEntry.Save de CM.
function patchRaceMode(text,change){
 if(!change||!['time','laps'].includes(change.mode)||typeof change.value!=='string')throw Error('Mode de course invalide');
 const value=change.value;
 if(!/^\d+(?:\.\d+)?$/.test(value)||Number(value)<=0||(change.mode==='laps'&&(!/^\d+$/.test(value)||Number(value)>1000))||(change.mode==='time'&&Number(value)>1440))throw Error('Limite de course invalide');
 const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);let start=-1,end=lines.length,found=0;
 for(let i=0;i<lines.length;i++){
  const h=lines[i].match(/^\uFEFF?\s*\[([^\]]+)\]/);if(!h)continue;
  const s=h[1].trim().toUpperCase();
  if(s==='RACE'||s==='__CM_RACE_OFF'){found++;start=i;end=lines.length;}
  else if(start>=0&&end===lines.length)end=i;
 }
 if(found!==1)throw Error('Session de course absente ou ambiguë');
 const fields=new Map();
 for(let i=start+1;i<end;i++){
  const m=lines[i].match(/^(\s*([^=;#]+?)\s*=)([^\r\n]*)(\r\n|\n|\r)?$/);if(!m)continue;
  const k=m[2].trim().toUpperCase();if(!['LAPS','TIME','__CM_LAPS_OFF','__CM_TIME_OFF'].includes(k))continue;
  if(fields.has(k))throw Error('Mode de course ambigu');fields.set(k,{i,prefix:m[1],value:m[3].trim(),ending:m[4]||''});
 }
 const laps=fields.get('LAPS'),time=fields.get('TIME');
 if(!laps||!time||!/^\d+$/.test(laps.value)||!/^\d+(?:\.\d+)?$/.test(time.value))throw Error('Mode de course ambigu');
 const mode=Number(laps.value)===0?'time':'laps';
 if(mode===change.mode){
  const field=mode==='time'?time:laps;
  if(Number(field.value)===Number(value))return text;
  lines[field.i]=field.prefix+value+field.ending;return lines.join('');
 }
 const keep=change.mode==='time'?'__CM_LAPS_OFF':'__CM_TIME_OFF',remove=change.mode==='time'?'__CM_TIME_OFF':'__CM_LAPS_OFF';
 const stored=change.mode==='time'?(mode==='laps'?laps.value:(fields.get(keep)?.value||'5')):(mode==='time'?time.value:(fields.get(keep)?.value||'10'));
 if(!/^\d+(?:\.\d+)?$/.test(stored))throw Error('Valeur de course CM ambiguë');
 const updates={LAPS:change.mode==='time'?'0':value,TIME:change.mode==='time'?value:'0',[keep]:stored};
 for(const [key,v] of Object.entries(updates)){
  const f=fields.get(key);if(f)lines[f.i]=f.prefix+v+f.ending;
 }
 const removeIndex=fields.get(remove)?.i;
 const nl=text.includes('\r\n')?'\r\n':'\n';
 if(!fields.has(keep)){
  if(end>0&&!/[\r\n]$/.test(lines[end-1]))lines[end-1]+=nl;
  lines.splice(end,0,`${keep}=${stored}${nl}`);
 }
 if(removeIndex!==undefined)lines.splice(removeIndex,1);
 return lines.join('');
}
module.exports={patchRaceMode};

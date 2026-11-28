'use strict';
// Lecture locale conservatrice et copie de test en mémoire, sans accès au serveur.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GDSPRacePreview=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 function inspect(text, minutes){
  if(typeof text!=='string'||!text.length||text.length>1048576||text.includes('\0'))throw Error('Fichier INI vide, trop volumineux ou invalide.');
  const value=String(minutes).trim();if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1440)throw Error('Durée : saisir un nombre entier entre 1 et 1440 minutes.');
  const sections=new Map(), entries=new Map();let section='';
  for(const line of text.split(/\r\n|\n|\r/)){
   const header=line.match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
   if(header){section=header[1].trim().toUpperCase();sections.set(section,(sections.get(section)||0)+1);continue;}
   const field=line.match(/^\s*([^=;#]+?)\s*=([^\r\n]*)$/);if(!field)continue;
   const key=field[1].trim().toUpperCase();if(!['LAPS','TIME','REVERSED_GRID_RACE_POSITIONS','TRACK','CONFIG_TRACK'].includes(key))continue;
   const id=section+'\0'+key;const list=entries.get(id)||[];list.push(field[2].trim());entries.set(id,list);
  }
  if(sections.get('SERVER')!==1||sections.get('RACE')!==1||sections.has('__CM_RACE_OFF'))throw Error('Sections SERVER ou RACE absentes, désactivées ou ambiguës.');
  function get(section,key,required=false){const a=entries.get(section+'\0'+key)||[];if(a.length>1||required&&a.length!==1)throw Error('Paramètre manquant ou ambigu : '+section+'.'+key);return a[0]??null;}
  const laps=get('RACE','LAPS',true),time=get('RACE','TIME',true);
  if(laps!=='0'||!/^\d+$/.test(time)||Number(time)<1||Number(time)>1440)throw Error('Seule une course active au temps, avec LAPS=0 et durée entière, est prise en charge.');
  const reverse=get('SERVER','REVERSED_GRID_RACE_POSITIONS');
  if(reverse!==null&&!/^(?:-1|\d+)$/.test(reverse))throw Error('Réglage de course inversée natif ambigu.');
  const track=get('SERVER','TRACK'),layout=get('SERVER','CONFIG_TRACK');
  for(const s of ['BOOK','PRACTICE','QUALIFY']) if((sections.get(s)||0)>1||(sections.get('__CM_'+s+'_OFF')||0)>1||(sections.has(s)&&sections.has('__CM_'+s+'_OFF')))throw Error('Session ambiguë : '+s);
  const active=['BOOK','PRACTICE','QUALIFY'].filter(s=>sections.has(s));
  return {type:'gdsp-race2-preview-v1',beforeMinutes:Number(time),afterMinutes:Number(value),track:track&&/^[a-zA-Z0-9_\/-]{1,150}$/.test(track)?track:null,layout:layout&&/^[a-zA-Z0-9_-]{1,120}$/.test(layout)?layout:null,otherActiveSessions:active,nativeReverse:reverse,changed:Number(time)!==Number(value)};
 }
 function createCopy(text,minutes){
  const plan=inspect(text,minutes);
  const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const nl=text.match(/\r\n|\n|\r/)?.[0]||'\n';let section='',serverHeader=-1,timeChanged=0,reverseChanged=0;
  for(let i=0;i<lines.length;i++){
   const body=lines[i].replace(/(?:\r\n|\n|\r)$/,'');const ending=lines[i].slice(body.length);
   const header=body.match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
   if(header){section=header[1].trim().toUpperCase();if(section==='SERVER')serverHeader=i;continue;}
   const field=body.match(/^(\s*([^=;#]+?)\s*=)([^\r\n]*)$/);if(!field)continue;
   const key=field[2].trim().toUpperCase();
   if(section==='RACE'&&key==='TIME'){lines[i]=field[1]+String(plan.afterMinutes)+ending;timeChanged++;}
   if(section==='SERVER'&&key==='REVERSED_GRID_RACE_POSITIONS'){lines[i]=field[1]+'0'+ending;reverseChanged++;}
  }
  if(timeChanged!==1||serverHeader<0||reverseChanged>1)throw Error('Modification ambiguë, copie non créée.');
  if(!reverseChanged){
   if(!/(?:\r\n|\n|\r)$/.test(lines[serverHeader]))lines[serverHeader]+=nl;
   lines.splice(serverHeader+1,0,'REVERSED_GRID_RACE_POSITIONS=0'+nl);
  }
  const result=lines.join('');const verified=inspect(result,minutes);
  if(verified.beforeMinutes!==plan.afterMinutes||verified.nativeReverse!=='0')throw Error('Vérification de la copie échouée.');
  return {text:result,plan};
 }
 return {inspect,createCopy};
});

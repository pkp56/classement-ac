'use strict';
// Primitives en mémoire uniquement : aucune lecture ou écriture disque.
// Une liste blanche empêche notamment la modification des ports, secrets et
// données internes Content Manager. Ces fonctions ne sont reliées à aucune API.
const ALLOWED = Object.freeze({
  SERVER: new Set(['NAME','TRACK','CONFIG_TRACK','CARS','MAX_CLIENTS','PICKUP_MODE_ENABLED','LOOP_MODE','SLEEP_TIME','MAX_CONTACTS_PER_KM','VOTING_QUORUM','VOTE_DURATION','KICK_QUORUM','CLIENT_SEND_INTERVAL_HZ','REGISTER_TO_LOBBY','SUN_ANGLE','TIME_OF_DAY_MULT','ABS_ALLOWED','TC_ALLOWED','STABILITY_ALLOWED','AUTOCLUTCH_ALLOWED','TYRE_BLANKETS_ALLOWED','FORCE_VIRTUAL_MIRROR','FUEL_RATE','DAMAGE_MULTIPLIER','TYRE_WEAR_RATE','ALLOWED_TYRES_OUT','MAX_BALLAST_KG','REVERSED_GRID_RACE_POSITIONS']),
  PRACTICE: new Set(['NAME','TIME','IS_OPEN']),
  QUALIFY: new Set(['NAME','TIME','IS_OPEN']),
  RACE: new Set(['NAME','TIME','LAPS','WAIT_TIME','IS_OPEN']),
});
const BOOLS=new Set(['PICKUP_MODE_ENABLED','LOOP_MODE','REGISTER_TO_LOBBY','STABILITY_ALLOWED','AUTOCLUTCH_ALLOWED','TYRE_BLANKETS_ALLOWED','FORCE_VIRTUAL_MIRROR']);
const IDS=new Set(['TRACK','CONFIG_TRACK']);
const NUMBERS={MAX_CLIENTS:[1,200],SLEEP_TIME:[0,10000],MAX_CONTACTS_PER_KM:[-1,10000],VOTING_QUORUM:[0,100],VOTE_DURATION:[0,3600],KICK_QUORUM:[0,100],CLIENT_SEND_INTERVAL_HZ:[1,1000],SUN_ANGLE:[-360,360],TIME_OF_DAY_MULT:[0,100],ABS_ALLOWED:[0,2],TC_ALLOWED:[0,2],FUEL_RATE:[0,1000],DAMAGE_MULTIPLIER:[0,1000],TYRE_WEAR_RATE:[0,1000],ALLOWED_TYRES_OUT:[-1,4],MAX_BALLAST_KG:[0,1000],TIME:[0,1440],LAPS:[0,1000],WAIT_TIME:[0,3600]};
function parse(text) {
  if(typeof text!=='string')throw new Error('Entrée invalide');
  const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean), entries=new Map(), sections=new Map();
  let section='';
  for(let index=0;index<lines.length;index++) {
    const body=lines[index].replace(/(?:\r\n|\n|\r)$/,'');
    const header=body.match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if(header){section=header[1].trim().toUpperCase();sections.set(section,(sections.get(section)||0)+1);continue;}
    const prop=body.match(/^(\s*([^=;#]+?)\s*=)(.*)$/);
    if(!prop)continue;
    const key=prop[2].trim().toUpperCase(), id=section+'\0'+key;
    if(!entries.has(id))entries.set(id,[]);
    entries.get(id).push({index,prefix:prop[1],value:prop[3],ending:lines[index].slice(body.length)});
  }
  return {lines,entries,sections};
}
function baseSession(section){const m=section.match(/^__CM_(PRACTICE|QUALIFY|RACE)_OFF$/);return m?m[1]:section;}
function keyAllowed(section,key){
  const base=baseSession(section);
  if(['PRACTICE','QUALIFY','RACE'].includes(section)&&key==='ENABLED')return true;
  if(Object.hasOwn(ALLOWED,base)&&ALLOWED[base].has(key))return true;
  return /^WEATHER_\d{1,3}$/.test(section)&&WEATHER_FIELDS.has(key);
}
function validate(section,key,value){
  if(value.length>500 || /[\r\n\x00-\x1f]/.test(value))throw new Error('Valeur invalide');
  if((BOOLS.has(key)||key==='ENABLED')&&!['0','1'].includes(value))throw new Error('Valeur booléenne invalide');
  if(key==='REVERSED_GRID_RACE_POSITIONS'&&(!/^(?:-1|0|[1-9]\d*)$/.test(value)||Number(value)>200))throw new Error('Grille inversée invalide');
  if(key==='IS_OPEN' && !(baseSession(section)==='RACE'?['0','1','2']:['0','1']).includes(value))throw new Error('État de session invalide');
  if(IDS.has(key)&&((key==='TRACK'&&!value)||(value&&!/^[a-zA-Z0-9_-]+$/.test(value))))throw new Error('Identifiant invalide');
  if(key==='CARS'&&(!value||!value.split(';').every(v=>/^[a-zA-Z0-9_-]+$/.test(v))))throw new Error('Liste de voitures invalide');
  if(/^WEATHER_\d{1,3}$/.test(section)){
    if(key==='GRAPHICS'||key==='__CM_GRAPHICS'){
      if(!/^[a-zA-Z0-9_-]{1,120}$/.test(value))throw new Error('Identifiant météo invalide');
    }else{
      const ranges={BASE_TEMPERATURE_AMBIENT:[-50,80],BASE_TEMPERATURE_ROAD:[-100,100],VARIATION_AMBIENT:[0,100],VARIATION_ROAD:[0,100],WIND_BASE_SPEED_MIN:[0,500],WIND_BASE_SPEED_MAX:[0,500],WIND_BASE_DIRECTION:[0,360],WIND_VARIATION_DIRECTION:[0,360]};
      const range=ranges[key];if(!range||! /^-?\d+(?:\.\d+)?$/.test(value)||Number(value)<range[0]||Number(value)>range[1])throw new Error('Valeur météo invalide');
    }
  }
  if(['MAX_CLIENTS','LAPS','ALLOWED_TYRES_OUT','ABS_ALLOWED','TC_ALLOWED'].includes(key)&&!/^\d+$/.test(value)&&!(key==='ALLOWED_TYRES_OUT'&&value==='-1'))throw Error('Valeur entière attendue');
  if(Object.hasOwn(NUMBERS,key)){
    const [min,max]=NUMBERS[key];
    if(!/^-?\d+(?:\.\d+)?$/.test(value)||Number(value)<min||Number(value)>max)throw new Error('Valeur numérique invalide');
  }
}
const WEATHER_FIELDS=new Set(['GRAPHICS','__CM_GRAPHICS','BASE_TEMPERATURE_AMBIENT','BASE_TEMPERATURE_ROAD','VARIATION_AMBIENT','VARIATION_ROAD','WIND_BASE_SPEED_MIN','WIND_BASE_SPEED_MAX','WIND_BASE_DIRECTION','WIND_VARIATION_DIRECTION']);
function welcomePaths(text){
 const {sections,entries}=parse(text);
 for(const name of ['SERVER','DATA'])if((sections.get(name)||0)!==1)throw Error('Chemins du message indisponibles');
 const result={};
 for(const [name,key] of [['SERVER','WELCOME_MESSAGE'],['DATA','WELCOME_PATH']]){
  const items=entries.get(name+'\0'+key)||[];
  if(items.length!==1)throw Error('Chemins du message indisponibles');
  result[key]=items[0].value.trim();
 }
 return result;
}
function inspectDirectLaunch(text){
 const {sections,entries}=parse(text),count=sections.get('__CM_PLUGIN')||0;
 if(count>1)return false;
 if(!count)return true;
 const active=entries.get('__CM_PLUGIN\0ACTIVE')||[];
 if(active.length>1)return false;
 return !active.length||['0','false'].includes(active[0].value.trim().toLowerCase());
}
// Cas expérimental limité : CM a son plugin interne activé, mais aucun plugin
// externe ni conditions réelles ; la liaison est déjà celle du collecteur GDSP.
function inspectPluginTest(text,{listenPort,pluginPort,host}={}){
 const {sections,entries}=parse(text);
 if(sections.get('SERVER')!==1||sections.get('__CM_PLUGIN')!==1)return false;
 if(!Number.isInteger(listenPort)||listenPort<1||listenPort>65535||!Number.isInteger(pluginPort)||pluginPort<1||pluginPort>65535||listenPort===pluginPort||host!=='127.0.0.1')return false;
 function get(section,key){const list=entries.get(section+'\0'+key)||[];return list.length===1?list[0].value.trim():null;}
 const active=get('__CM_PLUGIN','ACTIVE'),real=get('__CM_PLUGIN','REAL_CONDITIONS');
 if(!['1','true'].includes((active||'').toLowerCase())||!['0','false'].includes((real||'').toLowerCase()))return false;
 const address=get('SERVER','UDP_PLUGIN_ADDRESS'),local=get('SERVER','UDP_PLUGIN_LOCAL_PORT');
 if(address!==`127.0.0.1:${listenPort}`||local!==String(pluginPort))return false;
 const auth=entries.get('SERVER\0AUTH_PLUGIN_ADDRESS')||[];
 if(auth.length>1||(auth.length===1&&auth[0].value.trim()))return false;
 for(const [name,list] of entries){
  const [section,key]=name.split('\0');if(section!=='__CM_PLUGIN')continue;
  if(list.length!==1)return false;
  if(['ACTIVE','REAL_CONDITIONS','REAL_CONDITIONS_PARAMS'].includes(key))continue;
  if(/^EXTRA_PLUGIN_\d+_(ADDRESS|PORT)$/.test(key)&&(!list[0].value.trim()||list[0].value.trim()==='0'))continue;
  return false;
 }
 return true;
}
function trackParts(raw){
  if(/^[a-zA-Z0-9_-]+$/.test(raw))return {prefix:'',id:raw};
  const match=raw.match(/^(csp\/\d+\/\.\.\/(?:[a-zA-Z0-9_-]+\/\.\.\/)?)([a-zA-Z0-9_-]+)$/);
  return match?{prefix:match[1],id:match[2]}:null;
}
function inspectExtra(text){
  const {sections,entries}=parse(text), sessions={},inactiveSessions={};
  for(const session of ['BOOK','PRACTICE','QUALIFY','RACE']){
    const on=sections.get(session)||0,off=sections.get('__CM_'+session+'_OFF')||0;
    if(on>1||off>1||(on&&off))throw new Error('Session ambiguë : '+session);
    sessions[session]=on?'active':off?'inactive':'absente';
    if(off&&Object.hasOwn(ALLOWED,session)){
      const values={};
      for(const key of ALLOWED[session]){
        const list=entries.get('__CM_'+session+'_OFF\0'+key)||[];
        if(list.length>1)throw new Error('Session ambiguë : '+session);
        if(list.length)values[key]=list[0].value.trim();
      }
      inactiveSessions[session]=values;
    }
  }
  const weather={};
  for(const [id,items] of entries){
    const [section,key]=id.split('\0');
    if(!/^WEATHER_\d{1,3}$/.test(section)||!WEATHER_FIELDS.has(key))continue;
    if(items.length!==1||sections.get(section)!==1)throw new Error('Météo ambiguë');
    (weather[section] ||= {})[key]=items[0].value.trim();
  }
  const raw=(entries.get('SERVER\0TRACK')||[])[0]?.value.trim()||'';
  const parts=trackParts(raw),csp=raw.startsWith('csp/');
  return {sessions,inactiveSessions,weather,csp:{encodedInTrack:csp,trackId:parts?.id||raw,trackEditable:!!parts}};
}
function inspectIni(text){
  const parsed=parse(text),result={};
  for(const [id,entries] of parsed.entries){
    const [section,key]=id.split('\0');
    if(!keyAllowed(section,key))continue;
    if(entries.length!==1||parsed.sections.get(section)!==1)throw new Error('Configuration ambiguë : '+section+'.'+key);
    (result[section] ||= {})[key]=entries[0].value.trim();
  }
  for(const section of ['PRACTICE','QUALIFY','RACE']){
    const on=parsed.sections.get(section)||0,off=parsed.sections.get('__CM_'+section+'_OFF')||0;
    if(on>1||off>1||(on&&off))throw new Error('Session ambiguë : '+section);
    if(on||off)(result[section] ||= {}).ENABLED=on?'1':'0';
  }
  return result;
}
function patchIni(text, updates) {
  if(!Array.isArray(updates))throw new Error('Entrée invalide');
  const {lines,entries,sections}=parse(text), edits=new Set(),toggles=[],insertions=[];
  for(const u of updates){
    const section=String(u?.section||'').toUpperCase(),key=String(u?.key||'').toUpperCase();
    if(!keyAllowed(section,key))throw new Error('Paramètre non autorisé');
    if(/^WEATHER_\d{1,3}$/.test(section)&&['GRAPHICS','__CM_GRAPHICS'].includes(key)){
      // WeatherFX encode plusieurs paramètres dans GRAPHICS : refuser sa modification sans codec CM.
      const graphics=(entries.get(section+'\0GRAPHICS')||[])[0]?.value.trim()||'';
      if((entries.get(section+'\0__CM_GRAPHICS')||[]).length||/_type=/.test(graphics))throw new Error('Météo WeatherFX : changement du type non pris en charge');
    }
    if(baseSession(section)==='RACE'&&['TIME','LAPS'].includes(key)){
      const lapsEntries=entries.get(section+'\0LAPS')||[];
      if(lapsEntries.length!==1||!/^\d+$/.test(lapsEntries[0].value.trim()))throw new Error('Mode de course ambigu');
      const oldLaps=Number(lapsEntries[0].value.trim()),newValue=String(u.value);
      if(key==='TIME'&&oldLaps>0)throw new Error('Durée inactive pour une course en tours : utiliser Content Manager');
      if(key==='LAPS'&&/^\d+$/.test(newValue)&&((oldLaps===0)!==(Number(newValue)===0)))throw new Error('Changement de mode de course : utiliser Content Manager');
    }
    // CM peut encoder ses options CSP dans TRACK (csp/version/../...) et
    // afficher un nom propre dans __CM_SERVER.NAME. Ne jamais les écraser.
    if(section==='SERVER'&&key==='TRACK'){
      const current=entries.get('SERVER\0TRACK')||[];
      if(!current.length)throw new Error('Paramètre absent : SERVER.TRACK');
      if(current.length!==1||!trackParts(current[0].value.trim()))throw new Error('Circuit avec configuration CSP ambiguë : modification non prise en charge');
    }
    if(section==='SERVER'&&key==='NAME'&&(entries.get('__CM_SERVER\0NAME')||[]).some(x=>x.value.trim()))throw new Error('Nom géré par Content Manager : modification non prise en charge');
    const id=section+'\0'+key;if(edits.has(id))throw new Error('Paramètre demandé plusieurs fois');edits.add(id);
    if(typeof u.value!=='string'&&typeof u.value!=='number')throw new Error('Valeur invalide');
    const value=String(u.value);validate(section,key,value);
    if(key==='ENABLED'){
      const off='__CM_'+section+'_OFF',onCount=sections.get(section)||0,offCount=sections.get(off)||0;
      if(onCount+offCount!==1)throw new Error('Session absente ou ambiguë');
      toggles.push({from:onCount?section:off,to:value==='1'?section:off});continue;
    }
    const found=entries.get(id)||[];
    if(section==='SERVER'&&['CONFIG_TRACK','REVERSED_GRID_RACE_POSITIONS'].includes(key)&&found.length===0&&sections.get(section)===1){
      if(value)insertions.push({key,value});
      continue;
    }
    if(found.length!==1||sections.get(section)!==1)throw new Error('Paramètre absent ou ambigu : '+section+'.'+key);
    const output=section==='SERVER'&&key==='TRACK'?trackParts(found[0].value.trim()).prefix+value:value;
    lines[found[0].index]=found[0].prefix+output+found[0].ending;
  }
  for(const toggle of toggles){
    if(toggle.from===toggle.to)continue;
    const index=lines.findIndex(line=>{const match=line.match(/^\uFEFF?\s*\[([^\]]+)\]/);return match&&match[1].trim().toUpperCase()===toggle.from;});
    if(index<0)throw new Error('Session absente ou ambiguë');
    lines[index]=lines[index].replace(/^(\uFEFF?\s*\[)([^\]]+)(\])/,(_,a,_b,c)=>a+toggle.to+c);
  }
  if(insertions.length){
    const index=lines.findIndex(line=>/^\uFEFF?\s*\[SERVER\]\s*(?:[;#].*)?(?:\r\n|\n|\r|$)$/i.test(line));
    if(index<0)throw new Error('Section serveur absente');
    const newline=text.match(/\r\n|\n|\r/)?.[0]||'\r\n';
    if(!/(?:\r\n|\n|\r)$/.test(lines[index]))lines[index]+=newline;
    for(const insertion of insertions)lines[index]+=insertion.key+'='+insertion.value+newline;
  }
  return lines.join('');
}
module.exports={patchIni,inspectIni,inspectExtra,trackParts,inspectDirectLaunch,inspectPluginTest,welcomePaths};

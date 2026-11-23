'use strict';
// Préparation en mémoire d'un changement coordonné sur les deux INI. Ce module
// ne lit ni n'écrit de fichier et ne pilote aucun processus.
const {inspect,preview}=require('./draft');
const {inspectEntries,patchEntries}=require('./entry-list');
const {trackParts,inspectExtra}=require('./ini');
const {patchWeather}=require('./weather');
const crypto=require('node:crypto');
function hash(text){return crypto.createHash('sha256').update(text,'utf8').digest('hex')}
function prepare({config,entry,configRevision,entryRevision,configChanges=[],entryChanges=[],weatherChanges=[],raceMode,hasCsp=false,inventory}){
  if(typeof config!=='string'||typeof entry!=='string'||config.length>1048576||entry.length>1048576)throw new Error('Configuration invalide');
  if(hash(entry)!==entryRevision||inspect(config).revision!==configRevision)throw new Error('Les fichiers ont changé : recharge avant de modifier.');
  if(!Array.isArray(configChanges)||!Array.isArray(entryChanges)||!Array.isArray(weatherChanges)||(!configChanges.length&&!entryChanges.length&&!weatherChanges.length&&!raceMode&&!hasCsp))throw new Error('Aucune modification à préparer');
  if(!inventory||!Array.isArray(inventory.cars)||!Array.isArray(inventory.tracks))throw new Error('Inventaire du contenu indisponible');
  if(weatherChanges.some(w=>w.operation==='remove'&&configChanges.some(c=>String(c.section).toUpperCase()==='WEATHER_'+w.id)))throw Error('Annule les modifications de la météo à supprimer');
  const currentEntries=inspectEntries(entry),configPlan=configChanges.length?preview(config,configRevision,configChanges):{settings:inspect(config).settings,changes:[]};
  const updatedEntries=entryChanges.length?patchEntries(entry,entryChanges):entry;
  const afterConfig=configChanges.length?require('./ini').patchIni(config,configChanges):config;
  const withWeather=weatherChanges.length?patchWeather(afterConfig,weatherChanges):afterConfig;
  if(raceMode&&configChanges.some(c=>['RACE','__CM_RACE_OFF'].includes(String(c.section).toUpperCase())&&['TIME','LAPS'].includes(String(c.key).toUpperCase())))throw Error('Modifications de course contradictoires');
  const afterRace=raceMode?require('./race-mode').patchRaceMode(withWeather,raceMode):withWeather;
  const raceChanged=afterRace!==withWeather;
  const beforeWeather=inspectExtra(config).weather,afterWeather=inspectExtra(withWeather).weather;
  const weatherDiff=weatherChanges.map(w=>({id:w.id,before:beforeWeather['WEATHER_'+w.id]||null,after:afterWeather['WEATHER_'+w.id]||null}));
  const slots=inspectEntries(updatedEntries);
  const track=trackParts(configPlan.settings.SERVER?.TRACK||'')?.id,layout=configPlan.settings.SERVER?.CONFIG_TRACK||'';
  if(configChanges.some(x=>['TRACK','CONFIG_TRACK'].includes(String(x.key).toUpperCase()))){
    const found=inventory.tracks.find(t=>t.id===track);
    if(!found)throw new Error('Circuit introuvable dans le contenu installé');
    if(layout&&(!Array.isArray(found.layouts)||!found.layouts.includes(layout)))throw new Error('Configuration de circuit introuvable');
  }
  for(const change of entryChanges){
    if(change.operation==='remove')continue;
    const slot=slots.find(x=>x.id===change.id),car=inventory.cars.find(x=>x.id===slot.model);
    if(!car)throw new Error('Voiture introuvable dans le contenu installé');
    if(slot.skin&&(!Array.isArray(car.skins)||!car.skins.includes(slot.skin)))throw new Error('Skin introuvable pour cette voiture');
  }
  if(entryChanges.length||configChanges.some(x=>String(x.section).toUpperCase()==='SERVER'&&['CARS','MAX_CLIENTS'].includes(String(x.key).toUpperCase()))){
    const declared=configPlan.settings.SERVER?.CARS;
    if(!declared)throw new Error('Liste des voitures du serveur indisponible');
    const permitted=new Set(declared.split(';').map(x=>x.trim()).filter(Boolean));
    if(configChanges.some(x=>String(x.section).toUpperCase()==='SERVER'&&String(x.key).toUpperCase()==='CARS')&&[...permitted].some(id=>!inventory.cars.some(car=>car.id===id)))throw new Error('Voiture autorisée introuvable dans le contenu installé');
    if(slots.some(slot=>!permitted.has(slot.model)))throw new Error('Une voiture des places ne figure pas dans la liste serveur');
    const max=configPlan.settings.SERVER?.MAX_CLIENTS;
    if(max!=null && (!/^\d+$/.test(max)||Number(max)>slots.length))throw new Error('Le nombre de places est insuffisant');
  }
  const slotChanges=entryChanges.flatMap(change=>{const old=currentEntries.find(x=>x.id===change.id),slot=slots.find(x=>x.id===change.id);
    const before=old?{model:old.model,skin:old.skin}:null,after=slot?{model:slot.model,skin:slot.skin}:null;
    return !before||!after||before.model!==after.model||before.skin!==after.skin?[{id:change.id,before,after}]:[];
  });
  return {configRevision,entryRevision,configChanges:configPlan.changes,slotChanges,weatherChanges:weatherDiff,raceChange:raceChanged?{mode:raceMode.mode,value:raceMode.value}:null};
}
module.exports={prepare};

'use strict';
// Projet de modification sans effet de bord : l'application et le contrôle des
// processus restent volontairement indisponibles tant que leur isolation n'a pas
// été vérifiée sur Windows. Aucun mot de passe ni port ne sort de ce module.
const crypto=require('node:crypto');
const {patchIni,inspectIni}=require('./ini');
function revision(text){return crypto.createHash('sha256').update(text,'utf8').digest('hex');}
function inspect(text){
  if(typeof text!=='string'||text.length>1024*1024)throw new Error('Configuration invalide ou trop volumineuse');
  return {revision:revision(text),settings:inspectIni(text)};
}
function preview(text, expectedRevision, changes){
  const current=inspect(text);
  if(typeof expectedRevision!=='string'||expectedRevision!==current.revision)throw new Error('La configuration a changé : recharge avant de modifier.');
  if(!Array.isArray(changes)||changes.length===0||changes.length>80)throw new Error('Liste de modifications invalide');
  const updated=patchIni(text,changes),after=inspectIni(updated),diff=[];
  for(const change of changes){
    const section=String(change.section).toUpperCase(),key=String(change.key).toUpperCase();
    const before=current.settings[section]?.[key],value=after[section]?.[key]??after[section.replace(/^__CM_(PRACTICE|QUALIFY|RACE)_OFF$/,'$1')]?.[key]??after['__CM_'+section+'_OFF']?.[key];
    if(before!==value)diff.push({section,key,before,after:value});
  }
  return {revision:current.revision,settings:after,changes:diff};
}
module.exports={inspect,preview};

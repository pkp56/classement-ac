'use strict';
// Opérations pures, sans écriture disque. Conserve toutes les lignes non ciblées.
function parse(text){
  if(typeof text!=='string'||text.length>1024*1024)throw new Error('Liste invalide ou trop volumineuse');
  const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean),slots=new Map();let current=null;
  for(let i=0;i<lines.length;i++){
    const body=lines[i].replace(/(?:\r\n|\n|\r)$/,'');
    const header=body.match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if(header){
      if(current)current.end=i;
      const name=header[1].trim().toUpperCase(),match=name.match(/^CAR_(\d+)$/);
      if(match){const id=Number(match[1]);if(!Number.isSafeInteger(id)||id>999||slots.has(id))throw new Error('Place ambiguë');current={id,fields:new Map(),start:i,end:lines.length};slots.set(id,current);}else current=null;
      continue;
    }
    if(!current)continue;
    const m=body.match(/^(\s*([^=;#]+?)\s*=)(.*)$/);if(!m)continue;
    const key=m[2].trim().toUpperCase();if(current.fields.has(key))throw new Error('Champ de place dupliqué');
    current.fields.set(key,{value:m[3],prefix:m[1],ending:lines[i].slice(body.length),index:i});
  }
  return {lines,slots};
}
function skinParts(raw){
 if(!raw)return {id:'',suffix:''};
 const match=raw.match(/^([a-zA-Z0-9_-]*)(\/[a-zA-Z0-9_\-=]+)?$/);
 return match?{id:match[1],suffix:match[2]||''}:null;
}
function inspectEntries(text){
 const {slots}=parse(text);
 return [...slots.values()].sort((a,b)=>a.id-b.id).map(slot=>({id:slot.id,model:slot.fields.get('MODEL')?.value.trim()||'',skin:skinParts(slot.fields.get('SKIN')?.value.trim()||'')?.id||'',cspSkin:!!skinParts(slot.fields.get('SKIN')?.value.trim()||'')?.suffix,skinEditable:!!skinParts(slot.fields.get('SKIN')?.value.trim()||''),reserved:!!(slot.fields.get('GUID')?.value.trim())}));
}
function patchEntries(text,changes){
 if(!Array.isArray(changes)||changes.length===0||changes.length>200)throw new Error('Modifications invalides');
 const parsed=parse(text),seen=new Set(),removals=[],additions=[];
 for(const change of changes){
   const id=change?.id,slot=parsed.slots.get(id);
   if(!Number.isSafeInteger(id)||id<0||id>999||seen.has(id))throw new Error('Place absente ou dupliquée');seen.add(id);
   if(change.operation==='add'){
     if(slot||typeof change.model!=='string'||! /^[a-zA-Z0-9_-]{1,120}$/.test(change.model)||typeof change.skin!=='string'||! /^[a-zA-Z0-9_-]{0,120}$/.test(change.skin))throw Error('Nouvelle place invalide');
     additions.push(change);continue;
   }
   if(!slot)throw new Error('Place absente ou dupliquée');
   if(change.operation==='remove'){
     const allowed=new Set(['MODEL','SKIN','GUID','DRIVERNAME','TEAM','SPECTATOR_MODE','BALLAST','RESTRICTOR']);
     for(const [key,entry] of slot.fields){
       const v=entry.value.trim();
       if(!allowed.has(key)||(['GUID','DRIVERNAME','TEAM'].includes(key)&&v)||(['BALLAST','RESTRICTOR','SPECTATOR_MODE'].includes(key)&&v&&!/^0(?:\.0+)?$/.test(v))||(key==='SKIN'&&(!skinParts(v)||skinParts(v).suffix)))throw Error('Place contenant des données à conserver : suppression refusée');
     }
     for(const line of parsed.lines.slice(slot.start+1,slot.end))if(line.trim()&&!/^\s*[^=;#]+?\s*=/.test(line))throw Error('Place contenant des données à conserver : suppression refusée');
     removals.push(slot);continue;
   }
   if(change.operation!=null)throw Error('Opération de place invalide');
   const rawSkin=slot.fields.get('SKIN')?.value.trim()||'',parts=skinParts(rawSkin);
   if(!parts)throw Error('Options CSP de place ambiguës');
   if(parts.suffix&&Object.hasOwn(change,'model')&&change.model!==slot.fields.get('MODEL')?.value.trim())throw Error('Voiture avec options CSP : changement non pris en charge');
   for(const [name,key] of [['model','MODEL'],['skin','SKIN']]){
     if(!Object.hasOwn(change,name))continue;
     const value=change[name];if(typeof value!=='string'||value.length>120||!(/^[a-zA-Z0-9_-]+$/.test(value)||(name==='skin'&&value==='')))throw new Error('Identifiant de voiture ou skin invalide');
     const entry=slot.fields.get(key);if(!entry)throw new Error('Champ absent : '+key);
     parsed.lines[entry.index]=entry.prefix+value+(name==='skin'?parts.suffix:'')+entry.ending;
   }
 }
 const ids=[...parsed.slots.keys()].sort((a,b)=>a-b);
 if(ids.some((id,i)=>id!==i))throw Error('Numérotation des places non continue');
 const removeIds=removals.map(s=>s.id).sort((a,b)=>b-a);
 if(removeIds.some((id,i)=>id!==ids.length-1-i))throw Error('Seules les dernières places peuvent être supprimées');
 additions.sort((a,b)=>a.id-b.id);
 if(additions.some((c,i)=>c.id!==ids.length-removeIds.length+i))throw Error('Numérotation de nouvelle place invalide');
 for(const slot of removals.sort((a,b)=>b.start-a.start))parsed.lines.splice(slot.start,slot.end-slot.start);
 let result=parsed.lines.join('');
 const nl=text.includes('\r\n')?'\r\n':'\n';
 for(const c of additions){
   if(result&&!/[\r\n]$/.test(result))result+=nl;
   result+=`[CAR_${c.id}]${nl}MODEL=${c.model}${nl}SKIN=${c.skin}${nl}SPECTATOR_MODE=0${nl}DRIVERNAME=${nl}TEAM=${nl}GUID=${nl}BALLAST=0${nl}RESTRICTOR=0${nl}`;
 }
 return result;
}
module.exports={inspectEntries,patchEntries};

'use strict';
// Les blocs entiers restent intacts ; leur ordre est uniquement une hypothèse à tester.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GDSPEntryPreview=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 function prepare(text,grid){
  if(typeof text!=='string'||!text.length||text.length>1048576||text.includes('\0'))throw Error('Liste de places vide ou invalide.');
  if(!Array.isArray(grid)||!grid.length||grid.length>200)throw Error('Grille absente ou trop longue.');
  const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean),blocks=[],prefix=[];let block=null;
  for(const line of lines){
   const body=line.replace(/(?:\r\n|\n|\r)$/,'');const head=body.match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
   if(head){
    const m=head[1].trim().match(/^CAR_(\d+)$/i);if(!m)throw Error('Section autre qu’une place : adaptation manuelle nécessaire.');
    const id=Number(m[1]);if(!Number.isSafeInteger(id)||id>999||blocks.some(b=>b.id===id))throw Error('Identifiant de place invalide ou en double.');
    block={id,lines:[line],fields:new Map()};blocks.push(block);continue;
   }
   if(!block){if(body.trim()&&!/^\s*[;#]/.test(body))throw Error('Contenu avant les places non pris en charge.');prefix.push(line);continue;}
   block.lines.push(line);const prop=body.match(/^\s*([^=;#]+?)\s*=(.*)$/);
   if(prop){const key=prop[1].trim().toUpperCase();if(block.fields.has(key))throw Error('Champ dupliqué dans une place.');block.fields.set(key,prop[2].trim());}
   else if(body.trim()&&!/^\s*[;#]/.test(body))throw Error('Ligne de place non reconnue.');
  }
  blocks.sort((a,b)=>a.id-b.id);
  if(!blocks.length||blocks.length>200||blocks.some((b,i)=>b.id!==i))throw Error('Les places doivent être numérotées de façon continue à partir de CAR_0.');
  const byGuid=new Map();
  for(const b of blocks){
   if(!b.fields.has('GUID')||!b.fields.has('MODEL')||!b.fields.has('SKIN'))throw Error('Chaque place doit avoir MODEL, SKIN et GUID.');
   const id=b.fields.get('GUID');if(id){const k=id.toLowerCase();if(byGuid.has(k))throw Error('GUID en double dans les places.');byGuid.set(k,b);}
  }
  const used=new Set(),ordered=[],mapping=[];
  for(let i=0;i<grid.length;i++){
   const p=grid[i];if(!p||p.gridPosition!==i+1||typeof p.guid!=='string'||!p.guid.trim())throw Error('Grille incomplète : chaque pilote doit avoir un GUID et une position unique.');
   const guid=p.guid.trim().toLowerCase(),b=byGuid.get(guid);
   if(!b||used.has(guid))throw Error('GUID absent, non réservé ou répété dans la liste des places.');
   used.add(guid);ordered.push(b);mapping.push({gridPosition:i+1,name:p.name,oldSlot:b.id,newSlot:i,model:b.fields.get('MODEL'),skin:b.fields.get('SKIN')});
  }
  if([...byGuid.keys()].some(guid=>!used.has(guid)))throw Error('Une réservation ne figure pas dans la grille : traite les absents manuellement.');
  ordered.push(...blocks.filter(b=>!b.fields.get('GUID')));
  const nl=text.match(/\r\n|\n|\r/)?.[0]||'\n';let result=prefix.join('');
  ordered.forEach((b,index)=>{
   if(result&&!/[\r\n]$/.test(result))result+=nl;
   const header=b.lines[0].replace(/^(\uFEFF?\s*\[)CAR_\d+(\])/i,(_,a,c)=>`${a}CAR_${index}${c}`);
   result+=header+b.lines.slice(1).join('');
  });
  return {text:result,mapping,unreserved:blocks.length-grid.length};
 }
 return {prepare};
});

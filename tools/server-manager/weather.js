'use strict';
// Ajout et suppression d'une météo en fin de liste seulement. Les blocs existants
// ne sont jamais réécrits ni renumérotés.
function patchWeather(text,operations){
 if(!Array.isArray(operations)||operations.length>20)throw Error('Modifications météo invalides');
 const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean),sections=[];
 let current=null;
 for(let i=0;i<lines.length;i++){
  const h=lines[i].match(/^\uFEFF?\s*\[([^\]]+)\]\s*(?:[;#].*)?(?:\r\n|\n|\r)?$/);
  if(!h)continue;
  if(current)current.end=i;
  const m=h[1].trim().toUpperCase().match(/^WEATHER_(\d+)$/);
  current=m?{id:Number(m[1]),start:i,end:lines.length}:null;
  if(current)sections.push(current);
 }
 sections.sort((a,b)=>a.id-b.id);
 if(sections.some((s,i)=>s.id!==i))throw Error('Météos ambiguës ou non numérotées en continu');
 let count=sections.length;const removes=[],adds=[];
 for(const op of operations){
  if(op?.operation==='remove'){
   if(count<=1||op.id!==count-1||adds.length)throw Error('Seule la dernière météo peut être supprimée, en conservant au moins une météo');
   removes.push(sections[count-1]);count--;
  }else if(op?.operation==='add'){
   if(op.id!==count||typeof op.graphics!=='string'||! /^[a-zA-Z0-9_-]{1,120}$/.test(op.graphics))throw Error('Nouvelle météo invalide');
   adds.push(op);count++;
  }else throw Error('Modification météo invalide');
 }
 for(const s of removes.sort((a,b)=>b.start-a.start))lines.splice(s.start,s.end-s.start);
 let out=lines.join(''),nl=text.includes('\r\n')?'\r\n':'\n';
 for(const op of adds){if(out&&!/[\r\n]$/.test(out))out+=nl;out+=`[WEATHER_${op.id}]${nl}GRAPHICS=${op.graphics}${nl}BASE_TEMPERATURE_AMBIENT=18${nl}BASE_TEMPERATURE_ROAD=6${nl}VARIATION_AMBIENT=2${nl}VARIATION_ROAD=1${nl}WIND_BASE_SPEED_MIN=0${nl}WIND_BASE_SPEED_MAX=0${nl}WIND_BASE_DIRECTION=0${nl}WIND_VARIATION_DIRECTION=0${nl}`;}
 return out;
}
module.exports={patchWeather};

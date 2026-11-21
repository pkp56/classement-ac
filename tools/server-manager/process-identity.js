'use strict';
// Identification pure de processus Windows. Aucun appel système, démarrage ou
// arrêt ici. En cas d'ambiguïté, il faut bloquer toute action de contrôle.
const path=require('node:path');
function windowsArgv(input){
 if(typeof input!=='string'||input.length>32768||input.includes('\0'))throw new Error('Ligne de commande indisponible');
 let i=0,argv=[];
 while(i<input.length){
   while(i<input.length&&/[ \t]/.test(input[i]))i++;
   if(i===input.length)break;
   let arg='',quoted=false;
   while(i<input.length){
     if(!quoted&&/[ \t]/.test(input[i]))break;
     let slash=0;while(input[i]==='\\'){slash++;i++;}
     if(input[i]==='"'){
       arg+='\\'.repeat(Math.floor(slash/2));
       if(slash%2){arg+='"';i++;}else{quoted=!quoted;i++;}
     }else{
       arg+='\\'.repeat(slash);
       if(i<input.length&&(!/[ \t]/.test(input[i])||quoted)){arg+=input[i];i++;}
       else break;
     }
   }
   if(quoted)throw new Error('Guillemets non fermés');
   argv.push(arg);if(argv.length>256)throw new Error('Ligne de commande trop longue');
 }
 return argv;
}
function normalized(p,base){
 if(typeof p!=='string'||!p||p.includes('\0')||p.includes('"'))return null;
 if(!path.win32.isAbsolute(p))return null;
 return path.win32.normalize(p).toLowerCase();
}
function identify({root,processes}){
 if(typeof root!=='string'||!path.win32.isAbsolute(root)||!Array.isArray(processes))throw new Error('Paramètres invalides');
 const executable=normalized(path.win32.join(root,'acServer.exe'),root);
 const targets={local1:'SERVER_00',local2:'SERVER_01'},found={local1:[],local2:[]},unknown=[];
 for(const p of processes){
   // Un acServer sans chemin fiable peut être l'un des nôtres : bloquer.
   if(!p||!Number.isSafeInteger(p.pid)||p.pid<1||!p.executablePath||!p.commandLine){unknown.push({reason:'identité indisponible'});continue;}
   if(normalized(p.executablePath,root)!==executable)continue;
   let argv;try{argv=windowsArgv(p.commandLine)}catch(e){unknown.push({reason:'commande illisible'});continue;}
   if(normalized(argv[0],root)!==executable){unknown.push({reason:'exécutable ambigu'});continue;}
   let cfg=[],entry=[];
   for(let i=1;i<argv.length;i++){
     const flag=argv[i].toLowerCase();
     if(flag==='-c'||flag==='-e'){
       if(i+1>=argv.length){cfg=[];entry=[];break;}
       (flag==='-c'?cfg:entry).push(argv[++i]);
     }
   }
   if(cfg.length!==1||entry.length!==1){unknown.push({reason:'arguments ambigus'});continue;}
   let matched=null;
   for(const [id,preset] of Object.entries(targets)){
     const dir=path.win32.join(root,'presets',preset);
     if(normalized(cfg[0],root)===normalized(path.win32.join(dir,'server_cfg.ini'),root)&&normalized(entry[0],root)===normalized(path.win32.join(dir,'entry_list.ini'),root)){matched=id;break;}
   }
   if(!matched){unknown.push({reason:'préréglage inconnu'});continue;}
   if(typeof p.creationTime!=='string'||!p.creationTime||!Number.isFinite(Date.parse(p.creationTime))){unknown.push({reason:'date de création indisponible'});continue;}
   found[matched].push({pid:p.pid,creationTime:p.creationTime});
 }
 const ambiguous=unknown.length>0||found.local1.length>1||found.local2.length>1;
 return {ambiguous,servers:{local1:found.local1,local2:found.local2},unknown};
}
module.exports={windowsArgv,identify};

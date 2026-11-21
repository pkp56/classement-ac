'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {welcomePaths}=require('./ini'),{decodeWelcome,encodeWelcome}=require('./csp-welcome');
const IDS=Object.freeze({local1:'SERVER_00',local2:'SERVER_01'});
function normalizeValue(value){return value.replace(/[\\/]+/g,path.sep);}
function equalPath(a,b){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
async function readWelcome(root,id,config){
 if(!Object.hasOwn(IDS,id)||!path.isAbsolute(root))throw Error('Serveur inconnu');
 const server=await fs.realpath(root),preset=IDS[id],dir=path.join(server,'presets',preset),cfg=path.join(server,'cfg');
 const {WELCOME_PATH,WELCOME_MESSAGE}=welcomePaths(config);
 if(!WELCOME_PATH||!WELCOME_MESSAGE)throw Error('Message CM non configuré');
 const canonicalLocal=path.join(dir,'cm_welcome.txt'),canonicalPublic=path.join(cfg,`welcome_${preset}.txt`);
 const declared=path.resolve(server,normalizeValue(WELCOME_PATH)),declaredLive=path.resolve(server,normalizeValue(WELCOME_MESSAGE));
 if(!equalPath(declared,canonicalLocal)||!equalPath(declaredLive,canonicalPublic))throw Error('Chemin du message CM non pris en charge');
 for(const d of [path.join(server,'presets'),dir,cfg]){const st=await fs.lstat(d);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Chemin du message non sûr');}
 async function read(file){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>2039)throw Error('Message CM indisponible ou non sûr');const b=await fs.readFile(file);if(b.length>2039||b.includes(0))throw Error('Message CM invalide');return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);}
 const [local,live]=await Promise.all([read(canonicalLocal),read(canonicalPublic)]);
 if(local!==live)throw Error('Les messages CM et serveur diffèrent : vérifier dans CM');
 const decoded=decodeWelcome(local);
 return {local,live,decoded,revision:crypto.createHash('sha256').update(local,'utf8').digest('hex'),localPath:canonicalLocal,livePath:canonicalPublic};
}
function prepareWelcome(old,revision,cspConfig){
 if(!old||revision!==old.revision)throw Error('Le message CSP a changé : recharge avant de modifier');
 if(typeof cspConfig!=='string')throw Error('Configuration CSP invalide');
 // Les textarea HTML normalisent CRLF en LF : ne jamais réécrire le MOTD
 // ni recompresser le CSP pour un simple changement de fins de ligne.
 const normalized=text=>text.replace(/\r\n?/g,'\n');
 if(normalized(cspConfig)===normalized(old.decoded.config||''))return old.local;
 return encodeWelcome(old.decoded.message,cspConfig);
}
module.exports={readWelcome,prepareWelcome};

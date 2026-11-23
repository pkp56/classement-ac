'use strict';
// Codec pur du message d'accueil CM. Aucune lecture ni écriture de fichier.
const zlib=require('node:zlib');
const SEP='\t'.repeat(32)+'$CSP0:',LIMIT=2039,MAX_CONFIG=65536;
function decodeWelcome(text){
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>LIMIT)throw Error('Message d’accueil invalide ou trop long');
 const index=text.indexOf(SEP);
 if(index<0){if(text.includes('$CSP0:'))throw Error('Séparateur CSP ambigu');return {message:text,config:null};}
 if(text.indexOf(SEP,index+SEP.length)!==-1)throw Error('Séparateur CSP ambigu');
 const encoded=text.slice(index+SEP.length);
 if(!encoded||!/^[A-Za-z0-9+/]+$/.test(encoded))throw Error('Configuration CSP illisible');
 let bytes;
 try{bytes=zlib.inflateSync(Buffer.from(encoded,'base64'),{maxOutputLength:MAX_CONFIG});}catch(e){throw Error('Configuration CSP illisible');}
 let config;try{config=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch(e){throw Error('Configuration CSP illisible');}
 return {message:text.slice(0,index),config};
}
function encodeWelcome(message,config){
 if(typeof message!=='string'||message.includes('$CSP0:')||typeof config!=='string'||Buffer.byteLength(config,'utf8')>MAX_CONFIG)throw Error('Configuration CSP invalide');
 const text=config.trim()?message+SEP+zlib.deflateSync(Buffer.from(config,'utf8')).toString('base64').replace(/=+$/,''):message;
 if(Buffer.byteLength(text,'utf8')>LIMIT)throw Error('Message CSP trop long');
 return text;
}
module.exports={decodeWelcome,encodeWelcome};

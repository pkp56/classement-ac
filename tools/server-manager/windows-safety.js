'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {readProcessState}=require('./process-state');
const runFile=promisify(execFile);
// Vérification restrictive : erreur ou nom de processus incertain = refus.
async function canEdit(root,id,{platform=process.platform,run=runFile,state=readProcessState}={}){
 if(platform!=='win32')return false;
 const current=await state(root,{platform,run});
 if(!current.available||current.servers?.[id]!=='stopped')return false;
 try{
  const script="$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Content Manager|AcManager)(\\.exe)?$' }); if ($p.Count -gt 0) { 'OPEN' } else { 'CLOSED' }";
  const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{timeout:10000,maxBuffer:1024*1024,windowsHide:true});
  return stdout.trim()==='CLOSED';
 }catch(e){return false;}
}
module.exports={canEdit};

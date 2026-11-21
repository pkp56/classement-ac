'use strict';
// Lecture uniquement, le script PowerShell est fixe et ne reçoit aucun chemin
// ou paramètre utilisateur ; les lignes de commande ne sortent jamais du PC.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {identify}=require('./process-identity');
const runFile=promisify(execFile);
const SCRIPT=`$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'acServer.exe'" | ForEach-Object {
  $started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  [PSCustomObject]@{ pid = [int]$_.ProcessId; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine; creationTime = $started }
})
ConvertTo-Json -InputObject $processes -Compress -Depth 3`;
async function readProcessState(root,{platform=process.platform,run=runFile}={}){
 if(platform!=='win32')return {available:false,reason:'Vérification des processus disponible uniquement sur Windows.'};
 let result;
 try{
   const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT],{timeout:10000,maxBuffer:1024*1024,windowsHide:true});
   const rows=JSON.parse(stdout);
   if(!Array.isArray(rows))throw Error('invalid');
   result=identify({root,processes:rows});
 }catch(e){return {available:false,reason:'Impossible de vérifier les processus en toute sécurité.'};}
 if(result.ambiguous)return {available:false,reason:'Processus acServer ambigu : aucune action possible.'};
 return {available:true,servers:{local1:result.servers.local1.length?'running':'stopped',local2:result.servers.local2.length?'running':'stopped'}};
}
module.exports={readProcessState,SCRIPT};

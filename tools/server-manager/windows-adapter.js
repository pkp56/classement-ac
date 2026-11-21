'use strict';
// Adaptateur expérimental désactivé par défaut. Jamais de shell ou arguments libres.
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {SCRIPT}=require('./process-state');
const runFile=promisify(execFile);
const STOP_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
$pdata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GDSP_STOP_IDENTITY)) | ConvertFrom-Json
if ([int]$pdata.pid -le 0 -or $pdata.hash -notmatch '^[a-f0-9]{64}$') { throw 'identity' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GdspProcess {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);
}
'@
$process = [System.Diagnostics.Process]::GetProcessById([int]$pdata.pid)
try {
  # Le handle obtenu ici reste lié au processus même si son PID est réutilisé.
  $handle = $process.Handle
  $processDate = $process.StartTime.ToUniversalTime()
  $row = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$pdata.pid)
  if (!$row -or !$row.CommandLine -or !$row.ExecutablePath -or !$row.CreationDate) { throw 'identity' }
  $cimDate = $row.CreationDate.ToUniversalTime().ToString('o')
  $bytes = [Text.Encoding]::UTF8.GetBytes($row.CommandLine)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
  # CIM arrondit à la microseconde, alors que StartTime garde des ticks de 100 ns.
  # Comparer CIM exactement à l'identité initiale et tolérer moins d'une microseconde sur le handle.
  $deltaTicks = [Math]::Abs(($processDate - $row.CreationDate.ToUniversalTime()).Ticks)
  if ($deltaTicks -gt 9 -or $cimDate -ne $pdata.creationTime -or $hash -ne $pdata.hash -or ![String]::Equals($row.ExecutablePath, $pdata.executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'identity' }
  if (![GdspProcess]::TerminateProcess($handle, 0)) { throw 'terminate' }
} finally { $process.Dispose() }
Write-Output 'STOP_REQUESTED'
`;
function createWindowsAdapter({platform=process.platform,run=runFile,launch=spawn}={}){
 function guard(){if(platform!=='win32')throw Error('Contrôle disponible uniquement sur Windows.');}
 async function powershell(script,env){return run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{timeout:10000,maxBuffer:1024*1024,windowsHide:true,...(env?{env:{...process.env,...env}}:{})});}
 return {
  async list(){guard();const {stdout}=await powershell(SCRIPT);const rows=JSON.parse(stdout);if(!Array.isArray(rows))throw Error('Liste de processus illisible.');return rows;},
  async start({exe,args,cwd}){
   guard();if(!Array.isArray(args)||args.length!==4||args[0]!=='-c'||args[2]!=='-e')throw Error('Arguments invalides.');
   // Lancement direct acServer : ne reproduit pas nécessairement le wrapper CM.
   const child=launch(exe,args,{cwd,detached:true,windowsHide:true,stdio:'ignore',shell:false});
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});child.unref();
  },
  async stopVerified({pid,creationTime,executablePath,commandHash}){
   guard();if(!Number.isSafeInteger(pid)||pid<1||typeof creationTime!=='string'||typeof executablePath!=='string'||!/^[a-f0-9]{64}$/.test(commandHash))throw Error('Identité invalide.');
   const encoded=Buffer.from(JSON.stringify({pid,creationTime,executablePath,hash:commandHash}),'utf8').toString('base64');
   const {stdout}=await powershell(STOP_SCRIPT,{GDSP_STOP_IDENTITY:encoded});if(stdout.trim()!=='STOP_REQUESTED')throw Error('Arrêt non confirmé.');
  }
 };
}
module.exports={createWindowsAdapter};

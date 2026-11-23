[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script = Join-Path $PSScriptRoot 'Run-GDSPMobileUpdate.ps1'
if (-not (Test-Path $script -PathType Leaf)) { throw 'Script de mise à jour absent.' }
if ($script.Contains('"')) { throw 'Chemin invalide.' }
if (-not (Get-ScheduledTask -TaskName 'GDSP Node' -ErrorAction SilentlyContinue)) { throw 'Tâche GDSP Node introuvable : ne rien installer.' }
$name = 'GDSP Mobile Update'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'La tâche existe déjà. La vérifier localement ; aucune tâche remplacée.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $args -WorkingDirectory $repo
# Pas de mot de passe Windows stocké ; la session de ce compte doit rester ouverte.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
if ($PSCmdlet.ShouldProcess($name,'Installer une tâche déclenchée uniquement à la demande')) {
    Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Description 'Mise à jour GDSP approuvée : dépôt fixe, sauvegarde et contrôle local.' | Out-Null
    Write-Host 'Tâche installée sans déclenchement automatique. Activer séparément la fonction dans .env après vérification.'
    Write-Host 'La session Windows de ce compte doit rester ouverte (verrouillage autorisé).'
}

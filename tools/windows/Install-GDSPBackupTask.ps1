[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE 'GDSP-Backups'),
    [string]$PgBin = '',
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$At = '20:00'
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Backup-GDSP.ps1'
# Pas de mot de passe Windows stocke : fonctionne seulement quand cet utilisateur est connecte.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($value in @($script,$Destination,$PgBin)) { if ($value.Contains('"')) { throw 'Guillemet interdit dans un chemin.' } }
$args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Destination "' + $Destination + '"'
if ($PgBin) { $args += ' -PgBin "' + $PgBin + '"' }
# Exiger une premiere sauvegarde lisible avant d'automatiser.
$latest = Get-ChildItem $Destination -Directory -ErrorAction Stop |
    Where-Object { $_.Name -match '^gdsp-\d{8}T\d{9}Z-[a-f0-9]{8}$' } |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) { throw 'Faire une premiere sauvegarde manuelle avant installation.' }
& $script -Mode Verify -BackupFolder $latest.FullName -PgBin $PgBin
$name = 'GDSP Backup'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'La tache GDSP Backup existe deja. La verifier avant toute modification ; aucune tache remplacee.' }
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $args
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
if ($PSCmdlet.ShouldProcess($name, 'Installer la sauvegarde quotidienne (session utilisateur ouverte requise)')) {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Sauvegarde privee GDSP sur disque local. Verifier regulierement LastTaskResult et tester la restauration.' | Out-Null
    Write-Host "Tache installee a $At pour $user. Le PC doit etre allume et la session ouverte (verrouillage autorise)."
    Write-Host 'Une session fermee ou un PC eteint ne garantit pas la sauvegarde quotidienne. Aucun mot de passe Windows enregistre.'
}

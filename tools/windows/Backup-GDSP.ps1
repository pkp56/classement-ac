[CmdletBinding()]
param(
    [ValidateSet('Backup','Verify','RestoreTest')][string]$Mode = 'Backup',
    [string]$Destination = (Join-Path $env:USERPROFILE 'GDSP-Backups'),
    [string]$PgBin = '',
    [string]$BackupFolder = '',
    [ValidateSet('main','events')][string]$Database = 'main'
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $repo '.env') -PathType Leaf)) { throw 'Fichier .env absent du depot.' }
if (-not $PgBin) {
    $candidates = @(Get-ChildItem "$env:ProgramFiles\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+$' } | Sort-Object { [int]$_.Name } -Descending)
    foreach ($candidate in $candidates) {
        $bin = Join-Path $candidate.FullName 'bin'
        if (Test-Path (Join-Path $bin 'pg_dump.exe')) { $PgBin = $bin; break }
    }
}
foreach ($tool in @('pg_dump.exe','pg_restore.exe','createdb.exe')) {
    if (-not $PgBin -or -not (Test-Path (Join-Path $PgBin $tool) -PathType Leaf)) {
        throw 'Outils PostgreSQL introuvables. Indiquer -PgBin avec le dossier bin de PostgreSQL.'
    }
}
if ($Mode -eq 'Backup') {
    $Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if ($Destination -eq $repo -or $Destination.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $repo.StartsWith($Destination + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Destination -eq $env:USERPROFILE.TrimEnd('\')) { throw 'Choisir un sous-dossier dedie, hors du depot.' }
    # Refuser les jonctions/liens sur le chemin avant d'y copier des secrets.
    $cursor = $Destination
    while ($cursor) {
        if ((Test-Path $cursor) -and ((Get-Item $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Destination avec jonction/lien refusee.' }
        $parent = Split-Path $cursor -Parent
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
    $marker = Join-Path $Destination '.gdsp-backup-root'
    if ((Test-Path $Destination) -and -not (Test-Path $marker) -and @(Get-ChildItem $Destination -Force).Count -gt 0) {
        throw 'Dossier non vide et non initialise par GDSP : choisir un nouveau dossier dedie.'
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    # Dossier prive pour le compte qui execute la sauvegarde et SYSTEM.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Destination '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Protection NTFS impossible : aucune sauvegarde lancee.' }
    New-Item -ItemType File -Path $marker -Force | Out-Null
    $action = 'backup'; $target = $Destination
} else {
    if (-not $BackupFolder -or -not (Test-Path $BackupFolder -PathType Container)) { throw 'Indiquer -BackupFolder avec un dossier gdsp-... existant.' }
    $action = if ($Mode -eq 'Verify') { 'verify' } else { 'restore-test' }
    $target = [IO.Path]::GetFullPath($BackupFolder)
}
Push-Location $repo
try {
    # Node >= 20.12 : charger le vrai .env, sans le parser approximativement en PowerShell.
    # Retirer les valeurs heritees qui pourraient masquer celles du fichier du site.
    $keys = @('DATABASE_URL','EVENTS_DATABASE_URL','GLOBAL_EXCLUSIONS_FILE')
    $saved = @{}
    foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$null,'Process') }
    try {
        & $node '--env-file=.env' (Join-Path $repo 'tools\backup\backup.js') $action $target $PgBin $Database
        if ($LASTEXITCODE -ne 0) { throw 'Operation echouee. Ne pas considerer cette sauvegarde/restauration comme valide.' }
    } finally {
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
    }
} finally { Pop-Location }

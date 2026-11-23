[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dir = Join-Path $repo 'data\mobile-updates'
$requestFile = Join-Path $dir 'request.json'
$statusFile = Join-Path $dir 'status.json'
$target = ''
# Étape fixe et sans donnée sensible pour diagnostiquer un échec distant.
$phase = 'préparation'
$stopped = $false
$port = 0
function Set-UpdateStatus([string]$state,[string]$message) {
    $result = @{state=$state;target=$target;message=$message;at=[DateTime]::UtcNow.ToString('o')}
    [IO.File]::WriteAllText($statusFile,($result | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
function Git {
    param([string[]]$arguments)
    # Git peut écrire des messages normaux sur stderr (notamment fetch).
    # Windows PowerShell 5 traite ceux-ci comme des erreurs si Stop est actif.
    $ErrorActionPreference = 'Continue'
    $result = & git.exe @arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'git-failed' }
    return ($result | Out-String).Trim()
}
function Install-Dependencies {
    # npm écrit normalement sur stderr ; seul son code de sortie indique l'échec.
    $ErrorActionPreference = 'Continue'
    & npm.cmd ci --no-audit --no-fund 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm-failed' }
}
function Assert-Clean {
    if ((Git -arguments @('branch','--show-current')) -ne 'main') { throw 'branch' }
    if ((Git -arguments @('remote','get-url','origin')).TrimEnd('/') -ne 'https://github.com/pkp56/classement-ac.git') { throw 'origin' }
    if (Git -arguments @('status','--porcelain')) { throw 'dirty' }
}
function Is-PortListening([int]$number) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $number -ErrorAction SilentlyContinue)
}
Push-Location $repo
try {
    if (-not (Test-Path $requestFile -PathType Leaf)) { return }
    $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $target = [string]$request.target
    if ($target -cnotmatch '^[a-f0-9]{40}$') { throw 'invalid-request' }
    $when = [DateTimeOffset]::Parse([string]$request.requestedAt)
    $age = ([DateTimeOffset]::UtcNow - $when).TotalMinutes
    if ($age -lt -1 -or $age -gt 5) { throw 'expired-request' }
    Set-UpdateStatus 'running' 'Vérification de la version et sauvegarde.'
    $env:GIT_TERMINAL_PROMPT = '0'
    $phase = 'contrôles du dépôt et de la tâche'
    Assert-Clean
    $task = Get-ScheduledTask -TaskName 'GDSP Node' -ErrorAction Stop
    if ($task.State -ne 'Running') { throw 'node-task-not-running' }
    if (-not (Test-Path (Join-Path $repo '.env') -PathType Leaf)) { throw 'env-missing' }
    # Node lit le .env avec son parseur officiel (pas de secrets affichés).
    $phase = 'contrôle du serveur'
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
    $portValue = & node.exe '--env-file=.env' '-p' 'process.env.PORT || "10000"' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse([string]$portValue,[ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'invalid-port' }
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3 } catch { throw 'health-before' }
    if ($health.ok -ne $true -or $health.service -ne 'gdsp-frontend') { throw 'health-before' }
    $phase = 'récupération Git'
    $oldHead = Git -arguments @('rev-parse','HEAD')
    [void](Git -arguments @('fetch','--no-tags','origin','main'))
    if ((Git -arguments @('rev-parse','FETCH_HEAD')) -cne $target) { throw 'target-changed' }
    & git.exe merge-base --is-ancestor $oldHead $target 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'not-fast-forward' }
    # Exiger une vraie sauvegarde PostgreSQL + .env avant toute interruption.
    $phase = 'sauvegarde'
    & (Join-Path $PSScriptRoot 'Backup-GDSP.ps1') -Mode Backup | Out-Null
    Assert-Clean
    if ((Git -arguments @('rev-parse','HEAD')) -cne $oldHead) { throw 'head-changed' }
    $oldLock = Git -arguments @('rev-parse','HEAD:package-lock.json')
    $oldPackage = Git -arguments @('rev-parse','HEAD:package.json')
    Set-UpdateStatus 'running' 'Sauvegarde terminée. Mise à jour et redémarrage en cours.'
    $phase = 'arrêt du serveur'
    Stop-ScheduledTask -TaskName 'GDSP Node' -ErrorAction Stop
    $stopped = $true
    $limit = [DateTime]::UtcNow.AddSeconds(30)
    do { Start-Sleep -Seconds 1; $state = (Get-ScheduledTask -TaskName 'GDSP Node').State } while ($state -eq 'Running' -and [DateTime]::UtcNow -lt $limit)
    if ($state -eq 'Running' -or (Is-PortListening $port)) { throw 'node-still-running' }
    Assert-Clean
    if ((Git -arguments @('rev-parse','HEAD')) -cne $oldHead) { throw 'head-changed' }
    $phase = 'fusion Git'
    # Refuser aussi l'écrasement de fichiers locaux ignorés par Git (par exemple
    # un script conservé dans .git/info/exclude). Ne jamais les supprimer.
    [void](Git -arguments @('merge','--ff-only','--no-overwrite-ignore',$target))
    $newLock = Git -arguments @('rev-parse','HEAD:package-lock.json')
    $newPackage = Git -arguments @('rev-parse','HEAD:package.json')
    if ($oldLock -ne $newLock -or $oldPackage -ne $newPackage) {
        $phase = 'installation des dépendances'
        Install-Dependencies
    }
    $phase = 'redémarrage du serveur'
    Start-ScheduledTask -TaskName 'GDSP Node' -ErrorAction Stop
    $stopped = $false
    $healthy = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try { $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2; if ($response.ok -eq $true -and $response.service -eq 'gdsp-frontend') { $healthy=$true; break } } catch {}
    }
    if (-not $healthy) { throw 'health-failed' }
    Set-UpdateStatus 'completed' 'Mise à jour installée et service redémarré. Vérifie le site et les données.'
} catch {
    $problem = [string]$_.Exception.Message
    $msg = switch ($problem) {
        'dirty' { 'Dépôt modifié : aucune mise à jour. Vérifie les fichiers sur le PC.' }
        'target-changed' { 'La version distante a changé : vérifie à nouveau sur le mobile.' }
        'expired-request' { 'Demande expirée : vérifie à nouveau sur le mobile.' }
        'node-task-not-running' { 'La tâche GDSP Node ne fonctionne pas : vérifie le PC.' }
        'node-still-running' { 'Ancien serveur encore actif : pas de seconde instance lancée.' }
        'health-failed' { 'Serveur non vérifié après redémarrage : intervention sur le PC nécessaire.' }
        default { "Mise à jour interrompue pendant : $phase. Vérifie la sauvegarde, Git et la tâche sur le PC." }
    }
    if ($stopped) {
        try {
            if ($port -gt 0 -and -not (Is-PortListening $port) -and (Get-ScheduledTask -TaskName 'GDSP Node').State -ne 'Running') {
                Start-ScheduledTask -TaskName 'GDSP Node' -ErrorAction Stop
            }
        } catch { $msg += ' Redémarrage automatique impossible.' }
    }
    try { Set-UpdateStatus 'failed' $msg } catch {}
} finally {
    # Après erreur ou succès : une nouvelle vérification est nécessaire.
    if (Test-Path $requestFile -PathType Leaf) { Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue }
    Pop-Location
}

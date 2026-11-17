# Relie les mods de D:\content et E:\content au jeu, sans déplacer ni supprimer.
# Sans -Apply : aperçu seulement. Fermer CM, Assetto Corsa et le serveur avant -Apply.
[CmdletBinding()]
param(
    [string]$GameContent = 'C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content',
    [string[]]$ExternalContent = @('D:\content', 'E:\content'),
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $GameContent -PathType Container)) {
    throw "Dossier du jeu introuvable : $GameContent. Aucun lien cree."
}
$seen = @{}
foreach ($source in $ExternalContent) {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        Write-Warning "Disque ou dossier absent, ignore : $source"
        continue
    }
    foreach ($type in @('cars', 'tracks')) {
        $sourceFolder = Join-Path $source $type
        if (-not (Test-Path -LiteralPath $sourceFolder -PathType Container)) { continue }
        $destinationFolder = Join-Path $GameContent $type
        foreach ($mod in (Get-ChildItem -LiteralPath $sourceFolder -Directory | Sort-Object Name)) {
            # Ne suit pas des jonctions externes : evite les boucles de liens.
            if (($mod.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Write-Warning "Lien source ignore : $($mod.FullName)"
                continue
            }
            $key = "$type/$($mod.Name)"
            if ($seen.ContainsKey($key)) {
                Write-Host "DOUBLON IGNORE (priorite au premier disque) : $key"
                continue
            }
            $seen[$key] = $true
            $destination = Join-Path $destinationFolder $mod.Name
            # Get-Item detecte aussi une jonction existante ; aucun remplacement.
            $existing = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
            if ($null -ne $existing -or (Test-Path -LiteralPath $destination)) {
                Write-Host "DEJA PRESENT, CONSERVE : $destination"
                continue
            }
            if (-not $Apply) {
                Write-Host "A CREER : $destination -> $($mod.FullName)"
                continue
            }
            if (-not (Test-Path -LiteralPath $destinationFolder -PathType Container)) {
                New-Item -ItemType Directory -Path $destinationFolder | Out-Null
            }
            try {
                # Aucun -Force, Remove-Item, Move-Item ou remplacement de fichiers.
                New-Item -ItemType Junction -Path $destination -Target $mod.FullName | Out-Null
                Write-Host "LIEN CREE : $destination -> $($mod.FullName)"
            } catch {
                throw "Creation refusee pour $destination : $($_.Exception.Message). Aucun fichier existant n'a ete supprime. Verifier les droits (PowerShell administrateur si necessaire)."
            }
        }
    }
}
if (-not $Apply) {
    Write-Host "APERCU TERMINE : aucun fichier modifie. Relancer avec -Apply pour creer les jonctions apres verification."
}

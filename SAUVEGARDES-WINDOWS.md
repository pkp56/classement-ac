# Sauvegardes privées GDSP sur Windows

## État et précautions

Outils préparés, **pas encore installés ni exécutés sur le PC Windows**. Les tests automatisés simulent les outils PostgreSQL ; ils ne prouvent pas qu'une restauration réelle a réussi. PostgreSQL et PowerShell ne sont pas disponibles dans l'environnement de préparation.

Destination proposée : **`C:\Users\petitpkp\GDSP-Backups`**, hors du site et du dépôt Git. Cette copie protège contre une erreur de manipulation ou une perte de données applicative, **pas contre une panne de C:, un vol ou un ransomware**. Prévoir ensuite une copie sur un support indépendant. Le dossier n'est pas chiffré : il est privé par permissions NTFS, pour le compte utilisateur et SYSTEM ; les administrateurs du PC restent capables d'y accéder.

**Ne jamais publier ni envoyer les archives, `.env`, `config.env` ou les mots de passe.** Les archives contiennent des données privées et la configuration contient des secrets. Ne pas les placer dans le dossier servi par le site, dans GitHub, ou dans un dossier partagé.

## Contenu et garanties

Chaque dossier `gdsp-...` réussi contient :

- `main.dump` pour DATABASE_URL ; `events.dump` si EVENTS_DATABASE_URL désigne une autre base ; format PostgreSQL custom ;
- `config.env`, copie du `.env` du dépôt ;
- `global-exclusions.json` si présent (ou GLOBAL_EXCLUSIONS_FILE configuré) ;
- les fichiers locaux `telemetry-store.json` et `live-history.json` s'ils existent ; les fichiers facultatifs absents sont indiqués dans le manifeste ;
- `manifest.json` : date, inventaire et empreintes SHA-256, sans URL de connexion.

Les outils refusent les bases non locales et les options de connexion non prises en charge (seul sslmode est accepté). Les secrets de connexion passent à PostgreSQL dans son environnement, pas dans la ligne de commande ni le journal affiché. Le lanceur charge le `.env` du site et non une ancienne DATABASE_URL héritée du shell.

`pg_dump` utilise un instantané cohérent de chaque base et ne requiert pas d'arrêter le site. En revanche, deux bases distinctes ne sont pas prises au même instant et les fichiers JSON/configuration ne partagent pas la transaction PostgreSQL. Éviter une maintenance ou une modification de configuration pendant la sauvegarde. Le dump ne sauvegarde pas les rôles/mots de passe PostgreSQL globaux ni l'installation du serveur, les mods du jeu ou le Caddyfile externe. Préserver ces éléments séparément en lieu privé.

Une archive n'est finalisée qu'après réussite des dumps, lecture de leur catalogue par pg_restore, copie des fichiers et vérification des empreintes. La rotation conserve **les 14 derniers dossiers complets et intègres**, pas nécessairement 14 jours. Elle ne commence qu'après une nouvelle sauvegarde réussie et ne supprime pas les dossiers inconnus/incomplets. Les échecs retournent un code non nul. Un verrou empêche deux sauvegardes simultanées.

## Prérequis

- Mise à jour contenant ces scripts intégrée à main et récupérée sur le PC (ne pas lancer avant publication).
- PowerShell Windows 5.1 et Node récent (20.12 ou supérieur conseillé, avec prise en charge de `--env-file`).
- PostgreSQL local démarré et DATABASE_URL / EVENTS_DATABASE_URL fonctionnels dans `.env`.
- Outils `pg_dump.exe`, `pg_restore.exe`, `createdb.exe` de la même version majeure que le serveur de préférence. Le lanceur cherche la version installée la plus élevée sous `C:\Program Files\PostgreSQL\<version>\bin` ; indiquer -PgBin pour choisir explicitement la bonne installation.
- Assez d'espace libre pour la nouvelle sauvegarde **avant** suppression des anciennes, et les 14 archives à conserver.

## 1. Première sauvegarde manuelle

Dans PowerShell, sous le même compte que celui qui possédera la tâche :

```powershell
cd "C:\Users\petitpkp\classement-ac"
node --version
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Backup-GDSP.ps1
```

La commande doit afficher **« Sauvegarde terminée »** et un dossier complet. En cas d'erreur, s'arrêter et corriger avant installation automatique. Ne pas envoyer la configuration pour diagnostiquer. Si les outils ne sont pas détectés, adapter la version réelle, par exemple :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Backup-GDSP.ps1 -PgBin "C:\Program Files\PostgreSQL\17\bin"
```

Aucune modification de `.env`, aucun arrêt de GDSP Node, aucune modification de la base officielle ne sont nécessaires pour une sauvegarde.

## 2. Vérifier l'intégrité de la dernière archive

```powershell
$latest = Get-ChildItem "$env:USERPROFILE\GDSP-Backups" -Directory |
    Where-Object { $_.Name -match '^gdsp-\d{8}T\d{9}Z-[a-f0-9]{8}$' } |
    Sort-Object Name -Descending | Select-Object -First 1

if (-not $latest) { throw "Aucune sauvegarde GDSP trouvee" }

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Backup-GDSP.ps1 -Mode Verify -BackupFolder $latest.FullName
```

Ajouter le même -PgBin si nécessaire. Cette commande vérifie SHA-256 et le catalogue PostgreSQL, **pas une restauration complète**.

## 3. Tester réellement une restauration isolée

Après une première sauvegarde réussie, avec `$latest` défini comme ci-dessus :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Backup-GDSP.ps1 -Mode RestoreTest -BackupFolder $latest.FullName -Database main
```

Si seule EVENTS_DATABASE_URL est définie, ou pour tester sa base distincte, utiliser `-Database events` pour le dump correspondant. Le compte PostgreSQL doit pouvoir créer une base ; si ce droit manque, ne pas contourner le problème en restaurant dans la base officielle.

Cette commande :

1. vérifie l'archive ;
2. crée une **nouvelle base au nom généré** `gdsp_restore_test_<date>_<aléatoire>` ;
3. y restaure le dump avec arrêt à la première erreur, sans `--clean`, sans appliquer les anciens propriétaires/privilèges ;
4. affiche le nom seulement si pg_restore a réussi.

Elle ne change jamais DATABASE_URL ni la cible du site. La base de test est conservée pour inspection ; même en cas d'échec de restauration, elle peut rester partiellement remplie. Ne pas multiplier les essais indéfiniment sans nettoyer les bases de test identifiées avec certitude.

Contrôler ensuite dans pgAdmin les tables et quelques événements attendus, sans modifier la base officielle. Ne considérer la restauration comme validée qu'après cet essai réel et cette inspection. Les archives doivent provenir d'une source de confiance : les empreintes détectent la corruption mais ne sont pas une signature contre une falsification malveillante.

**Une récupération de production après incident doit être accompagnée** : arrêter les écritures, préserver la base endommagée, restaurer d'abord dans une nouvelle base et vérifier avant toute bascule. Aucun bouton de remplacement automatique de gdsp_local n'est fourni.

## 4. Installer la tâche quotidienne

Après réussite de la première sauvegarde (idéalement de la restauration test aussi) :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Install-GDSPBackupTask.ps1 -At "20:00"
```

Ajouter -PgBin si un chemin explicite a été nécessaire précédemment. L'installateur revérifie la dernière archive, refuse d'écraser une tâche existante et crée **GDSP Backup**, sans modifier **GDSP Node**. Si Windows refuse l'inscription, utiliser PowerShell administrateur sous le même compte.

**Limite importante : le PC doit être allumé et la session de cet utilisateur ouverte (verrouillée autorisée).** Aucun mot de passe Windows n'est demandé ni enregistré. La tâche n'est pas conçue pour s'exécuter après fermeture de session. StartWhenAvailable permet de rattraper une exécution manquée quand Windows le permet, mais ne garantit pas une sauvegarde chaque jour si le PC est éteint/déconnecté. Choisir un horaire où le PC est habituellement utilisé. Un fonctionnement garanti hors session nécessite une configuration dédiée ultérieure.

Déclencher une première exécution automatique et contrôler **après sa fin** :

```powershell
Start-ScheduledTask -TaskName "GDSP Backup"
Get-ScheduledTask -TaskName "GDSP Backup" | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "GDSP Backup" |
    Select-Object LastRunTime, LastTaskResult, NextRunTime
```

Après exécution terminée, LastTaskResult doit être **0** et un nouveau dossier complet doit être apparu. Pendant l'exécution, un autre code peut simplement indiquer qu'elle est encore en cours. En cas d'échec, relancer manuellement Backup-GDSP.ps1 pour obtenir le message lisible, sans publier les archives. Il n'y a pas d'alerte automatique par mail : contrôler régulièrement le dernier dossier et le résultat de tâche.

## Incident de verrou ou de disque

En cas de coupure brutale, `.gdsp-backup.lock` et un dossier `.partial-...` peuvent rester : l'outil ne supprime pas automatiquement un verrou potentiellement actif. Vérifier qu'aucune sauvegarde ne tourne avant toute intervention ; demander de l'aide plutôt que supprimer des fichiers à l'aveugle. Les archives complètes antérieures ne sont pas supprimées à cause d'un dump échoué.

Ne jamais supprimer la base officielle ni utiliser une commande de nettoyage global pour libérer de la place. Après validation, une copie indépendante des archives sur un autre support reste la prochaine amélioration à faire.

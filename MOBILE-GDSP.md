# Application GDSP mobile et mise à jour depuis le téléphone

## État

Cette première version est une **application web installable**, séparée de la
navigation PC : `/mobile/`. Elle affiche l'accueil, les événements actifs, leur
briefing, leur calendrier et les engagés. Le direct, les classements détaillés,
les fiches et l'administration complète ouvrent encore les pages existantes :
ce n'est pas encore une application mobile native complète.

Les données, sessions et réponses API ne sont jamais mises en cache par le
service worker : hors ligne, l'application affiche une erreur et non un faux
classement ancien. Il n'y a pas de notification push. Android/Chrome propose
l'installation lorsque ses critères sont remplis ; sur iPhone/Safari utiliser
**Partager → Sur l'écran d'accueil**. HTTPS est nécessaire hors localhost. Les
capacités exactes dépendent du navigateur et de sa version.

## Mise à jour à distance — expérimental, désactivé par défaut

**Ne pas activer sur le serveur officiel avant un essai Windows séparé**, avec
sauvegarde et vérification de restauration. Les tests automatisés peuvent
vérifier les règles Node et le contrôle d'accès, mais pas les tâches planifiées,
Git, `npm`, PostgreSQL, les droits NTFS ou le redémarrage sur ton PC réel.
Aucune modification n'est faite à `.env` ou aux tâches sans intervention locale.

L'administrateur se connecte depuis **Plus**, vérifie la version, puis saisit
une seconde clé et confirme l'interruption. Le téléphone ne choisit ni commande,
ni chemin, ni dépôt, ni branche. Le service n'accepte que la session cookie
administrateur locale avec protection CSRF, et une clé aléatoire distincte ;
les appels Bearer historiques sont refusés. La fonction est fermée sauf Windows,
`EVENTS_SOURCE=local`, activation explicite et empreinte de clé valide.

La tâche Windows séparée est lancée uniquement à la demande. Elle exige :

1. dépôt propre sur `main`, origine exactement `https://github.com/pkp56/classement-ac.git`, service `GDSP Node` en cours et healthz répondant sur le port de `.env` ;
2. commit `main` vérifié à nouveau, identique à celui confirmé sur le téléphone, et avance rapide possible ;
3. sauvegarde réussie avec `tools/windows/Backup-GDSP.ps1` (PostgreSQL local et `.env`) ;
4. arrêt de la tâche et absence de serveur sur le port avant mise à jour ; fusion rapide avec refus d'écraser des fichiers locaux ignorés ; `npm ci` uniquement si le manifeste ou le verrou de dépendances a changé ;
5. redémarrage de la même tâche et contrôle `/healthz`.

La demande et l'état sont dans `data/mobile-updates/`, ignorés par Git et
interdits à l'accès web direct. Ils ne contiennent ni clé ni mot de passe ;
l'état administratif ne divulgue pas les sorties des commandes. Une demande
unique bloque les doublons. Si le site est interrompu avant la réponse, attendre
et consulter son état avant de réessayer. Une demande coincée après un arrêt
brutal nécessite une inspection locale avant suppression manuelle.

**Limites importantes :** aucun retour arrière automatique Git/BDD n'est tenté ;
un échec après modification peut nécessiter une intervention locale et une
restauration. Un healthz réussi ne garantit pas que la base, les classements,
Caddy ou le jeu sont fonctionnels. Ne jamais lancer pendant une course ou un
travail simultané. Ne jamais utiliser `git reset --hard` ou nettoyer des fichiers
pour forcer une mise à jour. L'accès admin et une clé volés peuvent permettre de
déployer le code de `main` ; le mécanisme ne protège pas d'une compromission du
dépôt, d'une XSS sur le site ou du compte Windows. Protéger HTTPS, le PC, le
compte admin et la clé, et limiter l'accès réseau autant que possible.

### Préparation manuelle sur le PC de test uniquement

1. Confirmer une sauvegarde et une restauration de test selon
   `SAUVEGARDES-WINDOWS.md`. Le script de sauvegarde doit fonctionner sans
   intervention sous le compte Windows qui exécute les tâches. Le disque doit
   disposer d'assez d'espace. Préserver aussi `assets/mod-previews/`.
2. Vérifier que `GDSP Node` est une tâche planifiée exécutée par ce même compte,
   que la session Windows restera ouverte, que `git.exe`, `node.exe`, `npm.cmd`,
   les outils PostgreSQL et `schtasks.exe` sont utilisables sans invite, que
   `.env` contient le bon `PORT` et que `origin` et `main` sont corrects.
3. Installer la tâche **après lecture du script** :

   ```powershell
   Set-Location "C:\Users\petitpkp\classement-ac"
   .\tools\windows\Install-GDSPMobileUpdateTask.ps1 -WhatIf
   # Après vérification du compte et du résultat :
   .\tools\windows\Install-GDSPMobileUpdateTask.ps1
   ```

   Elle est limitée au compte courant, sans mot de passe Windows enregistré,
   sans déclenchement périodique. Si le compte est déconnecté ou les droits
   insuffisants, elle ne fonctionnera pas. Elle ne remplace pas une tâche existante.
4. Générer **localement** une clé aléatoire de 32 octets et son empreinte. Ne pas
   copier la clé dans le chat, Git, `.env`, une URL, un journal ou une capture.
   Conserver la clé dans un gestionnaire de mots de passe ; seule l'empreinte
   peut être ajoutée à `.env`. Exécuter dans une fenêtre privée :

   ```powershell
   $key = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
   $env:GDSP_TEMP_UPDATE_KEY = $key
   $hash = node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.GDSP_TEMP_UPDATE_KEY).digest('hex'))"
   Remove-Item Env:GDSP_TEMP_UPDATE_KEY
   Write-Host "Clé à sauvegarder en privé : $key"
   Write-Host "Empreinte seule pour .env : $hash"
   ```

   Ajouter manuellement à `.env` les lignes
   `GDSP_MOBILE_UPDATE_ENABLED=1` et `GDSP_MOBILE_UPDATE_KEY_HASH=<empreinte>`
   en remplaçant `<empreinte>` sur le PC. Ne pas y mettre la clé. Redémarrer
   **une seule fois** GDSP Node selon la procédure habituelle. Pour désactiver,
   retirer l'activation puis redémarrer ; supprimer/rotater la clé compromise.
5. Depuis HTTPS sur le téléphone, installer l'application, ouvrir **Plus**,
   se connecter, vérifier l'état. Tester d'abord sur un dépôt/PC et des données
   sans importance, puis tester une véritable mise à jour approuvée, y compris
   les échecs (mauvaise clé, dépôt sale, tâche absente, sauvegarde impossible,
   port occupé, redémarrage et réseau interrompu). Vérifier les sauvegardes et
   l'application après chaque essai. Ne pas conclure à partir de healthz seul.

L'installation et l'activation ne sont **pas** effectuées automatiquement par
le site ; l'aperçu de développement ne permet pas de déclencher de mise à jour.

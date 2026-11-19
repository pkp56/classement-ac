# Catalogue local de mods — C:, D: et E:

## Les trois emplacements prévus

Sans changer `.env`, le serveur Node examine, dans cet ordre :

```text
C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content
D:\content
E:\content
```

Chaque racine contient normalement les sous-dossiers `cars` et `tracks` :

```text
D:\content\cars\identifiant_voiture\ui\ui_car.json
D:\content\tracks\identifiant_circuit\ui\ui_track.json
D:\content\tracks\identifiant_circuit\ui\variante\ui_track.json
```

**D: et E: sont optionnels.** Ils peuvent être installés plus tard : un disque absent est signalé puis ignoré. Après installation de nouveaux mods, actualiser le catalogue dans le site. Le compte Windows exécutant **GDSP Node** doit pouvoir lire les trois racines.

Une autre configuration est possible, uniquement côté serveur dans `.env` (séparateur `;`, chemins avec `/` pour éviter les ambiguïtés d'échappement) :

```dotenv
AC_CONTENT_ROOTS=C:/Program Files (x86)/Steam/steamapps/common/assettocorsa/content;D:/content;E:/content
```

Cette ligne est facultative pour les trois chemins ci-dessus. Ne pas remplacer le reste de `.env`. Redémarrer Node après une modification de cette variable. Une valeur vide désactive toutes les racines.

## Ce que fait le site

**Administration → Événements** contient un panneau « Mods installés · catalogue du PC serveur » :

1. **Actualiser les voitures et circuits** analyse les dossiers configurés.
2. Affichage des sources accessibles / absentes, compte des voitures et des circuits / variantes, avertissements éventuels.
3. Rechercher et sélectionner une ou plusieurs voitures (Ctrl + clic dans la liste) et un circuit / variante.
4. Utiliser **Créer un événement** : la sélection est enregistrée avec l'événement ; si une date et un circuit ont été choisis, une première manche prévue est ajoutée.
5. Pour un événement existant, utiliser **Enregistrer la sélection**. La présentation « Voiture / Plateau » est actualisée avec les voitures choisies.
6. Pour un championnat à plusieurs manches, choisir le circuit et la date de chaque manche, puis **Ajouter la manche sélectionnée**. Cette opération ne modifie pas les résultats déjà importés.

Pour l’onglet **Voiture**, le scanner lit aussi `cars/<identifiant>/ui/ui_car.json` : nom, marque, classe, année, pays, auteur, version, URL, description, tags et caractéristiques. Les courbes `powerCurve` et `torqueCurve` sont conservées et affichées en graphiques avec leurs valeurs détaillées. Après une nouvelle analyse, il faut enregistrer de nouveau la sélection d’un événement existant pour actualiser sa fiche sauvegardée.

Les sélections sauvegardent les identifiants, les noms et les données de fiche retenues. Elles restent présentes si un disque est débranché ou un mod supprimé ; le menu les signale alors « disponibilité à vérifier ». Un rescan n'efface jamais l'historique des événements. Le catalogue est gardé en mémoire : après redémarrage Node, il faut relancer une analyse. Les choix des événements, eux, restent dans la base.

Si un mod est présent sur plusieurs disques, priorité au premier emplacement : C:, puis D:, puis E:. Une variante de circuit reste distincte de ses autres tracés. Un dossier sans métadonnées exploitables est affiché avec son identifiant et la mention « nom de dossier » ; ce n'est pas une validation que le mod est jouable.

### Actualiser une fiche déjà publiée

Ouvrir l’événement voulu, puis **Administration → Événements → Actualiser les circuits**. Sur la ligne de la manche, cliquer sur **Actualiser depuis Mod local** ou **Actualiser depuis Drive**. La source est celle de la fiche : inutile de recopier le lien Drive ou de créer une nouvelle manche. Le serveur relit les fichiers, recalcule le tracé, le profil, les secteurs et les surfaces disponibles, et enregistre la fiche dans cet événement. Le numéro, la date et les résultats sont conservés. Un mod absent ou une erreur de lecture empêchant l’import n’efface pas la fiche précédente. Pour une manche sans source identifiable, utiliser le secours manuel **Administration → Circuits**.

Le bouton **Actualiser les voitures et circuits** de l’onglet Gestion ne fait qu’analyser le catalogue. Il n’y a pas de surveillance automatique des disques ni de Drive : après modification des fichiers, actualiser la manche concernée. Les visiteurs verront sa nouvelle fiche en rechargeant l’événement.

### Traduire les descriptions des mods

Dans **Administration → Événements → Traduction**, le texte original de chaque description importée (voiture ou circuit) reste consultable. Saisir le français, puis cliquer sur **Enregistrer la traduction** sous le champ concerné. Vider le champ et enregistrer pour revenir à l’original. La traduction est propre à l’événement et indépendante du prochain import ; aucun fichier du mod ou de Drive n’est modifié. Si une ancienne fiche n’a pas de description, actualiser d’abord le circuit ou la sélection des voitures. Une description doit être présente dans le fichier UI du mod.

### Bandeaux et carte interactive (imports locaux)

- **Circuit** : création, ajout de manche et actualisation recherchent le `preview.png` ou `preview.jpg` près du `ui_track.json` de la variante. Le bandeau reprend les informations de piste disponibles. Un aperçu manquant laisse le fond habituel. `fast_lane.ai` alimente la carte et le profil : déplacer **Explorer le tour** ou sélectionner un repère (souris, tactile, clavier) pour lire distance et altitude. Les noms des portions proviennent des plages `IN`/`OUT` et du `TEXT` de `sections.ini` ; sans ce fichier, les virages détectés restent numérotés. Les tiers estimés ne sont pas des secteurs officiels.
- **Voiture(s)** : à la création ou via **Enregistrer la sélection**, le serveur parcourt les 80 premiers dossiers de `cars/<id>/skins` par ordre de nom. `preview.jpg`, `preview.png` ou `preview.jpeg` et, si présent, `ui_skin.json` alimentent le diaporama de chaque voiture (nom, équipe, numéro). Sans métadonnées, le nom du dossier sert de légende ; sans image, la livrée est ignorée. Défilement toutes les 5 secondes, avec pause, choix direct et flèches ; lecture manuelle si le navigateur demande moins d’animations.
- **Stockage Windows** : seules les images reconnues, jusqu’à 3 Mio chacune, sont copiées dans `assets/mod-previews` du site. Le compte **GDSP Node** doit pouvoir écrire dans ce dossier. Les doublons sont réutilisés. Les événements enregistrent les références, pas les images en base : **inclure ce dossier dans la sauvegarde du PC** pour conserver les photos même si le mod est retiré. Ne pas le nettoyer lors d’un `git pull`.
- Pour un **événement existant**, utiliser **Actualiser les circuits → Actualiser depuis Mod local** pour les manches locales, et **Gestion → Enregistrer la sélection** pour les voitures. Le simple scan du catalogue ne modifie pas les fiches déjà publiées.

### Limites de cette version

- Seuls les aperçus PNG/JPEG des mods sélectionnés sont copiés et publiés ; aucune distribution du mod complet.
- Pas de téléchargement public des fichiers de voiture, circuit, physique ou livrée.
- Pas d'écriture dans les dossiers du jeu par le site.
- Pas d'installation, d'extraction d'archive ni de configuration ACSM / serveur CM à distance.
- Le scanner ne suit une jonction que si sa destination reste dans une racine configurée. Une jonction vers un autre emplacement est ignorée ; ajouter explicitement cet emplacement dans la configuration si nécessaire.
- Pas de modification de la formule du Global ni des décisions de commission.

Les API `/api/admin/local-mods` et `/api/admin/local-mods/scan` nécessitent une connexion administrateur. Elles n'acceptent pas de chemin fourni par le navigateur. Les métadonnées sont échappées à l'affichage et le scan a une limite de volume.

## Préparer les dossiers sur les nouveaux disques

À faire seulement lorsque les disques existent. Cette commande crée les dossiers manquants, sans déplacer les mods existants :

```powershell
foreach ($drive in @('D:', 'E:')) {
    if (Test-Path "$drive\") {
        New-Item -ItemType Directory -Force -Path "$drive\content\cars", "$drive\content\tracks"
    }
}
```

Installer les dossiers complets des mods sous `cars` ou `tracks` (pas un dossier `content` supplémentaire imbriqué). Garder des lettres de disques stables ; un SSD interne est préférable. Ne pas reformater un disque contenant déjà des données.

## Rendre aussi les mods externes visibles à CM et au jeu (facultatif)

Le catalogue du **site** peut lire directement D: et E:. En revanche **CM et Assetto Corsa ne découvrent pas automatiquement ces emplacements**. Il leur faut des jonctions dans le dossier `content` du jeu.

Un script est fourni : `tools\windows\Link-ExternalMods.ps1`.

- Il laisse les mods existants sur C: en place.
- Il prépare une jonction par voiture / circuit de D:, puis E:, vers le dossier du jeu.
- Il ne remplace jamais un dossier ou une jonction déjà présents et ne déplace / supprime aucun fichier.
- En cas de doublon D:/E:, D: est prioritaire.
- Il ignore les disques absents et les sources qui sont elles-mêmes des jonctions.
- **Sans `-Apply`, c'est seulement un aperçu.**

Après avoir récupéré la mise à jour GitHub, dans PowerShell :

```powershell
cd C:\Users\petitpkp\classement-ac
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Link-ExternalMods.ps1
```

Examiner les lignes `A CREER`. Fermer CM, le jeu et les serveurs qui utilisent ces mods ; conserver une sauvegarde des mods. Pour créer les liens, si l'aperçu est correct :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\windows\Link-ExternalMods.ps1 -Apply
```

`ExecutionPolicy Bypass` ne concerne que ce processus PowerShell, pas la politique permanente du PC. Ne lancer que le script du dépôt vérifié. Si Windows refuse l'écriture dans `Program Files (x86)`, relancer PowerShell en administrateur après avoir vérifié l'aperçu. Le script n'a pas été exécuté sur un vrai PC Windows dans cette session : tester d'abord avec quelques mods sauvegardés.

Réouvrir CM et essayer une voiture et un circuit. Relancer le script après de nouvelles installations externes si elles doivent aussi être accessibles au jeu. Si un disque est absent, ses jonctions existantes ne fonctionneront pas jusqu'à son retour ; le script ne les supprime pas.

**ACSM / serveur dédié peut avoir son propre `content`** : ces jonctions concernent uniquement le jeu au chemin C: indiqué. Vérifier séparément le contenu du serveur ; ne pas supposer qu'il est synchronisé par ce script.

## Mettre le site à jour depuis GitHub

La proposition doit d'abord être fusionnée dans `main`. Ne pas utiliser les commandes de réinitialisation forcée si des changements locaux existent.

```powershell
cd C:\Users\petitpkp\classement-ac
git branch --show-current
git status --short --branch
```

Continuer seulement sur `main`. Si des fichiers sont modifiés, s'arrêter et les examiner. Le fichier local non suivi `data/global-exclusions.json`, déjà présent sur ce PC, doit être conservé (il peut être sauvegardé hors dépôt avant le pull).

```powershell
git pull --ff-only origin main
```

Cette fonctionnalité n'ajoute pas de dépendance. Si le pull inclut également d'autres changements à `package.json` / `package-lock.json`, arrêter **GDSP Node**, puis :

```powershell
npm.cmd ci
```

Dans le Planificateur de tâches : **GDSP Node → Terminer**, vérifier l'arrêt de l'ancienne instance, puis **Exécuter**. Ne pas lancer une deuxième instance Node dans une autre fenêtre.

Si le site est exclusivement lancé dans une fenêtre PowerShell, arrêter l'ancien processus avec Ctrl+C, puis :

```powershell
cd C:\Users\petitpkp\classement-ac
node --env-file=.env app.js
```

Ne jamais remplacer `.env` ni le publier sur GitHub. Ouvrir http://gdsp.duckdns.org puis **Ctrl+F5**, se connecter à Administration → Événements et lancer **Actualiser les voitures et circuits**. Le scan du site fonctionne sans lancer le script de jonctions.

## Vérifications

- C: accessible et D:/E: absents : le scan doit terminer sans bloquer.
- Ajouter un mod sur D:, rescanner : il apparaît dans le menu.
- Choisir deux variantes d'un même circuit : leurs identifiants de layout sont distincts.
- Enregistrer une sélection / manche, recharger la page : elle est conservée.
- Débrancher une source puis rescanner : l'événement conserve sa sélection historique.

Tests du dépôt : `npm.cmd test`. Pas de migration de base de données nécessaire.

### Alimenter les onglets du tracé

**Records par secteur** compare, secteur par secteur, les temps des tours sans coupe dans les JSON de qualification et de course du tracé, pour l’événement ouvert. **Carte des collisions** liste les contacts entre voitures et affiche un repère numéroté quand le JSON contient une `WorldPosition` et que la fiche possède la projection du tracé. `RelPosition` seule ne permet pas de localiser le contact sur le circuit.

Pour des sessions enregistrées avant cette mise à jour, réimporte manuellement les JSON de résultats d’origine : l’ancien import ne sauvegardait ni `Laps[].Sectors` ni `Events[].WorldPosition`. Il n’est pas nécessaire de supprimer les sessions avant de les réimporter. Pour placer les repères sur une ancienne fiche de mod importée, actualise aussi cette fiche depuis l’administration Circuits, avec son `fast_lane.ai`.

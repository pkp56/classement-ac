# Mise à jour du Global GDSP — Windows / Node

Cette version change le **Global inter-événements**, pas le barème des championnats, leurs points, leurs résultats, ni le calcul de performance propre aux fiches événement.

## Changements visibles

- Fenêtre des **10 dernières courses disputées** par pilote, tous événements chargés confondus. Les archives restent incluses comme auparavant ; ce n'est pas une limitation définitive au seul championnat Lola utilisé pour la simulation.
- Minimum **5 courses** pour apparaître au classement principal. De 5 à 9 : provisoire, toutes les courses disponibles comptent, pas de joker.
- Dès 10 : la course ayant la plus faible moyenne des quatre critères devient le joker sportif. Rythme, vitesse et résultats sont moyennés sur les 9 retenues ; **la propreté est moyennée sur les 10**, pour ne pas effacer les fautes de la course joker. À égalité, joker sur la plus ancienne course concernée.
- Courses de poids égal, fin de la pondération temporelle. Les DNS et résultats sans aucun tour enregistré ne sont pas des participations. Un abandon ayant roulé reste compté.
- Propreté : décisions explicitement qualifiées par la commission ; aucun retrait automatique depuis les contacts, les cuts, les secondes ajoutées ou les ajustements de points championnat.
- Retraits **par incident**, plancher de la note de course à 0 : avertissement 5, légère 10, importante 20, grave 35, DQ pour comportement 50. Une DQ technique ne doit pas être qualifiée comme faute de conduite.
- Attente / restitution validée : retrait divisé par deux pour l'incident concerné. Pas d'atténuation pour faute grave, DQ de conduite ou acte volontaire ; pas de bonus au-delà de 100 et pas de compensation d'un autre incident.
- Chaque incident est saisi une seule fois, même si avertissement et pénalité de temps portent sur ce même incident. Plusieurs incidents sur une course peuvent être saisis séparément.
- Statuts et détail de la fenêtre dans le profil Global : courses retenues, joker, notes de propreté, examens réalisés et décisions à qualifier. La tendance ancienne n'est plus présentée comme une progression actuelle : le classement affiche désormais la couverture des examens.
- **Real Penalty : non évalué sans journaux.** Aucun Drive Through ou Stop & Go n'est deviné, attribué ou importé dans cette version. Un futur import nécessitera l'étude du format réel des logs et la déduplication avec les décisions de commission.

### Données partielles : attention

La simulation exploratoire n'est **pas importée en production** : les catégories hypothétiques attribuées aux anciennes fautes ne deviennent pas des décisions officielles.

- Ancienne pénalité de temps / DQ / avertissement sans qualification : propreté indisponible pour cette course, signalée « décision à qualifier ».
- Aucune décision ni examen : valeur 100 = **aucun retrait connu**, pas « course certifiée propre ». Le score reste signalé partiel.
- Les valeurs indisponibles sont exclues de la moyenne de leur axe ; un axe sans aucune donnée utilise **50 neutre**. Les autres axes ont la même politique de données manquantes. Une valeur neutre n'est pas une sanction.
- Le score n'est confirmé qu'avec 10 courses, tous les examens de propreté de la fenêtre réalisés, aucune décision en attente et des données de rythme/vitesse suffisantes.
- Le score peut évoluer lors de la qualification des décisions : c'est une correction du niveau de connaissance, pas forcément une nouvelle faute.

## Avant l'installation

1. Sauvegarder les données du serveur / de la base selon votre installation. Ne pas confondre sauvegarde Git et sauvegarde des données.
2. Conserver le fichier `.env` local, sans le remplacer ni l'ajouter à Git. Ne jamais le partager.
3. Vérifier que les changements ont été **fusionnés dans `main` sur GitHub**. Une PR ouverte ne suffit pas pour `git pull origin main`.

## Installation dans PowerShell

```powershell
cd C:\Users\petitpkp\classement-ac
git branch --show-current
git status --short --branch
```

Continuer seulement si la branche est `main` et sans modifications locales à préserver. Sinon, s'arrêter et examiner les différences : ne pas utiliser `reset --hard`, `clean`, ni écraser la configuration.

```powershell
git rev-parse HEAD
git pull --ff-only origin main
```

Conserver le premier identifiant de commit pour le diagnostic en cas de problème. `Already up to date` signifie seulement que la copie correspond à `main` distant : si la PR n'a pas été fusionnée, elle n'est pas encore installée.

**Cette mise à jour ne modifie pas les dépendances : `npm.cmd ci` n'est pas nécessaire pour ce patch seul.** Si le pull apporte aussi d'autres changements à `package.json` ou `package-lock.json`, exécuter :

```powershell
npm.cmd ci
```

## Redémarrer une seule instance Node

### Si le site est géré par le Planificateur de tâches

Dans le Planificateur, sélectionner **GDSP Node**, faire **Terminer**, vérifier que l'ancienne instance est arrêtée, puis **Exécuter**. Ne pas lancer en parallèle une fenêtre Node manuelle.

Alternative PowerShell (adapter le nom / dossier de tâche s'ils diffèrent et utiliser les droits nécessaires) :

```powershell
Stop-ScheduledTask -TaskName "GDSP Node"
Get-ScheduledTask -TaskName "GDSP Node" | Select-Object TaskName, State
```

Quand la tâche est bien arrêtée et l'ancien processus Node terminé :

```powershell
Start-ScheduledTask -TaskName "GDSP Node"
```

En cas de port déjà occupé, ne pas démarrer une deuxième instance et ne pas tuer tous les processus Node : identifier l'ancienne instance GDSP.

### Si le site est lancé dans une fenêtre PowerShell

Arrêter l'ancien serveur avec **Ctrl+C** dans sa fenêtre, puis :

```powershell
cd C:\Users\petitpkp\classement-ac
node --env-file=.env app.js
```

## Après redémarrage

1. Ouvrir http://gdsp.duckdns.org puis **Ctrl+F5**. Les références des scripts ont aussi été versionnées pour renouveler le cache.
2. Ouvrir **Global** : vérifier le texte « 10 dernières courses » et les statuts provisoires / partiels.
3. Sur le championnat Lola exporté pour la simulation (9 courses), **aucun joker ne doit encore être actif**. Les données importées plus tard peuvent naturellement changer ce total.
4. Se connecter à **Administration → Commission**, sélectionner la manche. Pour chaque pilote de chaque course, utiliser **Propreté : à examiner**.
5. Indiquer le nombre d'incidents distincts, leur gravité, l'attente / restitution validée, un éventuel acte volontaire et un motif obligatoire. Indiquer **0** uniquement si l'examen conclut à aucune faute de conduite retenue, pas pour masquer une décision qui reste à examiner.
6. Vérifier la confirmation de sauvegarde serveur. En cas d'échec : les données sont conservées localement ; réessayer via **Données → Enregistrer sur le serveur**, sans fermer la page entre-temps.
7. Recharger la page et vérifier qu'un examen test est toujours présent. Cela vérifie aussi que le backend installé conserve bien le champ `penMap[clé].conduct`.
8. Faire une **Sauvegarde complète (commission incluse)** depuis l'onglet Données. L'ancien export des seules sessions reste disponible séparément. La sauvegarde complète est un export de précaution ; cette mise à jour n'ajoute pas de restauration automatique par import.

Une qualification ne change pas la sanction sportive existante. Modifier ensuite cette sanction demande confirmation et invalide sa qualification : la réexaminer. « Annuler l'examen » retire seulement la qualification, pas la sanction. Ne pas utiliser « Retirer » dans la liste des ajustements si l'on souhaite conserver une sanction sportive.

### Points à vérifier dans les anciennes décisions Lola

- Karl74 : commentaire identique en M1 C2 et M2 C2, doublon possible à arbitrer ; aucune correction automatique.
- Alexou : attente reconnue, mais second contact pendant le placement à traiter séparément ; ne pas atténuer automatiquement toute la course.
- Avertissements Tofusan/Kimy cités dans une note de Sherman : qualifier les pilotes concernés explicitement, sans compter deux fois un même incident.
- Richard : plusieurs incidents évoqués dans une seule décision ; les distinguer à l'examen.

## Validation technique

```powershell
npm.cmd test
```

Les qualifications sont enregistrées dans le `penMap` de l'événement via le mécanisme de sauvegarde existant. Pas de migration SQL, pas de suppression de données, pas de nouvelle variable `.env`, pas de nouvelle dépendance. Le dépôt de code ne contient ni l'export personnel fourni pour la simulation, ni des qualifications supposées de ses pilotes.

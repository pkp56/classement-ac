# Classement pilotes — serveur Assetto Corsa

## Mettre à jour le classement
1. Repérez le dossier `results/` de votre serveur (fichiers `.json` de chaque session).
2. Lancez : `python3 build_ranking.py --results /chemin/vers/results --config config.json --out data/ranking.json`
3. Rechargez la page.

Le script peut être lancé automatiquement après chaque soirée (cron, planificateur de tâches Windows).

## Voir la page
Servez le dossier avec n'importe quel serveur web. En local : `python3 -m http.server`, puis http://localhost:8000

## Personnaliser (config.json)
- `serverName` : nom affiché en haut de la page.
- `drivers` : pseudo et catégorie (platine, gold, silver, bronze) par identifiant Steam. Sans entrée, le dernier pseudo vu est utilisé.
- `championships` : période de dates et niveau (open, series, masters, finale) de chaque championnat.
- `scoring` : points de base par place et multiplicateur par niveau.
- `windowYears` : durée de la fenêtre glissante (5 ans par défaut).

`sample_results/` contient des résultats fictifs pour tester. Pointez `--results` vers vos vrais fichiers pour les remplacer.

## Page « Championnat » (résumés de course et profils pilotes)
1. Exportez le championnat depuis le Server Manager (lien « export ») et enregistrez le fichier dans `championship_input/championnat.json`.
2. Lancez : `python3 build_championship.py --input championship_input/championnat.json --out data/championship.json`
3. Rechargez la page, onglet « Championnat » : résumés des courses, profils pilotes (points forts et faibles), classement.

Les points sont recalculés d'après le barème du championnat et peuvent différer légèrement du Server Manager. Les profils comparent chaque pilote au reste du plateau (minimum 2 courses). La course 2 à grille inversée est exclue du critère « Remontées ».

## Collisions et incidents Assetto Corsa
Dans l'onglet **Résultats par course → Collisions & incidents**, vous pouvez importer un export JSON de logs Assetto Corsa (tableau d'événements ou objet contenant `Events`, `incidents` ou `collisions`). La page propose :
- tri chronologique, chronologique inversé ou par vitesse d'impact ;
- filtres par type, pilote, recherche texte et vitesse minimale ;
- statistiques sur les collisions voiture/décor, vitesse moyenne et pilotes les plus mentionnés ;
- rapport chronologique de type directeur de course ;
- export des logs au format JSON et conservation locale dans le navigateur.

**Important :** les logs importés sont stockés uniquement dans le navigateur (localStorage) et ne modifient pas le classement officiel du serveur. L'implication dans une collision ne signifie pas qu'un pilote est responsable. Les incidents ne sont pas automatiquement associés à une manche précise : importez le fichier correspondant à la course que vous analysez.

## Déploiement Render (service web Node.js existant)

Cette application utilise `app.js` comme serveur Express. Pour conserver le service Render existant et son URL, ne créez pas un nouveau service et ne changez pas sa branche sans vérifier les paramètres actuels dans le tableau de bord.

Paramètres Node.js usuels pour ce dépôt :
- **Build Command** : `npm install`
- **Start Command** : `npm start` (vérifier que le script existe dans `package.json` avant de modifier le service)
- **Health Check Path** : `/healthz`

La route `/healthz` renvoie uniquement `{"status":"ok"}` et ne révèle ni secrets ni données du championnat. Elle permet à Render de vérifier que le processus Express répond.

### Variables d'environnement
Les secrets doivent rester dans l'onglet **Environment** du service Render ; ne jamais les committer dans Git. Ce projet utilise notamment `GDSPADMIN` ou `ADMIN_PASSWORD` pour le mot de passe administrateur, et peut utiliser `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` et `GITHUB_BRANCH` pour publier les données sur GitHub.

### Persistance des données
Le code écrit aussi des fichiers dans `data/`. Sur Render, les écritures sur le disque local peuvent ne pas survivre à un redéploiement si le service n'a pas de disque persistant. Avant de compter sur les fichiers locaux comme sauvegarde durable, vérifiez la configuration de stockage du service. La publication GitHub du fichier `data/championship.json` est une voie distincte et dépend de la configuration de `GITHUB_TOKEN`.

### Vérification après déploiement
1. Ouvrir `/healthz` sur l'URL publique du service et vérifier une réponse HTTP 200.
2. Vérifier les journaux de déploiement et de démarrage dans Render.
3. Vérifier l'accès à la page principale et aux API d'administration.
4. Tester l'import d'équipes avec une copie des données, puis contrôler que les sessions et résultats existants sont conservés.
5. Ne jamais publier un secret dans un ticket GitHub, un journal ou un message.

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

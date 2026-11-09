# GDSP — International Series Lola T290

Site de championnat de la GDSP, servi statiquement par un petit serveur Express prêt à déployer sur Render.

## Déploiement Render (frontend)

1. Déployer ce dépôt comme **Web Service** Node :
   - Build command : `npm install`
   - Start command : `npm start`
2. Ajouter la variable d'environnement `GDSP_API_URL` pointant vers l'URL du backend déployé (`gdsp-render-backend`, par ex. `https://gdsp-lola-t290-api-xxxx.onrender.com`, sans slash final). Sans cette variable, le site fonctionne en lecture seule à partir de `data/data.json`.
3. Redéployer. Le site sera servi sur l'URL Render fournie.

## Développement et vérification

- L’accueil GDSP est la page d’entrée ; les résultats s’ouvrent depuis l’onglet **Résultats**.
- La colonne « Pts » des résultats affiche le point de pole en qualification et les points de classement en course.
- Lancer les tests de calcul ciblés avec `npm test`.
- Le cœur du site est dans `site.js` ; `patches-v71.js` contient les règles de calcul/pénalités conservées pour compatibilité. Les anciennes versions de patches non chargées ont été retirées.

## Barème (mis à jour)

- 41 / 38 / 35 / 32 / 30 / 28 / 26 / 24 / 22 / 20 / 18 / 17 / 16 / 15 / 14 / 13 / 12 / 11 / 10 / 9 / 8 / 7 / 6 / 5 / 4 / 3 / 2 / 1 points pour les 28 premières places ; 0 au-delà.
- Les manches d'1h doublent le barème ; le meilleur pilote en qualification reçoit le point de pole (+1, x2 en 1h). Les grilles inversées ne donnent pas de point de pole.
- Dans l'onglet Joker du championnat Lola T290, la manche au plus faible total est écartée du cumul, sans masquer les colonnes des manches.
- Un pilote marque des points à condition d'avoir couvert ≥ 75% de la distance du vainqueur et de ne pas être DQ.
- Pénalités commission = ajouts de temps en secondes sur le résultat de course (reclassement automatique), DQ/DNF/DNS commissaires, et bonus/retraits de points directs au championnat (général et Joker).

## Référencement — première étape (accueil et événements)

Le serveur expose `/` et `/evenements/:slug` avec du HTML public lisible sans
JavaScript (présentation et calendrier). Les cartes du hub sont de vrais liens.
Le navigateur restaure l'événement à l'ouverture directe et gère Retour/Suivant.
Les classements, résultats détaillés et profils restent interactifs : leur rendu
serveur et leurs URL dédiées ne font pas encore partie de cette première étape.

L’origine publique par défaut est **`https://classement-ac-1.onrender.com`** :
les URL canoniques et `/sitemap.xml` sont activés sans variable supplémentaire.
En cas de changement de domaine, définir **`PUBLIC_SITE_URL=https://votre-domaine.fr`**
sur le serveur de production (sans chemin). Ne pas utiliser
l'adresse d'un aperçu temporaire. `/robots.txt` référence ce sitemap. Après
publication, vérifier le domaine dans Google Search Console puis soumettre le
sitemap. Aucune indexation ni position dans Google n'est garantie.

Les pages publiques utilisent uniquement les endpoints publics du backend,
avec un cache de 60 secondes et un délai maximum de 10 secondes. Une panne
retourne HTTP 503 avec `Retry-After` plutôt qu'une page vide indexable ; un événement
inexistant retourne 404. Les calculs sportifs ne sont pas dupliqués. Les textes
édités dans Administration → Événements alimentent le HTML public.

Vérification : `npm test` comprend des tests HTTP avec un backend local simulé,
le HTML sans JavaScript, les erreurs, le sitemap et la restauration d'une URL.
L'accès au backend de production et l'indexation réelle se vérifient après déploiement.

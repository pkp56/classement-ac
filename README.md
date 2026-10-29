# GDSP — International Series Lola T290

Site de championnat de la GDSP, servi statiquement par un petit serveur Express prêt à déployer sur Render.

## Déploiement Render (frontend)

1. Déployer ce dépôt comme **Web Service** Node :
   - Build command : `npm install`
   - Start command : `npm start`
2. Ajouter la variable d'environnement `GDSP_API_URL` pointant vers l'URL du backend déployé (`gdsp-render-backend`, par ex. `https://gdsp-lola-t290-api-xxxx.onrender.com`, sans slash final). Sans cette variable, le site fonctionne en lecture seule à partir de `data/data.json`.
3. Redéployer. Le site sera servi sur l'URL Render fournie.

## Barème (mis à jour)

- 41 / 38 / 35 / 32 / 30 / 28 / 26 / 24 / 22 / 20 / 18 / 17 / 16 / 15 / 14 / 13 / 12 / 11 / 10 / 9 / 8 / 7 / 6 / 5 / 4 / 3 / 2 / 1 points pour les 28 premières places ; 0 au-delà.
- Les manches d'1h doublent le barème ; la pole donne +1 (x2 en 1h).
- Un pilote marque des points à condition d'avoir couvert ≥ 75% de la distance du vainqueur et de ne pas être DQ.
- Pénalités commission = ajouts de temps en secondes sur le résultat de course (reclassement automatique). DQ commissaires pris en compte.

# Lot 1 — fiabilité et sécurité

## État

Préparé et testé localement, non déployé. 279 tests passent (`npm test`). Aucun enregistrement sur les données de production, aucune vérification du Caddy installé ni remise en service d'un hébergement distant effectués.

## Changements

- En mode `EVENTS_SOURCE=local` (défaut), base PostgreSQL obligatoire : absence/panne = 503 JSON, jamais un repli silencieux sur Render. Cela concerne également le rendu serveur des pages publiques.
- L'ancien mode reste disponible explicitement via `EVENTS_SOURCE=backend`. Ses erreurs 5xx sont transformées en message JSON pour les API ; cela ne réactive pas un hébergement suspendu.
- Exclusions Global : GET local, PUT authentifié, fichier temporaire puis remplacement atomique, copie `.bak` de la version précédente. Erreurs de lecture/écriture explicites. Le navigateur signale l'utilisation de sa copie locale et les sauvegardes non confirmées.
- Réinitialisation : POST authentifié, confirmation requise, sauvegarde privée dans `backups/events` avant écriture. Ne prétend plus réussir si la base échoue. Pas de restauration automatique ; conserver aussi une sauvegarde PostgreSQL indépendante. Éviter toute édition concurrente pendant une réinitialisation.
- Un chargement incomplet des événements ne produit plus un classement Global présenté comme complet. Aucune règle de calcul modifiée.
- En-têtes compatibles avec les scripts/handlers inline existants. HSTS court (24 h) uniquement en HTTPS direct ou déclaré par le proxy de confiance (loopback par défaut). Pas de preload ni includeSubDomains.
- Fichiers internes/outils/sauvegardes et certains magasins privés non servis par le statique ; chemins encodés également vérifiés.
- Jetons admin supprimés de localStorage au profit de sessionStorage, sur le site et la télémétrie : reconnexion nécessaire pour les anciennes sessions. Ils restent accessibles au JavaScript ; ce n'est PAS une protection complète contre les XSS.
- PDF fourni précédemment copié sans modification vers `/docs/reglement-piste-gdsp-v2024-12.pdf`. La première page indique « Version 1. 2024/12 » : l'interface annonce cette version, pas le futur règlement.
- Direct : messages d'accueil plus compréhensibles, erreur de récupération explicite avec bouton Recharger. Les outils techniques avancés de la page live restent présents.

## Vérifications avant mise à jour Windows

Dossier habituel : `C:\Users\petitpkp\classement-ac`.

1. Conserver une copie de `.env` en lieu privé, du fichier `data\global-exclusions.json`, et une sauvegarde de la base PostgreSQL. Ne jamais publier ces fichiers.
2. Vérifier **sans divulguer les valeurs** que `.env` configure `EVENTS_DATABASE_URL` ou `DATABASE_URL`, les identifiants admin et `JWT_SECRET`. La base doit être joignable depuis ce PC.
3. Si le site utilisait encore intentionnellement l'ancien backend, choisir explicitement `EVENTS_SOURCE=backend` avant mise à jour, ou terminer d'abord la migration PostgreSQL locale. Ne pas déployer le mode local sans base : l'accueil répondra 503.
4. Ces changements doivent d'abord être intégrés à la branche de déploiement. Ensuite seulement, sur un `main` sans modification suivie : `git pull --ff-only origin main`. Ne pas lancer cette commande pour récupérer une branche encore non intégrée.
5. Arrêter puis relancer une seule instance de la tâche **GDSP Node** (ou le processus Node manuel). Aucune nouvelle dépendance applicative ajoutée dans ce lot.
6. Recharger le navigateur sans cache et se reconnecter à l'administration.

## Caddy : configuration distincte

`deploy/Caddyfile.example` est un exemple à adapter, **pas une configuration installée**. Sauvegarder le Caddyfile existant, conserver ses autres domaines/règles, vérifier le port réel Node dans `.env` (défaut 10000).

- Toutes les routes `/api/*` doivent atteindre le même Node que les pages : pas de `file_server`, de `respond` statique ou de second backend devant ces chemins.
- L'exemple active HTTPS automatique et la redirection HTTP : DNS, accès réseau et ports nécessaires doivent être fonctionnels avant utilisation. Le site était communiqué en HTTP ; ne pas présumer que le certificat fonctionne déjà.
- Valider avec `caddy validate --config <chemin-du-Caddyfile>` puis recharger selon le service/tâche réellement installé. Aucun changement Caddy n'a été effectué ici.
- Ne pas ajouter `script-src 'self'` sans retirer les scripts/handlers inline. La CSP proposée est volontairement partielle, elle ne bloque pas toutes les XSS.
- `TRUST_PROXY` vaut `loopback` par défaut. Ne pas le mettre à `true` pour un Node directement exposé. Restreindre le port Node au réseau/proxy prévu avec le pare-feu Windows.

## Contrôles après déploiement

Comparer d'abord en local `http://127.0.0.1:<PORT>`, puis via le domaine public (HTTP ou HTTPS selon configuration effective) :

| Requête | Attendu |
| --- | --- |
| GET `/healthz` ou `/health` | 200, processus Node vivant |
| GET `/api/health` | 200 si base/source événements disponible ; sinon 503 avec état explicite |
| GET `/api/events` | 200 JSON avec les événements attendus, pas de HTML « Service Suspended » |
| GET `/api/global-exclusions` | 200 JSON avec les exclusions du PC, sans authentification |
| GET `/api/live/status` | état live JSON ; live désactivé n'invalide pas la disponibilité des événements |
| GET `/api/live/state` | même état, alias déprécié |
| GET `/api/state` | 410 JSON, ancienne route retirée |
| GET `/api/save-championship` | 405 ; ce GET n'est pas un test de sauvegarde |
| POST de sauvegarde sans jeton valide | 401, aucune écriture |
| GET `/docs/reglement-piste-gdsp-v2024-12.pdf` | 200 PDF, sans dépendance Discord |
| GET `/.env`, `/tools/events/api.js`, `/data/global-exclusions.json` | 404 |

Tester la connexion puis une sauvegarde/relecture uniquement sur un événement de test autorisé, jamais sur les résultats officiels pour un simple contrôle. Vérifier également que les exclusions existantes sont identiques à la copie conservée. Les tests automatiques utilisent des fichiers temporaires et des données simulées ; ils ne valident pas la base réelle du PC.

## Hors de ce lot

Migration coordonnée vers cookies HttpOnly/Secure/SameSite avec protection CSRF, suppression des handlers inline et CSP stricte, limitation des tentatives de connexion, restauration guidée des sauvegardes et refonte complète des états publics du live. La sécurité globale n'est donc pas considérée comme achevée.

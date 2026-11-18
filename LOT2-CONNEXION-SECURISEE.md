# Lot 2 — connexion navigateur sécurisée

## Portée

Préparation pour l'installation Windows existante avec **EVENTS_SOURCE=local**, PostgreSQL local et HTTPS déjà confirmé par l'utilisateur sur **https://gdsp.duckdns.org**. Aucune modification de résultat, de barème ou de fiche pilote. Aucun déploiement ni essai sur les données de production effectué pendant la préparation.

## Vérifications automatiques

`npm test` : **290 tests réussis**. Couverture ajoutée : attributs des cookies, HTTPS obligatoire hors loopback, CSRF sur POST/PUT/PATCH/DELETE et logout, origines étrangères, expiration/signatures JWT, reconnexion après cookie invalide, quota et reprise, compatibilité des agents, client navigateur sans stockage de secret et parcours réel exclusions/télémétrie. Syntaxe des scripts site/télémétrie vérifiée. Ces tests ne remplacent pas le contrôle du navigateur et de Caddy sur le PC après déploiement.

## Fonctionnement

- Le site et la page télémétrie utilisent une session commune par cookie **`__Host-gdsp_admin`** : HttpOnly, Secure, SameSite=Strict, Path=/, sans Domain, durée maximale 8 h.
- Le JWT de connexion navigateur ne figure plus dans le JSON de login, ni dans localStorage/sessionStorage, ni dans l'URL. Seul un indicateur de connexion et le nonce CSRF restent accessibles au JavaScript.
- `GET /api/admin/session` restaure l'état de session et fournit le nonce CSRF en réponse JSON non mise en cache, sans révéler le JWT. Les anciens stockages de jeton sont supprimés au chargement.
- Toutes les écritures API utilisant une session cookie requièrent `X-GDSP-CSRF`, calculé pour cette session. Les origines étrangères et `Sec-Fetch-Site: cross-site` sont refusés. Le site et la télémétrie utilisent le même client `assets/admin-session.js` pour les POST/PUT/DELETE, y compris les appels auparavant directs.
- `POST /api/admin/logout` efface le cookie ; une session présente exige aussi un nonce CSRF pour cette action. La déconnexion n'est annoncée qu'après confirmation du serveur.
- Login : 10 tentatives par IP sur une fenêtre de 15 minutes (réussies ou non), vérifiées avant bcrypt ; dépassement = 429 et Retry-After. La table mémoire est bornée et les entrées expirées sont supprimées. Une IP ne peut pas contourner cette limite en choisissant l'ancien contrat Bearer.
- Les JWT acceptés doivent être HS256, de rôle admin, avec sujet et expiration. Chaque nouveau JWT a un identifiant unique.
- Les cookies du navigateur et le nonce CSRF ne sont pas transférés au backend par le proxy.

## HTTPS et développement

Utiliser **https://gdsp.duckdns.org** pour l'administration et la télémétrie. Une connexion navigateur sur un domaine HTTP est refusée avec `https-required` : aucune dégradation silencieuse vers un cookie non chiffré.

Exception pour les essais depuis le PC lui-même : HTTP sur `localhost`, `127.0.0.1` ou `[::1]`, requête réellement locale, utilise un cookie séparé `gdsp_dev_admin`, HttpOnly et SameSite=Strict. Ce cookie n'est pas accepté dans la session HTTPS publique. Les domaines HTTP du réseau local ne bénéficient pas de cette exception.

Caddy doit conserver le Host public et transmettre correctement le protocole HTTPS. Le serveur ne fait confiance qu'au proxy loopback par défaut (`TRUST_PROXY=loopback`). Ne pas élargir cette confiance à toutes les adresses ; protéger le port Node avec le pare-feu. Si le login dit « Utilise HTTPS » alors que le navigateur est en HTTPS, vérifier les en-têtes du proxy plutôt que désactiver Secure.

## Compatibilité explicite

- Les scripts API sans cookie peuvent encore demander un JWT via le contrat historique de login (sans `X-GDSP-Session: cookie`) et l'utiliser en Bearer. Ils restent authentifiés par jeton explicite, sans authentification ambiante par cookie ; leur login subit aussi la limite et le contrôle Origin.
- Les agents live/télémétrie sans cookie conservent leurs jetons machine et ne doivent pas ajouter un nonce CSRF.
- La **connexion navigateur par cookie nécessite EVENTS_SOURCE=local**. En mode backend historique, elle répond explicitement 503 `local-auth-required` : ce lot n'adapte pas le backend externe. Ne pas déployer ce client navigateur sur une installation restée en mode backend sans migration préalable. L'installation de l'utilisateur a été confirmée en local disponible au lot précédent.
- Les anciens onglets doivent être rechargés (Ctrl+F5). Ils ne peuvent plus se fier à leur ancien jeton stocké. Nouvelle connexion nécessaire la première fois.

## Vérifications avant et après publication

La préparation ne vaut pas publication. Après intégration à main seulement : sauvegarder `.env`, exclusions et PostgreSQL comme pour le lot 1, faire un pull sur main propre, puis redémarrer une seule instance GDSP Node. Aucune nouvelle dépendance npm ni modification de schéma SQL. Aucune modification automatique du Caddyfile ou de `.env`.

Contrôles manuels, sans toucher aux résultats officiels :

1. Ouvrir le site en HTTPS, Ctrl+F5. Les événements publics doivent rester accessibles sans connexion.
2. Se connecter à l'administration, recharger : la session doit rester reconnue. `/api/admin/session` doit indiquer authenticated=true ; ne pas partager son contenu (nonce CSRF).
3. Ouvrir `/telemetry` sur la même origine : elle doit reconnaître la même session sans réclamer le mot de passe à nouveau.
4. Sur un événement de test autorisé seulement, enregistrer puis relire une modification. Ne pas utiliser une réinitialisation pour tester.
5. Se déconnecter depuis la télémétrie ou le site ; recharger l'autre page : l'administration ne doit plus être reconnue.
6. Ouvrir une fenêtre privée : l'administration doit demander une connexion et les résultats publics rester accessibles.
7. Dans les outils navigateur, le cookie doit être HttpOnly, Secure, Strict ; le stockage local/session ne doit plus contenir de JWT. Ne pas envoyer de capture contenant le cookie ou un mot de passe.
8. `/api/health` doit toujours indiquer source=local, status=available.

Une erreur 403 CSRF peut survenir si une autre fenêtre a remplacé la session : recharger puis réessayer consciemment. Le client ne rejoue jamais automatiquement une écriture, pour éviter les doublons. Une erreur 429 demande d'attendre le délai annoncé ; ne pas désactiver la limite.

## Limites connues

- HttpOnly empêche la lecture du cookie par JavaScript, **pas les actions malveillantes d'une XSS exécutée sur le site**. Retirer les scripts/handlers inline puis renforcer la CSP reste un lot distinct.
- Le cookie peut persister 8 h, y compris après fermeture du navigateur : se déconnecter sur un PC partagé.
- Le JWT reste sans état côté serveur : logout retire le cookie du navigateur mais ne révoque pas une copie déjà volée avant son expiration. Une révocation centralisée et persistante est hors de ce lot ; changer le secret invalide toutes les sessions.
- La limite est par IP, en mémoire, pour une seule instance Node. Elle est réinitialisée au redémarrage, et plusieurs personnes derrière la même IP partagent le quota. Un déploiement multi-instance ou exposé à des attaques distribuées exige un stockage/filtrage supplémentaire.
- L'accès HTTPS et la configuration du Caddy réel n'ont pas été inspectés depuis cet environnement ; HTTPS sans alerte a été confirmé par l'utilisateur.

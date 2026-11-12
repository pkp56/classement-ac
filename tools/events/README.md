# Fusion du backend dans le site

L'API des événements vivait dans un service séparé, `gdsp-render-backend`
(Express + PostgreSQL + JWT). Elle est maintenant servie **par ce dépôt**, sur la
même origine que les pages. Le code d'origine fait ~350 lignes : il a été repris
dans `tools/events/api.js` avec le **même contrat JSON**, la **même table**
(`gdsp_events`) et la **même base**.

## Pourquoi

Deux services, c'était deux systèmes d'authentification : le login était relayé
au backend (qui renvoyait un JWT signé de son côté), tandis que le site comparait
le jeton à `ADMIN_PASSWORD` en clair. Un administrateur aux identifiants corrects
se retrouvait donc déconnecté dès qu'il ouvrait une page protégée localement —
la télémétrie, par exemple.

Un seul service, c'est aussi :

- un seul cold start Render au lieu de deux (le site et l'API se réveillaient
  l'un après l'autre, 30 s chacun) ;
- plus de proxy interne, donc plus de latence ni de `proxy error` en cascade ;
- un seul endroit où sont les identifiants, et un seul format de jeton.

## Ce qui change dans le contrat

Rien, sauf trois choses volontaires :

| Avant (`gdsp-render-backend`) | Après |
| --- | --- |
| `gdspadmin` / `gdsp290` acceptés si `ADMIN_*` absents | **aucun compte de secours** : sans `ADMIN_PASSWORD`, le login refuse |
| `JWT_SECRET` par défaut `"dev-jwt-secret-change-me"` | secret dérivé de `ADMIN_PASSWORD`, ou `JWT_SECRET` (16+ caractères) ; jamais de constante |
| CORS ouvert sur `FRONTEND_ORIGIN` | sans objet : même origine |

Le jeton reste un **JWT HS256 de 8 h**, avec `sub` = nom d'utilisateur et
`role = "admin"`. **Conséquence utile :** si `JWT_SECRET` est le même que celui
de l'ancien backend, les sessions déjà ouvertes restent valides après la bascule.
Autrement, il suffit de se reconnecter.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | base PostgreSQL/Neon. **Sans elle, les événements sont laissés à l'ancien service** (voir plus bas) — aucun plantage |
| `EVENTS_DATABASE_URL` | facultatif : une base dédiée aux événements, si tu veux les séparer de `DATABASE_URL` |
| `ADMIN_USERNAME` | identifiant admin (défaut `admin`) |
| `ADMIN_PASSWORD` | mot de passe **ou** hash bcrypt (`$2…`). Plusieurs comptes : `nom:secret,autre:$2…` |
| `JWT_SECRET` | secret de signature. Recommandé : `openssl rand -hex 32` |
| `EVENTS_SOURCE` | `local` (défaut) = ce service ; `backend` = ancien comportement, tout repasse par le proxy |

## Bascule, dans l'ordre

1. **Rien à faire pour démarrer.** Sans `DATABASE_URL` sur ce service, chaque
   route d'événements appelle `next()` : le proxy `/api/*` prend le relais et
   l'ancien backend répond. Le site se comporte comme avant.
2. **Ajouter `DATABASE_URL`** (la même base que le backend, ou une copie). Au
   premier appel, `gdsp_events` est créée si elle n'existe pas, et l'ancienne
   table `gdsp_championship_data` est reprise une fois. Les événements sont alors
   lus en local.
3. **Vérifier** : `GET /api/events` doit renvoyer les mêmes slugs qu'avant
   (`lola-t290-gdsp-championnat-2026`, `alpha-romeo-cup`, les archives…), et un
   enregistrement depuis l'admin doit se retrouver en base.
4. **Éteindre le service backend** sur Render. Rien à changer côté site.

Retour en arrière à tout moment : `EVENTS_SOURCE=backend` et le proxy reprend
la main, sans redéploiement de code.

## Pages publiques : rendues depuis la base

L'accueil (`/`), la fiche d'un événement (`/evenements/:slug`) et le
`sitemap.xml` sont rendus **côté serveur** : ils interrogeaient le backend en
HTTP, ils lisent maintenant la base (`publicJson` → `publicJsonLocal`). Le cache
de 60 s est conservé.

Le repli HTTP reste en place, mais uniquement quand il a un sens :

| Cas | Comportement |
| --- | --- |
| événement inexistant | **404** immédiat — le backend ne le connaîtrait pas davantage |
| aucune base configurée, ou base en erreur | repli sur l'ancien service (une page ne doit pas disparaître pendant la migration) |
| `EVENTS_SOURCE=backend` | tout repasse par l'ancien service, comme avant |

Conséquence : une fois `DATABASE_URL` posée et vérifiée, `GDSP_API_URL` et
`BACKEND_URL` peuvent être supprimées et le service `gdsp-render-backend` éteint
sans que l'accueil, les pages événement ni le sitemap ne tombent.

## Ce qui reste proxié

Les routes qui n'existent que dans l'ancien backend et qui ne sont pas des
événements (supervision `/health`, appels AssettoHosting non couverts) continuent
de passer par le proxy. Elles sont déjà servies localement pour la plupart
(`/api/ah-*`, `/api/live/*`, télémétrie).

## Tests

`tests/events-api.test.js` vérifie le contrat route par route avec un faux pool
`pg` : liste, lecture, création (409 sur doublon, coefficient 0,5 pour un
« open »), mise à jour, suppression, sauvegarde du championnat, compatibilité
`/api/championship` et `/api/save-championship`, et surtout :

- le mot de passe **n'est plus un jeton** (il ne circule plus dans les en-têtes) ;
- les identifiants de secours de l'ancien dépôt ne passent plus ;
- un jeton signé avec un autre secret est refusé proprement (401, pas 500) ;
- un jeton expiré est refusé ;
- sans base, on délègue au proxy au lieu de renvoyer une erreur.

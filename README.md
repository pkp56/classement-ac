# GDSP — International Series Lola T290

Site de championnat de la GDSP, servi statiquement par un petit serveur Express prêt à déployer sur Render.

## Déploiement Render (frontend)

1. Déployer ce dépôt comme **Web Service** Node :
   - Build command : `npm install`
   - Start command : `npm start`
2. Ajouter la variable d'environnement `GDSP_API_URL` pointant vers l'URL du backend déployé (`gdsp-render-backend`, par ex. `https://gdsp-lola-t290-api-xxxx.onrender.com`, sans slash final). Sans cette variable, le site fonctionne en lecture seule à partir de `data/data.json`.
3. Redéployer. Le site sera servi sur l'URL Render fournie.

## Événements et administration (depuis la fusion)

L'API des événements, l'authentification et la sauvegarde du championnat étaient
dans un service séparé (`gdsp-render-backend`). Elles sont maintenant servies par
ce dépôt, dans la même base PostgreSQL : voir [`tools/events/README.md`](tools/events/README.md).

- Sans `DATABASE_URL` sur ce service, les routes `/api/events*` sont laissées au
  proxy et l'ancien backend répond : le site fonctionne comme avant.
- Avec `DATABASE_URL`, elles sont lues et écrites en local, et le backend peut
  être éteint : l'accueil, les pages événement et le sitemap sont rendus depuis
  la base (le repli HTTP ne sert plus qu'en cas de base absente ou en erreur).
- Le jeton admin est un JWT de 8 h. Le mot de passe ne circule plus comme jeton.

## Développement et vérification

- L’accueil GDSP est la page d’entrée ; les résultats s’ouvrent depuis l’onglet **Résultats**.
- La colonne « Pts » des résultats affiche le point de pole en qualification et les points de classement en course.
- Lancer les tests de calcul ciblés avec `npm test`.
- Le cœur du site est dans `site.js` ; `patches-v71.js` contient les règles de calcul/pénalités conservées pour compatibilité. Les anciennes versions de patches non chargées ont été retirées.

## Live timing d'un serveur AC dédié

La page **`/live-timing`** suit en direct un serveur Assetto Corsa dédié qui
tourne sur ton PC (classement, tours, écarts estimés, stands, fil du serveur),
sur le modèle des pages live-timing d'AssettoHosting. Elle lit l'interface de
plugin UDP d'acServer (ACSP v4) : rien à installer côté jeu, seulement deux
lignes dans `server_cfg.ini` (`UDP_PLUGIN_ADDRESS`, `UDP_PLUGIN_LOCAL_PORT`).
Deux cas de figure :

* **site et serveur AC sur le même PC** → le collecteur du site lit acServer en
  UDP local directement ;
* **site hébergé (Render) et serveur AC sur un PC à la maison** → lancer
  `node tools/live-timing/agent.js` sur ce PC avec `SITE_URL` et `PUSH_TOKEN`
  (même valeur que `LIVE_PUSH_TOKEN` sur le site) ; le PC pousse un instantané
  par seconde en HTTPS, sans ouvrir de port entrant. Serveur lancé par Content
  Manager : voir `tools/live-timing/CONTENT-MANAGER.md` et
  `tools/live-timing/set-plugin-ports.js` (ajoute les deux lignes de plugin UDP
  dans `server_cfg.ini`) ;
* **serveur public dont tu n'as pas la main** → `LIVE_HTTP_SOURCES` avec son
  adresse HTTP (ou son lien acstuff), lecture seule via `/INFO` + `/ENTRY`.

Détails, variables d'environnement, simulateur de test et limites :
[`tools/live-timing/README.md`](tools/live-timing/README.md).

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

Le sitemap reste disponible si le backend des événements est indisponible : il
réutilise la dernière liste valide connue par le processus, ou contient uniquement
l’accueil après un redémarrage. Les pages HTML en panne conservent leur statut 503.

## Onglet Circuit (section championnat)

L'onglet **Circuit** du championnat Lola T290 affiche une fiche par manche, dans
l'ordre du calendrier publié sur le site : M1 Mont-Tremblant, M2 Riverside,
M3 Sebring, M4 Mid-Ohio, M5 Mexico 1967, M6 Österreichring. Le bandeau de
pastilles en haut de page permet de passer d'une manche à l'autre ; la sélection
est mémorisée dans `localStorage['gdsp_circuit_round']`.

Chaque fiche présente le tracé réel (extrait du `fast_lane.ai` du mod), le profil
altimétrique, le nombre de virages, le débriefing des surfaces (`surfaces.ini`),
les repères de chronométrie (`overlays.ini`) et, pour les manches courues, la date,
le vainqueur et les meilleurs tours issus des sessions importées. La manche 6
n'affiche jamais de date inventée : elle indique « Date à confirmer ».

### Régénérer les données

```bash
node tools/build-circuits-data.js      # écrit data/circuits.json
```

Le script est idempotent et n'utilise que des fichiers locaux :

| Entrée | Rôle |
| --- | --- |
| `data/data.json` | sessions importées (vainqueurs, meilleurs tours) |
| `tools/lib/championship-tracks.js` | ordre du calendrier, dates publiées, métadonnées |
| `maquette-circuit/assets/tracks/*/line.json` | tracé compact (220 points x/y/z + virages) |
| `maquette-circuit/assets/tracks/*/surfaces.ini` | briefing track limits |
| `maquette-circuit/assets/tracks/*/overlays.ini` | bornes des secteurs |
| `maquette-circuit/track-data.js` | Österreichring 1979 (virages nommés) |

Les `fast_lane.ai` bruts (1,4 à 2,2 Mo pièce) restent sur le Drive et ne sont pas
versionnés (`.gitignore`). Pour ajouter un circuit ou mettre à jour un tracé :

```bash
node tools/lib/pack-fast-lane.js chemin/vers/fast_lane.ai \
  maquette-circuit/assets/tracks/<circuit>/line.json
```

Les virages sont détectés sur la ligne complète (pics de courbure espacés de 45 m)
puis mémorisés en fraction de tour, ce qui garantit le même comptage quel que soit
le niveau de décimation du tracé. `tests/circuits.test.js` vérifie les 6 manches,
l'absence de date inventée, la présence d'un tracé exploitable, la couverture
complète du tour par les secteurs et la cohérence des repères avec la zone de dessin.

> **Attention** : `.gitignore` ignore `/lib/` (template Python). Le motif est
> volontairement **ancré à la racine** ; sans le `/` initial il avalait aussi
> `tools/lib/`, dont dépend tout le build.

### Importer un circuit depuis Google Drive

L'administration propose un onglet **Circuits**. Le dossier du mod doit être
partagé sur Drive en « Tout le monde disposant du lien » — **aucune clé API
Google n'est nécessaire.**

1. Coller l'URL du dossier (ou son identifiant) dans le champ prévu.
2. Renseigner éventuellement le nom du circuit et le numéro de manche.
3. « Analyser le dossier Drive » lit les fichiers et affiche la fiche obtenue.
4. **« Ajouter à l'onglet Circuit »** enregistre la manche dans l'événement
   courant. Elle est alors visible par tous les visiteurs, sans redéploiement.
   L'ajout est idempotent : réimporter le même numéro de manche la met à jour
   au lieu de la dupliquer.

« Télécharger le JSON » reste disponible pour versionner la manche dans
`data/circuits.json` si vous préférez la figer dans le dépôt.

Fichiers lus dans le dossier :

| Fichier | Usage | Obligatoire |
| --- | --- | --- |
| `fast_lane.ai` | tracé, profil d'altitude, virages | oui |
| `surfaces.ini` | grip et validité des surfaces | non |
| `overlays.ini` | bornes des secteurs | non |
| `ui_track.json` | nom et identifiant du circuit | non |

Détails d'implémentation :

- `tools/lib/drive-circuits.js` — extraction de l'ID, listing du dossier public
  (`embeddedfolderview`), téléchargement, décodage `fast_lane.ai`, détection des
  virages, parsing `surfaces.ini` / `overlays.ini`. Aucune dépendance externe.
- `tools/lib/circuit-round.js` — fabrique commune de la fiche (tracé SVG, profil,
  secteurs, virages). Utilisée à la fois par le build statique et par l'import,
  pour qu'un circuit importé s'affiche exactement comme un circuit du dépôt.
- **Stockage** : les manches importées vivent dans `data.circuitRounds` de
  l'événement, donc en PostgreSQL côté backend. `data/circuits.json` reste un
  fichier statique du dépôt et sert de socle ; `circuitsData()` fusionne les
  deux (`mergeCircuitRounds`), une manche importée remplaçant la statique de
  même numéro. `saveRemote` réexpédie `circuitRounds`, sinon une sauvegarde de
  l'événement les effacerait.

### Portée : tous les événements

L'onglet Circuit n'est plus réservé au championnat Lola T290. Il apparaît sur
n'importe quel événement dès qu'une manche existe :

| Événement | Source du calendrier |
| --- | --- |
| Championnat Lola T290 | `data/circuits.json` (6 manches) + manches importées |
| Tout autre événement | uniquement les manches importées |

Le fichier statique n'est chargé que pour le championnat Lola : sur un autre
événement, y mêler ce calendrier afficherait six circuits qui ne le concernent
pas.

`hasCircuitData()` décide de la visibilité de l'onglet. Tant que le calendrier
n'est pas chargé elle répond « oui » de façon optimiste (sinon l'onglet
n'apparaîtrait jamais), puis le rendu suivant le masque s'il s'avère qu'il n'y a
aucune manche. Une manche importée sur un événement vierge fait donc apparaître
l'onglet immédiatement.

Les libellés qui supposaient le championnat sont neutralisés hors Lola :
« Plateau : Lola T290 », « Grille Lola T290 », « Meilleur tour de la saison ».
Un circuit importé n'ayant pas de photo, le bandeau utilise un fond uni au lieu
de pointer vers une image absente.
- `POST /api/admin/circuits/import` — route protégée par le mot de passe admin
  (même `Bearer` que le reste de l'administration).
- `surfaces.ini` : le nom de surface vient de `KEY=` (la section s'appelle
  `[SURFACE_0]`), sinon on afficherait « SURFACE_0 » au lieu de « ROAD ».
- `overlays.ini` : chaque `[SECTOR_n]` donne le **début** du secteur n.
  Trois départs = trois secteurs (le dernier va jusqu'à 1), pas quatre.
- `tests/drive-import.test.js` couvre l'extraction d'ID, le décodage, le rejet
  d'un fichier tronqué et les deux cas ci-dessus.

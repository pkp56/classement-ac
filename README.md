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
  par seconde en HTTPS, sans ouvrir de port entrant ;
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

## Grille « finir ensemble » (départ lancé à écarts calculés)

Objectif : départ lancé, voitures placées à des endroits différents du circuit,
chacune avec l'écart qui correspond à sa moyenne de qualification, de sorte que
tout le monde passe la ligne au même instant au bout de N tours.

### Ce que permet Assetto Corsa, et ce qu'il ne permet pas

| Besoin | Faisable ? | Par quel moyen |
| --- | --- | --- |
| Classer du plus mauvais au meilleur rythme de qualif | oui | calcul hors jeu (ci-dessous) |
| Placer les voitures les unes derrière les autres à des endroits précis | **non** côté serveur | les positions de grille viennent du fichier **piste** `start_positions.ini` (`[GRID_n]`), pas du serveur : impossible d'en inventer de nouvelles à distance depuis `server_cfg.ini` |
| Choisir qui est devant | oui | `FIXED_GRID_ORDER=1` + `GRID_ORDER=<steamid1>,<steamid2>…` dans `server_cfg.ini` |
| Écarts de plusieurs centaines de mètres entre les voitures | non avec le départ arrêté | la grille native espace les voitures de quelques mètres seulement (8 à 12 m par rangée) ; il faudrait réécrire la piste |
| Vrai départ lancé (roulant, écarts libres) | oui, côté client | plugin serveur type CSP/Real Penalty, ou l'outil **Race Control** (§ plus bas) : le serveur AC ne sait pas faire de tour de formation |

Conséquence : la « grille à écarts calculés » n'est pas un réglage du serveur
Assetto Corsa. Deux chemins réalistes :

1. **Départ arrêté + handicap par la piste** — on garde la grille native, mais on
   peut envoyer le plus lent devant (`GRID_ORDER`) ; les écarts réels restent
   ceux de la piste. Pour de vrais écarts, il faut modifier `start_positions.ini`
   du circuit (fichier de piste, à faire une fois par circuit, hors serveur).
2. **Départ lancé** — le peloton part groupé derrière un meneur et les écarts se
   font naturellement en course, ce qui rend le handicap inutile : c'est la
   solution retenue par Race Control (voir ci-dessous).

### L'outil de calcul : `tools/grille-temps-moyens.js`

Il lit une session de qualification importée (le JSON Assetto Corsa de `data/`)
et produit la grille, les écarts et, si besoin, une ligne `GRID_ORDER=`.

```bash
# course de 20 tours, rythme = médiane des tours propres
node tools/grille-temps-moyens.js data/2026_9_9_21_37_QUALIFY.json --laps=20

# moyenne des tours propres, et export CSV pour la commission
node tools/grille-temps-moyens.js data/2026_9_9_21_37_QUALIFY.json --laps=15 --mode=mean --csv=grille.csv

# plafonner la grille : le plus lent n'a que 40 s de handicap, tout est
# comprimé proportionnellement (l'ordre ne change pas)
node tools/grille-temps-moyens.js data/2026_9_9_21_37_QUALIFY.json --laps=20 --cap=40
```

Règles de calcul appliquées :

- **rythme** = médiane (défaut) des tours à **+4 % maximum** du meilleur tour du
  pilote ; `--trim=P` change la fenêtre. Les tours de sortie/entrée des stands et
  les tours lents sont donc écartés. `--mode=mean` (moyenne) et `--mode=best`
  (meilleur tour) sont disponibles.
- **classement du plus mauvais au meilleur** : le plus lent reçoit la position 1.
- **écart** = `(rythme du pilote − rythme du meilleur) × nombre de tours` :
  c'est exactement le temps qu'il perdrait sur la distance, donc l'instant
  d'arrivée théorique est identique pour tous.
- **distance** = écart × vitesse de référence (longueur du circuit ÷ meilleur
  tour), pour savoir si la grille tient sur la piste.
- un pilote avec moins de `--min-laps` tours propres (défaut 2) n'est pas classé
  et part derrière.

### Combien de tours maximum pour que ce soit faisable ?

La limite n'est pas la longueur de la course mais **la longueur du peloton** :
si la grille fait plus d'un tour de circuit, le plus lent n'est plus sur la
piste quand le meilleur passe la ligne — ça ne peut pas être posé, et en jeu ça
donne des voitures hors piste ou des tours de retard immédiats.

Avec `S` = écart de rythme entre le plus lent et le meilleur (s au tour) et
`T` = temps d'un tour de référence (s), la grille occupe
`N × S / T` tours de circuit pour une course de `N` tours. D'où :

| Grille tolérée | Nombre de tours de course maximum |
| --- | --- |
| un tour de circuit (`N = T/S`) | le maximum absolu |
| un demi-tour | `T/(2S)` |
| un tiers de tour | `T/(3S)` |
| un quart de tour | `T/(4S)` |

Le script affiche ce tableau pour la session : c'est la réponse directe à
« c'est faisable jusqu'à combien de tours ». Deux façons de pousser la limite :
réduire la distance, ou diviser les écarts (`--cap`, qui correspond à la colonne
« écarts ÷ 2 » : les voitures se rejoignent vers la mi-course).

### Ordres de grandeur mesurés sur les qualifs du championnat

Sur les quatre qualifications déjà importées (15 à 19 min, 20 à 28 pilotes),
l'écart de rythme entre le plus lent et le meilleur va de **4,9 s à 6,6 s au
tour**. Le handicap du plus lent vaut donc :

| Course | Écart 1er → dernier |
| --- | --- |
| 10 tours | 49 à 66 s |
| 15 tours | 74 à 99 s |
| 20 tours | 98 à 132 s |

Nombre de tours maximum pour que la grille tienne sur la piste :

| Circuit | Écart de rythme | Grille = 1 tour | Grille = 1/2 tour | Grille = 1/4 de tour |
| --- | --- | --- | --- | --- |
| Mid-Ohio (3,6 km) | 6,3 s | **14,5 tours** | 7,3 | 3,6 |
| Mont-Tremblant (4,2 km) | 6,2 s | **16,5 tours** | 8,2 | 4,1 |
| Sebring (5,8 km) | 6,6 s | **20,0 tours** | 10,0 | 5,0 |
| Riverside (5,2 km) | 4,9 s | **21,5 tours** | 10,8 | 5,4 |

En divisant les écarts par deux (`--cap`), ces plafonds doublent : 29 à 43 tours
avec un peloton d'un tour, 15 à 22 tours avec un demi-tour.

À Mont-Tremblant (4,2 km, meilleur tour 1:42), 20 tours donnent 123 s de
handicap pour le plus lent, soit **1,2 tour de circuit** : la grille ferait plus
de 5 km, elle ne tient pas sur la piste. Le seuil où la grille reste sous un tour
d'écart est de **14 à 22 tours** selon le circuit (16,5 à Mont-Tremblant, 14,5 à
Mid-Ohio, 20 à Sebring, 21,5 à Riverside). D'où l'option `--cap` : elle garde
l'ordre de la grille et comprime tous les écarts pour que le plus lent reste dans
une fenêtre raisonnable (40 s ≈ 1,7 km de peloton à Mont-Tremblant).

## Race Control (départ lancé)

[Race Control](https://github.com/FranQuarnolo/race-control) (projet
communautaire, en espagnol, libellé « Largada en movimiento y penalizaciones en
tiempo real propias para Assetto Corsa ») fait le départ lancé : tour de
formation, vitesse limitée, bouton « Verte », sanctions automatiques (vitesse en
formation, pit lane, coupes de piste) et un client app à installer côté pilote
dans Content Manager. Il s'intègre à un panel de ligue ou sert seul.

Ce qu'il fait et ne fait pas pour cette idée :

- il **gère la procédure** de départ lancé (formation, vitesse, verte, pénalités) ;
- il **ne calcule pas** de grille à écarts de rythme de qualification : la mise
  en grille reste celle du jeu / de la piste ;
- le timing exact du départ est laissé au jeu : l'admin clique « Verte » au
  moment où le semaphore s'éteint.

C'est donc la brique complémentaire de l'outil ci-dessus, pas un remplacement :
Race Control pour la procédure, `tools/grille-temps-moyens.js` pour décider de
l'ordre et publier les écarts dans le classement / la commission.

### Mise en place pratique

1. Qualif (20 min) → import de la session comme d'habitude dans l'administration.
2. `node tools/grille-temps-moyens.js <session_QUALIFY.json> --laps=<tours de course> --csv=grille.csv --cap=40`.
3. Reporter l'ordre dans `GRID_ORDER=` (le script le génère) si le serveur est en
   `FIXED_GRID_ORDER=1`, ou simplement dans un tableau publié pour les pilotes.
4. Race Control (ou le plugin du serveur) lance la procédure de départ lancé.

Test : `npm test` (fichier `tests/grille-temps-moyens.test.js`) couvre le calcul
du rythme, l'ordre « plus mauvais devant », le handicap, le plafonnement et la
conversion en mètres.

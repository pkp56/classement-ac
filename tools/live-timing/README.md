# Live timing local — suivi en direct d'un serveur Assetto Corsa dédié

Cette partie reproduit le principe d'une page comme
`live-timing` d'AssettoHosting (classement en direct, tours, stands, fil du
serveur), mais **pour ton propre serveur dédié qui tourne sur ton PC**.

Page : **`/live-timing`** (servie par `app.js`, le même serveur Node que le site GDSP).

---

## 1. Comment ça marche

Trois briques :

```
mode local : acServer.exe ──UDP (ACSP v4)──► collector.js ──SSE──► live-timing.html
             (même PC que le site)          (dans app.js)

mode push  : acServer.exe ─UDP─► agent.js ─HTTPS POST /api/live/push─► site ─SSE─► navigateur
             (ton PC)              (ton PC)                            (Render)
```

* `acServer` possède une **interface de plugin UDP** (le même canal que celui
  utilisé par stracker / ptracker). Il y envoie : nouvelle session, connexions
  et départs, tours bouclés, positions temps réel, collisions, chat, fin de
  session.
* `tools/live-timing/collector.js` écoute ces paquets, reconstruit le classement
  (tours, progression, meilleurs tours, écarts estimés, stands) et l'expose en
  JSON + Server-Sent Events via `app.js`.
* `live-timing.html` affiche le tout et se met à jour une fois par seconde,
  sans rechargement.

Aucune modification du jeu ni de Content Manager n'est nécessaire : juste deux
lignes dans `server_cfg.ini`.

## 1 bis. Deux façons de brancher ton serveur

| Situation | Ce qu'il faut faire |
| --- | --- |
| **Le site et le serveur AC tournent sur le même PC** (ou sur le même réseau local, ex. `npm start` sur ta machine) | rien de plus : le collecteur du site lit acServer en UDP localement (section 2). |
| **Le site est hébergé ailleurs** (Render) et le serveur AC tourne sur ton PC | le PC pousse les données vers le site avec l'agent (section 2 bis) : aucun port entrant, aucune IP publique, ça marche derrière une box ou un partage 4G. |
| **Tu veux suivre un serveur public** dont tu n'as pas la main (celui d'un ami, un serveur d'open) | donne son adresse HTTP (`LIVE_HTTP_SOURCES`, section 1 ter) : lecture seule, mais immédiat. |

En mode « push », le site affiche en priorité ce que l'agent lui envoie ; s'il
n'y a pas d'agent, il retombe sur l'écoute UDP locale.

## 1 ter. Suivre un serveur public que tu ne possèdes pas (mode HTTP)

C'est le cas du lien que tu m'as envoyé
(`http://82.66.165.242:16835`, « {GDSP_ Server test 1 »). Un acServer expose
toujours son port HTTP (`HTTP_PORT`) avec deux pages publiques :

* `/INFO` → JSON (nom, circuit, places, temps restant, mot de passe…) ;
* `/ENTRY` → la feuille de temps (pilote, voiture, équipe, tours, dernier,
  meilleur, total), et en course les positions et écarts officiels.

Il suffit donc de donner l'adresse au site :

```bash
LIVE_HTTP_SOURCES=http://82.66.165.242:16835
```

Un lien `acstuff.club/s/q:race/online/join?ip=…&httpPort=…` est accepté tel quel
(converti automatiquement), et plusieurs serveurs peuvent être listés, séparés
par des virgules — un menu « Serveur suivi » apparaît alors sur la page.
`LIVE_HTTP_INTERVAL_MS` (défaut 3000) règle la fréquence de lecture.

**Ce mode est en lecture seule** : on n'a aucune autorisation sur ce serveur, donc
pas de chat, pas de kick, pas de changement de session. Et le HTTP ne donnant pas
les positions, il n'y a ni vitesse instantanée ni « live map » — mais les temps,
les tours et les classements sont ceux du serveur, pas des estimations.

**Limite importante, vérifiée en vrai** : certains serveurs acceptent la
connexion TCP puis la coupent immédiatement (`ECONNRESET`) quand elle vient
d'une IP de datacenter — c'est le cas du serveur `82.66.165.242:16835` depuis
l'hébergeur du site, alors que `/INFO` répond normalement depuis un navigateur
sur une box. La page affiche alors « Ce serveur public ne répond pas au site »
et explique quoi faire. Deux solutions :

1. lire depuis un PC, pas depuis l'hébergeur : lance l'agent (§ 2 bis) sur ton
   PC, il interroge `/INFO` + `/ENTRY` et pousse le résultat au site ;
2. héberger le live timing sur une machine « résidentielle » (le PC du serveur
   ou un petit serveur à la maison) plutôt que sur Render ;
3. **capture enregistrée** (dépannage, affichage immédiat) : depuis un PC qui
   voit le serveur, on enregistre `/INFO` + `/ENTRY` dans un fichier, et le site
   rejoue cette capture.

```bash
# sur ton PC
node tools/live-timing/capture.js http://82.66.165.242:16835 -o data/live-mirror.json
node tools/live-timing/capture.js <lien acstuff> -o data/live-mirror.json --watch 10

# côté site
LIVE_MIRROR_FILE=data/live-mirror.json
```

La page affiche alors le vrai classement, le vrai nom de serveur et le vrai
circuit, avec un bandeau explicite : « Capture enregistrée — ce n'est pas du
direct » et l'âge de la capture. L'agent reste la seule façon d'avoir du direct.

> **Serveur lancé par Content Manager ?** Guide dédié :
> [`CONTENT-MANAGER.md`](CONTENT-MANAGER.md) (deux lignes dans server_cfg.ini,
> script `set-plugin-ports.js`, double-clic sur `AGENT-gdsp.bat`).

## 2 bis. Site distant + serveur AC sur ton PC (mode push)

1. Sur le site (Render → Environment) ajoute un secret, par exemple :
   `LIVE_PUSH_TOKEN=un-mot-de-passe-long-et-unique`
2. Rien d'autre à changer côté site : l'endpoint `POST /api/live/push` s'active
   dès que cette variable existe (sinon il répond 503).
3. Sur le PC du serveur AC, avec Node installé (le dossier `tools/live-timing/`
   suffit, inutile d'installer les dépendances du site) :
   ```ini
   ; server_cfg.ini → [SERVER]
   UDP_PLUGIN_ADDRESS    = 127.0.0.1:12000
   UDP_PLUGIN_LOCAL_PORT = 12001
   ```
   ```bat
   :: Windows : lancer l'agent (à laisser tourner pendant la session)
   set SITE_URL=https://classement-ac-1.onrender.com
   set PUSH_TOKEN=un-mot-de-passe-long-et-unique
   node tools/live-timing/agent.js
   ```
   ```bash
   # Linux / macOS
   SITE_URL=https://classement-ac-1.onrender.com PUSH_TOKEN=… node tools/live-timing/agent.js
   ```
4. Ouvre `/live-timing` sur le site : le badge passe « Direct (PC distant) » dès
   le premier envoi accepté. Si plus rien n'arrive pendant 20 s, la page indique
   « Instantané périmé » puis « Hors ligne » (aucune donnée fantôme).

Notes pratiques :

* L'agent envoie **une photo par seconde** (~10 à 40 Ko) : quelques Mo par
  session, largement dans les quotas Render.
* Le PC n'ouvre **aucun port** : c'est une simple requête HTTPS sortante.
* `PUSH_INTERVAL_MS=2000` réduit la fréquence (et la charge) si besoin.
* **Veille d'un serveur dont tu n'as pas la main** : lance l'agent avec
  `WATCH_URL=http://82.66.165.242:16835` (au lieu de la config UDP). Il interroge
  le serveur depuis ton PC et pousse le classement au site — indispensable quand
  le serveur refuse les connexions venant d'un datacenter.
* Les commandes admin (chat, kick, changement de session) ne sont **pas**
  disponibles en mode push : le site ne peut pas joindre le PC. Lance-les depuis
  la console acServer ou depuis l'agent sur place.
* Render peut mettre le service en veille : au réveil, la page repart dès
  l'envoi suivant (l'agent réessaie automatiquement).

## 1 quater. Historique persistant

Le direct ne survit pas à un redémarrage du site — et une fois la séance
finie, il ne restait rien. **Chaque séance vue par le site est maintenant
conservée** (agent push, UDP local ou source HTTP) :

* identité (serveur, circuit, type, début/fin), nombre de pilotes ;
* **classement final complet** (positions, tours, écarts, meilleur tour) ;
* meilleurs tours et fil d'événements (150 derniers).

Sur la page `/live-timing`, le panneau **« Historique des séances »** liste
les séances les plus récentes ; « Ouvrir » rejoue le classement conservé
(bandeau « Archives »), « Retour au direct » revient au flux temps réel.

Stockage : PostgreSQL (`LIVE_DATABASE_URL`, sinon `DATABASE_URL`, table
`gdsp_live_sessions`) ou fichier `data/live-history.json` en local. Une
capture rejouée (`LIVE_MIRROR_FILE`) n'entre **jamais** dans l'historique :
seules les vraies séances comptent. `LIVE_HISTORY_FILE=off` coupe
l'historique.

API publique : `GET /api/live/sessions` (liste), `GET /api/live/sessions?id=…`
(détail avec classement).

## 2. Configuration du serveur AC

Dans `server_cfg.ini`, section `[SERVER]` :

```ini
[SERVER]
UDP_PLUGIN_ADDRESS    = 127.0.0.1:12000
UDP_PLUGIN_LOCAL_PORT = 12001
```

* `UDP_PLUGIN_ADDRESS` = là où le serveur **envoie** les événements (le port
  d'écoute du collecteur).
* `UDP_PLUGIN_LOCAL_PORT` = là où le serveur **écoute** les requêtes
  (intervalle des positions, demande d'infos voiture…). Il doit être différent
  du précédent.

Redémarre `acServer` après modification. Ces deux ports restent en **local** :
rien à ouvrir sur le routeur (contrairement à 9600/8081 pour les joueurs).

> `stracker` utilise déjà ce mécanisme. Si tu le fais tourner sur le même
> serveur, donne-lui d'autres ports (ou passe par ACSRelay), sinon les deux
> outils se disputeront le plugin.

## 3. Lancer le site

```bash
npm install
npm start                 # http://localhost:10000/live-timing
```

Variables d'environnement utiles (toutes facultatives) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LIVE_TIMING_ENABLED` | `1` | `0` pour désactiver complètement la collecte |
| `AC_HOST` | `127.0.0.1` | IP du serveur AC |
| `AC_LISTEN_PORT` | `12000` | port d'écoute = `UDP_PLUGIN_ADDRESS` |
| `AC_PLUGIN_PORT` | `12001` | port du serveur = `UDP_PLUGIN_LOCAL_PORT` |
| `AC_REALTIME_MS` | `500` | fréquence des positions temps réel |
| `AC_HTTP_URL` | *(vide)* | ex. `http://127.0.0.1:8081` : ajoute le résumé `/INFO` (nb de places, mot de passe, `timeleft`) et permet un affichage « serveur joignable » même si l'UDP ne répond pas |
| `AC_SERVER_LABEL` | `Serveur Assetto Corsa` | nom affiché avant le premier paquet |
| `LIVE_PUSH_TOKEN` | *(vide)* | (site) active la réception des agents distants ; **même valeur** dans `PUSH_TOKEN` de l'agent |
| `LIVE_HTTP_SOURCES` | *(vide)* | (site) URL HTTP / `ip:port` / lien acstuff de serveurs publics à suivre, séparés par des virgules (max 5) |
| `LIVE_HTTP_INTERVAL_MS` | `3000` | (site) fréquence de lecture des sources HTTP |
| `WATCH_URL` | *(vide)* | (agent) au lieu d'écouter l'UDP, l'agent lit ce serveur via `/INFO` + `/ENTRY` puis pousse le résultat au site |

## 4. Essayer sans serveur AC

Un faux `acServer` est fourni : il envoie un peloton complet (8 pilotes, tours
réalistes d'Österreichring 1979, ~1:59) au collecteur.

```bash
# terminal 1
npm start

# terminal 2
node tools/live-timing/simulate-acserver.js
```

Ouvre `/live-timing` : le classement se remplit en quelques secondes.
`SIM_SPEED=60` accélère, `SIM_SPEED=5` ralentit.

## 5. Ce que la page affiche

* **Bandeau d'état** : vert « Direct » quand des paquets arrivent, ambre quand
  seul le résumé HTTP répond, rouge sinon — avec la config exacte à recopier
  dans `server_cfg.ini` et un bouton pour la copier.
* **KPI** : nom du serveur, circuit + variante, session (essais/qualifs/course,
  tours ou minutes), temps restant, pilotes en piste, meilleur tour, météo et
  températures.
* **Classement** : position, pilote + équipe, tours, écart au leader, intervalle
  avec la voiture précédente, dernier tour (marqueur `c` si coupures), meilleur
  tour, vitesse instantanée, badge `PIT` quand la voiture est arrêtée aux stands.
* **Meilleurs tours**, **fil du serveur** (arrivées, départs, tours, stands,
  chat, erreurs) et **diagnostic** (dernier paquet reçu, protocole, tour de
  référence utilisé pour les écarts).

## 6. Précisions honnêtes

* **Les écarts sont estimés.** L'ACSP ne transmet pas les écarts officiels du
  jeu : ils sont recalculés à partir de la progression (tours + position
  normalisée) et du meilleur tour de référence, comme le font stracker ou
  ptracker. Ils sont donc justes à quelques dixièmes, pas au millième.
  La colonne est marquée « estimé » dans le JSON (`gapEstimated`).
* **Pas de temps partiels par secteur.** Le plugin n'envoie pas les secteurs ;
  il faudrait une app cliente (ptracker) pour ça.
* **Les stands sont déduits** d'une vitesse quasi nulle pendant plus de 4 s
  (le protocole n'envoie pas d'événement « entrée aux stands »).
* **La page est en `noindex`** : elle n'a de sens que sur la machine qui héberge
  le serveur, elle n'est pas indexée.

## 7. API JSON

| Route | Contenu |
| --- | --- |
| `GET /api/live/snapshot` | photo complète (serveur, session, voitures, meilleurs tours, événements, diagnostic) |
| `?source=N` | sur `/status`, `/snapshot`, `/stream` : choisit la N-ième source HTTP de `LIVE_HTTP_SOURCES` (0 par défaut) |
| `GET /api/live/status` | identique, allégé côté client pour l'état initial |
| `GET /api/live/stream` | flux SSE `snapshot` (1/s) + `log` (événements temps réel) |
| `POST /api/live/command` | admin (`Bearer` mot de passe admin) : `{action:'chat'|'kick'|'next-session'|'restart-session', message, carId}` — mode local uniquement |
| `GET /api/live/config` | mode disponible (`push` actif ou non, ports UDP attendus) — utilisé par la page |
| `POST /api/live/push` | reçoit l'instantané d'un agent distant ; en-tête `X-Live-Token` obligatoire |

## 8. Pièges fréquents

| Symptôme | Cause probable |
| --- | --- |
| Page vide, état « Hors ligne » | `UDP_PLUGIN_ADDRESS` / `UDP_PLUGIN_LOCAL_PORT` absents ou inversés dans `server_cfg.ini`, ou acServer pas redémarré |
| Un seul pilote affiché | le serveur ne démarre en général pas les positions temps réel tant que l'intervalle n'est pas demandé : c'est le collecteur qui l'envoie, vérifie que `AC_PLUGIN_PORT` pointe bien vers acServer |
| Classement figé mais tours corrects | positions désactivées (`AC_REALTIME_MS=0` dans l'environnement) |
| Messages bizarres `RP>…` | messages chiffrés du plugin Real Penalty, volontairement filtrés |
| Tout à zéro en course | le serveur a redémarré entre-temps : les compteurs repartent avec la nouvelle session |
| « Instantané périmé » en mode push | l'agent s'est arrêté, le PC a perdu le réseau, ou acServer ne tourne plus |
| `401 Jeton invalide` dans l'agent | `PUSH_TOKEN` de l'agent ≠ `LIVE_PUSH_TOKEN` du site |
| `503 mode push non activé` dans l'agent | ajoute `LIVE_PUSH_TOKEN` sur le site puis redéploie |

# Télémétrie & BoP — GDSP

Application **séparée** du site de classement. Elle mesure les voitures sur le
serveur, calcule ce qu'elles coûtent **en course** (pas seulement au tour), et
produit le rapport qui sert à équilibrer un championnat multi-voitures.

> Le classement global et les fiches pilotes du site ne sont **jamais** touchés :
> stockage, API et code sont distincts (voir « Isolation » plus bas).

---

## Pourquoi le temps au tour ne suffit pas

Deux voitures ne se comparent pas sur leur meilleur tour mais sur le **temps de
course**, arrêts compris :

```
autonomie essence (tours) = réservoir utilisable / consommation par tour
autonomie gomme   (tours) = 100 / usure (%/tour)
arrêts nécessaires        = le plus tôt des deux, jusqu'au drapeau
temps de course           = tours × tour médian + arrêts × (pit-lane + service)
```

Exemple réel (démonstration, données de contexte ci-dessous) :

| Voiture | Tour médian | L/tour | Autonomie | Arrêts sur 20 min | Course à distance égale |
| --- | --- | --- | --- | --- | --- |
| alfa_giulietta_spider | 1:15.576 | 1,50 | 30,0 tours | 0 | **18:53.640** (réf.) |
| bmw_m3_e30 | 1:16.210 | 1,90 | 28,9 tours | 0 | +9.510 |
| actk_lola_t290 | **1:14.902** | 2,40 | 12,5 tours | 1 | +23.410 |

La Lola est **0,7 s plus rapide au tour** et perd **23 s** sur 20 minutes. C'est
exactement la décision qu'un BoP doit prendre, et qu'un classement de chronos ne
peut pas prendre.

Ces chiffres sont reproductibles : `node tools/telemetry/cli.js demo --force`
régénère le rapport complet (CSV, Markdown, HTML) depuis
`data/telemetry/demo-monza-junior.json`.

Le rapport simule les trois formats demandés : **20, 30 et 45 minutes**.

---

## Ce qui est mesuré, ce qui ne l'est pas

| Donnée | Source | Sans rien installer chez les pilotes ? |
| --- | --- | --- |
| temps, tours, écarts, vitesse max | UDP du serveur (plugin ACSP) | oui |
| consommation, usure pneus, vitesse max | script CSP `csp/gdsp_telemetry.lua`, poussé par le serveur | oui, une fois le script déclaré sur le serveur |
| pit-lane, débit de ravitaillement, changement de gommes | mesure dédiée (jour 4), saisie dans `/telemetry` | oui |

**Règle absolue** : une valeur qui n'a pas été mesurée reste `null`. Elle
n'entre jamais dans un calcul de BoP. Un tour sans mesure de conso compte pour
le tour médian (le chrono est fiable) mais pas pour la consommation.

Le protocole de test refuse de produire un rapport tant que les mesures
essentielles manquent : un BoP faux est plus dangereux qu'un BoP absent, parce
qu'il ferait changer les voitures pour de mauvaises raisons.

---

## Isolation : `telemetry` ne touche jamais au championnat

- base : schéma **`telemetry`** (tables `session`, `stint`, `lap`,
  `circuit_profile`), aucune clé étrangère hors de ce schéma ;
- code : `tools/telemetry/`, aucun import du module du site ;
- l'API et les pages portent `/telemetry/...`, jamais `/api/events` ou
  `/api/championship`.

Les tests vérifient cette isolation : aucune référence aux tables du site dans le
schéma.

---

## Utilisation

### 1. Enregistrer une session

```js
const { createCollector } = require('./tools/telemetry/collector');

const collector = await createCollector();               // fichier local par défaut
await collector.openSession({
  track: 'ks_monza66-junior',
  sessionType: 'practice',
  airTempC: 26, roadTempC: 34, grip: 0.98,
  fuelRate: 100, tyreWearRate: 100,                      // OBLIGATOIRE pour comparer
  campaign: 'campagne-2026-11'
});

await collector.recordLap({
  driverGuid: '76561198015862674', driverName: "Assassin's Street",
  car: 'alfa_giulietta_spider',
  lapNumber: 4, lapMs: 75576,
  fuelUsedL: 1.5, tyreWearPct: 1.4, speedMaxKmh: 187
});
```

### 2. Générer le rapport

```bash
node tools/telemetry/cli.js campaign --campaign campagne-2026-11   # état des 10 jours
node tools/telemetry/cli.js report   --campaign campagne-2026-11   # CSV + Markdown + HTML
```

Les trois fichiers sortent dans `reports/` :

- `bop-<campagne>-<date>.csv` — tableur : `;` en séparateur, virgule décimale,
  BOM UTF-8 (Excel n'abîme pas les accents) ;
- `.md` — lisible dans GitHub ;
- `.html` — autonome, imprimable en PDF.

`--force` génère le rapport malgré une campagne incomplète, en inscrivant
l'avertissement en tête des trois fichiers.

### 3. En ligne : le script CSP poussé aux pilotes

C'est le chemin normal : le script se dépose **une seule fois sur le serveur**,
et chaque pilote l'exécute à la connexion, sans rien installer.

```
serveur AC
  server/cfg/csp_extra_options.ini        ← 3 lignes à ajouter, une fois
        │
        └─► le client télécharge  <site>/csp/telemetry.lua
                │                 (le site y injecte l'URL et le jeton)
                └─► web.post  ──► POST <site>/api/telemetry/push
                                        │
                                        └─► schéma `telemetry` → page /telemetry → rapport BoP
```

**a. Déclarer le script sur le serveur** — `server/cfg/csp_extra_options.ini` :

```ini
[SCRIPT_2]
SCRIPT = https://<ton-site>/csp/telemetry.lua
REQUIRED = 0
```

`REQUIRED = 0` est volontaire : si le site est momentanément hors ligne, les
pilotes ne doivent pas être éjectés du serveur. Le script n'empêche jamais de
rouler.

**b. Rien d'autre à écrire à la main.** La route `/csp/telemetry.lua` sert le
script avec, à la fin, la table de configuration :

```lua
__GDSP_TELEMETRY__ = { url = ".../api/telemetry/push", token = "...", campaign = "...", intervalSec = 5 }
```

Le jeton n'est donc pas dans le dépôt : il vient de l'environnement du site.
Si le script n'est pas servi par le site (copie locale, gist), il retombe sur
`ac.configValues` : les mêmes quatre paramètres peuvent alors être passés dans
le bloc `[SCRIPT_2]`.

> **Cette table est du Lua, pas du JSON.** `{ url = "…" }` et non
> `{"url":"…"}`. CSP compile le fichier entier : une virgule de trop ou un `:`
> au lieu du `=` et il rejette tout, avec pour seule trace dans
> `custom_shaders_patch.log` :
>
> ```
> 🚨 Failed to parse: code:518: '}' expected near ':'
> ⚠️ Lua: <Server Script: SCRIPT_2> failed to load
> ```
>
> Aucun message en jeu, aucune donnée envoyée : c'est le pire mode de panne,
> parce qu'il est silencieux côté pilote. Un test compile désormais le script
> **tel qu'il est servi** (`tests/telemetry-service.test.js`) pour que cette
> faute ne puisse plus passer.

**b bis. Le ping de démarrage.** Dès le chargement, et **sans avoir roulé un
seul tour**, le script envoie un paquet `kind: "ping"`. Le site l'accepte sans
rien stocker (ce n'est pas une mesure) et l'inscrit dans ses logs Render :

```
télémétrie: ping reçu — circuit=ks_monza66-junior voiture=… pilote=7656119…
```

En jeu, le message dit `Connexion au site établie (200)`. C'est le seul contrôle
qui distingue les pannes sans faire rouler personne :

| Message du ping | Cause |
| --- | --- |
| `Connexion au site établie (200)` | script exécuté, réseau OK, jeton accepté, base joignable |
| `HTTP 401` | `TELEMETRY_TOKEN` du site ≠ jeton injecté dans le script |
| `HTTP 503` | `TELEMETRY_ENABLED=0`, ou base injoignable sur Render |
| `envoi impossible` | pas de réseau, ou `web.post` indisponible (CSP < 0.1.79) |
| **aucun message** | le script n'a pas été téléchargé ou n'a pas démarré |

**c. Vérifier sur le premier tour.** Le script affiche un message en jeu :

```
Télémétrie GDSP · carburant lu · pneus lus · envoi actif
```

Si un champ est absent de ta version de CSP, le message dit `NON LU` /
`NON LUS` et **le script n'envoie pas de valeur inventée** : le tour part avec
`fuelUsedL` / `tyreWearPct` absents, et la page affiche « — ». C'est le
diagnostic à demander au pilote avant de conclure qu'un chiffre manque.

**d. Ce que le script fait et ne fait pas**

| | |
| --- | --- |
| lit | niveau de carburant (L), usure des 4 pneus (0…1), temps au tour, vitesse max, compteur de tours |
| calcule | consommation = niveau début − niveau fin ; usure = usure début − usure fin, par roue |
| ne fait pas | aucune conduite, aucune modification de la voiture, aucun réglage — lecture seule |
| en cas de doute | ravitaillement (niveau qui monte) → pas de consommation publiée ; tour sans identité → ignoré |
| réseau | un envoi toutes les 5 s au plus, lots de 120 tours max, hors-ligne → les tours restent en mémoire et repartent au rétablissement |
| doublons | le site déduplique par `pilote | voiture | numéro de tour` — un renvoi ne crée jamais de doublon |

Le script a été écrit pour ne jamais casser la session : chaque lecture est
protégée (`pcall`), et si rien n'est lisible il se contente de le dire.

### 4. Page de consultation `/telemetry` (admin)

Connexion avec le compte administrateur habituel du site, puis :

- **filtres** voiture / circuit / pilote / campagne, avec regroupement par
  pilote (même voiture, plusieurs pilotes) ;
- **quatre indicateurs** : tours mesurés, voitures comparables, voiture la plus
  rapide au tour, voiture la plus rapide en course ;
- **tableau par voiture** : tour médian, L/tour, gomme %/tour, réservoir,
  autonomies essence et gomme, vitesse max ;
- **mesures pit-lane** du circuit (sans elles, aucun temps de course n'est
  calculable) : temps de traversée des stands, débit de ravitaillement, temps
  de changement de gommes ;
- **rapport** téléchargeable en CSV, Markdown et HTML.

Chaque cellule non mesurée affiche « — » : c'est une information, pas un zéro.

#### Si la connexion est refusée

La page distingue maintenant trois situations, avec le message correspondant :

| Message | Cause | Correction |
| --- | --- | --- |
| « Identifiants refusés par le serveur. » | le login (relayé au backend) refuse le couple utilisateur/mot de passe | vérifier `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| « Ce service refuse le jeton (HTTP 401) » | le backend a validé la connexion, mais **ce service-ci** n'a pas le même mot de passe | poser `ADMIN_PASSWORD` (et `ADMIN_USERNAME`) sur le **même** service Render que le site |
| « Le service démarre (Render à froid, ~30 s) » | le service ou le backend est injoignable | réessayer : le jeton est **conservé**, pas besoin de se reconnecter |

Le mot de passe admin sert à deux choses distinctes : il est le jeton renvoyé
par le login, et c'est lui que `checkAdminAuth` compare localement. S'ils
diffèrent entre le site et le backend, la connexion réussit puis les routes de
télémétrie répondent 401 : c'est exactement ce que le message d'écran explique.

### 5. Base PostgreSQL / Neon

La télémétrie va dans la **même base Neon que le site**, dans un schéma séparé :

```bash
TELEMETRY_DATABASE_URL=postgres://...
```

`pg` est **déjà dans les dépendances** : rien à installer. Le schéma `telemetry`
(tables `session`, `stint`, `lap`, `circuit_profile`) est créé automatiquement
au premier appel — aucune migration à lancer à la main.

> **Piège rencontré en production.** Une contrainte d'unicité portant sur une
> expression (`UNIQUE (started_at, track, COALESCE(track_config,''))`) est
> refusée par Postgres : `syntax error at or near "("`. L'initialisation
> échouait donc en entier, et les logs Render répétaient
> `télémétrie: ouverture impossible`. L'unicité sur expression passe par un
> `CREATE UNIQUE INDEX`, jamais par une contrainte de table — un test le
> vérifie (`tests/telemetry-store.test.js`).

Sans cette variable, un fichier JSON local sert de base (même API, sans
dépendance) : pratique pour tester ou travailler hors ligne.

Sur Render, la base est **obligatoire** : le disque est effacé à chaque
déploiement, un fichier local ne survivrait pas. Si `TELEMETRY_DATABASE_URL`
est définie sans que la base soit joignable, les routes de télémétrie répondent
503 et le reste du site continue de fonctionner normalement.

### 6. Essai local, sans serveur AC

Deux commandes suffisent pour voir la page et le rapport avec de vraies données
de démonstration (Monza junior, trois voitures, deux pilotes) :

```bash
node tools/telemetry/demo-seed.js --write        # remplit data/telemetry/demo-store.json
TELEMETRY_STORE_FILE=data/telemetry/demo-store.json \
ADMIN_PASSWORD=secret TELEMETRY_TOKEN=jeton node app.js
```

Puis `http://localhost:10000/telemetry` (port par défaut, `PORT=8080` pour en
changer) et connexion avec `secret`. Le store de démonstration est un fichier
ordinaire : le supprimer suffit à repartir de zéro. Il n'est jamais lu en
production, où `TELEMETRY_STORE_FILE` n'est pas défini.

Les chiffres de la démonstration sortent du **même** code que la production :
`demo-seed.js` appelle `TelemetryService.ingest` puis `report`, pas une maquette
HTML. Le rapport produit est reproduit ci-dessous (extrait) :

```
| Voiture                | Tour médian | L/tour | Gomme %/tour | Autonomie essence |
| alfa_giulietta_spider  | 1:15.576    | 1,50   | 1,40         | 30,0 tours        |
| bmw_m3_e30             | 1:16.210    | 1,90   | 2,80         | 28,9 tours        |
| actk_lola_t290         | 1:14.902    | 2,40   | 2,20         | 12,5 tours        |
```

---

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `TELEMETRY_TOKEN` | *(vide)* | jeton attendu dans `X-Telemetry-Token`. Vide = les envois sont **refusés** (503), sauf `TELEMETRY_ALLOW_OPEN=1` |
| `TELEMETRY_ALLOW_OPEN` | `0` | `1` accepte les envois sans jeton — réservé aux essais, jamais en prod |
| `TELEMETRY_ENABLED` | `1` | `0` coupe la télémétrie : les routes répondent 503, le reste du site continue |
| `TELEMETRY_CAMPAIGN` | `campagne` | nom de campagne injecté dans le script, pour séparer les périodes |
| `TELEMETRY_INTERVAL_SEC` | `5` | intervalle minimum entre deux envois (2 s plancher) |
| `TELEMETRY_DATABASE_URL` | *(vide)* | base `telemetry` (schéma séparé) ; vide = fichier JSON local |
| `TELEMETRY_STORE_FILE` | `data/telemetry-store.json` | chemin du fichier quand il n'y a pas de base |
| `PUBLIC_SITE_URL` | *(hôte de la requête)* | adresse publique injectée dans le script |

Sur Render, `TELEMETRY_DATABASE_URL` est **obligatoire** : le disque est effacé
à chaque déploiement, un fichier local ne survivrait pas.

---

## Campagne de 10 jours

| J | Objectif | Ce que ça invalide si on l'oublie |
| --- | --- | --- |
| 1 | Référence : tour médian, météo, `FUEL_RATE`/`TYRE_WEAR_RATE` | sans les rates, les sessions ne sont pas comparables |
| 2 | Relais longs : L/tour et usure %/tour | un relais de 3 tours ne dit rien |
| 3 | Deuxième pilote sur la même voiture | on ne distingue pas voiture et pilote |
| 4 | Pit-lane, débit de ravitaillement, changement de gommes | aucun temps de course calculable |
| 5 | Réservoir bas vs plein : sensibilité à la masse | un lest proposé serait inventé |
| 6-8 | Matrice pilote × voiture | comparaison entre voitures impossible |
| 9 | Reproductibilité (écart ≤ 0,3 %) | on ne distingue pas une voiture du bruit |
| 10 | Rapport et décision | tout ce qui précède doit être validé |

`node tools/telemetry/cli.js campaign` dit exactement quels jours sont validés
et ce qui manque.

---

## Limites, dites franchement

1. **Le carburant et l'usure ne sortent pas du serveur dédié.** Le protocole ACSP
   ne transporte que position, vitesse, rapport et régime. Il faut les lire côté
   client (script CSP envoyé par le serveur, comme le rolling start) ou installer
   une application chez chaque pilote.
2. **Les arrêts simulés supposent un service parfait** : pas d'erreur de
   ravitaillement, pas d'attente au stand. Ce sont des temps « au mieux ».
3. **La sensibilité à la masse n'est pas devinée** : sans la mesure du jour 5,
   le rapport affiche le delta en secondes et laisse la décision à l'humain.
4. **Un pilote qui a roulé dans une seule voiture n'entre pas** dans la
   comparaison entre voitures : son delta mesurerait son absence, pas la voiture.

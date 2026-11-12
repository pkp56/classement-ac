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
| alfa_giulietta_spider | 1:15.576 | 1,50 | 30 tours | 0 | **18:53.640** |
| bmw_m3_e30 | 1:16.210 | 1,90 | 28,9 tours | 0 | +9.510 |
| actk_lola_t290 | **1:14.902** | 2,40 | 12,5 tours | 1 | +23.410 |

La Lola est **0,7 s plus rapide au tour** et perd **23 s** sur 20 minutes. C'est
exactement la décision qu'un BoP doit prendre, et qu'un classement de chronos ne
peut pas prendre.

Le rapport simule les trois formats demandés : **20, 30 et 45 minutes**.

---

## Ce qui est mesuré, ce qui ne l'est pas

| Donnée | Source | Sans rien installer chez les pilotes ? |
| --- | --- | --- |
| temps, tours, écarts, vitesse max | UDP du serveur (plugin ACSP) | oui |
| consommation, usure pneus, températures | à instrumenter (script CSP poussé par le serveur) | oui, une fois le script en place |
| pit-lane, débit de ravitaillement, changement de gommes | mesure dédiée (jour 4) | oui |

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

### 3. Base PostgreSQL / Neon

La télémétrie va dans la **même base Neon que le site**, dans un schéma séparé :

```bash
TELEMETRY_DATABASE_URL=postgres://...   # ou DATABASE_URL
npm i pg
```

Sans cette variable, un fichier JSON local sert de base (même API, sans
dépendance) : pratique pour tester ou travailler hors ligne.

Sur Render, la base est **obligatoire** : le disque est effacé à chaque
déploiement, un fichier local ne survivrait pas.

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

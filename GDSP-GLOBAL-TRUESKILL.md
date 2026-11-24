# GDSP Global — Indice TrueSkill expérimental

**Statut :** proposition + prototype moteur implémenté. Non officielle.  
**État au 2026-11-20 (implémentation) :**

- `assets/trueskill-rating.js` — moteur TrueSkill porté en JavaScript pur (graphe factoriel et passage de messages du papier), sans dépendance runtime. Vérifié contre les valeurs de référence du graphe (β = σ₀/2, drift nul, entrée 4 joueurs avec égalités) à 1e-7 près.
- `assets/trueskill-gdsp.js` — adaptateur sessions GDSP → courses TrueSkill (RACE uniquement, coefficient Global > 0, corrections Commission appliquées, DNF non qualifiés / DNS / services exclus, DQ Commission incluse en bas, `hidden` admin respecté). Fonctions PC/mobile injectées : zéro divergence de règles.
- PC : section repliable « Indice TrueSkill — expérimental » en bas du classement Global + panneau sur la fiche pilote Global (`index.html` charge `trueskill-rating.js?v=1` et `trueskill-gdsp.js?v=1`, `site.js?v=135`).
- Mobile : parité PC/mobile — même section et même panneau via `profile-engine` / `profile-views`, coque PWA passée en `gdsp-mobile-shell-v6`.
- `tools/trueskill-benchmark.js` — walk-forward vs Elo pairwise et baseline « plus expérimenté ». Usage : `node tools/trueskill-benchmark.js <export.json> [--beta=5.5]`.
- Tests : `tests/trueskill-rating.test.js`, `tests/trueskill-gdsp.test.js` ; parité PC/mobile de l'indice dans `tests/site-boot.test.js`.

**Reste à faire avant adoption :** benchmark walk-forward sur l'export complet de l'historique (fixtures disponibles = trop partielles), gel des seuils AVANT lecture des métriques, revue Commission/pilotes, décision sur les 7 questions de la section 13. Le Global officiel n'est pas modifié et l'indice n'apparaît pas dans le classement sportif.

**Source principale :** Ralf Herbrich, Tom Minka et Thore Graepel, *TrueSkill™: A Bayesian Skill Rating System*, NIPS 2006.  
**Objectif :** ajouter un indicateur expérimental de niveau qui complète le Global GDSP actuel sans modifier le classement officiel, les championnats, les sanctions ni les résultats.

## 1. Décision de cadrage

Implémentation proposée en trois étapes :

1. **Moteur pur et auditable** : `assets/trueskill-rating.js`, partagé PC/mobile, avec tests.
2. **Affichage expérimental séparé** : onglet du Global PC et mobile affichant l’indice, son incertitude et son évolution.
3. **Validation sur l’historique** : comparaison walk-forward avec le Global actuel avant toute adoption sportive.

Le Global actuel reste la référence sportive publique. TrueSkill ne modifie pas :

- les points de championnat ;
- les positions et les pénalités ;
- le score Global v2 ;
- les niveaux existants ;
- les sanctions Commission ;
- les résultats enregistrés.

## 2. Ce que TrueSkill apporte

TrueSkill améliore trois limites d’Elo :

- plusieurs participants au lieu de deux équipes adverses ;
- incertitude explicite du niveau ;
- généralisation aux équipes de participants.

Il représente :

- `s_i ~ N(μ_i, σ_i²)` : compétence réelle du pilote `i` ;
- `p_i ~ N(p_i ; s_i, β²)` : performance du pilote pendant une course ;
- pour une équipe `j`, `t_j` est la somme des performances de ses membres ;
- la probabilité d’un résultat est la probabilité que l’ordre des performances observées corresponde au classement.

Le papier utilise un graphe factoriel et un passage approximatif de messages, fondé sur la propagation d’espérances. Les messages non gaussiens sont approximés par des gaussiennes avec la même moyenne et la même variance.

Pour le GDSP v1, chaque pilote solo participe comme une équipe de taille 1. Les endurances à rotation de pilotes sont donc exclues de la v1 ou traitées uniquement si le module reçoit explicitement l’identité du pilote pour la course considérée.

## 3. Périmètre fonctionnel

### Inclus

- Courses `RACE` seulement.
- Tous les événements Global avec coefficient strictement positif :
  - championnat ;
  - endurance si chaque résultat est individuel ;
  - Cup ;
  - Open ;
  - archive si son coefficient configuré est positif.
- Résultats après corrections Commission, si elles sont connues.
- Classement complet de la course.
- Exclusions Global existantes.
- Pace cars, broadcast et Safety Car reconnus comme inscriptions de service.
- Historique auditable par course.
- Indice et marge d’incertitude.

### Exclus

- Qualifications, entraînements et PRACTICE.
- Fiestas et Trackdays, coefficient Global nul.
- Épreuves ou courses marquées test.
- Événements dont le coefficient Global est nul.
- Inscrits AssettoHosting sans ligne de résultat.
- Pace car / broadcast, même s’ils apparaissent par erreur dans `ahEntrants` ou dans les résultats non corrigés.
- Modification automatique du Global officiel.
- Calcul officiel attribuant des sanctions.
- Note globale fondée sur la propreté.

## 4. Modèle de données attendu

Une course devient un ensemble de lignes :

```js
{
  eventSlug: 'lola-t290-gdsp-championnat-2026',
  eventName: 'Lola T290 GDSP — Championnat',
  eventKind: 'championship',
  globalWeight: 1,
  raceKey: 'lola...:2026-11-01T21:00:00Z:spa:RACE',
  date: '2026-11-01T21:00:00Z',
  finishOrder: ['pilot-a', 'pilot-b', 'pilot-c'],
  entries: [
    { id: 'pilot-a', name: 'Alice', outcome: 'classified' },
    { id: 'pilot-b', name: 'Bob', outcome: 'classified' },
    { id: 'pilot-c', name: 'Charlie', outcome: 'dq_sporting' }
  ]
}
```

`outcome` prend une des valeurs :

| Valeur | Traitement |
|---|---|
| `classified` | Inclus dans l’ordre sportif final |
| `dq_sporting` | Inclus en position inférieure à tous les classés, si la Commission le décide |
| `dnf_commission` | Inclus uniquement après décision Commission explicite indiquant de le classer en bas |
| `excluded_commission` | Exclu : erreur sans décision sportive, DNS, abandon mécanique sans qualification |
| `dns` | Exclu |
| `dq_unqualified` | Exclu tant que la Commission n’a pas qualifié la nature de la DQ |
| `service` | Toujours exclu |

La v1 ne déduit jamais automatiquement la nature d’un DNF, d’un DNS ou d’une DQ à partir des seules données AssettoHosting.

## 5. Algorithme de calcul

### Rejouage chronologique

Le modèle est rejoué, pour chaque pilote, depuis le début de l’historique Global dans l’ordre chronologique.

Pour chaque course :

1. Construire l’ordre sportif officiel.
2. Exclure les entrées non admissibles.
3. Vérifier que la course contient au moins deux participants notables.
4. Appliquer l’algorithme TrueSkill au classement complet.
5. Enregistrer l’état avant/après de chaque participant.
6. Passer au week-end/course suivante.

Il ne faut pas appliquer une passe « ajustée à la main » après TrueSkill. Les ajustements doivent pouvoir être expliqués par le graphe factoriel et les décisions Commission.

### Paramètres initiaux

Valeurs de départ inspirées du papier, à valider sur les données GDSP :

```txt
μ₀ = 25
σ₀ = 25 / 3 ≈ 8,33
β  = σ₀ / 2 ≈ 4,17
γ  = σ₀ / 100 ≈ 0,083
```

Mais le GDSP est très bruité : piste, trafic, météo, safety car, incidents, voiture différente selon les manches. La première expérimentation devra donc tester :

```txt
β_GDSP = 5 à 6
γ_GDSP = faible, à calibrer
```

Ne pas publier les paramètres comme « optimaux » sans validation walk-forward.

### Coefficients d’événements

Le coefficient Global `w ∈ ]0,1]` réduit l’information accordée au résultat. Exemple :

```txt
β_course = β_GDSP / sqrt(w)
```

Effet :

- championnat ou endurance : information complète ;
- Cup : mise à jour réduite ;
- Open : mise à jour nettement réduite ;
- Fiesta / Trackday : aucune mise à jour ;
- coefficient 0 : course ignorée complètement.

Cette adaptation est préférable à une multiplication artificielle des « points », car TrueSkill met à jour une distribution de croyance, pas un total de points.

### Égalités

Une position réellement ex æquo selon le règlement est rare. La v1 doit néanmoins définir le comportement :

- ex æquo officiel : traitement comme un même rang, avec règle TrueSkill admissible ;
- égalité de points sans égalité de ligne d’arrivée : départage selon la règle sportive normale, sans créer un draw TrueSkill ;
- absence de règle disponible : exclure la course du benchmark plutôt que d’inventer un ordre.

### Notes et incertitude

Affichage v1 :

```txt
Indice conservateur = μ − 3σ
Écart-type = σ
Nombre de courses notées = n
Confiance = faible / moyenne / élevée
```

Le papier présente `μ − 3σ` comme une note conservatrice, adaptée aux classements publics où les profils bien établis doivent monter progressivement.

Pour la v1, **ne pas** convertir immédiatement l’indice en Niveau 1/2/3/4. Les paliers doivent être calibrés sur l’historique GDSP, pas repris du papier.

## 6. Exclusions et garde-fous

L’indice reprend les mécanismes existants :

- `globalHidden` / exclusions Global administrateur ;
- coefficient Global par événement ;
- service role détecté par nom explicite ;
- sessions importées sans résultat classable ;
- événements incomplets ou non auditables.

Règle d’affichage : si l’historique ne peut pas être calculé correctement, le bloc affiche « Indice indisponible » avec la raison. Il ne montre pas un classement partiel présenté comme complet.

## 7. Interface proposée

### Classement Global PC et mobile

Ajouter un onglet ou une section repliable :

**Indice TrueSkill — expérimental**

Colonnes :

- position ;
- pilote ;
- indice `μ − 3σ` ;
- écart-type `σ` ;
- courses notées ;
- confiance ;
- évolution après la dernière course ;
- badge provisoire avant 10 courses.

### Fiche pilote

Ajouter un panneau :

**Indice TrueSkill (expérimental)**

Contenu :

- indice actuel et incertitude ;
- confiance ;
- courbe d’évolution par course ;
- liste des courses prises en compte ;
- liste des courses exclues et raison ;
- évolution après chaque manche ;
- rappel explicite : « ne remplace pas le classement officiel ».

### Administration

Ajouter dans Exclusions Global ou dans un écran dédié :

- réintégrer un pilote exclu ;
- masquer un pilote du Global expérimental ;
- exclure une course ;
- saisir la raison ;
- voir le nombre de courses notées restantes.

Toute exclusion sportive ou technique doit conserver une raison écrite.

## 8. Prédiction et évaluation

L’adoption ne doit pas être basée sur « le classement semble plausible ».

### Méthode walk-forward

Pour chaque course `k` d’un historique chronologique :

1. Calculer l’indice à partir des courses `1…k−1`.
2. Prédire la distribution ou le classement attendu de la course `k`.
3. Observer le résultat réel.
4. Comparer avec les prédictions du Global actuel et d’une baseline Elo.

### Métriques

- log-loss ou Brier score sur les résultats ;
- précision du vainqueur ;
- précision du podium ;
- erreur moyenne de position prédite ;
- calibration par tranches de confiance ;
- stabilité des rookies après 5, 10 et 20 courses ;
- robustesse aux DNF/DQ ;
- sensibilité à l’exclusion d’une course atypique.

### Critère de réussite proposé

Ne pas envisager un affichage public par défaut si la version expérimentale n’est pas au moins aussi fiable que le Global actuel sur l’historique.

Pour adoption publique :

- meilleure calibration ou meilleure précision prédictive, ou
- avantage clair sur les rookies et les échantillons courts, sans dégrader les pilotes confirmés.

Les seuils numériques seront gelés avant le benchmark pour éviter de choisir après coup la métrique la plus favorable.

## 9. Architecture technique

### Module partagé

```txt
assets/trueskill-rating.js
```

API cible :

```js
const result = GDSPTrueSkill.replay(courses, {
  beta: 5.5,          // GDSP (à valider) ; le papier utilise β = σ₀/2 ≈ 4.17
  sigmaDrift: 0.083,  // γ (dérive d'incertitude entre courses)
  drawProbability: 0.10,
  minRaces: 5         // minimum pour apparaître ; provisoire avant 10
});
```

`adjustRace(players, {beta, sigmaDrift, drawProbability | epsilon})` expose aussi la mise à jour d'une course unique pour le benchmark.

Résultat :

```js
{
  ratings: [
    {
      id,
      name,
      team,
      mu,
      sigma,
      conservative,
      races,
      confidence,
      provisional,
      evolution: [
        { raceKey, beforeMu, beforeSigma, afterMu, afterSigma, deltaConservative }
      ],
      exclusions: [{ raceKey, reason }]
    }
  ],
  diagnostics: {
    coursesUsed,
    coursesSkipped,
    warnings
  }
}
```

### PC et mobile

- PC : vue Global expérimentale dans `site.js`, versionnée correctement.
- Mobile : moteur et vues mobiles dédiées, parité avec PC.
- PWA : incrémenter la coque si des fichiers hashés ou l’UI changent.
- Aucune donnée de production modifiée par le calcul.

### Dépendance

Décision d'implémentation : **option 1 — implémentation maison**, sans dépendance runtime (le paquet npm `trueskill@0.0.2` a été inspecté puis écarté : paramètres globaux mutables, `AdjustPlayers` mutante, vieille base `free-gaussian`). Le port maison reproduit les valeurs de référence du graphe factoriel à 1e-7 près (voir `tests/trueskill-rating.test.js`).

## 10. Tests obligatoires

### Moteur

- Rookie gagnant contre plateau établi : la note monte davantage que pour un favori gagnant.
- Favori perdant contre faible plateau : la note descend.
- DNF/DNS exclus n’ont aucun effet.
- `dq_sporting` modifie bien l’ordre final.
- Pace car / Broadcast exclus.
- Coefficient 0 : aucun effet sur l’état.
- Coefficient inférieur à 1 : effet plus faible qu’une épreuve officielle.
- Exclusion Global administrateur.
- Rejeu chronologique stable et déterministe.
- Égalité d’ordre ou course incomplète : comportement défini, jamais aléatoire.

### PC / mobile

- Parité des notes et des exclusions.
- Classements identiques à arrondi près.
- Affichage indisponible si les données nécessaires manquent.
- Aucun changement dans le Global officiel.
- Service worker PWA compatible avec la nouvelle vue.

### Audit

- Chaque pilote peut être retracé jusqu’aux courses prises en compte.
- Chaque exclusion visible avec sa raison.
- Aucune course ne disparaît sans trace.

## 11. Déploiement

1. Branche dédiée et PR de prototype moteur.
2. Tests complets et comparaison sur fixture GDSP.
3. PR PC : panneau expérimental, masqué si incomplet.
4. PR mobile : parité PC/mobile et version PWA incrémentée.
5. Déploiement progressif derrière un drapeau d’administration ou une section repliée.
6. Benchmark sur historique complet.
7. Revue Commission / pilotes avant toute adoption sportive.

Aucune migration de base n’est nécessaire si l’indice est calculé à la volée. Une persistance du cache ne devra être ajoutée que si les performances l’exigent, avec invalidation explicite liée à la version du moteur.

## 12. Critères d’acceptation

- Le Global officiel ne change pas.
- Le calcul est reproductible PC/mobile.
- Les courses et exclusions sont auditables.
- Les pace cars et broadcast ne reçoivent aucun rating.
- Une course mal définie est refusée proprement ou exclue avec raison.
- Les utilisateurs comprennent qu’il s’agit d’un indice expérimental.
- Les tests et le benchmark passent sur l’historique.
- Aucune donnée de résultats n’est modifiée pour "faire fonctionner" l’indice.

## 13. Questions à trancher

1. DNF : exclure toujours sauf décision Commission, ou classer dernier par défaut après course terminée partiellement ?
2. DNS : toujours exclure, ou compter comme mauvaise performance après une absence injustifiée ?
3. Endurances à plusieurs pilotes : exclure toutes les courses, ou permettre un rating par pilote relais ?
4. Coefficient Global : modulation par `β / sqrt(w)` ou simple exclusion des événements faibles ?
5. L’interface publique affiche-t-elle l’indice `μ − 3σ` brut ou un indice converti 0–100 ?
6. Qui valide le passage de « expérimental » à « public officiel » ?
7. Faut-il un indice distinct Qualification, ou uniquement course ?

## 14. Recommandation finale

La valeur du papier est surtout la combinaison :

- classement complet plutôt que victoire/défaite ;
- incertitude explicite ;
- progression naturelle pour les rookies ;
- ajustement économique après chaque course.

La meilleure intégration GDSP est donc un **Global expérimental parallèle**, mesurant le niveau avec marge d’incertitude, tandis que le Global v2 conserve son rôle sportif officiel et la Commission son rôle disciplinaire.

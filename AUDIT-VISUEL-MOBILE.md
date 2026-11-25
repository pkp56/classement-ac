# Audit — Mobile GDSP : visuel & adaptation aux écrans mobiles

Date : 2026-11-24 · Périmètre : `mobile/` uniquement (PWA installable `/mobile/`) — PC hors sujet.
Méthode : revue complète du code (`index.html`, `mobile.css` 16 000+ lignes minifiées ≈ 10,6 Ko, `mobile.js`, `event-views.js`, `profile-views.js`, `results-engine.js`, `profile-engine.js`, `sw.js`, `manifest.webmanifest`, `icons/`) + calculs de contraste WCAG 2.1. **Aucun rendu navigateur réel ni test sur appareils physiques n'a été effectué** : les constats visuels sont des lectures de code et des mesures calculées, à confirmer sur téléphone.
État au moment de l'audit : `main` post-PR #154 · versions css v7 / js v8 / SW `gdsp-mobile-shell-v12` · 562/562 tests verts.

---

## 1. Verdict global

La version mobile est **saine structurellement** : navigation à 5 onglets + barre de sections d'événement, zones sûres (safe-area) gérées en bas, cibles tactiles ≥ 44 px presque partout, contraste majoritaire correct, échappement HTML systématique, aucun tableau large en overflow horizontal, PWA correctement versionnée.
L'essentiel des défauts se concentre sur : **la typographie des titres sur Android/iOS**, **les barres fixes sur écran ≥ 700 px**, **le contraste du texte secondaire sur fond clair**, et quelques oublis d'adaptation fine (petits écrans, paysage, iOS).

Sévérité : **P0** = défaut visible/casse claire · **P1** = gêne sérieuse · **P2** = finition/dette.

| # | Sév. | Constat |
|---|------|---------|
| 1 | P0 | Titres en Impact s'affichent en sans-serif **régulier** (graisse 400) sur Android/iOS |
| 2 | P0 | Barres fixes (bottom-nav, event-subnav) en pleine largeur sur ≥ 700 px — boutons énormes sur tablette/desktop |
| 3 | P0 | `--muted #62706b` sous AA 4.5:1 sur fond `#eae3d2` (4.05), fond erreur (4.27) et fond pill (4.03) |
| 4 | P1 | iOS : pas de `-webkit-text-size-adjust:100%` → inflation des polices en paysage |
| 5 | P1 | `.global-driver-name` non stylé : empilement badge/nom/score fragile, pas de `min-width:0` |
| 6 | P1 | `#content` mauvais citoyen a11y : `tabindex="-1"` + `aria-live="polite"` sur tout le `main` → lecteur d'écran trop bavard, focus jamais déplacé |
| 7 | P1 | Paysage téléphone (hauteur < 480 px) : 124–180 px de chrome fixe, aucune adaptation |
| 8 | P1 | iOS standalone : safe-area haut non exploitée (`apple-mobile-web-app-status-bar-style: default` + pas de `env(safe-area-inset-top)`) |
| 9 | P2 | Icônes de navigation : glyphes Unicode hétérogènes (⌂ ▤ ★ ◉ ⋯ vs emojis 🏁 👤 🏎️) — rendu variable selon plateforme |
| 10 | P2 | CSS mort : `.embedded-page`, `.embedded-note` (jamais utilisées), double déclaration `grid-template-columns` sur `.bottom-nav` |
| 11 | P2 | Nombre magiques 68/70/78/126/56/… entre bottom-nav, event-subnav et `body{padding-bottom}` |
| 12 | P2 | `intro.webp` = 515 Ko pour le héros — lourd sur réseau mobile |
| 13 | P2 | Icônes PWA `purpose:"any"` uniquement — pas de variante `maskable` (rognage possible sur Android adaptatif) |
| 14 | P2 | Focus-visible manquant sur `summary`, `select`, inputs (cohérence avec les autres composants) |
| 15 | P2 | `-webkit-tap-highlight-color` non désactivé ; `overscroll-behavior` absent |

---

## 2. Adaptation aux écrans mobiles

### Ce qui est en place et correct
- `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` ✓
- `env(safe-area-inset-bottom)` sur `.bottom-nav`, `.event-subnav` et `body{padding-bottom:calc(78px + …)}` / `body.has-event-subnav{126px + …}` ✓
- `main{max-width:740px;margin:auto}` + cartes 2 colonnes dès 700 px ✓
- Grilles fluides `minmax(0,…)` partout (`.row`, `.result-row`, `.spec-list`, `.profile-stats`, navs) : pas de scroll horizontal attendu ✓
- Inputs en `font:16px` / recherche `type="search"` → pas de zoom intempestif iOS ✓
- `overflow-wrap:anywhere` systématique sur les chaînes dynamiques ✓

### Problèmes

**#2 (P0) — Barres fixes non contraintes ≥ 700 px.** `.bottom-nav` et `.event-subnav` sont en `left:0;right:0`. Sur une tablette ou un téléphone en paysage large (≥ 700 px), `main` est centré à 740 px mais la navigation s'étire sur toute la largeur : 5 boutons de 200+ px, visuellement cassés. Correctif : centrer et limiter les deux barres (`left:50%;transform:translateX(-50%);width:min(100%,740px)`), ou passer par un conteneur commun.

**#1 (P0) — Titres Impact.** `Impact` n'existe ni sur Android ni sur iOS. La cascade `Impact,'Arial Narrow',sans-serif` retombe donc sur le **sans-serif régulier (graisse 400)** pour `.hero h1`, `.page-title`, `.section-title h2`, `.panel h2` : titres maigres, sans la force attendue (voir capture « GDSP CUP SERIES » : déjà sur le téléphone, le rendu dépend de la police de repli du device). Correctif minimal : `font-weight:800` (Impact ignore la graisse, le repli devient gras). Mieux : pile dédiée mobile, ex. `font-family:'Arial Black','Helvetica Neue',sans-serif; font-weight:800; letter-spacing:.02em`.

**#3 (P0) — Contraste du texte secondaire.** Mesures (texte 12 px `.muted` / `.row small`) :

| Texte | Fond | Ratio | AA texte normal |
|---|---|---|---|
| #62706b | #f9f5e9 (panneau) | 4.76:1 | ✓ (juste) |
| #62706b | **#eae3d2 (corps, p ex. page Événements, ligne sous le direct)** | **4.05:1** | ✗ |
| #62706b | **#f7e6db (erreur)** | **4.27:1** | ✗ |
| #62706b | **#ece2cd (.pill)** | **4.03:1** | ✗ |
| #a23628 (accent rouge, 12 px bold) | #eae3d2 | 5.30:1 | ✓ |
| Tout le reste (navs, badges, or sur navy…) | — | 5.3 → 9.8:1 | ✓ |

Correctif : assombrir `--muted` à **#5c6863** (5.33 / 4.54 / 4.78 / 4.52 — AA partout, changement quasi invisible) ou `#56625d` pour une marge confortable.

**#4 (P1) — iOS paysage.** Sans `html{-webkit-text-size-adjust:100%}`, Safari iOS gonfle les polices en orientation paysage. À ajouter (progressive, sans effet ailleurs).

**#7 (P1) — Paysage téléphone.** En hauteur < ~480 px, `.bottom-nav` (68 px + indicateur) + `.event-subnav` (56 px) occupent jusqu'à ~35 % de la hauteur utile. Aucune règle `@media (max-height: …)` pour compacter (ex. hauteur 48 px, labels réduits) ni pour masquer les labels. À traiter ou à assumer en connaissance de cause.

**#8 (P1) — Safe-area haut.** En PWA standalone iOS avec `viewport-fit=cover`, le contenu démarre sous l'encoche/la barre d'état ; `.app-header` est `position:sticky;top:0` sans `padding-top:env(safe-area-inset-top)`. Aujourd'hui toléré parce que `apple-mobile-web-app-status-bar-style: default` réserve la zone ; le jour où l'on passe en `black-translucent` (plus immersif, fond navy), l'en-tête serait mangé par la barre d'état. Décider : soit rester en `default` (et le documenter), soit `black-translucent` **+** `padding-top:env(safe-area-inset-top)` sur `.app-header`.

**#15 (P2) — Finitions tactiles.** Ajouter `-webkit-tap-highlight-color:transparent` (le flash gris Android) et `overscroll-behavior-y:none` (élastique parasite en bas de liste). `@media (pointer:coarse)` permettrait aussi d'agrandir `.more-link` à 48 px.

**Petite épaisseur 320 px.** `main{padding:22px 16px 30px}` + `.panel{padding:18px}` → ~38 px de marges cumulées ; `.hero h1` 35 px / `.page-title` 33 px OK ; `.profile-stats` 2 colonnes OK ; `.spec-list` OK. Aucun débordement détecté à 320 px, seulement serré : acceptable.

**Clavier ouvert.** Les formulaires (connexion admin, clé de mise à jour) sont dans `main` : Android redimensionne la vue, iOS repositionne les éléments fixes au-dessus du clavier → champs accessibles. OK, à ne pas casser.

---

## 3. Visuel et identité

### Cohérent et réussi
- Palette navy/paper/rouge/or fidèle à la charte, header sticky avec liseré rouge, hero brandé (`intro.webp`) ;
- Mini-caps rouges `.eyebrow`, titres capitales, boutons rouges/dorés : identité forte, lisible ;
- Barre de sections d'événement (`.event-subnav`) au-dessus de la bottom-nav, même langage que celle-ci : désormais le hub événement et ses sous-pages sont cohérents, sans doublons (PR #153/#154) ;
- `#entrant-skin` 86×60 contain sur fond blanc : cartes engagés propres ;
- Panneaux `.panel` uniformes, hiérarchie h1 → h2 → h3 correcte.

### À corriger / arbitrer

**#9 (P2) — Icônes.** bottom-nav : glyphes texte (⌂ U+2302, ▤ U+25A4, ★, ◉, ⋯). event-subnav : emojis/symboles (🏁, 👤, 🏎️, ◎). Le rendu varie selon la police/emoji set de l'appareil (⌂ peut déborder sur Android, ▤ mal centré, 🏁/🏎️ en emoji plein écran alors que les 5 onglets sont en pictogrammes fins). Recommandation : **un jeu d'icônes SVG inline cohérent** (stroke 1.5–2 px, même grille 24×24) pour les 9 entrées, ou au minimum unifier sur emojis.

**#5 (P1) — Carte pilote Global.** `<span class="position">` + `<picture.global-level-badge>` + `<div class="global-driver-name">` + `<span class="global-score">` dans un `.event-card` flex, mais `.global-driver-name` **n'a aucune règle CSS** (pas de `flex:1;min-width:0`) alors que `.event-card>div` vise le `div` direct… ce sélecteur cible bien `.global-driver-name` (c'est un `div` enfant direct) : `min-width:0;flex:1` s'appliquent donc via `.event-card>div`. Restent à ajouter : `overflow-wrap:anywhere` sur le petit texte (<br> + long nom d'équipe) et un peu d'air entre badge et nom. Fragile mais non cassant — à verrouiller plutôt qu'à réparer d'urgence.

**#1 typographie** (déjà compté en P0) : l'identité « Impact » est un choix PC ; sur mobile elle s'effondre. Trancher : vraie pile mobile lourde (cf. §2) ou assume la graisse 800.

**Héros** (#12) : `intro.webp` 515 Ko chargée via CSS sur la page d'accueil mobile. Une version 16:9 ≤ 1200 px / q≈70 (~80–120 Ko) diviserait le coût réseau sans perte visible (image de fond sombre sous gradient 97 % → 78 %).

**Badges de niveau** (`global-level-badge` 40/72 px, cercle) : bien dimensionnés, `loading="lazy"` ✓, `alt` renseigné ✓.

---

## 4. Accessibilité

**Bon :** `lang="fr"` ✓ ; `aria-label` sur les deux `<nav>` ✓ ; `aria-hidden` sur les pictogrammes ✓ ; `aria-current="page"` géré sur les onglets ET la barre d'événement ✓ ; cibles ≥ 44 px (`.back`, `.btn`, `.session-detail summary`, navs, `.more-link` ≈ 51 px) ✓ ; `role="status"` sur la bannière de mise à jour et les messages admin ✓ ; `prefers-reduced-motion` respecté ✓ ; `:focus-visible` doré sur `.btn`, `.event-card`, `.bottom-nav a`, `.back`, `.more-link`, `.event-subnav a` ✓.

**À reprendre :**

**#6 (P1) — Gestion du focus & des annonces.** Au changement de vue, `content.innerHTML` est remplacé mais le focus reste sur le lien cliqué et `main[aria-live="polite"]` force le lecteur d'écran à **relire tout le contenu injecté** (des formulaires, des centaines de lignes TrueSkill…). Recommandé : focus explicite sur `content` (ou sur le `h1`) après chaque `show()`, et `aria-live` retiré (ou réduit à `role="status"` sur un conteneur ciblé). `main{outline:none}` est alors légitime (outline visible seulement hors clic si l'on garde `:focus-visible`).

**#14 (P2) — Focus-visible manquants** sur `.session-detail summary`, `.livery select`, inputs de formulaire et sélecteur de recherche : remplacement inégal du contour navigateur selon les thèmes. Uniformiser.

**#3 contrastes** (ci-dessus) = critère AA.

**Ordre de lecture** : header → nav éventuelle → main → barres fixes en dernier dans le DOM ? Non : `main` puis `nav.event-subnav` puis `nav.bottom-nav` ✓ logique (le contenu avant la navigation).

---

## 5. PWA, service worker & métadonnées

- Manifest cohérent (`start_url`/`scope` `/mobile/`, `display:standalone`, `theme_color` = header #102a32, `background_color` = corps #eae3d2) ✓
- **#13 (P2)** Icônes 192/512 `purpose:"any"` uniquement. Android adaptatif peut rogner les coins : ajouter une variante `512x512` `purpose:"maskable"` (logo dans la zone de sécurité 80 %) ou déclarer `"purpose":"any maskable"`.
- SW réseau-d'abord avec repli cache, jamais d'API/session en cache ✓ ; `CACHE` bumpé à chaque release (`v12`) ✓ ; `SHELL` **strictement aligné** sur les `?v=` de `index.html` (vérifié un à un : css 7, js 8, patch 97, views 10/5, engines 5/7, icons) ✓ — rien à redire, c'est propre.
- `apple-mobile-web-app-status-bar-style: default` → voir #8.
- `theme-color` identique HTML/manifest ✓.
- `description` renseignée ✓ · `lang` ✓ · `apple-touch-icon` ✓.

---

## 6. Qualité du code & dette

**#10 (P2) — CSS mort.** `.embedded-page` (cadre intégré 100dvh) et `.embedded-note` : aucune référence dans HTML/JS actuels (les vues complètes ne sont plus intégrées). Supprimer. `.bottom-nav{grid-template-columns:repeat(4,…)}` en tête de fichier **puis** `.bottom-nav{grid-template-columns:repeat(5,minmax(0,1fr))}` plus bas : la première est morte, fusionner.

**#11 (P2) — Nombres magiques couplés.** `.bottom-nav a{min-height:68px}` ↔ `.event-subnav{bottom:calc(70px + …)}` ↔ `body{padding-bottom:calc(78px + …)}` ↔ `body.has-event-subnav{calc(126px + …)}` : quatre valeurs à synchroniser à la main (les 2 px de jeu entre subnav et nav, les 10 px entre nav et padding). Une CSS custom property (`--nav-h:68px; --subnav-h:56px`) rendrait le couplage explicite. Idem `.event-subnav` répète la structure de `.bottom-nav` (factoriser `.tabbar` commun).

**Duplication JS.** `skinUrl`/`valid()` réimplémentés à l'identique dans `mobile.js`, `event-views.js` (`skinImage`) et `profile-views.js` (`driverImage`) — candidat à extraction-mutualisation (déjà un `assets/` de helpers partagés côté PC).

**Divers.** `.hero-actions,.actions` : `.actions` n'est plus utilisée par aucun écran (hub épuré en PR #154) — vérifier puis supprimer. `.archive-list` utilisée ✓. Pas de commentaires superflus, pas de code mort JS évident ailleurs.

---

## 7. Performance & poids

| Ressource | Poids | Note |
|---|---|---|
| `mobile.css` | 10,6 Ko | minifié OK |
| `mobile.js` + views + engines | ~103 Ko bruts | 13 scripts différés ; acceptable, cache SW |
| `intro.webp` | **515 Ko** | **#12 — à optimiser** |
| Badges niveau `.webp?v=27` | non mesuré | `lazy` ✓ |
| `/api/ah-skin-preview` | réseau PC | `lazy` ✓, masquées si erreur ✓ |

---

## 8. Recommandations prioritaires

**Quick wins (≈ 30 min, sans changement de comportement) — P0 :**
1. Titres : `font-weight:800` sur `.hero h1,.page-title,.section-title h2,.panel h2` (ou pile mobile dédiée).
2. Contraindre `.bottom-nav,.event-subnav` à `width:min(100%,740px)` centrées.
3. `--muted:#5c6863` (AA sur tous les fonds mesurés).

**Ensuite — P1 :**
4. `html{-webkit-text-size-adjust:100%}` · 5. `.global-driver-name{min-width:0}` + espacement badge · 6. Focus/`aria-live` du `main` · 7. Media query hauteur < 480 px (barres compactées) · 8. Décision safe-area haut (`default` documenté, ou `black-translucent` + padding).

**Finition — P2 :**
9. jeu SVG 9 icônes · 10. ménage CSS (`.embedded-*`, doublon `.bottom-nav`, `--nav-h` custom props, `-webkit-tap-highlight-color`, `overscroll-behavior`) · 11. `intro.webp` recompressé · 12. icône `maskable` · 13. `:focus-visible` uniformisé · 14. extraction helper skin partagé · 15. suppression `.actions` si confirmée inutilisée.

**Vérification après corrections :** bump `mobile.css`/`mobile.js` + `gdsp-mobile-shell-vNN` + `tests/mobile-pwa.test.js` ; `npm test` (562 attendus) ; contrôle réel sur iPhone (standalone, encoche) et Android petit écran 360 px.

---

## 9. Limites de cet audit

- Aucun appareil physique ni émulateur n'a été utilisé : tailles, retours tactiles, rendu emoji/polices et comportement clavier restent à confirmer sur téléphone.
- Contrastes calculés (formule WCAG 2.1), pas mesurés au photomètre.
- Le comportement des aperçus de livrée dépend du serveur AssettoHosting (disponibilité au moment du test).

---

## 10. Corrections appliquées (PR de suivi, 2026-11-24)

- P0-1 : titres en `font-weight:800` (repli Android/iOS désormais gras ; Impact desktop inchangé).
- P0-2 : `.bottom-nav` et `.event-subnav` centrées (`left:50%;transform:translateX(-50%);width:min(100%,740px)`) — plus d'étirement ≥ 700 px.
- P0-3 : `--muted` → `#5c6863` (AA ≥ 4.5 sur panneau, corps, erreur, pill).
- P1-4 : `html{-webkit-text-size-adjust:100%}` ; P1-5 : `.global-driver-name{min-width:0}` + `overflow-wrap` ; P1-6 : `aria-live` retiré du `<main>`, focus placé sur le contenu et retour en haut de page au changement de vue (hors actualisation live).
- P2-15 (partiel) : `-webkit-tap-highlight-color:transparent` ; P2-10 (partiel) : CSS mort supprimé (`.embedded-page`, `.embedded-note`, `.actions`, doublon `grid-template-columns`).
- Bumps : mobile.css v8, mobile.js v9, SW `gdsp-mobile-shell-v13` ; 562/562 tests verts.

**Reste ouvert** : safe-area haut / `status-bar-style` (décision requise), paysage compacté (< 480 px), jeu d'icônes SVG, `intro.webp` allégé, icône `maskable`, extraction du helper skin, nombres magiques en variables CSS, `overscroll-behavior`, `:focus-visible` uniformisé (#14).

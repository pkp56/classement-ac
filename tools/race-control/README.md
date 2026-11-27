# Race Control : configurateur et script CSP

Source : `GDSP_LocalTestPack` du Drive (script Lua portant la version interne
`GDSP-RS 1.1.1`, configurateur et encodeur du même dossier). Les fichiers de
production sont `race-control.html`, `race-control/{encoder,configurator}.js`,
`race-control/gdsp-logo.png` et `csp/rolling_start.lua`. Le configurateur
fonctionne dans le navigateur sans mini-serveur ni API de génération ; aucune
option ne modifie directement un serveur AC ou les résultats du site.

L'URL par défaut `https://gdsp.duckdns.org/csp/rolling_start.lua` est publique :
le script ne doit contenir aucun secret. Le fichier manuellement placé à la
racine `gdsp_rolling_start.lua`, s'il existe, n'est ni remplacé ni utilisé par
cette nouvelle URL. Le Lua est servi en texte avec revalidation du cache.

Générer le bloc, vérifier les options, l'ajouter aux Extra options du serveur
CM souhaité sans effacer les autres sections (télémétrie `[SCRIPT_2]`), puis
redémarrer ce serveur. Un chargement automatique par CSP exige une URL
accessible aux pilotes, leur version CSP compatible et une configuration
serveur correctement appliquée. L'application CM complémentaire n'est pas
incluse ici ; ses fonctionnalités avancées ne sont pas garanties sans elle.

Les détections et pénalités de jeu peuvent être activées selon les options :
tester d'abord hors course officielle et ne pas assimiler les événements ou
pénalités du script à une décision de commission. Le script n'a pas encore été
validé en situation réelle multi-pilotes avec le site et le serveur CM 2.

Dans l'administration GDSP, l'onglet « Race Control » ouvre ce configurateur ;
la page reste accessible par URL directe et ne contient ni mot de passe ni
commandes de lancement. Le MOTD `$CSP0:` est généré dans le navigateur par
compression DEFLATE (API `CompressionStream`), avec limite de 2039 octets et
copie désactivée au-delà. Le MOTD est une alternative au bloc CSP : vérifier
au préalable la configuration et le message existants avant remplacement.

## Pace car IA (optionnel, depuis GDSP-RS 1.2.0)

Le système de safety car humaine (mots-clés `safetyCarKey`, limiteur `paceKmh`,
`safetyCarKey`/`scFallback`) est **inchangé**. En plus, le script peut piloter
lui-même une voiture de pace car pendant le tour de formation.

- Le script ne crée jamais de voiture : le serveur doit inscrire la voiture de
  pace car dans sa liste d'entrées (voiture IA du serveur). `aiPaceMode = 'grid'`
  privilégie les voitures IA de la grille, `'any'` accepte n'importe quelle
  voiture dont le nom de pilote ou l'ID contient `aiPaceName`.
- Le pilotage repose sur l'autopilote du jeu : `physics.setCarAutopilot`,
  `physics.setAITopSpeed`, `physics.setAIThrottleLimit`, `physics.setAIAggression`,
  `physics.setAIPitStopRequest`. Tous les appels sont protégés par `pcall` : une
  version de CSP qui ne les expose pas ne casse pas le départ lancé, le pace car
  IA reste simplement inactif.
- Le pace car IA est exclu du classement de formation : il ne prend pas la place
  du leader, ne déclenche pas le vert et ne reçoit pas de pénalité de formation.
- Après le drapeau vert, il rentre aux stands (`aiPaceInLap = 1`, recommandé) ou
  reste en piste mais laisse filer le peloton (`0`).
- Réglages : `aiPaceMode` (`off` par défaut), `aiPaceName` (`Pace Car`),
  `aiPaceModel` (`dodge_monaco_police`), `aiPaceFollow` (1), `aiPaceKmh`
  (90, borné 30–180), `aiPaceLeadM` (30, borné 10–200), `aiPaceInLap` (1).
  Commande de secours en course : `!rs aipace off`, `!rs aipace on [nom]`,
  `!rs aipace 90`.

### Vitesse : suivre les pilotes (par défaut)

`aiPaceFollow = 1` : le pace car prend la vitesse **réelle du leader** du
peloton (celle que roulent les pilotes pendant la formation) et ne la dépasse
jamais de plus de 6 km/h. `aiPaceKmh` sert alors uniquement de **plafond de
sécurité** réglé depuis Race Control. Si le peloton est encore arrêté, le pace
car garde une allure de formation douce (40 km/h maximum). `aiPaceFollow = 0`
revient à une vitesse fixe.

### Modèle de voiture et livraison depuis Race Control

La section « 3 bis. Pace Car IA » du configurateur propose :

- un champ **Modèle de voiture** (ID du dossier `content/cars`), accessible
  aussi en liste avec le bouton **Charger les voitures du serveur** : ce bouton
  lit l'inventaire déjà exposé par l'API administrateur
  (`/api/server-manager/inventory`, protégée par la connexion admin) et remplit
  la liste des modèles et des skins disponibles ;
- un champ **Skin** facultatif (les options CSP du type `skin/option` sont
  ramenées à l'identifiant de skin seul) ;
- un numéro de place `[CAR_xx]` et un nom de pilote affiché ;
- un bloc **« Copier le bloc à coller »** qui produit le `[CAR_xx]` complet pour
  `entry_list.ini`, les options CSP correspondantes, et la marche à suivre.

**Aucun fichier serveur n'est modifié automatiquement** : le bloc est copié
puis collé par l'administrateur, ce qui évite d'altérer une grille de course ou
une configuration existante sans relecture. `aiPaceModel` sert aussi de critère
de sélection dans le script : il évite de piloter par erreur une voiture de
pilote portant le même nom que la pace car.
- Limite connue : sur DSP, seule la première voiture de l'index CSP est pilotée
  par le client ; les appels `setCarAutopilot` sans index visent la voiture
  locale. Le réglage reste donc à valider en conditions réelles multi-pilotes,
  comme le reste du script.

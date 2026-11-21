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

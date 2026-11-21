# Deux serveurs AC locaux : direct et télémétrie

La sélection sépare deux collecteurs UDP locaux. Elle ne crée pas les serveurs
AC et n'altère pas la configuration du premier. Avant tout, faire une copie des
configurations CM et vérifier les ports libres ; ne pas diffuser les mots de
passe, jetons ou le contenu du `.env`.

## 1. Serveur AC et ports de jeu

Donner des **noms de serveur différents** aux deux instances. Attribuer au
second ses propres ports de jeu TCP, UDP et HTTP ; par exemple 9601 TCP/UDP et
8082 HTTP si libres. Vérifier également la façon dont Content Manager lance
les deux instances : chacune doit avoir sa propre configuration effective et
ses fichiers de travail, sans écraser ceux de l'autre. Un nouveau préréglage ne
prouve pas à lui seul que deux processus sont isolés.

Pour l'accès Internet, ouvrir uniquement les ports de jeu requis sur le
pare-feu Windows et les rediriger vers le PC sur la box, puis tester depuis
l'extérieur. Si l'opérateur utilise du CGNAT, le transfert peut être impossible
sans adresse IPv4 publique. Les ports du plugin ci-dessous ne sont pas des
ports de jeu : ne pas les rediriger sur Internet.

## 2. Live UDP local

Le collecteur existant garde son couple (`AC_LISTEN_PORT` / `AC_PLUGIN_PORT`,
par défaut 12000 / 12001). Choisir un autre couple libre, par exemple 12002 /
12003. Ajouter au `.env` du **site**, sans remplacer les autres variables :

```ini
AC_SECOND_LISTEN_PORT=12002
AC_SECOND_PLUGIN_PORT=12003
AC_SECOND_LABEL=Serveur CM 2
```

Redémarrer une seule fois GDSP Node après sauvegarde. Dans la configuration
**effective du deuxième acServer**, section `[SERVER]` :

```ini
UDP_PLUGIN_ADDRESS=127.0.0.1:12002
UDP_PLUGIN_LOCAL_PORT=12003
```

Ces valeurs correspondent respectivement au port d'écoute GDSP et au port
plugin du deuxième acServer. Le collecteur GDSP écoute sur les interfaces du PC :
protéger ces ports via le pare-feu, ne pas les exposer sur Internet. Vérifier que
Content Manager ne réécrit pas ces lignes au lancement, et que les deux serveurs
ont des fichiers séparés. Le script `set-plugin-ports.js` utilise les ports du
premier serveur par défaut : ne pas l'appliquer au second sans adaptation.

Le menu Live propose « Serveur CM 1 » et « Serveur CM 2 ». Une source en panne
reste vide : elle ne bascule pas silencieusement sur l'autre. Les commandes
admin sont ciblées sur la source explicitement sélectionnée. Le mode push reste
un instantané global unique ; ne pas lancer deux agents push vers ce même canal.

Si un autre outil utilise déjà le plugin UDP d'un serveur (par ex. S-Tracker),
le simple ajout d'un second couple ne le multiplexe pas : un relais adapté est
nécessaire. Vérifier les réglages existants avant de les remplacer.

## 3. Télémétrie CSP

Configurer le script CSP sur le second serveur conformément à
`tools/telemetry/README.md`, y compris la substitution de l'identité pilote si
nécessaire. Vérifier que CSP est activé chez le pilote, qu'un ping et un tour
sont acceptés, et que le nom du serveur remonte correctement. Le filtre de la
page Télémétrie utilise ce nom réellement envoyé par CSP : des noms identiques
ne peuvent pas être distingués, et les séances sans nom restent uniquement
visibles avec « Tous ». Il ne modifie aucune donnée historique.

Le filtre concerne les tours, le résumé, les rapports, la liste des séances et
les clients CSP affichés. Les profils et mesures pit-lane restent partagés par
circuit/configuration, comme avant, y compris entre serveurs. À la première
mise en service, tester les deux serveurs avec des pilotes et circuits distincts
et confirmer les filtres et journaux ; aucune validation de production ne peut
être déduite des tests simulés.

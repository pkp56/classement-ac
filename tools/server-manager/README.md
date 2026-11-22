# Gestion des deux serveurs : fondations non activées

Ce dossier est un travail en cours : la consultation et la validation expérimentales en
lecture seule sont reliées à l’API et à l’administration, sur activation explicite via
`GDSP_AC_SERVER_ROOT`. La commande de sauvegarde est expérimentale et désactivée par défaut. Les commandes de processus sont branchées mais désactivées par défaut. Ne pas activer l’écriture sur des serveurs réels avant les essais Windows et la préparation du dossier privé.

`presets.js` lit uniquement les dossiers `SERVER_00` et `SERVER_01` depuis une
racine prédéfinie côté système, refuse les liens symboliques et les fichiers
binaires ou trop volumineux, et masque secrets, ports et GUID. `ini.js` et
`entry-list.js` préparent des modifications ciblées en mémoire en préservant
les autres lignes. `draft.js` contrôle une empreinte de version avant aperçu.

Reste à concevoir et vérifier avant activation des modifications et commandes :

- Lister circuits, layouts, voitures et skins réellement installés, vérifier
  les places et l'entrée ; la suppression est limitée aux dernières places sans données protégées.
- Couvrir toutes les options CM/CSP voulues et préserver la gestion de contenu et les configurations
  internes de CM ; les listes blanches actuelles ne constituent pas une
  configuration complète et leurs bornes doivent être validées.
- Proposer un aperçu exact et confirmer explicitement ; `backups.js` prépare
  une sauvegarde hors dossier public mais les ACL Windows restent à configurer
  et à vérifier. Synchroniser les deux fichiers, protéger contre les modifications
  concurrentes de Content Manager, tester l'écriture et la restauration sous
  Windows. Les fonctions présentes ne constituent pas une transaction disque.
- Identifier sans ambiguïté les processus déjà lancés par CM et surveiller
  leur cycle de vie ; ne jamais supposer qu'un PID ou un port seul suffit.
  Gérer la reprise après redémarrage de GDSP et empêcher le démarrage en double.
- Protéger chaque action par l'authentification et le CSRF, limiter les chemins
  aux deux préréglages autorisés, ne jamais exposer de shell ou d'arguments libres.
- Tester réellement avec les deux serveurs CM sur Windows, d'abord hors course,
  sans toucher aux classements ni aux pénalités de commission.

Attention : CM peut encoder CSP et ses options dans `SERVER.TRACK` sous la forme
`csp/<version>/../.../../<circuit>` et utiliser `__CM_SERVER.NAME` à la place
`SERVER.NAME` (vérifié dans `ServerPresetObject.cs` du projet actools). Le
prototype conserve les préfixes CSP reconnus lors du changement de circuit et refuse les formats ambigus ; il refuse encore de changer le nom géré par CM.
Il ne doit pas remplacer les fichiers de préréglage actuellement en service.

La consultation de l'état utilise une commande PowerShell fixe sans arguments
utilisateur. Elle ne renvoie aucun PID ni chemin : elle ne rapporte un état que
si les deux chemins `-c` et `-e`, l'exécutable et la date de création sont
identifiables de façon univoque. Une situation ambiguë renvoie « indisponible ».
La commande n'est pas encore validée sur le PC réel et n'autorise aucune action.

### Brouillon dans Administration

L'onglet « Serveurs CM » charge séparément les deux préréglages et propose un brouillon local avec un aperçu des champs modifiés. L'enregistrement expérimental est désactivé côté serveur par défaut : fermer l'onglet, changer de serveur ou recharger abandonne le brouillon non enregistré. Les commandes serveur sont désactivées par défaut et aucune modification de port n’est proposée. Les champs absents ne sont pas encore pris en charge. Les dernières places non réservées et les dernières météos peuvent être ajoutées ou supprimées sous conditions. Un circuit encodant CSP peut être modifié lorsque son format est reconnu, en conservant son préfixe ; le nom peut être contrôlé par Content Manager. Vérifier les valeurs et leurs unités dans CM ; la compatibilité des valeurs proposées avec les fichiers réels n'est pas encore validée.

L'inventaire facultatif est lu depuis `content` à côté du dossier `server` désigné par `GDSP_AC_SERVER_ROOT`. Si les contenus sont ailleurs, configurer `GDSP_AC_CONTENT_ROOT` avec le chemin absolu du dossier `content`. L'inventaire est limité aux identifiants de répertoires sans lien symbolique et aux layouts identifiés par leurs fichiers `models_*.ini`. Il est protégé par l'authentification administrateur et ne télécharge rien. Sans inventaire disponible, la saisie manuelle reste possible ; elle n'est pas une validation de présence des contenus.

### Étape 2 : état d'avancement

Le bouton de vérification soumet le brouillon à l'API administrateur sans écriture. Le serveur relit les deux fichiers et l'inventaire, vérifie leurs empreintes, filtre les champs autorisés et contrôle les circuits, voitures et places avant de renvoyer un aperçu expurgé. Les modifications non prises en charge sont refusées. La sauvegarde synchronise et relit les deux copies avant remplacement. Le code d’écriture est branché à une route administrateur, mais reste désactivé par défaut.

L'enregistrement n'est **pas activé par défaut** : une sauvegarde doit être placée dans un dossier privé dont les ACL Windows ont été vérifiées ; l'installation des deux fichiers, les conflits avec CM, la restauration après interruption et les permissions doivent encore être garantis et testés sur Windows. Un verrou interne à GDSP ou une empreinte seule ne protège pas contre une écriture concurrente de Content Manager. Ne pas utiliser les primitives pour modifier les préréglages réels tant que ces conditions ne sont pas résolues.

#### Précautions pour les essais Windows (non encore validés)

L'activation technique exige `GDSP_CM_WRITES_ENABLED=1`, `GDSP_AC_SERVER_ROOT` et `GDSP_AC_BACKUP_ROOT` (chemin absolu hors site et hors serveur). Le dossier de sauvegarde doit exister et avoir des ACL NTFS restrictives définies et contrôlées par l'administrateur : il contient les mots de passe et GUID. Le mode Unix ne configure pas ces ACL. L'application refuse une opération si CM ou l'instance visée semble en marche ; fermer CM et garantir qu'aucun autre programme n'écrit les INI pendant l'opération restent indispensables. Un contrôle de version n'est pas un verrou partagé avec les autres programmes. Le remplacement par fichier temporaire peut également modifier les ACL des fichiers de destination : tester et vérifier les permissions avant toute utilisation réelle.

La sauvegarde contient les deux fichiers d'origine. Si l'application est interrompue pendant les remplacements, ou si leur vérification échoue, `local1.pending` ou `local2.pending` bloque toute nouvelle écriture pour ce serveur. Son fichier `backup.txt` indique la copie à restaurer manuellement, serveur arrêté et CM fermé. Vérifier les deux fichiers et leurs permissions, puis seulement retirer le marqueur. Ne jamais supprimer ce marqueur sans comprendre l'état des fichiers. Si les options CSP ont été modifiées, la copie `cm_welcome.txt` de la sauvegarde doit également être restaurée dans les deux chemins du message (préréglage et `cfg/welcome_SERVER_00.txt` ou `cfg/welcome_SERVER_01.txt`). Il n'existe pas de transaction atomique simultanée des fichiers ni de restauration automatique.

L'adaptateur `windows-adapter.js` est un prototype branché mais **désactivé par défaut** : il lance `acServer.exe` sans shell et demande l'arrêt après vérification de l'identité via un handle Windows. Ces appels n'ont pas encore été testés sur le PC réel. Un démarrage direct avec seulement `-c` et `-e` peut omettre des options, plugins ou services fournis par CM ; il ne doit pas être activé tant que la commande de démarrage réelle et la reprise après redémarrage GDSP ne sont pas validées. Les boutons restent inopérants sans `GDSP_CM_CONTROL_ENABLED=1`, et ne doivent pas être activés avant ces vérifications.

Le marqueur `local1.start-pending` ou `local2.start-pending` empêche un second lancement, y compris après redémarrage de GDSP, tant que l'instance n'a pas été identifiée. Si un démarrage échoue ou ne peut pas être vérifié, fermer CM, vérifier manuellement les processus, puis seulement retirer le marqueur correspondant. Une restauration en attente interdit le démarrage ; écriture et commandes sont sérialisées dans GDSP. Ces verrous ne contrôlent pas les actions extérieures à GDSP.

Les séances existantes peuvent être activées et désactivées par renommage de section CM ; les paramètres météo numériques existants sont modifiables. Le type WeatherFX reste géré dans CM. Le basculement tours/temps maintient les champs internes CM. L'édition CSP est proposée uniquement si les deux messages d'accueil locaux sont présents, identiques et aux chemins CM reconnus ; le message d'accueil est conservé, les options sont remplacées après confirmation explicite.

La source Content Manager confirme que les scripts et autres Extra options peuvent être encodés dans le fichier du message d'accueil avec 32 tabulations, `$CSP0:` puis une configuration comprimée en zlib et encodée en base64 sans padding. Il ne faut pas confondre ce fichier avec les deux INI ni écraser le MOTD ou les autres scripts. La source confirme également que le plugin et le wrapper CM peuvent être nécessaires : le lancement direct est refusé si le plugin CM est actif ou si un fichier de configuration wrapper CM est présent. Cette détection prudente ne garantit pas la compatibilité de tous les autres environnements.

### Essai exceptionnel du serveur 1 sans plugin interne CM

Si le plugin interne CM est déclaré actif, le lancement reste normalement bloqué. Un essai ponctuel pour le serveur 1 est proposé seulement après une seconde confirmation explicite : le plugin interne CM ne sera pas lancé et ses fonctions (notamment son interface et son suivi) ne sont pas garanties. Aucun port ni préréglage n'est modifié. Le serveur 2 ne bénéficie pas de cette exception.

L'essai est refusé si les conditions réelles CM sont activées ou ambiguës, si des plugins externes ou des paramètres plugin non reconnus sont présents, si un plugin d'authentification est configuré, si un wrapper CM est détecté, ou si la liaison n'est pas exactement celle du collecteur GDSP local en écoute. La vérification de Content Manager fermé, de l'identité des processus et de l'absence de lancement en attente continue à s'appliquer. La création du processus ne démontre pas que le serveur est joignable ou que le live, Race Control et la télémétrie fonctionnent ; ils doivent être testés séparément. Pour retrouver les services CM, arrêter l'instance et relancer le préréglage depuis Content Manager.

Une seconde racine `content` peut être configurée avec `GDSP_AC_EXTRA_CONTENT_ROOT` (chemin absolu) en plus de `GDSP_AC_CONTENT_ROOT` ou de la racine par défaut. L'inventaire, l'aperçu et l'enregistrement utilisent les mêmes deux racines. Une racine configurée mais inaccessible rend l'inventaire indisponible, au lieu de cacher silencieusement des éléments. Les identifiants identiques sont regroupés, ainsi que leurs variantes et skins : cette présence dans l'inventaire ne garantit pas que le serveur AC ou Content Manager peut effectivement accéder à ce contenu ni quelle copie il utilisera. Vérifier en jeu les contenus sur le second disque ; aucun fichier n'est déplacé ou lié automatiquement.

### Préparer une manche de Cup (brouillon)

Après avoir ouvert une Cup sur le site, consulter le serveur CM choisi dans l'administration. Le panneau de préparation utilise les identifiants du calendrier et des fiches voitures de l'événement chargé, puis demande explicitement le nombre de places, la durée des qualifications et celle de la première course. Il remplit seulement l'éditeur local : aucun enregistrement ni démarrage. L'inventaire local doit confirmer la voiture, le circuit et sa variante. Une place réservée ou avec options CSP utilisant une autre voiture bloque le préremplissage. Les places existantes ne sont pas supprimées, et les nouvelles places n'ont pas de skin prédéfini : vérifier les skins et le nombre réel de box. L'aperçu et l'enregistrement habituels sont nécessaires, avec serveur arrêté, CM fermé et sauvegarde. Ce brouillon ne configure pas un setup fixe, une seconde course, la grille inversée ni la transition entre courses ; ces points doivent être validés séparément avant toute utilisation sportive. Il ne modifie pas l'événement ou les résultats.

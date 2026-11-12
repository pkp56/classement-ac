# Serveur Assetto Corsa lancé par **Content Manager** → live timing sur le site

Réponse courte : **oui.** Ton serveur tourne sur ton PC (CM le lance), donc
l'agent installé sur ce même PC lit les données et les pousse au site. Rien à
ouvrir sur la box, rien à héberger.

Trois étapes, une seule fois à faire pour les deux premières.

---

## 1. Une variable sur Render (2 minutes)

[dashboard.render.com](https://dashboard.render.com) → service **classement-ac-1**
→ onglet **Environment** → **Add Environment Variable** :

| Nom | Valeur |
| --- | --- |
| `LIVE_PUSH_TOKEN` | un mot de passe long que tu inventes, ex. `gdsp-live-2026-x7k2m9` |

**Save Changes** → Render redéploie (1 à 3 min). C'est ce jeton qui autorise ton
PC à publier sur le site.

---

## 2. Node.js sur le PC + le dossier du site (5 minutes)

1. [nodejs.org](https://nodejs.org) → version **LTS** → `.msi` → options par
   défaut. Vérifie avec `node -v` dans une invite de commandes.
2. GitHub [github.com/pkp56/classement-ac](https://github.com/pkp56/classement-ac)
   → **Code** → **Download ZIP** → extraire dans `Documents\classement-ac`.
   (Pas de `npm install` : l'agent n'utilise que des modules intégrés.)

---

## 3. Les deux lignes de plugin dans `server_cfg.ini` (le point qui bloque le plus)

Un serveur lancé par Content Manager **écrit lui-même** `server/cfg/server_cfg.ini`
à chaque démarrage. Il n'y a pas de case « plugin UDP » dans CM, donc il faut
ajouter à la main, dans la section `[SERVER]` :

```ini
UDP_PLUGIN_ADDRESS    = 127.0.0.1:12000
UDP_PLUGIN_LOCAL_PORT = 12001
```

* `UDP_PLUGIN_ADDRESS` = là où le serveur **envoie** les événements (l'agent écoute).
* `UDP_PLUGIN_LOCAL_PORT` = là où le serveur **écoute** les demandes (l'agent écrit).
* Les deux doivent être **différents**, et restent en **local** (rien à ouvrir).

### Le script qui le fait pour toi

```bat
:: 1. arrête le serveur dans Content Manager
:: 2. puis, dans le dossier du site :
node tools\live-timing\set-plugin-ports.js --find
:: ou en donnant le chemin exact :
node tools\live-timing\set-plugin-ports.js "C:\Users\toi\Documents\Assetto Corsa\server\cfg\server_cfg.ini"
```

Le script affiche ce qu'il change, garde une copie `server_cfg.ini.bak`, ne
touche à aucune autre ligne, et refait les fins de ligne CRLF de Windows.
`--check` en fin de commande montre les changements sans écrire.

**Puis relance le serveur depuis CM.** Si CM réécrit le fichier et que le live
redevient vide, relance simplement le script : il est rejouable à volonté.

> Plusieurs serveurs dans CM (un `server_cfg.ini` par preset) ? Lance le script
> sur celui du serveur utilisé. `--find` liste aussi les autres fichiers trouvés.

---

## 4. Lancer l'agent (à chaque session)

Le plus simple : un double-clic.

1. Ouvre `tools\live-timing\AGENT-gdsp.bat` avec le **Bloc-notes**.
2. Remplace `set PUSH_TOKEN=change-moi` par ton jeton de l'étape 1.
3. Enregistre, puis **double-clique** le `.bat`.

Ligne de commande équivalente, si tu préfères :

```bat
cd /d %USERPROFILE%\Documents\classement-ac
set SITE_URL=https://classement-ac-1.onrender.com
set PUSH_TOKEN=gdsp-live-2026-x7k2m9
node tools\live-timing\agent.js
```

Ce que tu dois voir :

```
GDSP live timing — agent local
  serveur AC   : 127.0.0.1:12001 (écoute UDP 12000)
  site         : https://classement-ac-1.onrender.com/api/live/push
  fréquence    : 1 envoi / 1000 ms
· Session practice : Practice
✓ Premier envoi accepté par https://classement-ac-1.onrender.com/api/live/push
```

Laisse la fenêtre ouverte pendant la session (réduite, ça suffit). Fermer la
fenêtre arrête le direct.

---

## 5. Vérifier sur le site

`https://classement-ac-1.onrender.com/live-timing` → badge **« Direct (PC distant) »**.
En mode UDP (donc CM sur le même PC), la page a **tout** : classement, écarts,
tours, meilleurs tours, **vitesses**, positions en piste et fil des événements —
contrairement au mode HTTP distant qui n'a que les temps.

| Ce que tu vois | Cause | Correctif |
| --- | --- | --- |
| `⚠ Aucun paquet reçu d'acServer` | les deux lignes manquent ou CM les a effacées | refais l'étape 3, relance le serveur **puis** l'agent |
| `✓ Premier envoi accepté` mais page vide | personne en piste / session pas lancée | normal : l'agent n'envoie rien à vide |
| `401 jeton invalide` | `PUSH_TOKEN` ≠ `LIVE_PUSH_TOKEN` | recopie la valeur exacte de Render |
| `503 mode push non activé` | Render n'a pas fini de redéployer | attends la fin du déploiement |
| `✗ SITE_URL manquant` | les `set` n'ont pas été faits dans la même fenêtre | utilise le `.bat` |

---

## Et si deux outils veulent le même port ?

Le plugin UDP d'acServer n'accepte qu'un destinataire. Si tu fais tourner
**stracker** (ou KissMyRank, ou le live timing d'un autre outil) **en même temps**,
il faut chaîner les deux avec **ACSRelay**, ou donner à l'agent un autre couple
de ports. Dans le cas le plus courant — un seul outil, le nôtre — rien à faire.

---

## Ce que l'agent fait exactement

* il écoute l'UDP d'acServer (protocole ACSP v4) sur `127.0.0.1:12000` ;
* il renvoie les demandes de positions sur `127.0.0.1:12001` ;
* une fois par seconde, il envoie un instantané JSON au site (quelques Ko) ;
* il n'envoie **rien** s'il n'y a ni voiture ni session : le site ne peut pas
  afficher un faux direct ;
* aucune commande (chat, kick, changement de session) ne passe par là : le site
  ne peut pas piloter ton serveur, c'est volontaire.

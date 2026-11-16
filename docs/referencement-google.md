# Référencer GDSP sur Google — mode d'emploi

Site : **http://gdsp.duckdns.org** (serveur `app.js` de ce dépôt, exposé par DuckDNS).
Objectif : que Google connaisse, explore et indexe le site. Aucun outil ne garantit
une position dans les résultats — on prépare le terrain, proprement et dans l'ordre.

---

## 0. Ce que le code fait déjà pour toi

Rien à installer, ces points sont dans le dépôt :

| Élément | Où | Détail |
|---|---|---|
| `robots.txt` | `app.js` | Autorise tout sauf `/api/` et `/admin`, et pointe vers le sitemap avec **ton** domaine. |
| `sitemap.xml` | `app.js` | Accueil + une URL par événement (`/evenements/<slug>`), `lastmod` compris. Reste lisible même si le backend dort. |
| HTML rendu côté serveur | `app.js` + `seo.js` | `/` et `/evenements/<slug>` sont lisibles **sans JavaScript**, avec titre, description, H1 et liens réels. |
| URL canoniques | `seo.js` | Toujours absolues, sur le domaine réellement visité (ou `PUBLIC_SITE_URL`). |
| Open Graph / Twitter Card | `seo.js` | Aperçu correct quand un lien est partagé sur Discord, X, WhatsApp… |
| Données structurées | `seo.js` | JSON-LD `WebSite` (accueil) et `BreadcrumbList` + `SportsEvent` (événements). |
| Vue Circuit en `noindex` | `app.js` | `/evenements/<slug>/circuit` reste servie, mais sa canonique pointe vers la fiche événement : pas de contenu dupliqué. |
| Pages d'erreur en `noindex` | `app.js` | Un 404/503 n'est jamais indexé. |
| Balise de vérification Google | `index.html` | `google-site-verification` déjà présente (propriété « préfixe d'URL »). |

L'adresse publique utilisée pour les canoniques et le sitemap est, dans l'ordre :
`PUBLIC_SITE_URL` → le domaine de la requête (`gdsp.duckdns.org`) → `RENDER_EXTERNAL_URL`
→ l'adresse Render par défaut. **Rien à configurer** si tu sers le site via DuckDNS.

---

## 1. Vérifier que le domaine répond vraiment (à faire en premier)

Dernier contrôle : le DNS de `gdsp.duckdns.org` pointe vers `90.19.53.254`, mais la
connexion HTTP se ferme sans réponse (`Empty reply from server`) et le port 443 ne
répond pas non plus depuis l'extérieur. Google ne peut rien indexer dans cet état.

Checklist côté box / serveur :

1. **Redirection de port** sur la box : `80 → <IP locale du PC>:<PORT>` (et `443` seulement
   si tu ajoutes HTTPS, voir §2). Le serveur écoute déjà sur `0.0.0.0`.
2. **L'IP locale du PC est fixe** (bail DHCP réservé), sinon la redirection casse au
   prochain redémarrage.
3. **Adresse DuckDNS à jour** : l'IP publique chez toi doit être `90.19.53.254`. Si le
   FAI change l'IP, relancer la mise à jour DuckDNS (client, cron, ou
   `https://www.duckdns.org/update?domains=gdsp&token=<TON_TOKEN>`).
4. **Pas de NAT loopback** : depuis chez toi, `http://gdsp.duckdns.org` peut échouer
   alors que le site marche depuis l'extérieur. Teste sur le réseau mobile, pas en Wi-Fi.
5. **Pare-feu** Windows/Linux : autoriser le port applicatif.
6. **FAI** : certains bloquent le port 80 entrant (offres « grand public »). Vérifie avec
   `curl -v http://gdsp.duckdns.org/` depuis un autre réseau.

Contrôle rapide une fois la redirection en place :

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://gdsp.duckdns.org/robots.txt   # attend 200
curl -sS http://gdsp.duckdns.org/robots.txt                                    # doit citer ton sitemap
curl -sS http://gdsp.duckdns.org/sitemap.xml | head -20
```

Un script fait ces trois appels et te dit quoi corriger :

```bash
node tools/seo-check.js http://gdsp.duckdns.org
```

---

## 2. HTTPS : fortement recommandé

Google indexe l'HTTP, mais Chrome affiche « Non sécurisé » — mauvais pour la confiance
et pour les liens partagés. Deux options simples :

- **Caddy** devant l'application (certificat automatique, le plus simple) :

  ```caddy
  gdsp.duckdns.org {
    reverse_proxy 127.0.0.1:10000
  }
  ```

- **Cloudflare** (gratuit) : le DNS reste chez DuckDNS, tu passes le domaine en proxy
  Cloudflare et tu actives « Full » ; le port 80/443 entrant n'est alors plus nécessaire.

Quand HTTPS est en place, déclare la version retenue pour éviter le doublon
`http://` / `https://` dans l'index :

```bash
PUBLIC_SITE_URL=https://gdsp.duckdns.org
```

Puis mets à jour la propriété dans Search Console (l'URL de propriété est
`https://gdsp.duckdns.org`) et re-soumets le sitemap.

> Si le site reste en HTTP, garde `http://gdsp.duckdns.org` : Search Console traite
> `http://` et `https://` comme deux propriétés différentes.

---

## 3. Vérifier le site dans Google Search Console

1. Va sur <https://search.google.com/search-console>.
2. **Ajouter une propriété** → type **Préfixe d'URL** → `http://gdsp.duckdns.org`
   (ou `https://gdsp.duckdns.org` si tu as activé HTTPS). C'est le type adapté à un
   sous-domaine DuckDNS : la balise `<meta google-site-verification>` déjà présente
   dans `index.html` suffit.
3. Si tu préfères une **propriété Domaine** (`duckdns.org` ne t'appartient pas, donc
   choisis bien `gdsp.duckdns.org`), il faut un enregistrement **TXT** — DuckDNS ne gère
   que des TXT liés à son API :
   `https://www.duckdns.org/update?domains=gdsp&token=<TON_TOKEN>&txt=<CONTENU_TXT>`
   (domaines **sans** `:port`), puis « Vérifier ». La vérification de domaine se
   re-contrôle environ tous les 30 jours : ne supprime pas le TXT.
4. Ouvre **Sitemaps** → ajoute `sitemap.xml` → **Envoyer**.
   Le fichier référence déjà chaque événement et sera relu automatiquement.
5. **Inspection de l'URL** : colle `http://gdsp.duckdns.org/` → **Tester l'URL en direct**
   → tu dois voir « URL accessible », la canonique, et la page rendue. Demande
   **Indexation** pour l'accueil et une fiche événement.

Délai réaliste : quelques jours pour l'exploration, plusieurs semaines avant des
impressions visibles. Un site neuf et peu lié ailleurs reste peu visible.

---

## 4. Aider Google à comprendre le contenu

Le contenu public indexable est aujourd'hui : **l'accueil** (présentation + liste
réelle des événements) et **chaque fiche `/evenements/<slug>`** (présentation,
voiture, horaires, calendrier des manches). Les classements, profils et résultats
détaillés sont encore rendus uniquement côté navigateur : Google ne les voit pas.
Pour aller plus loin, dans l'ordre de rentabilité :

1. **Du texte, pas seulement des tableaux** : chaque événement a déjà `briefing`,
   `car`, `schedule`, `formatText` dans Administration → Événements. Ce sont ces
   champs qui alimentent la page publique : écris-les complets (qui, quoi, quand,
   quelle voiture, quel circuit, comment s'inscrire).
2. **Des liens sortants/entrants** : mets l'adresse du site dans la description de
   ton Discord, de ta chaîne YouTube/Twitch, des forums simracing, des groupes
   Assetto Corsa. Un lien éditorial depuis un site reconnu vaut plus que dix
   annuaires.
3. **Titres uniques** : ils viennent du nom de l'événement (`<nom> | GDSP Assetto
   Corsa`, modifiable par renommage de l'événement dans l'admin).
4. **Contenu stable** : ne change pas les slugs d'événements déjà publiés (l'URL
   changerait → 404 pour Google). Un événement supprimé doit rester renvoyé en 404,
   c'est propre.

---

## 5. Vérifications régulières (5 minutes / mois)

- Search Console → **Pages** : les URL exclues « Explorer avec une balise noindex »
  doivent être uniquement `/circuit`, 404 et `/api/`.
- **Indexation** → « Pages erronées » doit rester vide.
- `node tools/seo-check.js` sur le domaine public.
- Après un changement de domaine : `PUBLIC_SITE_URL` mis à jour, sitemap re-soumis,
  nouvelle propriété vérifiée.

---

## 6. Ce qu'il ne faut pas faire

- Bloquer `/assets/` ou `/hero-gdsp.jpg` dans `robots.txt` : les robots d'aperçu
  (Discord, X) en ont besoin.
- Lancer une campagne de liens achetés ou de « soumission automatique à 1000
  annuaires » : risque de pénalité, bénéfice nul.
- Créer plusieurs URL pour le même contenu (sous-domaines, `?event=…`) : garde une
  URL canonique par page, c'est ce que fait déjà le code.
- Indexer les pages de travail : `/live-timing`, `/telemetry`, `/circuits` sont déjà
  en `noindex,nofollow`, laisse-le.

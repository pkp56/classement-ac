# Référencement — domaine GDSP et pages publiques

## Portée

Lot préparé dans le dépôt, non déployé. L'utilisateur a confirmé `PUBLIC_SITE_URL=https://gdsp.duckdns.org` dans le `.env` Windows : aucune modification de cette variable n'est nécessaire. Aucune intervention sur Google, le DNS, l'ancien hébergement ou Caddy effectuée ici. Pas de promesse de positionnement ni de délai d'indexation.

L'apparence des pages normales, les fiches pilotes, les données et les règles de classement ne changent pas.

## Tests

**299 tests réussis** avec `npm test`, dont les vérifications HTTP du domaine par défaut et du domaine configuré, des redirections GET/HEAD, des erreurs 404/503, des balises de partage et des routes conservées. Aucun contrôle direct de l’indexation Google ni du serveur Windows depuis cet environnement.

## Changements

- Le domaine public par défaut devient **https://gdsp.duckdns.org**, au lieu de l'ancienne adresse Render. Une variable PUBLIC_SITE_URL explicite reste prioritaire.
- La configuration est normalisée en origine HTTP(S), sans slash final. Chemins, identifiants, paramètres et fragments sont refusés pour ne pas produire de sitemap erroné. Une configuration invalide empêche le démarrage : corriger la variable en URL simple, jamais en lien Markdown.
- Les pages d'accueil et de présentation des événements conservent leur contenu rendu serveur, titre, description et URL canonique. Elles ajoutent des balises **Open Graph et Twitter Card**, avec le logo existant en image absolue, sans nouvelle image ni modification de la charte.
- **GET/HEAD /index.html → 301 /**, paramètres de requête conservés. La redirection reste relative, fixe et n'est pas construite depuis une entrée externe.
- Les adresses inconnues renvoient **404**, une page lisible et un lien vers l'accueil, pas une fausse page d'accueil en 200. La page 404 n'exécute pas le JavaScript applicatif, qui pourrait masquer le message.
- Les erreurs d'événement 404 et d'indisponibilité 503 sont aussi marquées noindex et restent lisibles sans démarrage de la SPA ; les 503 conservent Retry-After.
- Le lien existant **/evenements/:slug/circuit** est explicitement conservé, avec vérification de l'existence de l'événement et canonique vers sa présentation. Les événements inexistants ne sont plus dissimulés derrière un accueil 200. Aucune modification de leur fiche ni de leur rendu interactif.
- **/admin** reste accessible avec son shell existant et un en-tête noindex ; les routes live, télémétrie, API, fichiers statiques et leur protection restent conservées.

## Vérification après publication seulement

Après intégration à main, mise à jour et redémarrage habituel de GDSP Node, ouvrir :

1. **https://gdsp.duckdns.org/** : accueil normal.
2. **https://gdsp.duckdns.org/index.html** : doit aboutir à `/` (301 visible dans l'onglet Réseau des outils du navigateur).
3. **https://gdsp.duckdns.org/sitemap.xml** : les balises `<loc>` doivent employer `https://gdsp.duckdns.org`, avec les événements attendus.
4. **https://gdsp.duckdns.org/robots.txt** : ligne `Sitemap: https://gdsp.duckdns.org/sitemap.xml`.
5. Une page réelle `/evenements/<slug>` : dans le **code source reçu**, vérifier une seule canonique et les balises `og:title`, `og:description`, `og:url`, `og:image`. Les outils de partage peuvent garder leur ancien aperçu en cache.
6. Un lien circuit existant : doit encore s'ouvrir et afficher sa fiche habituelle après chargement.
7. Une URL volontairement inexistante, comme `/verification-page-absente-gdsp` : page « Page introuvable » et statut 404, pas d'accueil après quelques secondes.
8. Vérifier que la connexion admin, le live et la télémétrie restent accessibles aux adresses habituelles.

Les aperçus de partage sont préparés dans le HTML reçu sur l'accueil et les événements ; ils ne constituent pas de nouvelles pages de résultats ou de profils indexables. Le logo existant sert d'illustration de partage simple, pas de grande affiche dédiée.

## Actions externes à faire séparément

- Dans Google Search Console, vérifier que la propriété choisie correspond bien au nouveau domaine HTTPS, puis soumettre `https://gdsp.duckdns.org/sitemap.xml` et demander l'inspection de l'accueil et de quelques événements représentatifs. Aucune connexion à Search Console n'a été utilisée ici.
- Vérifier la redirection HTTP vers HTTPS dans Caddy : la confirmation d'un accès HTTPS sans alerte ne prouve pas, à elle seule, la redirection HTTP.
- Si l'ancien hébergement est encore maîtrisé, configurer là-bas des redirections permanentes vers les mêmes chemins du nouveau domaine. Ce dépôt ne peut pas rediriger les requêtes qui arrivent sur un autre hébergement éteint ou suspendu.
- Mettre à jour les liens partagés sur Discord et ailleurs si nécessaire. Ne pas supprimer les archives d'événements simplement pour le référencement.

La sécurité CSP/XSS, la refonte du live et le test de redémarrage Windows restent reportés selon la demande de l'utilisateur.

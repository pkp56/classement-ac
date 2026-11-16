#!/usr/bin/env node
'use strict';
/*
 * Contrôle de référencement d'une instance GDSP publique.
 *
 *   node tools/seo-check.js https://gdsp.duckdns.org
 *
 * Vérifie ce que Google verra : accessibilité, robots.txt, sitemap, canonique,
 * Open Graph et données structurées. Sort en erreur (code 1) si un point bloquant
 * est cassé, pour pouvoir l'utiliser en cron après un déploiement.
 */
const site = (process.argv[2] || 'http://gdsp.duckdns.org').replace(/\/+$/, '');
const timeoutMs = Number(process.env.SEO_CHECK_TIMEOUT_MS || 15000);

const results = [];
const record = (level, label, detail = '') => {
  results.push({ level, label, detail });
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  console.log(`${icon} ${label}${detail ? ' — ' + detail : ''}`);
};

async function get(path) {
  const res = await fetch(site + path, {
    redirect: 'follow',
    headers: { 'user-agent': 'GDSP-SEO-Check/1.0 (+' + site + ')' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

function pick(html, re) {
  const m = re.exec(html);
  return m ? m[1] : '';
}

console.log(`\nGDSP — contrôle de référencement\nSite : ${site}\n`);

(async () => {
  let home;
  try {
    home = await get('/');
  } catch (error) {
    record('error', 'Le site ne répond pas', error.message);
    record('error', 'Rien d’autre ne peut être vérifié', 'Corrige l’accès (redirection de port, DNS, pare-feu) puis relance.');
    process.exit(1);
  }
  const siteOrigin = new URL(site).origin;

  record(home.status === 200 ? 'ok' : 'error', 'Page d’accueil', 'HTTP ' + home.status);
  if (home.status !== 200) {
    record('error', 'Sans accueil en 200, Google n’indexera rien', 'Vérifie le serveur (app.js) derrière le domaine.');
    process.exit(1);
  }

  const title = pick(home.body, /<title>([\s\S]*?)<\/title>/);
  const description = pick(home.body, /<meta name="description" content="([^"]*)"/);
  const canonical = pick(home.body, /<link rel="canonical" href="([^"]*)"/);
  const ogImage = pick(home.body, /<meta property="og:image" content="([^"]*)"/);
  const ld = /<script type="application\/ld\+json">[\s\S]*?<\/script>/.test(home.body);

  record(title ? 'ok' : 'error', 'Balise <title>', title || 'absente');
  record(description ? 'ok' : 'warn', 'Meta description', description ? description.slice(0, 80) + '…' : 'absente');
  if (!canonical) record('warn', 'URL canonique absente', 'Elle dépend de PUBLIC_SITE_URL ou de l’en-tête Host.');
  else if (!canonical.startsWith(siteOrigin)) record('error', 'Canonique sur un autre domaine', canonical + ' (attendu : ' + siteOrigin + ')');
  else record('ok', 'URL canonique', canonical);
  if (ogImage && !ogImage.startsWith('http')) record('warn', 'og:image doit être absolue', ogImage);
  else record(ogImage ? 'ok' : 'warn', 'Image de partage (og:image)', ogImage || 'absente');
  record(ld ? 'ok' : 'warn', 'Données structurées JSON-LD', ld ? 'présentes' : 'absentes');

  // robots.txt
  try {
    const robots = await get('/robots.txt');
    record(robots.status === 200 ? 'ok' : 'error', 'robots.txt', 'HTTP ' + robots.status);
    const sitemapLine = pick(robots.body, /Sitemap:\s*(\S+)/);
    if (!sitemapLine) record('warn', 'Aucun sitemap déclaré dans robots.txt');
    else if (!sitemapLine.startsWith(siteOrigin)) record('warn', 'Sitemap déclaré sur un autre domaine', sitemapLine);
    else record('ok', 'Sitemap déclaré', sitemapLine);
    if (/Disallow:\s*\/\s*$/m.test(robots.body)) record('error', 'robots.txt bloque tout le site', 'Disallow: / trouvé');
    if (/Disallow:\s*\/assets/m.test(robots.body)) record('warn', 'robots.txt bloque /assets', 'Les aperçus de partage en ont besoin.');
  } catch (error) {
    record('error', 'robots.txt injoignable', error.message);
  }

  // sitemap.xml
  let eventUrls = [];
  try {
    const sitemap = await get('/sitemap.xml');
    record(sitemap.status === 200 ? 'ok' : 'error', 'sitemap.xml', 'HTTP ' + sitemap.status);
    const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    eventUrls = locs.filter(u => u.includes('/evenements/'));
    record(locs.length ? 'ok' : 'warn', 'URL listées dans le sitemap', String(locs.length));
    const wrong = locs.filter(u => !u.startsWith(siteOrigin));
    if (wrong.length) record('error', 'URL du sitemap sur un autre domaine', wrong[0]);
    if (/<lastmod>/.test(sitemap.body)) record('ok', 'lastmod présent', 'Google peut prioriser la relecture');
  } catch (error) {
    record('error', 'sitemap.xml injoignable', error.message);
  }

  // Une fiche événement réelle, lue dans le sitemap
  if (eventUrls[0]) {
    const path = new URL(eventUrls[0]).pathname;
    try {
      const page = await get(path);
      const ok = page.status === 200;
      record(ok ? 'ok' : 'error', 'Fiche événement lisible sans JavaScript', path + ' → HTTP ' + page.status);
      if (ok) {
        const h1 = /<h1[^>]*>[\s\S]*?<\/h1>/.test(page.body);
        const canon = pick(page.body, /<link rel="canonical" href="([^"]*)"/);
        record(h1 ? 'ok' : 'warn', 'Titre H1 sur la fiche', h1 ? 'présent' : 'absent');
        record(canon === siteOrigin + path ? 'ok' : 'warn', 'Canonique de la fiche', canon || 'absente');
      }
    } catch (error) {
      record('error', 'Fiche événement injoignable', path + ' — ' + error.message);
    }
  } else {
    record('warn', 'Aucune fiche événement dans le sitemap', 'Crée un événement (Administration → Événements) pour donner du contenu à indexer.');
  }

  // Contrôles « bon sens » côté partage
  try {
    const hero = await fetch(new URL('/hero-gdsp.jpg', site), { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    record(hero.ok ? 'ok' : 'warn', 'Image de partage accessible', 'HTTP ' + hero.status);
  } catch (error) {
    record('warn', 'Image de partage injoignable', error.message);
  }

  const errors = results.filter(r => r.level === 'error').length;
  const warns = results.filter(r => r.level === 'warn').length;
  console.log(`\n${errors ? '✗' : '✓'} ${results.length - errors - warns} point(s) OK · ${warns} avertissement(s) · ${errors} erreur(s)\n`);
  if (errors) {
    console.log('À corriger en priorité :');
    results.filter(r => r.level === 'error').forEach(r => console.log(' - ' + r.label + (r.detail ? ' : ' + r.detail : '')));
    console.log('');
  }
  process.exit(errors ? 1 : 0);
})();

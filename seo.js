// Public, server-rendered landing pages. No ranking calculations are duplicated here.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eventPath = slug => '/evenements/' + encodeURIComponent(slug);
const eventCircuitPath = slug => eventPath(slug) + '/circuit';
// Image de partage (Open Graph / Twitter) servie depuis la racine du site.
const OG_IMAGE_PATH = '/hero-gdsp.jpg';
const SITE_NAME = 'Gentleman Drivers Project';
function eventContent(ev) {
  const e = escapeHtml;
  const data = ev.data || {};
  const info = data.eventInfo || {};
  const dates = new Map();
  for (const s of data.sessions || []) {
    if (s.date) dates.set(String(s.date).slice(0,10), {track:s.track, imported:true});
  }
  for (const [date, round] of Object.entries(data.customCalendar || {})) {
    if (!dates.has(date)) dates.set(date, {track:round.track, imported:false});
  }
  return `<article class="panel"><div class="eyebrow">Événement Assetto Corsa · GDSP</div><h1>${e(ev.name)}</h1><p>${e(info.briefing || 'Retrouvez les informations et le calendrier de cet événement Assetto Corsa organisé par Gentleman Drivers Project.')}</p>${['car','schedule','formatText'].map(k => info[k] ? `<p>${e(info[k])}</p>` : '').join('')}<h2>Calendrier des manches</h2>${dates.size ? `<ul>${[...dates].sort(([a],[b])=>a.localeCompare(b)).map(([date,r])=>`<li><time datetime="${e(date)}">${e(date)}</time> · ${e(r.track || 'Circuit à confirmer')} · ${r.imported?'Résultats importés':'À venir'}</li>`).join('')}</ul>` : '<p>Calendrier à venir.</p>'}<p><a href="/">Tous les événements GDSP</a></p></article>`;
}
function homeContent(events) {
  return `<article class="panel"><h1>Gentleman Drivers Project — Assetto Corsa historique et vintage</h1><p>Découvrez les opens et championnats Assetto Corsa de GDSP, avec une passion pour le simracing historique et vintage. Retrouvez leurs calendriers, résultats et classements. Une communauté réunie autour de la course et de l’esprit gentleman driver.</p><h2>Championnats, opens et archives</h2><ul>${events.map(ev=>`<li><a href="${eventPath(ev.slug)}">${escapeHtml(ev.name)}</a></li>`).join('')}</ul></article>`;
}
// Une URL canonique n'a de sens qu'en absolu : les chemins relatifs sont
// résolus contre l'origine publique du site.
function absoluteUrl(pathOrUrl, origin) {
  const value = String(pathOrUrl ?? '');
  if (!origin) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return String(origin).replace(/\/$/, '') + (value.startsWith('/') ? value : '/' + value);
}
/**
 * Enrichit le gabarit HTML : titre, description, canonique, Open Graph,
 * Twitter Card et données structurées JSON-LD (fil d'Ariane).
 *
 * `origin` est l'origine publique absolue (PUBLIC_SITE_URL). Sans elle, on
 * n'écrit ni canonique ni URL absolue : mieux vaut pas de balise qu'une balise
 * fausse qui enverrait Google vers une adresse d'aperçu temporaire.
 */
function renderPage(template, {title,description,content,canonical,origin,ogType,jsonLd}) {
  const absoluteCanonical = canonical ? absoluteUrl(canonical, origin) : '';
  const url = absoluteCanonical || absoluteUrl('/', origin);
  const image = absoluteUrl(OG_IMAGE_PATH, origin);
  const meta = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    absoluteCanonical ? `<link rel="canonical" href="${escapeHtml(absoluteCanonical)}">` : '',
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:locale" content="fr_FR">`,
    `<meta property="og:type" content="${escapeHtml(ogType || 'website')}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    `<meta name="theme-color" content="#102a32">`,
    jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''
  ].filter(Boolean).join('');
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = html.replace('</head>', meta + '</head>');
  return html.replace('<div class="page" id="app"></div>', `<div class="page" id="app">${content}</div>`);
}
/** Fil d'Ariane structuré : aide Google à situer une page dans le site. */
function breadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {})
    }))
  };
}
function homeJsonLd(origin) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    alternateName: 'GDSP — Assetto Corsa',
    description: 'Opens et championnats Assetto Corsa historique et vintage : calendriers, résultats et classements.',
    inLanguage: 'fr-FR',
    ...(origin ? { url: absoluteUrl('/', origin) } : {})
  };
}
function eventJsonLd(ev, origin) {
  const event = { '@type': 'SportsEvent', name: String(ev.name || '') };
  if (origin) event.url = absoluteUrl(eventPath(ev.slug), origin);
  const briefing = ev.data?.eventInfo?.briefing;
  if (briefing) event.description = String(briefing).slice(0, 300);
  event.eventAttendanceMode = 'https://schema.org/OnlineEventAttendanceMode';
  event.organizer = { '@type': 'Organization', name: SITE_NAME, ...(origin ? { url: absoluteUrl('/', origin) } : {}) };
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil GDSP', ...(origin ? { item: absoluteUrl('/', origin) } : {}) },
      { '@type': 'ListItem', position: 2, name: String(ev.name || ''), ...(origin ? { item: absoluteUrl(eventPath(ev.slug), origin) } : {}) }
    ],
    '@graph': [event]
  };
}
module.exports = {escapeHtml,eventPath,eventCircuitPath,eventContent,homeContent,renderPage,absoluteUrl,breadcrumb,homeJsonLd,eventJsonLd,OG_IMAGE_PATH,SITE_NAME};

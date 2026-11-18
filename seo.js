// Public, server-rendered landing pages. No ranking calculations are duplicated here.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eventPath = slug => '/evenements/' + encodeURIComponent(slug);
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
const DEFAULT_SITE_URL='https://gdsp.duckdns.org';
function siteOrigin(value=DEFAULT_SITE_URL){
  const url=new URL(String(value).trim());
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('PUBLIC_SITE_URL doit être une origine HTTP(S), sans chemin ni identifiants.');
  return url.origin;
}
function renderPage(template, {title,description,content,canonical,noindex=false,interactive=true}) {
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  const e=escapeHtml;
  const tags=[`<meta name="description" content="${e(description)}">`];
  if(noindex)tags.push('<meta name="robots" content="noindex,follow">');
  if(canonical){
    const image=new URL('/assets/logo.png',canonical).href;
    tags.push(`<link rel="canonical" href="${e(canonical)}">`,
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Gentleman Drivers Project">',
      '<meta property="og:locale" content="fr_FR">',
      `<meta property="og:title" content="${e(title)}">`,
      `<meta property="og:description" content="${e(description)}">`,
      `<meta property="og:url" content="${e(canonical)}">`,
      `<meta property="og:image" content="${e(image)}">`,
      '<meta property="og:image:alt" content="Logo Gentleman Drivers Project">',
      '<meta name="twitter:card" content="summary">',
      `<meta name="twitter:title" content="${e(title)}">`,
      `<meta name="twitter:description" content="${e(description)}">`,
      `<meta name="twitter:image" content="${e(image)}">`);
  }
  html = html.replace('</head>', tags.join('\n')+'</head>');
  html=html.replace('<div class="page" id="app"></div>', `<div class="page" id="app">${content}</div>`);
  // Les erreurs ne doivent pas être remplacées par l'accueil au démarrage de la SPA.
  if(!interactive)html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  return html;
}
module.exports = {escapeHtml,eventPath,eventContent,homeContent,renderPage,siteOrigin,DEFAULT_SITE_URL};

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
function renderPage(template, {title,description,content,canonical}) {
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = html.replace('</head>', `<meta name="description" content="${escapeHtml(description)}">${canonical?`<link rel="canonical" href="${escapeHtml(canonical)}">`:''}</head>`);
  return html.replace('<div class="page" id="app"></div>', `<div class="page" id="app">${content}</div>`);
}
module.exports = {escapeHtml,eventPath,eventContent,homeContent,renderPage};

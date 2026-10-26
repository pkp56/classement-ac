(() => {
'use strict';

const TZ = 'Europe/Paris';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('fr-FR');
const fmtDate = (iso, o = { day: 'numeric', month: 'long', year: 'numeric' }) =>
  new Intl.DateTimeFormat('fr-FR', { ...o, timeZone: TZ }).format(new Date(iso));
const fmtLap = (ms) => {
  if (!ms || ms <= 0) return '—';
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
};
const ord = (n) => (n === 1 ? '1er' : `${n}e`);
const LINE_COLORS = ['#14181B', '#6A2DB4', '#13813A', '#C42E2A', '#A9830F', '#6F8C9B'];

let CH = null;
let loading = null;

function load() {
  if (CH) return Promise.resolve(CH);
  if (!loading) {
    loading = fetch('data/championship.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((j) => { CH = j; return j; });
  }
  return loading;
}

const nm = (id) => CH.drivers[id]?.name || id;
const standingOf = (id) => CH.standings.find((s) => s.driver === id);

/* ---------------------------------------------------------------- navigation interne */
function subnav(cur) {
  const items = [['', 'Résumés des courses'], ['pilotes', 'Profils pilotes'], ['classement', 'Classement']];
  return `<div class="bar" role="navigation" aria-label="Sections du championnat">
    ${items.map(([k, l]) => `<a class="pill" href="#/championnat${k ? '/' + k : ''}" aria-current="${(cur || '') === k}">${l}</a>`).join('')}
  </div>`;
}

function head(title) {
  const m = CH.meta;
  return `<section class="pro-head">
      <h1>${esc(title)}</h1>
      <p>${esc(m.name)}</p>
      <dl class="stats">
        <div><dt>Manches terminées</dt><dd>${m.eventsCompleted} <small>sur ${m.eventsPlanned}</small></dd></div>
        <div><dt>Courses</dt><dd>${m.races}</dd></div>
        <div><dt>Pilotes</dt><dd>${m.drivers}</dd></div>
        <div><dt>Tours courus</dt><dd>${nf.format(m.totalLaps)}</dd></div>
      </dl>
    </section>`;
}

/* ---------------------------------------------------------------- résumés */
function positionsChart(rc) {
  const ids = Object.keys(rc.positions);
  if (!ids.length) return '';
  const L = rc.laps;
  const all = ids.flatMap((g) => rc.positions[g]).filter(Boolean);
  const maxPos = Math.max(6, ...all);
  const W = 760, H = 220, pl = 30, pr = 150, pt = 14, pb = 26;
  const x = (i) => pl + (L === 1 ? 0 : (i * (W - pl - pr)) / (L - 1));
  const y = (p) => pt + ((p - 1) * (H - pt - pb)) / (maxPos - 1);
  const yTicks = [1, 5, 10, 15, 20, 25].filter((t) => t <= maxPos);
  const lines = ids.map((g, k) => {
    const pts = rc.positions[g].map((p, i) => (p ? `${x(i).toFixed(1)},${y(p).toFixed(1)}` : null)).filter(Boolean).join(' ');
    const last = rc.positions[g].filter(Boolean).at(-1);
    const col = LINE_COLORS[k];
    return `<polyline fill="none" stroke="${col}" stroke-width="${k === 0 ? 3 : 2}" stroke-linejoin="round" points="${pts}"/>
      <text x="${W - pr + 8}" y="${(y(last) + 4).toFixed(1)}" style="fill:${col};font-weight:700">${esc(nm(g))}</text>`;
  }).join('');
  const xt = [1, Math.round(L / 2), L].filter((v, i, a) => a.indexOf(v) === i);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Position tour par tour des six premiers de la course">
      ${yTicks.map((t) => `<line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}"/><text x="4" y="${y(t) + 4}">${t}</text>`).join('')}
      ${xt.map((t) => `<text x="${x(t - 1)}" y="${H - 6}" text-anchor="middle">Tour ${t}</text>`).join('')}
      ${lines}
    </svg></div>`;
}

function raceTable(rc) {
  const rows = rc.results.map((x) => {
    const gap = x.status !== 'FIN' ? '<span class="dnf-txt">Abandon</span>'
      : x.pos === 1 ? '—'
      : x.gap != null ? `+${(x.gap / 1000).toFixed(3).replace('.', ',')} s`
      : `+${x.gapLaps} tour${x.gapLaps > 1 ? 's' : ''}`;
    const fl = rc.fastestLap?.driver === x.driver;
    const gain = x.gain == null ? '' : x.gain > 0 ? `<span class="evo up">▲ ${x.gain}</span>` : x.gain < 0 ? `<span class="evo down">▼ ${-x.gain}</span>` : '<span class="evo flat">=</span>';
    return `<tr>
      <td class="rank">${x.status === 'FIN' ? x.pos : '—'}</td>
      <td>${esc(nm(x.driver))}${rc.pole === x.driver && rc.raceNo === 1 ? ' <span class="chip-purple">Pole</span>' : ''}</td>
      <td class="num">${x.grid ?? '—'}</td>
      <td>${gain}</td>
      <td class="num">${x.laps}</td>
      <td class="num">${gap}</td>
      <td class="num ${fl ? 'best-lap' : ''}">${fmtLap(x.bestLap)}</td>
      <td class="num">${x.contacts + x.envHits}</td>
      <td class="num total">${x.points}</td></tr>`;
  }).join('');
  return `<div class="scroll"><table>
    <thead><tr><th>Place</th><th>Pilote</th><th class="num">Grille</th><th>Évol.</th><th class="num">Tours</th><th class="num">Écart</th><th class="num">Meilleur tour</th><th class="num" title="Contacts et sorties de piste">Incidents</th><th class="num">Points</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function raceCard(rc) {
  const s = rc.summary;
  const podium = rc.results.filter((x) => x.status === 'FIN').slice(0, 3);
  const sess = rc.twoRaces ? ` · course ${rc.raceNo}` : '';
  return `<article class="race" id="${esc(rc.id)}">
    <div class="race-meta">
      <strong>${esc(rc.track)}</strong>
      <span>${fmtDate(rc.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      <span class="muted">${esc(rc.eventName)}${sess}</span>
    </div>
    <div class="race-body">
      <h3>${esc(s.headline)}</h3>
      ${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
      <ol class="podium">
        ${podium.map((x) => `<li><span class="pos">${x.pos}</span> ${esc(nm(x.driver))}<span class="sub">${x.pos === 1 ? `${x.laps} tours` : x.gap != null ? '+' + (x.gap / 1000).toFixed(3).replace('.', ',') + ' s' : ''}</span></li>`).join('')}
      </ol>
      ${s.highlights.length ? `<dl class="hl">${s.highlights.map((h) => `<div><dt>${esc(h.label)}</dt><dd>${esc(nm(h.driver))}<span class="sub">${esc(h.value)}</span></dd></div>`).join('')}</dl>` : ''}
      <details>
        <summary>Résultats complets et positions tour par tour</summary>
        ${positionsChart(rc)}
        ${raceTable(rc)}
      </details>
    </div>
  </article>`;
}

function viewRaces() {
  const races = [...CH.races].sort((a, b) => b.date.localeCompare(a.date));
  return `${head('Résumés des courses')}
    ${subnav('')}
    <p class="lede">Un résumé par course, du plus récent au plus ancien. Ouvrez « Résultats complets » pour voir la grille, les écarts et la course tour par tour.</p>
    <div class="races">${races.map(raceCard).join('')}</div>
    ${notes()}`;
}

/* ---------------------------------------------------------------- profils */
function axisBars(p) {
  return `<ul class="axes">${p.axes.map((a) => `<li>
      <span class="ax-l">${esc(a.label)}</span>
      <span class="ax-bar" role="img" aria-label="${esc(a.label)} : n°${a.rank} sur ${a.of}"><i style="width:${Math.max(4, Math.round(a.pct * 100))}%"></i></span>
      <span class="ax-r">n°${a.rank}<small>/${a.of}</small></span></li>`).join('')}</ul>`;
}

function profileCard(p) {
  const d = CH.drivers[p.driver];
  const st = standingOf(p.driver);
  const line = [
    st ? `${ord(st.rank)} · ${nf.format(st.points)} pts` : '',
    `${p.races} course${p.races > 1 ? 's' : ''}`,
    p.wins ? `${p.wins} victoire${p.wins > 1 ? 's' : ''}` : '',
    p.podiums ? `${p.podiums} podium${p.podiums > 1 ? 's' : ''}` : '',
    p.poles ? `${p.poles} pole${p.poles > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
  const facts = [
    p.avgGrid != null ? `Grille moyenne ${String(p.avgGrid).replace('.', ',')}` : '',
    p.avgFinish != null ? `arrivée moyenne ${String(p.avgFinish).replace('.', ',')}` : '',
    p.bestFinish != null ? `meilleure place ${p.bestFinish}` : '',
    p.dnf ? `${p.dnf} abandon${p.dnf > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
  const list = (arr, empty) => arr.length ? `<ul>${arr.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
  return `<article class="prof" id="p-${esc(p.driver)}">
    <header>
      <h3>${esc(d.name)}</h3>
      <p class="muted">${esc(d.team || 'Sans équipe')}</p>
      <p><strong>${esc(line)}</strong></p>
      <p class="muted">${esc(facts)}</p>
    </header>
    ${p.enough ? `
    <div class="sw">
      <div><h4>Points forts</h4>${list(p.strengths, 'Aucun point fort marqué pour l’instant.')}</div>
      <div><h4>Points faibles</h4>${list(p.weaknesses, 'Aucun point faible marqué pour l’instant.')}</div>
    </div>
    ${axisBars(p)}` : `<p class="muted">Pas assez de courses (${p.races}) pour établir un profil. Il en faut au moins 2.</p>`}
  </article>`;
}

function viewProfiles(filter) {
  const order = new Map(CH.standings.map((s, i) => [s.driver, i]));
  const profs = Object.values(CH.profiles).sort((a, b) => (order.get(a.driver) ?? 999) - (order.get(b.driver) ?? 999));
  const shown = filter && CH.profiles[filter] ? [CH.profiles[filter]] : profs;
  return `${head('Profils pilotes')}
    ${subnav('pilotes')}
    <p class="lede">Chaque profil compare le pilote au reste du plateau sur les courses du championnat. Un point fort ou faible n'apparaît que s'il place le pilote dans le tiers supérieur ou inférieur du plateau.</p>
    <div class="selects">
      <label for="prof-pick" class="muted">Pilote</label>
      <select id="prof-pick">
        <option value="">Tous les pilotes</option>
        ${profs.map((p) => `<option value="${esc(p.driver)}" ${p.driver === filter ? 'selected' : ''}>${esc(nm(p.driver))}</option>`).join('')}
      </select>
    </div>
    <div class="profs">${shown.map(profileCard).join('')}</div>
    <p class="muted" style="margin-top:20px"><strong>Lecture des barres :</strong> plus la barre est longue, plus le pilote est bien classé sur ce critère parmi les pilotes qui ont au moins 2 courses (n°1 = meilleur).</p>
    ${notes()}`;
}

/* ---------------------------------------------------------------- classement */
function viewStandings() {
  const races = [...CH.races].sort((a, b) => a.date.localeCompare(b.date));
  const rows = CH.standings.map((s) => {
    const d = CH.drivers[s.driver];
    return `<tr class="${s.rank === 1 ? 'lead' : ''}">
      <td class="rank">${s.rank}</td>
      <td><a class="plink" href="#/championnat/pilotes/${encodeURIComponent(s.driver)}">${esc(d.name)}</a><span class="sub">${esc(d.team || '')}</span></td>
      ${races.map((r) => `<td class="num">${s.byRace[r.id] != null ? s.byRace[r.id] : '—'}</td>`).join('')}
      <td class="num">${s.wins}</td><td class="num">${s.podiums}</td><td class="num">${s.poles}</td>
      <td class="num total">${nf.format(s.points)}</td></tr>`;
  }).join('');
  return `${head('Classement du championnat')}
    ${subnav('classement')}
    <div class="scroll"><table>
      <thead><tr><th>Rang</th><th>Pilote</th>
        ${races.map((r) => `<th class="num" title="${esc(r.eventName)}">${esc(r.track)}${r.twoRaces ? ' C' + r.raceNo : ''}</th>`).join('')}
        <th class="num">Vict.</th><th class="num">Podiums</th><th class="num">Poles</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${notes()}`;
}

function notes() {
  return `<div class="notice-soft"><h3>Comment sont calculées ces données</h3><ul>${CH.meta.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
}

/* ---------------------------------------------------------------- point d'entrée */
function render(sub, arg) {
  return load().then(() => {
    if (sub === 'pilotes') return viewProfiles(arg);
    if (sub === 'classement') return viewStandings();
    return viewRaces();
  }).catch(() => `<div class="notice"><h2>Championnat introuvable</h2>
    <p>La page charge <code>data/championship.json</code>. Générez-le avec
    <code>python3 build_championship.py --input championnat.json</code> puis rechargez la page.</p></div>`);
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'prof-pick') {
    location.hash = `#/championnat/pilotes${e.target.value ? '/' + encodeURIComponent(e.target.value) : ''}`;
  }
});

window.Championnat = { render };
})();

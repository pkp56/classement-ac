(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('fr-FR');
const CATS = { platine: 'Platine', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };

let DB, TZ, DRV, RACE, HIST;

/* ------------------------------------------------------------------ */
/* Formats                                                            */
/* ------------------------------------------------------------------ */
const fmtDate = (iso, o = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat('fr-FR', { ...o, timeZone: TZ }).format(new Date(iso));
const nightKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const fmtLap = (ms) => {
  if (!ms || ms <= 0) return '—';
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
};
const fmtTotal = (ms) => {
  if (!ms || ms <= 0) return '—';
  const h = Math.floor(ms / 3600000);
  const rest = ms - h * 3600000;
  return h ? `${h}:${fmtLap(rest).padStart(8, '0')}` : fmtLap(rest);
};
const fmtGap = (ms) => `+${(ms / 1000).toFixed(3)}`;
const nm = (id) => DRV[id]?.name || id;
const plink = (id) => `<a class="plink" href="#/pilote/${encodeURIComponent(id)}">${esc(nm(id))}</a>`;
const catChip = (c) => (c ? `<span class="cat cat-${esc(c)}">${esc(CATS[c] || c)}</span>` : '');

/* ------------------------------------------------------------------ */
/* Calculs                                                            */
/* ------------------------------------------------------------------ */
function standings(cutoffIso) {
  const end = new Date(cutoffIso);
  const start = new Date(cutoffIso);
  start.setUTCFullYear(start.getUTCFullYear() - DB.meta.windowYears);
  const rows = new Map();
  for (const r of DB.races) {
    const d = new Date(r.date);
    if (d > end || d <= start) continue;
    const year = d.getUTCFullYear();
    for (const x of r.results) {
      let row = rows.get(x.driver);
      if (!row) {
        row = { id: x.driver, total: 0, wins: 0, podiums: 0, races: 0, bySeason: {} };
        rows.set(x.driver, row);
      }
      row.total += x.points;
      row.races++;
      row.bySeason[year] = (row.bySeason[year] || 0) + x.points;
      if (x.status === 'FIN' && x.pos === 1) row.wins++;
      if (x.status === 'FIN' && x.pos <= 3) row.podiums++;
    }
  }
  const arr = [...rows.values()].sort(
    (a, b) => b.total - a.total || b.wins - a.wins || b.podiums - a.podiums || nm(a.id).localeCompare(nm(b.id), 'fr'));
  arr.forEach((r, i) => (r.rank = i + 1));
  return arr;
}

function ranked(h, cat) {
  return h.st.filter((r) => !cat || DRV[r.id]?.category === cat).map((r, i) => ({ ...r, rank: i + 1 }));
}

function careerStats(id) {
  const s = { races: 0, wins: 0, podiums: 0, top5: 0, poles: 0, fastest: 0, dnf: 0, best: null, posSum: 0, posN: 0, rows: [] };
  for (const r of DB.races) {
    const x = r.results.find((z) => z.driver === id);
    if (!x) continue;
    s.races++;
    if (x.status === 'FIN') {
      s.posSum += x.pos; s.posN++;
      if (x.pos === 1) s.wins++;
      if (x.pos <= 3) s.podiums++;
      if (x.pos <= 5) s.top5++;
      s.best = s.best == null ? x.pos : Math.min(s.best, x.pos);
    } else s.dnf++;
    if (r.pole === id) s.poles++;
    if (r.fastestLap?.driver === id) s.fastest++;
    s.rows.push({ race: r, res: x });
  }
  s.avg = s.posN ? s.posSum / s.posN : null;
  return s;
}

function bestLaps(id) {
  const m = new Map();
  for (const r of DB.races) {
    const x = r.results.find((z) => z.driver === id);
    if (!x || !(x.bestLap > 0)) continue;
    const cur = m.get(r.trackKey);
    if (!cur || x.bestLap < cur.time) m.set(r.trackKey, { time: x.bestLap, car: x.car, date: r.date, track: r.track });
  }
  return m;
}

function trackRecords() {
  const m = new Map();
  for (const r of DB.races) {
    for (const x of r.results) {
      if (!(x.bestLap > 0)) continue;
      const cur = m.get(r.trackKey);
      if (!cur || x.bestLap < cur.time) m.set(r.trackKey, { time: x.bestLap, driver: x.driver, car: x.car, date: r.date, track: r.track });
    }
  }
  return [...m.values()].sort((a, b) => a.track.localeCompare(b.track, 'fr'));
}

function bestRank(id) {
  let b = null;
  for (const h of HIST) {
    const r = h.st.find((x) => x.id === id);
    if (r) b = b == null ? r.rank : Math.min(b, r.rank);
  }
  return b;
}

function leaderSince() {
  const leader = HIST.at(-1).leader;
  let i = HIST.length - 1;
  while (i > 0 && HIST[i - 1].leader === leader) i--;
  return { leader, since: HIST[i].races[0].date, nights: HIST.length - i };
}

function recentForm(id, n = 5) {
  const out = [];
  for (const r of DB.races) {
    const x = r.results.find((z) => z.driver === id);
    if (x) out.push(x);
  }
  return out.slice(-n);
}

function resChip(x) {
  if (x.status !== 'FIN') return '<span class="res dnf" title="Abandon">Ab.</span>';
  const c = x.pos === 1 ? 'win' : x.pos <= 3 ? 'podium' : '';
  return `<span class="res ${c}">P${x.pos}</span>`;
}

function evoCell(rank, prevRank, hasPrev) {
  if (!hasPrev) return '<span class="evo none">·</span>';
  if (prevRank == null) return '<span class="evo new">Nouv.</span>';
  const d = prevRank - rank;
  if (d > 0) return `<span class="evo up" title="Gagne ${d} place${d > 1 ? 's' : ''}">▲ ${d}</span>`;
  if (d < 0) return `<span class="evo down" title="Perd ${-d} place${d < -1 ? 's' : ''}">▼ ${-d}</span>`;
  return '<span class="evo flat">=</span>';
}

/* ------------------------------------------------------------------ */
/* Préparation des données                                            */
/* ------------------------------------------------------------------ */
function prepare() {
  TZ = DB.meta.timezone || 'Europe/Paris';
  DB.races.sort((a, b) => a.date.localeCompare(b.date));
  RACE = Object.fromEntries(DB.races.map((r) => [r.id, r]));
  DRV = DB.drivers;

  const byNight = new Map();
  for (const r of DB.races) {
    const k = nightKey(r.date);
    if (!byNight.has(k)) byNight.set(k, []);
    byNight.get(k).push(r);
  }
  HIST = [...byNight.entries()].map(([night, races]) => {
    const cutoff = races[races.length - 1].date;
    const st = standings(cutoff);
    return { night, cutoff, races, st, leader: st[0]?.id };
  });
}

/* ------------------------------------------------------------------ */
/* Vues                                                               */
/* ------------------------------------------------------------------ */
function viewRanking(cat) {
  const cur = HIST.at(-1);
  const prev = HIST.at(-2);
  const rows = ranked(cur, cat);
  const prevMap = new Map(prev ? ranked(prev, cat).map((r) => [r.id, r.rank]) : []);
  const years = [...new Set(cur.st.flatMap((r) => Object.keys(r.bySeason)))].sort().slice(-5);
  const { leader, since } = leaderSince();
  const lastRace = cur.races.at(-1);
  const cats = [...new Set(Object.values(DRV).map((d) => d.category).filter(Boolean))]
    .sort((a, b) => Object.keys(CATS).indexOf(a) - Object.keys(CATS).indexOf(b));

  const filters = cats.length
    ? `<div class="bar"><span class="label">Catégorie</span>
        <a class="pill" href="#/ranking" aria-current="${!cat}">Toutes</a>
        ${cats.map((c) => `<a class="pill" href="#/ranking/${esc(c)}" aria-current="${cat === c}">${esc(CATS[c] || c)}</a>`).join('')}
      </div>`
    : '<div class="bar"></div>';

  const body = rows.map((r, i) => {
    const other = i === 0 ? rows[1] : rows[i - 1];
    const compare = other ? `<a class="plink" href="#/face-a-face/${encodeURIComponent(r.id)}/${encodeURIComponent(other.id)}">Face-à-face</a>` : '';
    const d = DRV[r.id] || {};
    return `<tr class="${r.rank === 1 ? 'lead' : ''}">
      <td class="rank">${r.rank}</td>
      <td>${evoCell(r.rank, prevMap.get(r.id), !!prev)}</td>
      <td>${plink(r.id)}<span class="sub">meilleur rang ${bestRank(r.id) ?? '—'}</span></td>
      <td>${catChip(d.category)}</td>
      ${years.map((y) => `<td class="num">${r.bySeason[y] ? nf.format(r.bySeason[y]) : '—'}</td>`).join('')}
      <td class="num total">${nf.format(r.total)}</td>
      <td><span class="form">${recentForm(r.id).map(resChip).join('')}</span></td>
      <td class="nowrap">${compare}</td>
    </tr>`;
  }).join('');

  return `
    <section class="hero">
      <div>
        <span class="hero-tag">N°1</span>
        <h1><a href="#/pilote/${encodeURIComponent(leader)}">${esc(nm(leader))}</a></h1>
        <p>En tête depuis le ${fmtDate(since)}.</p>
      </div>
      <dl class="facts">
        <div><dt>Fenêtre</dt><dd>${DB.meta.windowYears} ans glissants</dd></div>
        <div><dt>Dernière mise à jour</dt><dd>${fmtDate(lastRace.date)} · ${esc(lastRace.track)}</dd></div>
        <div><dt>Pilotes classés</dt><dd>${cur.st.length}</dd></div>
      </dl>
    </section>
    ${filters}
    <p class="lede">Les points des ${DB.meta.windowYears} dernières années, saison par saison. Un résultat s'efface ${DB.meta.windowYears} ans, jour pour jour, après la course.</p>
    <div class="scroll"><table>
      <thead><tr>
        <th>Rang</th><th>Évol.</th><th>Pilote</th><th>Catégorie</th>
        ${years.map((y) => `<th class="num">Saison ${y}</th>`).join('')}
        <th class="num">Total</th><th>Dernières courses</th><th>Comparer</th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="${years.length + 7}" class="empty">Aucun pilote dans cette catégorie.</td></tr>`}</tbody>
    </table></div>
    ${leadersTable()}
    ${baremeBlock()}`;
}

function leadersTable() {
  const rows = HIST.map((h) => {
    const t = h.st[0];
    return t ? `<tr><td>${fmtDate(h.cutoff)}</td><td>${plink(t.id)}</td><td class="num">${nf.format(t.total)}</td></tr>` : '';
  }).reverse().join('');
  return `<h2>La course au n°1, classement après classement</h2>
    <div class="scroll"><table>
      <thead><tr><th>Classement</th><th>N°1</th><th class="num">Points</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function sparkline(id) {
  const vals = HIST.map((h) => { const r = h.st.find((x) => x.id === id); return r ? r.rank : null; });
  const max = Math.max(2, ...DB.races.length ? [HIST.at(-1).st.length] : [2]);
  const W = 720, H = 150, pl = 34, pr = 18, pt = 18, pb = 28;
  const n = vals.length;
  const x = (i) => (n === 1 ? (W) / 2 : pl + (i * (W - pl - pr)) / (n - 1));
  const y = (v) => pt + ((v - 1) * (H - pt - pb)) / (max - 1);
  const pts = vals.map((v, i) => (v ? [x(i), y(v), v, i] : null)).filter(Boolean);
  const first = HIST.findIndex((h, i) => vals[i]);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du rang de ${esc(nm(id))} après chaque soirée">
    <line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(1)}" y2="${y(1)}"/>
    <line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(max)}" y2="${y(max)}"/>
    <text x="6" y="${y(1) + 4}">1</text><text x="6" y="${y(max) + 4}">${max}</text>
    <polyline class="line" points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>
    ${pts.map((p) => `<g><circle class="dot ${p[3] === first ? 'first' : ''}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5"/><text x="${p[0].toFixed(1)}" y="${(p[1] - 10).toFixed(1)}" text-anchor="middle">${p[2]}</text></g>`).join('')}
    <text x="${pl}" y="${H - 6}">${fmtDate(HIST[0].cutoff, { day: 'numeric', month: 'short' })}</text>
    <text x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtDate(HIST.at(-1).cutoff, { day: 'numeric', month: 'short' })}</text>
  </svg>`;
}

function viewDriver(id) {
  const d = DRV[id];
  if (!d) return notFound('Pilote introuvable');
  const s = careerStats(id);
  const cur = HIST.at(-1).st.find((r) => r.id === id);
  const bl = [...bestLaps(id).values()].sort((a, b) => a.track.localeCompare(b.track, 'fr'));
  const records = new Map(trackRecords().map((r) => [r.track, r]));
  const rate = s.races ? Math.round((100 * s.wins) / s.races) : 0;

  const results = [...s.rows].reverse().map(({ race, res }) => `<tr>
      <td class="nowrap">${fmtDate(race.date)}</td>
      <td><a class="plink" href="#/courses/${esc(race.id)}">${esc(race.track)}</a><span class="sub">${esc(race.championshipName)}</span></td>
      <td class="num ${res.status === 'FIN' && res.pos === 1 ? 'win-cell' : ''}">${res.status === 'FIN' ? res.pos : '<span class="dnf-txt">Ab.</span>'}</td>
      <td class="num">${nf.format(res.points)}</td>
      <td class="num ${race.fastestLap?.driver === id ? 'best-lap' : ''}">${fmtLap(res.bestLap)}</td>
      <td>${race.pole === id ? '<span class="chip-purple">Pole</span>' : ''}</td>
    </tr>`).join('');

  const lapsRows = bl.map((b) => {
    const rec = records.get(b.track);
    const isRec = rec && rec.driver === id && rec.time === b.time;
    return `<tr><td>${esc(b.track)}<span class="sub">${esc(b.car)} · ${fmtDate(b.date)}</span></td>
      <td class="num ${isRec ? 'best-lap' : ''}">${fmtLap(b.time)}</td>
      <td class="num muted">${isRec ? 'Record' : rec ? fmtGap(b.time - rec.time) : ''}</td></tr>`;
  }).join('');

  const others = Object.values(DRV).filter((o) => o.id !== id)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  return `
    <section class="pro-head">
      <h1>${esc(d.name)}</h1>
      <p>${catChip(d.category)} ${cur ? `${cur.rank}${cur.rank === 1 ? 'er' : 'e'} du classement · ${nf.format(cur.total)} points sur ${DB.meta.windowYears} ans · meilleur rang ${bestRank(id)}` : 'Hors classement (aucune course dans la fenêtre)'}</p>
      <dl class="stats">
        <div><dt>Courses</dt><dd>${s.races}</dd></div>
        <div><dt>Victoires</dt><dd>${s.wins} <small>${rate} %</small></dd></div>
        <div><dt>Podiums</dt><dd>${s.podiums}</dd></div>
        <div><dt>Top 5</dt><dd>${s.top5}</dd></div>
        <div><dt>Poles</dt><dd>${s.poles}</dd></div>
        <div><dt>Meilleurs tours</dt><dd>${s.fastest}</dd></div>
        <div><dt>Abandons</dt><dd>${s.dnf}</dd></div>
        <div><dt>Place moyenne</dt><dd>${s.avg == null ? '—' : s.avg.toFixed(1).replace('.', ',')}</dd></div>
      </dl>
    </section>

    <h2>Rang après chaque soirée</h2>
    <div class="chart">${sparkline(id)}</div>

    <div class="grid-2">
      <div>
        <h2>Résultats</h2>
        <div class="scroll"><table>
          <thead><tr><th>Date</th><th>Course</th><th class="num">Place</th><th class="num">Points</th><th class="num">Meilleur tour</th><th></th></tr></thead>
          <tbody>${results || '<tr><td colspan="6" class="empty">Aucune course.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div>
        <h2>Meilleurs tours par circuit</h2>
        <div class="scroll"><table>
          <thead><tr><th>Circuit</th><th class="num">Temps</th><th class="num">Record</th></tr></thead>
          <tbody>${lapsRows || '<tr><td colspan="3" class="empty">Aucun tour chronométré.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>

    <h2>Se comparer</h2>
    <div class="selects">
      <label for="vs-pick" class="muted">Face-à-face avec</label>
      <select id="vs-pick" data-vs="${esc(id)}">
        <option value="">Choisir un pilote</option>
        ${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}
      </select>
    </div>`;
}

function viewCourses(id) {
  const races = [...DB.races].reverse();
  const race = id ? RACE[id] : races[0];
  if (!race) return notFound('Course introuvable');
  const winner = race.results[0];
  const lvl = DB.scoring.levels[race.level]?.label || race.level;
  const night = HIST.find((h) => h.races.includes(race));

  const rows = race.results.map((x) => {
    let gap = '';
    if (x.status !== 'FIN') gap = '<span class="dnf-txt">Abandon</span>';
    else if (x.pos === 1) gap = fmtTotal(x.totalTime);
    else if (x.laps === winner.laps) gap = fmtGap(x.totalTime - winner.totalTime);
    else gap = `+${winner.laps - x.laps} tour${winner.laps - x.laps > 1 ? 's' : ''}`;
    const fl = race.fastestLap?.driver === x.driver;
    return `<tr>
      <td class="rank">${x.status === 'FIN' ? x.pos : '—'}</td>
      <td>${plink(x.driver)}${race.pole === x.driver ? ' <span class="chip-purple">Pole</span>' : ''}</td>
      <td class="muted">${esc(x.car)}</td>
      <td class="num">${x.laps}</td>
      <td class="num">${gap}</td>
      <td class="num ${fl ? 'best-lap' : ''}">${fmtLap(x.bestLap)}</td>
      <td class="num total">${nf.format(x.points)}</td>
    </tr>`;
  }).join('');

  return `
    <section class="pro-head">
      <h1>${esc(race.track)}</h1>
      <p>${fmtDate(race.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${esc(race.championshipName)} (niveau ${esc(lvl)})${race.endurance ? ' · endurance' : ''} · ${race.durationMinutes} min</p>
    </section>
    <div class="selects">
      <label for="race-pick" class="muted">Course</label>
      <select id="race-pick">
        ${races.map((r) => `<option value="${esc(r.id)}" ${r.id === race.id ? 'selected' : ''}>${fmtDate(r.date)} · ${esc(r.track)}</option>`).join('')}
      </select>
    </div>
    <h2>Résultats</h2>
    <div class="scroll"><table>
      <thead><tr><th>Place</th><th>Pilote</th><th>Voiture</th><th class="num">Tours</th><th class="num">Écart</th><th class="num">Meilleur tour</th><th class="num">Points</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="lede" style="margin-top:14px">${race.fastestLap ? `Meilleur tour : ${plink(race.fastestLap.driver)} en <span class="best-lap">${fmtLap(race.fastestLap.time)}</span>.` : ''}
    ${night ? ` Après cette soirée, ${plink(night.leader)} est n°1 avec ${nf.format(night.st[0].total)} points.` : ''}</p>`;
}

function viewPalmares() {
  const all = Object.keys(DRV).map((id) => ({ id, ...careerStats(id) })).filter((s) => s.races)
    .sort((a, b) => b.wins - a.wins || b.podiums - a.podiums || b.poles - a.poles || a.races - b.races);
  const rows = all.map((s) => `<tr>
      <td>${plink(s.id)}<span class="sub">${s.best != null ? `meilleure place : ${s.best}` : ''}</span></td>
      <td class="num">${s.races}</td>
      <td class="num total">${s.wins}</td>
      <td class="num">${s.podiums}</td>
      <td class="num">${s.poles}</td>
      <td class="num">${s.fastest}</td>
      <td class="num">${s.dnf}</td>
      <td class="num">${s.avg == null ? '—' : s.avg.toFixed(1).replace('.', ',')}</td>
    </tr>`).join('');

  const rec = trackRecords().map((r) => `<tr>
      <td>${esc(r.track)}</td>
      <td>${plink(r.driver)}<span class="sub">${esc(r.car)} · ${fmtDate(r.date)}</span></td>
      <td class="num best-lap">${fmtLap(r.time)}</td></tr>`).join('');

  return `
    <section class="pro-head"><h1>Palmarès</h1><p>Victoires, podiums, poles et meilleurs tours depuis la première course du serveur.</p></section>
    <h2>Les pilotes</h2>
    <div class="scroll"><table>
      <thead><tr><th>Pilote</th><th class="num">Courses</th><th class="num">Victoires</th><th class="num">Podiums</th><th class="num">Poles</th><th class="num">Meilleurs tours</th><th class="num">Abandons</th><th class="num">Place moy.</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h2>Records du circuit</h2>
    <div class="scroll"><table>
      <thead><tr><th>Circuit</th><th>Pilote</th><th class="num">Temps</th></tr></thead>
      <tbody>${rec}</tbody></table></div>`;
}

function viewPilotes() {
  const cur = HIST.at(-1).st;
  const ids = Object.keys(DRV).sort((a, b) => {
    const ra = cur.find((r) => r.id === a)?.rank ?? 1e6, rb = cur.find((r) => r.id === b)?.rank ?? 1e6;
    return ra - rb || nm(a).localeCompare(nm(b), 'fr');
  });
  const rows = ids.map((id) => {
    const r = cur.find((x) => x.id === id);
    const s = careerStats(id);
    return `<tr><td class="rank">${r ? r.rank : '—'}</td><td>${plink(id)}</td><td>${catChip(DRV[id].category)}</td>
      <td class="num">${s.races}</td><td class="num">${s.wins}</td><td class="num">${s.podiums}</td>
      <td class="num total">${r ? nf.format(r.total) : '—'}</td></tr>`;
  }).join('');
  return `
    <section class="pro-head"><h1>Pilotes</h1><p>Ouvrez une fiche pour voir les statistiques, les résultats et les meilleurs tours de chacun.</p></section>
    <div class="scroll" style="margin-top:24px"><table>
      <thead><tr><th>Rang</th><th>Pilote</th><th>Catégorie</th><th class="num">Courses</th><th class="num">Victoires</th><th class="num">Podiums</th><th class="num">Points</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function viewFace(a, b) {
  const cur = HIST.at(-1).st;
  if (!DRV[a]) a = cur[0]?.id;
  if (!DRV[b] || b === a) b = cur.find((r) => r.id !== a)?.id;
  if (!a || !b) return notFound('Il faut au moins deux pilotes.');

  const common = [];
  for (const r of DB.races) {
    const x = r.results.find((z) => z.driver === a), y = r.results.find((z) => z.driver === b);
    if (x && y) common.push({ r, x, y });
  }
  const score = (z) => (z.status === 'FIN' ? z.pos : 1000 + z.pos);
  let aw = 0, bw = 0;
  for (const { x, y } of common) { if (score(x) < score(y)) aw++; else if (score(y) < score(x)) bw++; }
  const avg = (key) => {
    const v = common.map((c) => c[key]).filter((z) => z.status === 'FIN').map((z) => z.pos);
    return v.length ? (v.reduce((p, q) => p + q, 0) / v.length).toFixed(1).replace('.', ',') : '—';
  };
  const ra = cur.find((r) => r.id === a), rb = cur.find((r) => r.id === b);
  const la = bestLaps(a), lb = bestLaps(b);
  const lapRows = [...la.keys()].filter((k) => lb.has(k)).map((k) => {
    const x = la.get(k), y = lb.get(k);
    const diff = x.time - y.time;
    return `<tr><td>${esc(x.track)}</td>
      <td class="num ${diff <= 0 ? 'best-lap' : ''}">${fmtLap(x.time)}</td>
      <td class="num ${diff >= 0 ? 'best-lap' : ''}">${fmtLap(y.time)}</td>
      <td class="num muted">${diff === 0 ? '=' : (diff < 0 ? '−' : '+') + (Math.abs(diff) / 1000).toFixed(3)}</td></tr>`;
  }).join('');
  const total = aw + bw || 1;
  const opts = (sel) => Object.values(DRV).sort((p, q) => p.name.localeCompare(q.name, 'fr'))
    .map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

  const races = [...common].reverse().map(({ r, x, y }) => `<tr>
      <td class="nowrap">${fmtDate(r.date)}</td><td>${esc(r.track)}</td>
      <td class="num ${score(x) < score(y) ? 'win-cell' : ''}">${x.status === 'FIN' ? x.pos : 'Ab.'}</td>
      <td class="num ${score(y) < score(x) ? 'win-cell' : ''}">${y.status === 'FIN' ? y.pos : 'Ab.'}</td></tr>`).join('');

  return `
    <section class="pro-head"><h1>Face-à-face</h1></section>
    <div class="selects">
      <select id="fa-a" aria-label="Premier pilote">${opts(a)}</select>
      <span class="muted">contre</span>
      <select id="fa-b" aria-label="Second pilote">${opts(b)}</select>
    </div>
    <div class="vs">
      <div class="side"><strong>${esc(nm(a))}</strong>${ra ? `${ra.rank}${ra.rank === 1 ? 'er' : 'e'} · ${nf.format(ra.total)} pts` : 'Non classé'}</div>
      <div class="mid">VS</div>
      <div class="side right"><strong>${esc(nm(b))}</strong>${rb ? `${rb.rank}${rb.rank === 1 ? 'er' : 'e'} · ${nf.format(rb.total)} pts` : 'Non classé'}</div>
    </div>
    <p class="lede">${common.length ? `Sur ${common.length} course${common.length > 1 ? 's' : ''} disputée${common.length > 1 ? 's' : ''} ensemble, qui termine devant l'autre ?` : 'Ces deux pilotes n’ont encore jamais couru ensemble.'}</p>
    ${common.length ? `
    <div class="duel-bar" role="img" aria-label="${aw} contre ${bw}"><i style="width:${(100 * aw / total).toFixed(1)}%"></i><i style="width:${(100 * bw / total).toFixed(1)}%"></i></div>
    <div class="duel-legend"><span>${esc(nm(a))} : ${aw}</span><span>${esc(nm(b))} : ${bw}</span></div>
    <p class="muted">Place moyenne : ${esc(nm(a))} ${avg('x')} · ${esc(nm(b))} ${avg('y')}</p>
    <div class="grid-2">
      <div><h2>Course par course</h2><div class="scroll"><table>
        <thead><tr><th>Date</th><th>Circuit</th><th class="num">${esc(nm(a))}</th><th class="num">${esc(nm(b))}</th></tr></thead>
        <tbody>${races}</tbody></table></div></div>
      <div><h2>Meilleurs tours</h2><div class="scroll"><table>
        <thead><tr><th>Circuit</th><th class="num">${esc(nm(a))}</th><th class="num">${esc(nm(b))}</th><th class="num">Écart</th></tr></thead>
        <tbody>${lapRows || '<tr><td colspan="4" class="empty">Aucun circuit en commun.</td></tr>'}</tbody></table></div></div>
    </div>` : ''}`;
}

function baremeBlock() {
  const sc = DB.scoring, L = sc.levels, base = sc.baseScale;
  const range = (m, from, to) => {
    const a = Math.round(base[from - 1] * m), b = Math.round(base[Math.min(to, base.length) - 1] * m);
    return `${nf.format(a)} à ${nf.format(b)}`;
  };
  const rows = Object.values(L).map((l) => {
    const m = l.multiplier;
    return `<tr><td><strong>${esc(l.label)}</strong><span class="sub">${esc(l.description || '')}</span></td>
      <td class="num total">${nf.format(Math.round(base[0] * m))}</td>
      <td class="num">${nf.format(Math.round(base[1] * m))}</td>
      <td class="num">${nf.format(Math.round(base[2] * m))}</td>
      <td class="num">${range(m, 4, 10)}</td>
      <td class="num">${base.length >= 20 ? range(m, 11, 20) : '—'}</td>
      <td class="num">${nf.format(Math.round(sc.beyond * m))}</td></tr>`;
  }).join('');
  const endu = DB.meta.enduranceMultiplier && DB.meta.enduranceMinMinutes
    ? `<div><h3>Endurance</h3><p>Une course de ${DB.meta.enduranceMinMinutes} minutes ou plus compte ${String(DB.meta.enduranceMultiplier).replace('.', ',')} fois.</p></div>` : '';
  return `
    <h2 id="bareme">Le barème</h2>
    <div class="scroll"><table>
      <thead><tr><th>Niveau</th><th class="num">1er</th><th class="num">2e</th><th class="num">3e</th><th class="num">4e à 10e</th><th class="num">11e à 20e</th><th class="num">Au-delà</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="rules">
      <div><h3>${DB.meta.windowYears} ans glissants</h3><p>Un résultat compte ${DB.meta.windowYears} ans, jour pour jour, puis sort du classement.</p></div>
      <div><h3>Chaque course compte</h3><p>Les points s'additionnent, sans plafond, sur toutes les courses du serveur.</p></div>
      <div><h3>Classement scratch</h3><p>La place à l'arrivée, toutes catégories confondues. Un abandon ne rapporte rien.</p></div>
      ${endu}
      <div><h3>Égalité</h3><p>À points égaux, le nombre de victoires départage, puis celui des podiums.</p></div>
    </div>`;
}

function notFound(msg) {
  return `<div class="notice"><h2>${esc(msg)}</h2><p><a href="#/ranking">Retour au classement</a></p></div>`;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */
const NAV = [
  ['ranking', 'Ranking'], ['courses', 'Course par course'], ['palmares', 'Palmarès'], ['pilotes', 'Pilotes'], ['face-a-face', 'Face-à-face'], ['championnat', 'Championnat'],
];

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [view = 'ranking', a, b] = parts;
  let html, title = DB.meta.serverName;
  switch (view) {
    case 'ranking': html = viewRanking(a); title = `Ranking · ${title}`; break;
    case 'courses': html = viewCourses(a); title = `Course par course · ${title}`; break;
    case 'palmares': html = viewPalmares(); title = `Palmarès · ${title}`; break;
    case 'pilotes': html = viewPilotes(); title = `Pilotes · ${title}`; break;
    case 'pilote': html = viewDriver(a); title = `${nm(a)} · ${title}`; break;
    case 'face-a-face': html = viewFace(a, b); title = `Face-à-face · ${title}`; break;
    case 'championnat':
      html = '<p class="loading">Chargement du championnat…</p>';
      title = `Championnat · ${title}`;
      if (window.Championnat) {
        const hash = location.hash;
        window.Championnat.render(a, b).then((h) => { if (location.hash === hash) { $('#app').innerHTML = h; window.scrollTo(0, 0); } });
      }
      break;
    default: html = notFound('Page introuvable');
  }
  $('#app').innerHTML = html;
  document.title = title;
  const section = view === 'pilote' ? 'pilotes' : view;
  $('#nav').innerHTML = NAV.map(([k, label]) =>
    `<a href="#/${k}" ${k === section ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  window.scrollTo(0, 0);
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'race-pick') location.hash = `#/courses/${encodeURIComponent(t.value)}`;
  else if (t.id === 'vs-pick' && t.value) location.hash = `#/face-a-face/${encodeURIComponent(t.dataset.vs)}/${encodeURIComponent(t.value)}`;
  else if (t.id === 'fa-a' || t.id === 'fa-b') {
    location.hash = `#/face-a-face/${encodeURIComponent($('#fa-a').value)}/${encodeURIComponent($('#fa-b').value)}`;
  }
});

async function init() {
  try {
    const res = await fetch('data/ranking.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    DB = await res.json();
    if (!DB.races?.length) throw new Error('vide');
  } catch (err) {
    $('#app').innerHTML = `<div class="notice"><h2>Données introuvables</h2>
      <p>La page charge <code>data/ranking.json</code>. Générez-le avec <code>build_ranking.py</code> et ouvrez la page via un serveur web (par exemple <code>python3 -m http.server</code> dans ce dossier), pas en double-cliquant sur le fichier.</p></div>`;
    return;
  }
  prepare();
  $('#brand').textContent = DB.meta.serverName;
  $('#foot-text').textContent = `${DB.meta.serverName} · ${DB.meta.simulator} · mis à jour le ${fmtDate(DB.meta.generatedAt)}`;
  window.addEventListener('hashchange', route);
  route();
}

init();
})();

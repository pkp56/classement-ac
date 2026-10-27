/* sessions.js - à charger APRÈS le script principal de index.html.
   Corrige l'import : les JSON de course / qualification / championnat ne sont plus
   pris pour de simples logs de collisions. */
(function () {
  const typeLabel = t => /RACE/.test(t) ? 'Course' : /QUALIF/.test(t) ? 'Qualification' : /PRACT/.test(t) ? 'Essais' : (t || 'Session');
  const fmt = ms => { ms = Number(ms); if (!ms || ms <= 0 || ms >= 3600000) return '—'; const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); };
  const gap = (ms, ref) => { ms = Number(ms); ref = Number(ref); return ms > 0 && ref > 0 && ms < 3600000 && ms > ref ? '+' + ((ms - ref) / 1000).toFixed(3) + ' s' : '—'; };
  const msg = t => { $('adminMessage').textContent = t; };
  const when = s => { const d = new Date(s); return s && !isNaN(d) ? ' · ' + d.toLocaleDateString('fr-FR') : ''; };

  // Lit un fichier de résultats du serveur AC : Result + Laps + Events
  function parseSession(d) {
    const type = String(d.Type || d.SessionType || '').toUpperCase();
    const laps = Array.isArray(d.Laps) ? d.Laps : [];
    const evAll = Array.isArray(d.Events) ? d.Events.filter(e => e && (e.Type || e.type)) : [];
    const nm = v => String(v && typeof v === 'object' ? (v.Name || v.Guid) : (v || '')).trim();
    const results = (d.Result || []).map((r, i) => {
      const name = r.DriverName || (r.Driver && r.Driver.Name) || 'Inconnu';
      const mine = laps.filter(l => (l.DriverGuid && l.DriverGuid === r.DriverGuid) || l.DriverName === name);
      const t = mine.map(l => Number(l.LapTime)).filter(x => x > 0 && x < 3600000);
      const clean = t.filter(x => x <= Math.min(...t) * 1.07);
      let cons = null;
      if (clean.length > 2) { const m = clean.reduce((a, b) => a + b, 0) / clean.length; cons = Math.sqrt(clean.reduce((a, b) => a + (b - m) ** 2, 0) / clean.length) / m * 100; }
      // Les événements de collision ne sont pas exploités ni conservés.
      const b = Number(r.BestLap) || 0;
      return { pos: i + 1, name, guid: r.DriverGuid || '', car: r.CarModel || '—', best: b > 0 && b < 3600000 ? b : 0, total: Number(r.TotalTime) || 0, laps: mine.length, dsq: !!(r.Disqualified || r.IsDisqualified), consistency: cons, contacts: 0, envHits: 0 };
    });
    // Les événements (collisions, contacts, sorties) ne sont pas conservés dans les sessions importées.
    const eventName = d.EventName || (d.SessionConfig && d.SessionConfig.name) || '';
    const durationMinutes = Number((d.SessionConfig && (d.SessionConfig.time || d.SessionConfig.duration)) || d.DurationMinutes || 0);
    return { id: [d.ChampionshipID || '', eventName, d.Date || d.Timestamp || '', d.TrackName || '', type].join('|'), type, track: [d.TrackName, d.TrackConfig].filter(Boolean).join(' · ') || 'Piste inconnue', eventName, date: d.Date || '', durationMinutes, results, events: [] };
  }

  const table = (s, race) => '<div class="message">' + esc(typeLabel(s.type) + ' · ' + s.track) + ' · ' + s.results.length + ' pilotes' + '</div><div class="table-wrap"><table><thead><tr><th>Pos.</th><th>Pilote</th><th>Voiture</th>' + (race ? '<th>Tours</th><th>Temps total</th><th>Écart</th>' : '') + '<th>Meilleur tour</th>' + (race ? '' : '<th>Écart</th>') + '</tr></thead><tbody>' +
    s.results.map(r => '<tr><td class="rank">' + r.pos + '</td><td><b>' + esc(r.name) + '</b>' + (r.dsq ? ' <span class="tag">DSQ</span>' : '') + '</td><td>' + esc(r.car) + '</td>' + (race ? '<td>' + r.laps + '</td><td>' + fmt(r.total) + '</td><td>' + gap(r.total, s.results[0].total) + '</td>' : '') + '<td class="points">' + fmt(r.best) + '</td>' + (race ? '' : '<td>' + gap(r.best, s.results[0].best) + '</td>') + '</tr>').join('') + '</tbody></table></div>';

  const sessionLabel = (s, index, group) => {
    if (/QUALIF/.test(s.type)) return 'Qualification';
    if (/RACE/.test(s.type)) {
      const races = group.filter(x => /RACE/.test(x.type)).sort((a,b) => String(a.date).localeCompare(String(b.date)));
      const raceIndex = races.indexOf(s) + 1;
      return (s.durationMinutes >= 50 ? 'Course unique · 60 min' : 'Course ' + raceIndex + ' · 25 min');
    }
    return typeLabel(s.type);
  };

  function currentGroup() {
    const groups = groupSessions();
    return groups[Number($('raceSelect').value)] || [];
  }

  function groupSessions() {
    const list = (db && db.sessions) || [];
    const map = new Map();
    list.forEach(s => {
      const key = String(s.eventName || s.track || 'Manche sans nom').trim();
      if (!map.has(key)) map.set(key, { key, label: key, sessions: [] });
      map.get(key).sessions.push(s);
    });
    return [...map.values()].map(g => {
      g.sessions.sort((a,b) => {
        const order = s => /QUALIF/.test(s.type) ? 0 : /RACE/.test(s.type) ? 1 : 2;
        return order(a)-order(b) || String(a.date).localeCompare(String(b.date));
      });
      return g;
    }).sort((a,b) => {
      const first = g => g.sessions.map(s=>s.date).filter(Boolean).sort()[0] || '';
      return first(a).localeCompare(first(b)) || a.label.localeCompare(b.label,'fr');
    });
  }

  function showSession() {
    const group = currentGroup();
    const sel = $('sessionSelect');
    const s = group[Number(sel.value)] || group[0];
    if (!s) {
      $('sessionDetail').innerHTML = '<div class="empty">Aucune session importée pour cette manche. Importez les JSON de qualification et de course depuis l’administration.</div>';
      return;
    }
    const isRace = /RACE/.test(s.type);
    $('sessionDetail').innerHTML = '<div class="message"><b>' + esc(sessionLabel(s, Number(sel.value), group)) + '</b> · ' + esc(s.track) + when(s.date) + ' · ' + s.results.length + ' pilotes</div>' + table(s, isRace);
    if (s.events && s.events.length) { incidentData = normIncidents(s.events); renderIncidentTools(); }
  }

  function renderSessions() {
    const eventSel = $('raceSelect'), sessionSel = $('sessionSelect'), groups = groupSessions();
    const previousGroup = eventSel.value;
    const previousSession = sessionSel.value;
    eventSel.innerHTML = groups.length ? groups.map((g,i) => '<option value="' + i + '">' + esc(g.label) + '</option>').join('') : '<option value="">Aucune manche importée</option>';
    if (previousGroup && groups[Number(previousGroup)]) eventSel.value = previousGroup;
    const group = currentGroup();
    sessionSel.innerHTML = group.length ? group.map((s,i) => '<option value="' + i + '">' + esc(sessionLabel(s,i,group)) + '</option>').join('') : '<option value="">Aucune session</option>';
    if (previousSession && group[Number(previousSession)]) sessionSel.value = previousSession;
    showSession();
  }

  function clearDerived() {
    if (!db) db = { drivers: {}, standings: [], sessions: [], meta: {} };
    db.drivers = {};
    db.standings = [];
    db.standingsDropWorst = [];
    db.teamStandings = [];
    db.teamStandingsDropWorst = [];
    db.meritStandings = [];
    db.races = [];
    db.auto = true;
    db.meta = Object.assign({}, db.meta, {
      eventsCompleted: 0, races: 0, drivers: 0,
      updated: new Date().toISOString(),
      source: 'sessions',
      message: 'Aucun résultat : importez les JSON de qualification et de course.'
    });
    normalizeData(db);
  }

  function refreshDerived() {
    const list = (db && db.sessions) || [];
    if (list.some(s => /RACE/.test(String(s.type)) && !/QUALIF/.test(String(s.type)))) rebuild();
    else clearDerived();
  }

  // Barème GDSP : 30, 26, 23, 21, 20, 19 puis -1 par place jusqu'à P24.
  const POINTS = [30, 26, 23, 21, 20, 19, ...Array.from({length:18}, (_,i)=>18-i)];
  const racePoints = (pos, duration) => (pos >= 1 && pos <= 24 ? POINTS[pos-1] : 0) * (duration >= 50 ? 2 : 1);

  // Reconstruit classement + fiches pilotes à partir des courses importées
  function rebuild() {
    const races = (db.sessions || []).filter(s => /RACE/.test(s.type) && !/QUALIF/.test(s.type)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const dr = {}, st = {};
    db.races = [];
    races.forEach((s, n) => {
      const key = 'm' + (n + 1) + '-race', rr = [];
      s.results.forEach((r, i) => {
        const id = r.guid || r.name;
        dr[id] = dr[id] || { name: r.name, team: '' };
        const e = st[id] = st[id] || { driver: id, points: 0, wins: 0, podiums: 0, races: 0, byRace: {} };
        const pts = r.dsq ? 0 : racePoints(i + 1, s.durationMinutes);
        e.points += pts; e.races++; e.byRace[key] = pts;
        if (i === 0 && !r.dsq) e.wins++;
        if (i < 3 && !r.dsq) e.podiums++;
        rr.push({ driver: id, pos: i + 1, status: r.dsq ? 'DSQ' : 'FIN', grid: r.grid || i + 1, laps: r.laps, bestLap: r.best, points: pts, racePoints: pts, meritPoints: 0, consistency: r.consistency, contacts: 0, envHits: 0 });
      });
      db.races.push({ id: key, event: n + 1, eventName: s.eventName || s.track, session: 'RACE', raceNo: n + 1, durationMinutes: s.durationMinutes || 25, results: rr });
    });
    db.drivers = dr;
    db.standings = Object.values(st);
    db.meta = Object.assign({}, db.meta, { eventsCompleted: new Set(races.map(s => s.eventName || s.track)).size, races: races.length, drivers: Object.keys(dr).length, updated: new Date().toISOString(), scoringRules: { race25: POINTS, race60Multiplier: 2, pole25: 1, pole60: 2, officialUsesAllRounds: true } });
    db.auto = true;
    normalizeData(db);
  }

  async function save() {
    const r = await fetch('/api/save-championship', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken }, body: JSON.stringify(db) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Erreur HTTP ' + r.status);
  }

  async function smartImport() {
    if (!adminToken) return msg('Connexion administrateur requise pour importer un JSON.');
    const f = $('importFile').files[0];
    if (!f) return msg('Choisissez d’abord un fichier JSON.');
    try {
      const d = JSON.parse(await f.text());
      let text;
      if (d && d.drivers && Array.isArray(d.standings)) {            // championnat (format du site)
        // Un ancien JSON de classement ne doit jamais être la source des résultats.
        // On ne garde que les sessions déjà importées, puis on reconstruit les données dérivées.
        d.sessions = (db && db.sessions) || d.sessions || [];
        db = d;
        refreshDerived();
        text = 'Fichier championnat reçu : les classements ont été reconstruits à partir des sessions de course et de qualification importées.';
      } else if (d && (Array.isArray(d.Result) || Array.isArray(d.Laps))) { // course / qualification AC
        const s = parseSession(d);
        if (!s.results.length) throw new Error('Aucun résultat dans cette session.');
        if (!db) normalizeData({ drivers: {}, standings: [], meta: {}, sessions: [] });
        db.sessions = (db.sessions || []).filter(x => x.id !== s.id).concat(s);
        refreshDerived();
        text = typeLabel(s.type) + ' importée : ' + s.results.length + ' pilotes. Les classements et fiches sont calculés uniquement depuis les sessions importées.';
      } else if (d && Array.isArray(d.Classes)) {
        throw new Error('Export Server Manager détecté : convertissez-le d’abord avec build_championship.py, puis importez data/championship.json.');
      } else {                                                       // simple log de collisions
        incidentData = normIncidents(d);
        localStorage.setItem(incidentStoreKey, JSON.stringify(incidentData.map(x => x.raw)));
        renderIncidentTools();
        return msg('Logs de collisions importés : ' + incidentData.length + ' (stockés dans ce navigateur).');
      }
      renderAll();
      await save();
      msg(text + ' Sauvegardé sur le serveur et publié sur GitHub si GITHUB_TOKEN est configuré.');
    } catch (e) { msg('Import impossible : ' + e.message); loadData(); }
  }

  // Deux sélecteurs cohérents : manche, puis séance (qualification/course).
  document.querySelector('.race-tabs').insertAdjacentHTML('beforebegin', '<div class="toolbar" style="margin-top:16px"><label for="sessionSelect" class="muted">Séance</label><select id="sessionSelect" aria-label="Choisir qualification ou course"></select></div><div id="sessionDetail" style="margin-top:16px"></div>');
  $('raceSelect').addEventListener('change', renderSessions);
  $('sessionSelect').addEventListener('change', showSession);
  const old = $('importBtn'), btn = old.cloneNode(true);
  old.replaceWith(btn);
  btn.addEventListener('click', smartImport);
  const baseRenderAll = renderAll;
  renderAll = function () {
    if (db) refreshDerived();
    baseRenderAll();
    renderSessions();
  };
  renderSessions();
})();

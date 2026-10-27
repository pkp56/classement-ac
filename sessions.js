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
      const mineEv = evAll.filter(e => nm(e.Driver || e.driver) === name);
      const b = Number(r.BestLap) || 0;
      return { pos: i + 1, name, guid: r.DriverGuid || '', car: r.CarModel || '—', best: b > 0 && b < 3600000 ? b : 0, total: Number(r.TotalTime) || 0, laps: mine.length, dsq: !!(r.Disqualified || r.IsDisqualified), consistency: cons, contacts: mineEv.filter(e => /CAR/.test(e.Type || e.type)).length, envHits: mineEv.filter(e => /ENV/.test(e.Type || e.type)).length };
    });
    const events = /QUALIF|PRACT/.test(type) ? [] : evAll; // pas de collisions pour les qualifs
    return { id: [d.Date || d.Timestamp || '', d.TrackName || '', type, results.length].join('|'), type, track: [d.TrackName, d.TrackConfig].filter(Boolean).join(' · ') || 'Piste inconnue', date: d.Date || '', results, events };
  }

  const table = (s, race) => '<div class="message">' + esc(typeLabel(s.type) + ' · ' + s.track) + ' · ' + s.results.length + ' pilotes' + (s.events.length ? ' · ' + s.events.length + ' incident(s)' : '') + '</div><div class="table-wrap"><table><thead><tr><th>Pos.</th><th>Pilote</th><th>Voiture</th>' + (race ? '<th>Tours</th><th>Temps total</th><th>Écart</th>' : '') + '<th>Meilleur tour</th>' + (race ? '' : '<th>Écart</th>') + '</tr></thead><tbody>' +
    s.results.map(r => '<tr><td class="rank">' + r.pos + '</td><td><b>' + esc(r.name) + '</b>' + (r.dsq ? ' <span class="tag">DSQ</span>' : '') + '</td><td>' + esc(r.car) + '</td>' + (race ? '<td>' + r.laps + '</td><td>' + fmt(r.total) + '</td><td>' + gap(r.total, s.results[0].total) + '</td>' : '') + '<td class="points">' + fmt(r.best) + '</td>' + (race ? '' : '<td>' + gap(r.best, s.results[0].best) + '</td>') + '</tr>').join('') + '</tbody></table></div>';

  function showSession() {
    const list = (db && db.sessions) || [];
    const s = list[$('sessionSelect').value];
    const isRace = s && /RACE/.test(s.type);
    $('sessRace').innerHTML = s && isRace ? table(s, true) : '';
    $('sessQualif').innerHTML = s && !isRace ? table(s, false) : '<div class="message">Importez le JSON de résultats d’une qualification (fichier du serveur AC) depuis l’administration, puis choisissez-la dans la liste des sessions.</div>';
    if (s && isRace && s.events.length) { incidentData = normIncidents(s.events); renderIncidentTools(); }
  }

  function renderSessions() {
    const sel = $('sessionSelect'), list = (db && db.sessions) || [], prev = sel.value;
    sel.innerHTML = list.length ? list.map((s, i) => '<option value="' + i + '">' + esc(typeLabel(s.type) + ' · ' + s.track + when(s.date)) + '</option>').join('') : '<option value="">Aucune session importée</option>';
    if (prev && list[prev]) sel.value = prev;
    showSession();
  }

  // Barème des points par place (à adapter à ton championnat)
  const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

  // Reconstruit classement + fiches pilotes à partir des courses importées
  function rebuild() {
    const races = (db.sessions || []).filter(s => /RACE/.test(s.type)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const dr = {}, st = {};
    db.races = [];
    races.forEach((s, n) => {
      const key = 'm' + (n + 1) + '-race', rr = [];
      s.results.forEach((r, i) => {
        const id = r.guid || r.name;
        dr[id] = dr[id] || { name: r.name, team: '' };
        const e = st[id] = st[id] || { driver: id, points: 0, wins: 0, podiums: 0, races: 0, byRace: {} };
        const pts = r.dsq ? 0 : (POINTS[i] || 0);
        e.points += pts; e.races++; e.byRace[key] = pts;
        if (i === 0 && !r.dsq) e.wins++;
        if (i < 3 && !r.dsq) e.podiums++;
        rr.push({ driver: id, bestLap: r.best, consistency: r.consistency, contacts: r.contacts, envHits: r.envHits });
      });
      db.races.push({ eventName: s.track, raceNo: n + 1, results: rr });
    });
    db.drivers = dr;
    db.standings = Object.values(st);
    db.meta = Object.assign({}, db.meta, { eventsCompleted: races.length, updated: new Date().toISOString() });
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
        d.sessions = d.sessions || (db && db.sessions) || [];
        normalizeData(d);
        text = 'Championnat importé (' + d.standings.length + ' pilotes).';
      } else if (d && (Array.isArray(d.Result) || Array.isArray(d.Laps))) { // course / qualification AC
        const s = parseSession(d);
        if (!s.results.length) throw new Error('Aucun résultat dans cette session.');
        if (!db) normalizeData({ drivers: {}, standings: [], meta: {}, sessions: [] });
        db.sessions = (db.sessions || []).filter(x => x.id !== s.id).concat(s);
        if (db.auto || !(db.standings || []).length) rebuild(); // classement calculé depuis les courses
        text = typeLabel(s.type) + ' importée : ' + s.results.length + ' pilotes, ' + s.events.length + ' incident(s).';
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
      msg(text + ' Sauvegardé sur le serveur.');
    } catch (e) { msg('Import impossible : ' + e.message); loadData(); }
  }

  // Branchement sur la page
  document.querySelector('.race-tabs').insertAdjacentHTML('beforebegin', '<div class="toolbar" style="margin-top:16px"><select id="sessionSelect" aria-label="Session importée"></select></div>');
  $('raceCoursePanel').insertAdjacentHTML('beforeend', '<div id="sessRace"></div>');
  $('raceQualifPanel').innerHTML = '<div id="sessQualif"></div>';
  $('sessionSelect').addEventListener('change', showSession);
  const old = $('importBtn'), btn = old.cloneNode(true);
  old.replaceWith(btn);
  btn.addEventListener('click', smartImport);
  const baseRenderAll = renderAll;
  renderAll = function () { baseRenderAll(); renderSessions(); };
  renderSessions();
})();

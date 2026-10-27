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
    const normalizeName = value => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').trim().replace(/\\s+/g, ' ').toLocaleLowerCase('fr');
    const person = value => value && typeof value === 'object' ? value : {};
    const cars = Array.isArray(d.Cars) ? d.Cars : [];
    const byGuid = new Map(), byCar = new Map(), byName = new Map();
    const remember = (driver, carId) => {
      const v = person(driver), name = String(v.Name || v.DriverName || '').trim();
      const guid = String(v.Guid || v.DriverGuid || '').trim();
      const team = String(v.TeamName || v.Team || v.TeamShortName || '').trim();
      if (guid) byGuid.set(guid, { name, team });
      if (name) byName.set(normalizeName(name), { name, team, guid });
      if (carId !== undefined && carId !== null) byCar.set(String(carId), { name, team, guid });
    };
    cars.forEach(c => remember(c.Driver || c, c.CarId));
    (Array.isArray(d.Entrants) ? d.Entrants : []).forEach(e => remember(e.Driver || e, e.CarId));
    const resultRows = Array.isArray(d.Result) ? d.Result : [];
    resultRows.forEach(r => remember(r.Driver || { Name: r.DriverName, Guid: r.DriverGuid, Team: r.Team || r.TeamName }, r.CarId));
    const results = resultRows.map((r, i) => {
      const guid = String(r.DriverGuid || person(r.Driver).Guid || '').trim();
      const name = String(r.DriverName || person(r.Driver).Name || byGuid.get(guid)?.name || 'Inconnu').trim();
      const carDriver = byGuid.get(guid) || byName.get(normalizeName(name)) || byCar.get(String(r.CarId)) || {};
      const previous = (db && db.drivers && (db.drivers[guid] || Object.values(db.drivers).find(x => normalizeName(x.name) === normalizeName(name)))) || {};
      const team = String(r.TeamName || r.Team || person(r.Driver).TeamName || person(r.Driver).Team || carDriver.team || previous.team || '').trim();
      const mine = laps.filter(l => (l.DriverGuid && l.DriverGuid === guid) || normalizeName(l.DriverName || person(l.Driver).Name) === normalizeName(name));
      const t = mine.map(l => Number(l.LapTime)).filter(x => x > 0 && x < 3600000);
      const clean = t.length ? t.filter(x => x <= Math.min(...t) * 1.07) : [];
      let cons = null;
      if (clean.length > 2) { const m = clean.reduce((a, b) => a + b, 0) / clean.length; cons = Math.sqrt(clean.reduce((a, b) => a + (b - m) ** 2, 0) / clean.length) / m * 100; }
      const b = Number(r.BestLap) || 0;
      return { pos: i + 1, name, guid, team, car: r.CarModel || r.Car || '—', best: b > 0 && b < 3600000 ? b : 0, total: Number(r.TotalTime) || 0, laps: mine.length || Number(r.NumLaps) || 0, dsq: !!(r.Disqualified || r.IsDisqualified), consistency: cons, contacts: 0, envHits: 0 };
    });
    // Conserver uniquement les vitesses et les noms nécessaires aux statistiques : aucun GUID n'est exporté ici.
    const speedStats = [];
    evAll.forEach(ev => {
      const speed = Number(ev.ImpactSpeed ?? ev.impactSpeed ?? ev.impact_speed ?? 0);
      if (!(speed > 0) || ev.AfterSessionEnd) return;
      const driverRaw = person(ev.Driver), otherRaw = person(ev.OtherDriver);
      const driver = String(driverRaw.Name || (typeof ev.Driver === 'string' ? ev.Driver : '') || byCar.get(String(ev.CarId))?.name || '').trim();
      const otherDriver = String(otherRaw.Name || (typeof ev.OtherDriver === 'string' ? ev.OtherDriver : '') || byCar.get(String(ev.OtherCarId))?.name || '').trim();
      if (!driver && !otherDriver) return;
      speedStats.push({ driver: driver || 'Inconnu', otherDriver: otherDriver || '—', speed, type: String(ev.Type || ev.type || 'EVENT'), timestamp: Number(ev.Timestamp || ev.timestamp || 0) });
    });
    const eventName = d.EventName || (d.SessionConfig && d.SessionConfig.name) || '';
    const durationMinutes = Number((d.SessionConfig && (d.SessionConfig.time || d.SessionConfig.duration)) || d.DurationMinutes || 0);
    return { id: [d.ChampionshipID || '', eventName, d.Date || d.Timestamp || '', d.TrackName || '', type].join('|'), type, track: [d.TrackName, d.TrackConfig].filter(Boolean).join(' · ') || 'Piste inconnue', eventName, date: d.Date || '', durationMinutes, results, speedStats, events: [] };
  }

  const table = (s, race) => '<div class="message">' + esc(typeLabel(s.type) + ' · ' + s.track) + ' · ' + s.results.length + ' pilotes' + '</div><div class="table-wrap"><table><thead><tr><th>Pos.</th><th>Pilote</th><th>Équipe</th><th>Voiture</th>' + (race ? '<th>Tours</th><th>Temps total</th><th>Écart</th>' : '') + '<th>Meilleur tour</th>' + (race ? '' : '<th>Écart</th>') + '</tr></thead><tbody>' +
    s.results.map(r => '<tr><td class="rank">' + r.pos + '</td><td><b>' + esc(r.name) + '</b>' + (r.dsq ? ' <span class="tag">DSQ</span>' : '') + '</td><td>' + esc(r.team || '—') + '</td><td>' + esc(r.car) + '</td>' + (race ? '<td>' + r.laps + '</td><td>' + fmt(r.total) + '</td><td>' + gap(r.total, s.results[0].total) + '</td>' : '') + '<td class="points">' + fmt(r.best) + '</td>' + (race ? '' : '<td>' + gap(r.best, s.results[0].best) + '</td>') + '</tr>').join('') + '</tbody></table></div>';

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
      const raw = String(s.eventName || s.track || 'Manche sans nom').trim();
      // Les exports peuvent nommer la même manche différemment selon la séance.
      // Regrouper d'abord par numéro de manche explicite, puis par nom si absent.
      const match = raw.match(/manche\\s*#?\\s*(\\d+)/i);
      const key = match ? 'round-' + Number(match[1]) : 'event-' + raw.toLocaleLowerCase('fr');
      if (!map.has(key)) {
        map.set(key, { key, label: match ? 'Manche ' + Number(match[1]) : raw, sessions: [], eventNames: new Set() });
      }
      const group = map.get(key);
      group.sessions.push(s);
      group.eventNames.add(raw);
    });
    return [...map.values()].map(g => {
      g.sessions.sort((a,b) => {
        const order = s => /QUALIF/.test(String(s.type)) ? 0 : /RACE/.test(String(s.type)) ? 1 : 2;
        return order(a)-order(b) || String(a.date).localeCompare(String(b.date));
      });
      // Si le libellé contient une piste explicite, l'afficher en complément du numéro.
      if (g.key.startsWith('round-')) {
        const tracks = [...new Set(g.sessions.map(s => s.track).filter(Boolean))];
        if (tracks.length === 1) g.label += ' — ' + tracks[0];
      } else if (g.eventNames.size > 1) {
        g.label = [...g.eventNames][0];
      }
      delete g.eventNames;
      return g;
    }).sort((a,b) => {
      const round = g => Number((g.key.match(/^round-(\\d+)$/) || [])[1] || 0);
      if (round(a) && round(b)) return round(a)-round(b);
      if (round(a)) return -1;
      if (round(b)) return 1;
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
    // Garder les fiches pilotes et leurs équipes : seule la partie calculée est remise à zéro.
    db.drivers = (db.drivers && typeof db.drivers === 'object') ? db.drivers : {};
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
    const previousDrivers = (db && db.drivers) || {};
    db.races = [];
    races.forEach((s, n) => {
      const key = 'm' + (n + 1) + '-race', rr = [];
      s.results.forEach((r, i) => {
        const id = r.guid || r.name;
        const previous = previousDrivers[id] || {};
        dr[id] = dr[id] || { name: r.name, team: r.team || previous.team || '' };
        if (!dr[id].team && (r.team || previous.team)) dr[id].team = r.team || previous.team;
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
    if (!adminToken) return msg('Connexion administrateur requise pour importer des JSON.');
    const files = Array.from($('importFile').files || []);
    if (!files.length) return msg('Choisissez un ou plusieurs fichiers JSON.');
    const errors = [], imported = [], incidentFiles = [];
    try {
      for (const f of files) {
        try {
          const d = JSON.parse(await f.text());
          if (d && d.drivers && Array.isArray(d.standings)) {
            const importedSessions = Array.isArray(d.sessions) ? d.sessions : [];
            const currentSessions = (db && Array.isArray(db.sessions)) ? db.sessions : [];
            const oldDrivers = (db && db.drivers) || {};
            d.sessions = importedSessions.length ? importedSessions : currentSessions;
            d.drivers = d.drivers || {};
            Object.entries(oldDrivers).forEach(([id, driver]) => {
              if (d.drivers[id] && !d.drivers[id].team && driver && driver.team) d.drivers[id].team = driver.team;
            });
            db = d;
            imported.push(f.name + ' (championnat)');
          } else if (d && (Array.isArray(d.Result) || Array.isArray(d.Laps))) {
            const s = parseSession(d);
            if (!s.results.length) throw new Error('aucun résultat dans cette session');
            if (!db) normalizeData({ drivers: {}, standings: [], meta: {}, sessions: [] });
            db.sessions = (db.sessions || []).filter(x => x.id !== s.id).concat(s);
            imported.push(f.name + ' (' + typeLabel(s.type) + ', ' + s.results.length + ' pilotes)');
          } else if (d && Array.isArray(d.Classes) && Array.isArray(d.Entrants)) {
            // Import ciblé des équipes depuis un export Assetto Server Manager.
            // Ne touche ni aux résultats, ni aux séances, ni aux points.
            const entrants = d.Entrants.map(e => ({
              name: String(e.Name || e.DriverName || '').trim(),
              team: String(e.Team || e.TeamName || '').trim()
            })).filter(e => e.name && e.team);
            if (!entrants.length) throw new Error('aucun pilote avec une équipe renseignée dans Entrants');
            const normalizeName = value => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').trim().replace(/\\s+/g, ' ').toLocaleLowerCase('fr');
            const teamsByName = new Map(entrants.map(e => [normalizeName(e.name), e.team]));
            let matched = 0;
            const currentDrivers = (db && db.drivers) || {};
            Object.values(currentDrivers).forEach(driver => {
              const team = teamsByName.get(normalizeName(driver.name));
              if (team) { driver.team = team; matched++; }
            });
            // Conserve aussi l'équipe sur les résultats de séance afin qu'une reconstruction ultérieure la garde.
            ((db && db.sessions) || []).forEach(session => (session.results || []).forEach(result => {
              const team = teamsByName.get(normalizeName(result.name));
              if (team) result.team = team;
            }));
            if (!matched) throw new Error('aucun nom de pilote de l’export ne correspond aux pilotes du championnat actuel');
            db.meta = Object.assign({}, db.meta, { updated: new Date().toISOString() });
            await save();
            normalizeData(db);
            renderAll();
            imported.push(f.name + ' (équipes : ' + matched + ' pilotes mis à jour, résultats conservés)');
          } else if (d && Array.isArray(d.Classes)) {
            throw new Error('export Server Manager détecté : export Entrants manquant pour importer les équipes');
          } else {
            incidentFiles.push({ name: f.name, data: d });
          }
        } catch (e) {
          errors.push(f.name + ' : ' + e.message);
        }
      }
      if (imported.length) {
        // Réconcilier les équipes entre course et qualification, même si une seule source contient l'équipe.
        const normalizeTeamName = value => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').trim().replace(/\\s+/g, ' ').toLocaleLowerCase('fr');
        const teamsByGuid = new Map(), teamsByName = new Map();
        ((db && db.sessions) || []).forEach(session => (session.results || []).forEach(result => {
          if (!result.team) return;
          if (result.guid) teamsByGuid.set(result.guid, result.team);
          if (result.name) teamsByName.set(normalizeTeamName(result.name), result.team);
        }));
        ((db && db.sessions) || []).forEach(session => (session.results || []).forEach(result => {
          result.team = result.team || teamsByGuid.get(result.guid) || teamsByName.get(normalizeTeamName(result.name)) || '';
        }));
        Object.entries((db && db.drivers) || {}).forEach(([id, driver]) => {
          driver.team = driver.team || teamsByGuid.get(id) || teamsByName.get(normalizeTeamName(driver.name)) || '';
        });
        refreshDerived();
        renderAll();
        await save();
      }
      for (const item of incidentFiles) {
        incidentData = normIncidents(item.data);
        localStorage.setItem(incidentStoreKey, JSON.stringify(incidentData.map(x => x.raw)));
        renderIncidentTools();
        imported.push(item.name + ' (' + incidentData.length + ' incidents locaux)');
      }
      const summary = [];
      if (imported.length) summary.push(imported.length + ' fichier(s) traité(s) : ' + imported.join(' ; '));
      if (errors.length) summary.push('Erreurs : ' + errors.join(' | '));
      if (imported.length && imported.some(x => !x.includes('incidents locaux'))) summary.push('championnat sauvegardé sur le serveur');
      msg(summary.join('\n') || 'Aucun fichier reconnu.');
    } catch (e) {
      msg('Import impossible : ' + e.message);
      loadData();
    }
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

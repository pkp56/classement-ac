const {test} = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../assets/trueskill-gdsp');
const engine = require('../assets/trueskill-rating');

// Helpers conformes au contrat utilisé par site.js et mobile/profile-engine.js.
function makeHelpers() {
  const groupSessionsByDate = sessList => {
    const map = {};
    (sessList || []).filter(s => s && s.date).forEach(s => (map[String(s.date).slice(0, 10)] ??= []).push(s));
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0])).map(([date, sessions], idx) => ({ date, sessions, roundIndex: idx }));
  };
  // Version simplifiée de sortSessionForPerf : classe par comTimeAdd/dq/dnf/dns.
  const sortSessionForPerf = (session) => {
    const arr = (session.results || []).map(r => ({ ...r, comTimeAdd: 0, comDQ: false, comDNF: false, comDNS: false }));
    for (const k of Object.keys(session.penMap || {})) {
      const adj = session.penMap[k];
      const did = k.split(':')[2];
      const target = arr.find(x => x.id === did);
      if (!target || !adj) continue;
      if (adj.dq) target.comDQ = true;
      if (adj.dns) target.comDNS = true;
      if (adj.dnf) target.comDNF = true;
      if (typeof adj.timeAdd === 'number') target.comTimeAdd = adj.timeAdd * 1000;
    }
    const base = Number.isFinite(session._weight) ? session._weight : 1;
    arr.forEach(x => {
      x._t = Number.isFinite(x.time) && x.time > 0 ? x.time + (x.comTimeAdd || 0) : 1e18;
      if (x.disqualified || x.comDQ) x._dq = true;
      if (x.comDNF || (x.laps || 0) <= 0) x._t = 1e18;
    });
    arr.sort((a, b) => (a._dq ? 1 : 0) - (b._dq ? 1 : 0) || b.laps - a.laps || a._t - b._t);
    return arr;
  };
  const eventGlobalWeight = ev => {
    const raw = ev && ev.points_config && ev.points_config.globalCoef;
    if (raw !== undefined && raw !== '') { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : 1; }
    return ({ championship: 1, endurance: 1, cup: 0.75, open: 0.5, fiesta: 0, trackday: 0 })[ev && ev.kind] ?? 1;
  };
  const serviceOf = require('../assets/entrant-roles').serviceRole;
  return { groupSessionsByDate, sortSessionForPerf, eventGlobalWeight, serviceOf };
}

test('buildCourses : seules les RACE avec poids > 0 sont rejouées, avec les bons outcomes', () => {
  const helpers = makeHelpers();
  const mk = (extra) => ({ slug: 'cup', name: 'Cup', kind: 'cup', points_config: { globalCoef: 1 }, ...extra });
  const events = [
    mk({ slug: 'cup', name: 'Cup', data: { sessions: [
      { type: 'QUALIFY', date: '2026-05-01T20:00:00Z', results: [{ id: 'q1', name: 'Qualif Seule', laps: 3, time: 1e9 }], laps: [] },
      { type: 'RACE', date: '2026-05-01T21:00:00Z', track: 'spa', results: [
        { id: 'alice', name: 'Alice', laps: 10, time: 1000 },
        { id: 'bob', name: 'Bob', laps: 10, time: 1100 },
        { id: 'dq', name: 'DQ Brut', laps: 10, time: 900, disqualified: true },
        { id: 'dns', name: 'Absent', laps: 0, time: 0 },
        { id: 'pace', name: 'Broadcast', laps: 12, time: 500 }
      ], laps: [], penMap: { '0:1:dq': { dq: true } } }
    ], penMap: { '0:1:dq': { dq: true } } } }),
    mk({ slug: 'fiesta', name: 'Fiesta', kind: 'fiesta', points_config: { globalCoef: 0 }, data: { sessions: [
      { type: 'RACE', date: '2026-05-02T21:00:00Z', results: [{ id: 'x', name: 'X', laps: 5, time: 1000 }, { id: 'y', name: 'Y', laps: 5, time: 1100 }], laps: [] }
    ], penMap: {} } })
  ];
  const courses = adapter.buildCourses(events, helpers);
  assert.equal(courses.length, 1, 'la fiesta est exclue et les qualifs ignorées');
  const course = courses[0];
  assert.equal(course.globalWeight, 1);
  const byId = Object.fromEntries(course.entries.map(e => [e.id, e]));
  assert.equal(byId.alice.outcome, 'classified');
  assert.equal(byId.bob.outcome, 'classified');
  assert.equal(byId.dq.outcome, 'dq_sporting'); // DQ qualifiée par la Commission → classée en bas
  assert.equal(byId.dns, undefined, 'DNS sans ligne classable exclu de la course');
  assert.equal(byId.pace.outcome, 'service');
  assert.ok(course.entries.every(e => Number.isFinite(e.rank) && e.rank > 0));
});

test('buildCourses : DNF Commission et DQ non qualifiée sont exclus, DQ sportive classée en bas', () => {
  const helpers = makeHelpers();
  const session = { type: 'RACE', date: '2026-06-01T21:00:00Z', track: 'monza', results: [
    { id: 'a', name: 'A', laps: 8, time: 1000 },
    { id: 'b', name: 'B', laps: 8, time: 1100 },
    { id: 'c', name: 'C', laps: 3, time: 1200 },
    { id: 'd', name: 'D', laps: 8, time: 1050, disqualified: true }
  ], laps: [], penMap: { '0:0:c': { dnf: true } } };
  const course = adapter.buildCourses([
    { slug: 'cup', name: 'Cup', kind: 'cup', points_config: { globalCoef: 1 }, data: { sessions: [session], penMap: session.penMap } }
  ], helpers)[0];
  const byId = Object.fromEntries(course.entries.map(e => [e.id, e]));
  // c : DNF non qualifié (<75% / abandon) → exclu du classement sportif évalué
  assert.equal(byId.c.outcome, 'dnf_unqualified');
  // d : DQ Commission non qualifiée (pas d'entrée penMap dq) → exclu tant que non qualifiée
  assert.equal(byId.d.outcome, 'dq_unqualified');
  const replay = engine.replay([course], { beta: 5.5, minRaces: 1 });
  const ids = replay.all.map(r => r.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('buildCourses : service détecté par nom explicite ne reçoit jamais d’indice', () => {
  const helpers = makeHelpers();
  const session = { type: 'RACE', date: '2026-06-01T21:00:00Z', track: 'spa', results: [
    { id: 'p', name: 'Pilote Réel', laps: 10, time: 1000 },
    { id: 's', name: 'Pace Car', laps: 10, time: 500 },
    { id: 'b', name: 'Pilote Deux', laps: 10, time: 1100 }
  ], laps: [] };
  const course = adapter.buildCourses([
    { slug: 'open', name: 'Open', kind: 'open', points_config: { globalCoef: 0.5 }, data: { sessions: [session], penMap: {} } }
  ], helpers)[0];
  const service = course.entries.find(e => e.id === 's');
  assert.equal(service.outcome, 'service');
  const replay = engine.replay([course], { beta: 5.5, minRaces: 1 });
  assert.deepEqual(replay.all.map(r => r.id).sort(), ['b', 'p']);
});

test('buildCourses : la pondération réduit la même course, l’exclusion admin masque le pilote', () => {
  const helpers = makeHelpers();
  const session = (slug, coef, date) => ({ slug, name: slug, kind: 'open', points_config: { globalCoef: coef }, data: { sessions: [
    { type: 'RACE', date, track: 'spa', results: [
      { id: 'a', name: 'A', laps: 10, time: 1000 }, { id: 'b', name: 'B', laps: 10, time: 1100 }, { id: 'c', name: 'C', laps: 10, time: 1200 }
    ], laps: [] }
  ], penMap: {} } });
  const low = engine.replay(adapter.buildCourses([session('open-faible', 0.5, '2026-06-01T21:00:00Z')], helpers), { beta: 5.5, minRaces: 1 });
  const high = engine.replay(adapter.buildCourses([session('open-fort', 1, '2026-06-01T21:00:00Z')], helpers), { beta: 5.5, minRaces: 1 });
  const aLow = low.all.find(r => r.id === 'a'), aHigh = high.all.find(r => r.id === 'a');
  assert.ok(Math.abs(aLow.history[0].deltaMu) < Math.abs(aHigh.history[0].deltaMu));
  const hidden = engine.replay(adapter.buildCourses([session('open-cache', 1, '2026-06-01T21:00:00Z')], helpers), { beta: 5.5, minRaces: 1, hidden: { a: true } });
  assert.deepEqual(hidden.all.map(r => r.id).sort(), ['b', 'c']);
});

test('buildCourses : un événement sans data ou sans sessions est ignoré proprement', () => {
  const helpers = makeHelpers();
  assert.deepEqual(adapter.buildCourses([{ slug: 'vide', name: 'Vide', kind: 'open', data: null }], helpers), []);
  assert.deepEqual(adapter.buildCourses(null, helpers), []);
  assert.throws(() => adapter.buildCourses([], {}), /groupSessionsByDate/);
});

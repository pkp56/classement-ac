const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/m2-c2.json'), 'utf8'));
const siteSource = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
const patchSource = fs.readFileSync(path.join(root, 'patches-v71.js'), 'utf8');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function makeBrowser(extraEvents = [], extraFetch = null) {
  const elements = new Map();
  const storage = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', textContent: '', style: {}, value: '' });
    return elements.get(id);
  };
  const priorRound = {
    date: '2026-09-09T21:37:00+02:00', track: 'mt-tremblant_69', type: 'QUALIFY',
    results: [], laps: [], events: []
  };
  const event = {
    slug: fixture.event.slug,
    name: 'International Series Lola T290 - GDSP - Championnat',
    kind: 'championship',
    points_config: fixture.event.points_config,
    updated_at: '2026-11-01T12:00:00Z',
    data: { sessions: [priorRound, ...fixture.sessions], penMap: { ...fixture.penMap }, manualDrivers: null, customCalendar: null }
  };
  const events = [
    {
      slug: event.slug, name: event.name, kind: event.kind,
      points_config: event.points_config, updated_at: event.updated_at
    },
    ...extraEvents
  ];
  const calls = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    document: { getElementById, querySelectorAll() { return []; }, readyState: 'complete' },
    localStorage: {
      getItem(k) { return storage.has(k) ? storage.get(k) : null; },
      setItem(k, v) { storage.set(k, String(v)); },
      removeItem(k) { storage.delete(k); }
    },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (extraFetch) {
        const custom = await extraFetch(url, opts);
        if (custom) return custom;
      }
      if (url === '/api/global-exclusions') return response({ ids: {} });
      if (url === '/api/events') return response({ events });
      if (url === '/api/events/' + encodeURIComponent(event.slug)) return response(event);
      return response({ ok: true }, 200);
    },
    alert() {},
    scrollTo() {},
    prompt() { return '0'; },
    confirm() { return true; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URL, Blob, Date, Math, Map, Set, Promise
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(siteSource, sandbox);
  vm.runInContext(patchSource, sandbox);
  return { sandbox, getElementById, calls, storage };
}

test('site opens at the GDSP home, then Results renders the loaded championship and commission column', async () => {
  const { sandbox, getElementById } = makeBrowser();
  // Let the app's async bootstrap finish its list fetch and background event preload.
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(vm.runInContext('page', sandbox), 'hub');
  assert.match(getElementById('app').innerHTML, /La piste,<br>entre gentlemen/i);
  assert.match(getElementById('app').innerHTML, /Championnats en cours/i);

  await vm.runInContext("round=1;sessionIndex=2;go('manches')", sandbox);
  const resultHtml = getElementById('app').innerHTML;
  assert.equal(vm.runInContext('page', sandbox), 'manches');
  assert.doesNotMatch(resultHtml, /Aucune manche importée/);
  assert.match(resultHtml, /<th>Pénal\.<\/th>/);
  assert.match(resultHtml, /<th>Pts<\/th>/);
  assert.match(resultHtml, /<td><b>41<\/b><\/td>/);
  assert.match(resultHtml, /Karl74/);
  assert.match(resultHtml, /\+22\.098 s/);

  vm.runInContext('sessionIndex=0;render()', sandbox);
  const qualHtml = getElementById('app').innerHTML;
  assert.match(qualHtml, /<th>Pts<\/th>/);
  assert.match(qualHtml, /<td><b>1<\/b><\/td>/);
  assert.match(qualHtml, /<td class="muted">0<\/td>/);

  vm.runInContext("addAdjustment(1,2,'fixture-dnf',0,false,false,'Abandon',{dnf:true})", sandbox);
  assert.equal(vm.runInContext("penMap['1:2:fixture-dnf'].dnf", sandbox), true);
  assert.equal(vm.runInContext("penMap['1:2:fixture-dnf'].timeAdd", sandbox), 0);

  await vm.runInContext("go('classement')", sandbox);
  vm.runInContext("showrank('joker')", sandbox);
  const jokerHtml = getElementById('app').innerHTML;
  assert.match(jokerHtml, /Pilotes · Joker/);
  assert.doesNotMatch(jokerHtml, /8 meilleures manches/);
  assert.match(jokerHtml, /plus faible total de manche est écarté/);
  assert.match(jokerHtml, /Total Joker/);
});

test('duplicate legacy Lola event is suppressed and tombstoned when deleted', async () => {
  const legacyDup = {
    slug: 'lola-t290-2026',
    name: 'International Series Lola T290 — 2026',
    kind: 'championship',
    points_config: {},
    updated_at: '2026-11-01T12:00:00Z'
  };
  const archiveEv = {
    slug: 'open-archive-1',
    name: 'Open Archive Test',
    kind: 'archive',
    points_config: {},
    updated_at: '2026-10-01T12:00:00Z'
  };
  const { sandbox, getElementById, calls } = makeBrowser([legacyDup, archiveEv]);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  const slugs = Array.from(vm.runInContext('events.map(e=>e.slug)', sandbox));
  assert.ok(!slugs.includes('lola-t290-2026'), 'legacy Lola duplicate must be hidden automatically');
  assert.doesNotMatch(getElementById('event-switcher').innerHTML, /Lola T290 — 2026/);
  assert.doesNotMatch(getElementById('app').innerHTML, /Lola T290 — 2026/);

  // Also verify explicit deletion writes the persistent _deleted tombstone for lola-t290-2026
  vm.runInContext("adminAuth=true;adminToken='tok';", sandbox);
  await vm.runInContext("deleteEvent('lola-t290-2026')", sandbox);
  const putCall = calls.find(c => c.url === '/api/events/lola-t290-2026' && c.method === 'PUT');
  assert.ok(putCall && putCall.body.pointsConfig._deleted === true, 'PUT tombstone must mark pointsConfig._deleted');
});

test('Commission tab lets admin add and remove championship points for a driver', async () => {
  const { sandbox, getElementById } = makeBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  const karlBefore = vm.runInContext("calculate().find(d=>d.name==='Karl74').total", sandbox);
  const karlId = vm.runInContext("allDrivers().find(d=>d.name==='Karl74').id", sandbox);

  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='adjust';page='admin';render()", sandbox);
  const commHtml = getElementById('app').innerHTML;
  assert.match(commHtml, /\+ Ajouter des points/);
  assert.match(commHtml, /− Enlever des points/);

  getElementById('champ-pts-driver').value = karlId;
  getElementById('champ-pts-delta').value = '5';
  getElementById('champ-pts-note').value = 'Pénalité championnat';
  vm.runInContext('submitChampPointsAdj(-1)', sandbox);

  assert.equal(vm.runInContext("calculate().find(d=>d.name==='Karl74').total", sandbox), karlBefore - 5);
  assert.match(getElementById('app').innerHTML, /-5 pts/);
  assert.match(getElementById('app').innerHTML, /Pénalité championnat/);

  getElementById('champ-pts-driver').value = karlId;
  getElementById('champ-pts-delta').value = '2';
  getElementById('champ-pts-note').value = 'Bonus';
  vm.runInContext('submitChampPointsAdj(1)', sandbox);

  assert.equal(vm.runInContext("calculate().find(d=>d.name==='Karl74').total", sandbox), karlBefore - 3);

  await vm.runInContext("go('classement')", sandbox);
  const rankHtml = getElementById('app').innerHTML;
  assert.match(rankHtml, /<th>Ajust\.<\/th>/);
  assert.match(rankHtml, /<td class="penalty">-3<\/td>/);

  // Removing both adjustments restores original total and hides Ajust. column
  vm.runInContext("Object.keys(penMap).filter(k=>k.startsWith('champ:')).forEach(k=>removeAdjustment(k))", sandbox);
  assert.equal(vm.runInContext("calculate().find(d=>d.name==='Karl74').total", sandbox), karlBefore);
  assert.doesNotMatch(getElementById('app').innerHTML, /<th>Ajust\.<\/th>/);
});

test('event driver profile and global driver profile render ? tooltip icons, Δ rythme, and Analyse du rythme card', async () => {
  const makeWeekend = (idx) => ([
    {
      type: 'QUALIFY',
      date: `2026-06-0${idx}T19:30:00Z`,
      track: 'riverside',
      results: [
        { id: 'd1', name: 'Karl74', team: 'GDSP', laps: 4, best: 89800 },
        { id: 'd2', name: 'Pistol', team: 'GDSP', laps: 4, best: 90600 },
        { id: 'd3', name: 'Sherman', team: 'GDSP', laps: 4, best: 91000 }
      ],
      laps: [],
      events: []
    },
    {
      type: 'RACE',
      date: `2026-06-0${idx}T20:00:00Z`,
      track: 'riverside',
      results: [
        { id: 'd1', name: 'Karl74', team: 'GDSP', grid: 2, laps: 10, best: 90100, time: 905000 },
        { id: 'd2', name: 'Pistol', team: 'GDSP', grid: 1, laps: 10, best: 90400, time: 908000 },
        { id: 'd3', name: 'Sherman', team: 'GDSP', grid: 3, laps: 10, best: 90800, time: 912000 }
      ],
      laps: [
        { id: 'd1', time: 96000, cuts: 0 }, { id: 'd1', time: 90100, cuts: 0 }, { id: 'd1', time: 90300, cuts: 0 }, { id: 'd1', time: 90500, cuts: 0 },
        { id: 'd2', time: 97000, cuts: 0 }, { id: 'd2', time: 90400, cuts: 0 }, { id: 'd2', time: 90700, cuts: 0 }, { id: 'd2', time: 91000, cuts: 0 },
        { id: 'd3', time: 98000, cuts: 0 }, { id: 'd3', time: 90800, cuts: 0 }, { id: 'd3', time: 91100, cuts: 0 }, { id: 'd3', time: 91500, cuts: 0 }
      ],
      events: []
    }
  ]);
  const multiRaceEv = {
    slug: 'gt-open-2026',
    name: 'GT Open 2026',
    kind: 'championship',
    points_config: { expectedRounds: 5 },
    data: { sessions: [1, 2, 3, 4, 5].flatMap(makeWeekend) }
  };

  const { sandbox, getElementById } = makeBrowser(
    [multiRaceEv],
    url => (url === '/api/events/gt-open-2026' ? response(multiRaceEv) : null)
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  // 1) Event driver profile (Pilotes -> Karl74)
  await vm.runInContext("loadEvent('gt-open-2026')", sandbox);
  vm.runInContext("driverId='d1';page='pilotes';render()", sandbox);
  const eventProfileHtml = getElementById('app').innerHTML;
  for (const label of [
    'Régularité',
    'Propreté',
    'Vitesse au tour',
    'Résultats',
    'Analyse du rythme',
    'Race consistency &amp; meilleur tour week-end',
    'Meilleur WE',
    'Moy. course',
    'Pit/exclu',
    'Courses enregistrées',
    'Meilleur résultat brut',
    'Places gagnées / course',
    'Collisions / course',
    'Delta',
    'Collisions brutes',
    'Δ rythme',
    'Méthode iRacing',
    'Choc arrière clair'
  ]) {
    assert.ok(
      eventProfileHtml.includes(label) && eventProfileHtml.includes('class="gdsp-i">?</i>'),
      `Event driver profile should render ${label}`
    );
  }
  assert.match(eventProfileHtml, /1:29\.800<span style="[^"]*">Q<\/span>/);
  const eventTipCount = (eventProfileHtml.match(/class="gdsp-i">\?<\/i>/g) || []).length;
  assert.ok(eventTipCount >= 15, `Expected at least 15 ? icons on event driver profile, got ${eventTipCount}`);

  // 2) Global ranking & Global driver profile (Global -> Karl74)
  await vm.runInContext("go('global')", sandbox);
  const globalRankHtml = getElementById('app').innerHTML;
  assert.match(globalRankHtml, /4 critères \(0-100\) <span class="gdsp-tip/);
  assert.match(globalRankHtml, /class="gdsp-tip gdsp-bar"/);

  await vm.runInContext("globalDriverId='d1';go('gpilote')", sandbox);
  const globalProfileHtml = getElementById('app').innerHTML;
  const globalRatings = vm.runInContext('globalPerformanceRatings()', sandbox);
  assert.ok(globalRatings.length > 0);
  for (const rating of globalRatings) {
    const d = rating.details;
    assert.ok(Math.abs(rating.score - (d.regularite + d.proprete + d.vitesse + d.resultats) / 4) < 1e-9);
  }
  assert.doesNotMatch(globalProfileHtml, /Régularité inter-événements|<b>Progression<\/b>/);
  assert.match(globalProfileHtml, /Quatre critères · un niveau/);
  for (const cls of ['drv-hero', 'drv-roundel', 'drv-global-level', 'drv-kpis', 'drv-perf-grid', 'drv-portrait-grid']) {
    assert.ok(globalProfileHtml.includes(cls), `Global profile includes ${cls}`);
  }
  assert.match(globalProfileHtml, /class="lvl-badge"[^>]*width="180"/);
  assert.doesNotMatch(globalProfileHtml, /Voiture engagée/);
  assert.match(globalProfileHtml, /Choisir un pilote Global/);
  for (const label of [
    'Niveau GLOBAL',
    'Rythme',
    'Propreté',
    'Vitesse au tour',
    'Résultats',
    'Analyse du rythme',
    'Race consistency &amp; meilleur tour week-end',
    'GT Open 2026 · Riverside',
    'Courses',
    'Meilleur',
    'Pos. moy.',
    'Δ départ',
    'Coll./course',
    'Δ rythme'
  ]) {
    assert.ok(
      globalProfileHtml.includes(label),
      `Global driver profile should include ${label}`
    );
  }
  assert.match(globalProfileHtml, /1:29\.800<span style="[^"]*">Q<\/span>/);
  const globalTipCount = (globalProfileHtml.match(/class="gdsp-i">\?<\/i>/g) || []).length;
  assert.ok(globalTipCount >= 17, `Expected at least 17 ? icons on global driver profile, got ${globalTipCount}`);
});

test('restored formulas compute iRacing consistency, weekend Q/R best lap, Option 3 fouls, and v45 results accurately', async () => {
  const { sandbox } = makeBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  // 1) raceConsistencyMs: ignores Lap 1 (110s) and pit lap (125s > 90s + 21s), best=90000, non-best=[90400, 90800] -> avg gap = 600 ms
  const cons = vm.runInContext(
    'raceConsistencyMs([{time:110000},{time:90000},{time:125000},{time:90400},{time:90800}])',
    sandbox
  );
  assert.equal(cons, 600);

  // 2) scoreResultsV45: 2 drivers -> 55 / 45, 28 drivers -> 100 / 0, DNF/DQ -> 0
  assert.equal(vm.runInContext('scoreResultsV45(2, 1, false)', sandbox), 55);
  assert.equal(vm.runInContext('scoreResultsV45(2, 2, false)', sandbox), 45);
  assert.equal(vm.runInContext('scoreResultsV45(28, 1, false)', sandbox), 100);
  assert.equal(vm.runInContext('scoreResultsV45(28, 28, false)', sandbox), 0);
  assert.equal(vm.runInContext('scoreResultsV45(20, 3, true)', sandbox), 0);

  // 3) weekendBestLaps: picks Q if faster, R if faster
  const bestEntries = Array.from(vm.runInContext(`
    Array.from(weekendBestLaps({
      sessions: [
        { type: 'QUALIFY', results: [{ id: 'a', best: 89500, laps: 3 }, { id: 'b', best: 91000, laps: 3 }] },
        { type: 'RACE', results: [{ id: 'a', best: 90100, laps: 10, time: 910000 }, { id: 'b', best: 90200, laps: 10, time: 912000 }] }
      ]
    }).entries())
  `, sandbox));
  const bestObj = Object.fromEntries(bestEntries.map(([k, v]) => [k, { best: v.best, bestSession: v.bestSession }]));
  assert.deepEqual(bestObj, {
    a: { best: 89500, bestSession: 'Q' },
    b: { best: 90200, bestSession: 'R' }
  });

  // 4) raceFoulScores (Option 3):
  // - Driver A rear-ends Driver B (X=0.8, Z=0.2) at ts=200; B loses 4.0s on lap (94.0s vs 90.0s pace) => A gets +2.0 fault pts, B gets 0
  // - Driver B & C touch side-by-side (|Z|=1.3 >= 1.0) => 0-0 even if C loses 5s
  // - Driver C has 2 cuts => +2.0 fault pts
  const foulEntries = Array.from(vm.runInContext(`
    Array.from(raceFoulScores({
      results: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      laps: [
        { id: 'a', time: 95000, cuts: 0, timestamp: 100 }, { id: 'a', time: 90000, cuts: 0, timestamp: 190 }, { id: 'a', time: 90500, cuts: 0, timestamp: 280 },
        { id: 'b', time: 95000, cuts: 0, timestamp: 100 }, { id: 'b', time: 90000, cuts: 0, timestamp: 190 }, { id: 'b', time: 94000, cuts: 0, timestamp: 284 },
        { id: 'c', time: 95000, cuts: 1, timestamp: 100 }, { id: 'c', time: 90000, cuts: 1, timestamp: 190 }, { id: 'c', time: 95000, cuts: 0, timestamp: 285 }
      ],
      events: [
        { type: 'COLLISION_WITH_CAR', aid: 'a', bid: 'b', timestamp: 200, RelPosition: { X: 0.8, Y: 0, Z: 0.2 } },
        { type: 'COLLISION_WITH_CAR', aid: 'b', bid: 'a', timestamp: 200, RelPosition: { X: -0.8, Y: 0, Z: -0.2 } },
        { type: 'COLLISION_WITH_CAR', aid: 'b', bid: 'c', timestamp: 210, RelPosition: { X: 0.6, Y: 0, Z: 1.3 } },
        { type: 'COLLISION_WITH_CAR', aid: 'c', bid: 'b', timestamp: 210, RelPosition: { X: -0.6, Y: 0, Z: -1.3 } }
      ]
    }).entries())
  `, sandbox));
  const fouls = Object.fromEntries(foulEntries);
  assert.equal(fouls.a, 2);
  assert.equal(fouls.b, 0);
  assert.equal(fouls.c, 2);
});

test('Administration / Événements lets admin insert, persist across saves, and remove an event poster on Event Accueil (omitted from Classements)', async () => {
  const upcomingEv = {
    slug: 'alfa-romeo-cup-2026',
    name: 'Alfa Romeo Cup',
    kind: 'championship',
    points_config: { expectedRounds: 3 },
    updated_at: '2026-11-08T12:00:00Z',
    data: { sessions: [], penMap: {} }
  };
  let savedUpcomingData = { ...upcomingEv.data };
  let savedUpcomingCfg = { ...upcomingEv.points_config };

  const { sandbox, getElementById, calls } = makeBrowser(
    [upcomingEv],
    (url, opts = {}) => {
      if (url === '/api/events/alfa-romeo-cup-2026' && (!opts.method || opts.method === 'GET')) {
        return response({ ...upcomingEv, points_config: savedUpcomingCfg, data: savedUpcomingData });
      }
      if (url === '/api/events/alfa-romeo-cup-2026/data' && opts.method === 'POST') {
        savedUpcomingData = JSON.parse(opts.body);
        return response({ ok: true });
      }
      if (url === '/api/events/alfa-romeo-cup-2026' && opts.method === 'PUT') {
        const b = JSON.parse(opts.body);
        if (b.pointsConfig) savedUpcomingCfg = b.pointsConfig;
        return response({ ok: true });
      }
      return null;
    }
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  // 1) Open Administration -> Événements and verify the poster upload button is rendered
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()", sandbox);
  const eventsAdminHtml = getElementById('app').innerHTML;
  assert.match(eventsAdminHtml, /Insérer une affiche/);
  assert.match(eventsAdminHtml, /Alfa Romeo Cup/);

  // 2) Upload a poster on the current Lola championship AND on the upcoming Alfa Romeo Cup
  const lolaSlug = fixture.event.slug;
  const sampleDataUrl = 'data:image/jpeg;base64,dGVzdHBvc3Rlcg==';
  sandbox.__posterFileEvent = { target: { files: [{ dataUrl: sampleDataUrl }] } };
  vm.runInContext(`triggerEventPosterUpload('${lolaSlug}')`, sandbox);
  await vm.runInContext('handleEventPosterFile(__posterFileEvent)', sandbox);

  // Verify Lola's existing sessions were preserved when saving posterImage
  const lolaDataPost = calls.find(c => c.url === `/api/events/${lolaSlug}/data` && c.method === 'POST');
  assert.ok(lolaDataPost, 'POST /data should be called for Lola');
  assert.equal(lolaDataPost.body.posterImage, sampleDataUrl);
  assert.ok(Array.isArray(lolaDataPost.body.sessions) && lolaDataPost.body.sessions.length >= 2, 'existing sessions must be preserved');

  // Verify subsequent saveRemote() keeps posterImage intact
  await vm.runInContext('saveRemote()', sandbox);
  const lastLolaPost = calls.filter(c => c.url === `/api/events/${lolaSlug}/data` && c.method === 'POST').at(-1);
  assert.equal(lastLolaPost.body.posterImage, sampleDataUrl);

  // Verify Event Accueil sub-tab renders the poster, while Classements no longer displays it
  await vm.runInContext("go('event')", sandbox);
  assert.match(getElementById('app').innerHTML, /class="event-poster-img"/);
  assert.ok(getElementById('app').innerHTML.includes(sampleDataUrl));
  await vm.runInContext("go('classement')", sandbox);
  assert.doesNotMatch(getElementById('app').innerHTML, /class="event-poster-img"/);
  vm.runInContext("showrank('merite')", sandbox);
  assert.doesNotMatch(getElementById('app').innerHTML, /class="event-poster-img"/);

  // 3) Upload poster for upcoming Alfa Romeo Cup (0 sessions) and switch to it (opens on Event Accueil)
  vm.runInContext("triggerEventPosterUpload('alfa-romeo-cup-2026')", sandbox);
  await vm.runInContext('handleEventPosterFile(__posterFileEvent)', sandbox);
  assert.equal(savedUpcomingCfg.hasPoster, true);
  await vm.runInContext("switchEvent('alfa-romeo-cup-2026')", sandbox);
  assert.equal(vm.runInContext('page', sandbox), 'event');
  assert.match(getElementById('app').innerHTML, /class="event-poster-img"/);
  assert.match(getElementById('app').innerHTML, /Affiche — Alfa Romeo Cup/);

  // 4) Removing the poster clears it from Event Accueil and server state
  sandbox.confirm = () => true;
  await vm.runInContext("removeEventPoster('alfa-romeo-cup-2026')", sandbox);
  assert.doesNotMatch(getElementById('app').innerHTML, /class="event-poster-img"/);
  assert.equal(savedUpcomingData.posterImage, undefined);
});

test('Pilotes redesigned driver sheet renders 70s racing roundel, Lola livery, KPI cards, 2-col performance & rythme, signed portrait, and podium/delta pills', async () => {
  const { sandbox, getElementById } = makeBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  // 1) Pilotes list on active Lola championship displays Lola T290 livery thumbnails
  await vm.runInContext("go('pilotes')", sandbox);
  const listHtml = getElementById('app').innerHTML;
  assert.match(listHtml, /\/assets\/tofusan\.jpg\?v=6/);
  assert.match(listHtml, /\/assets\/karl\.jpg\?v=6/);

  // 2) Open Tofusan (#21) driver profile sheet
  const tofuId = vm.runInContext("allDrivers().find(d=>d.name==='Tofusan').id", sandbox);
  vm.runInContext(`driverId=${JSON.stringify(tofuId)};render()`, sandbox);
  const sheetHtml = getElementById('app').innerHTML;

  assert.match(sheetHtml, /class="drv-topbar"/);
  assert.match(sheetHtml, /← Tous les pilotes/);
  assert.match(sheetHtml, /#21 · Tofusan/);
  assert.match(sheetHtml, /<div class="drv-roundel">21<\/div>/);
  assert.match(sheetHtml, /N° 21/);
  assert.match(sheetHtml, /\/assets\/tofusan\.jpg\?v=6/);
  assert.match(sheetHtml, /Arrivée moy\./);
  assert.match(sheetHtml, /class="drv-kpis"/);
  assert.match(sheetHtml, /class="drv-perf-grid"/);
  assert.match(sheetHtml, /class="drv-score-badge"/);
  assert.match(sheetHtml, /class="drv-bar-mid"/);
  assert.match(sheetHtml, /class="panel drv-portrait-card drv-portrait-pos"/);
  assert.match(sheetHtml, /class="panel drv-portrait-card drv-portrait-axe"/);
  assert.match(sheetHtml, /podium-pill p[123]/);
  assert.match(sheetHtml, /delta-pill (up|down|eq)/);
});

test('Unified Event tab displays active event name in header nav, groups Accueil/Classements/Résultats/Pilotes, and persists custom Accueil info & gallery', async () => {
  const lolaSlug = fixture.event.slug;
  let storedLolaData = null;
  const upcomingEv = {
    slug: 'alfa-gta-2026',
    name: 'Coppa Alfa Romeo GTA',
    kind: 'championship',
    points_config: { expectedRounds: 5, globalCoef: 1.0 },
    updated_at: '2026-11-08T15:00:00Z',
    data: { sessions: [], penMap: {} }
  };

  const { sandbox, getElementById, calls } = makeBrowser(
    [upcomingEv],
    (url, opts = {}) => {
      if (url === `/api/events/${lolaSlug}` && (!opts.method || opts.method === 'GET') && storedLolaData) {
        return response({
          slug: lolaSlug,
          name: 'International Series Lola T290 - GDSP - Championnat',
          kind: 'championship',
          points_config: fixture.event.points_config,
          updated_at: '2026-11-08T15:00:00Z',
          data: storedLolaData
        });
      }
      if (url === `/api/events/${lolaSlug}/data` && opts.method === 'POST') {
        storedLolaData = JSON.parse(opts.body);
        return response({ ok: true });
      }
      if (url === '/api/events/alfa-gta-2026' && (!opts.method || opts.method === 'GET')) {
        return response(upcomingEv);
      }
      return null;
    }
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  // 1) Top navbar shows 1 unified Event tab bearing the active event's name (not separate Classements/Résultats/Pilotes top buttons)
  const navHtml = getElementById('nav').innerHTML;
  assert.match(navHtml, /class="nav-event-tab/);
  assert.match(navHtml, /International Series Lola T290 - GDSP - Championnat/);
  assert.doesNotMatch(navHtml, />CLASSEMENTS<\/button>/);
  assert.doesNotMatch(navHtml, />RÉSULTATS<\/button>/);
  assert.doesNotMatch(navHtml, />PILOTES<\/button>/);

  // 2) Opening the Event tab renders the Event Banner, 4 sub-tabs, Calendar, and Provisional Podium
  await vm.runInContext("go('event')", sandbox);
  const evHomeHtml = getElementById('app').innerHTML;
  assert.match(evHomeHtml, /class="ev-shell"/);
  assert.doesNotMatch(evHomeHtml, /ev-banner-right|ev-back-hub|Changer d’événement|Changer d'événement/);
  assert.match(evHomeHtml, /Accueil <span class="ev-subtab-badge">Affiche &amp; Infos<\/span>/);
  assert.match(evHomeHtml, /Classements <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Résultats <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Pilotes <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Calendrier des manches/);
  assert.match(evHomeHtml, /Podium provisoire/);

  // 3) Admin can customize Event Accueil briefing/links, upcoming calendar round, and gallery images — and saveRemote() preserves them
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()", sandbox);
  getElementById('evinfo-car').value = 'Lola T290 · 1972';
  getElementById('evinfo-schedule').value = 'Mercredi 21h15';
  getElementById('evinfo-briefing').value = 'Briefing spécial championnat historique.';
  getElementById('evinfo-format').value = '4 sprints + 2 endurances';
  getElementById('evinfo-rules').value = 'https://example.com/reglement.pdf';
  getElementById('evinfo-skins').value = 'https://example.com/skins.zip';
  getElementById('evinfo-discord').value = 'https://discord.gg/kDZXwRgRS';
  await vm.runInContext('saveEventInfoForm()', sandbox);

  const galDataUrl = 'data:image/jpeg;base64,Z2FsbGVyeWltZw==';
  getElementById('evgal-caption').value = 'Départ à Riverside';
  sandbox.__galFileEvent = { target: { files: [{ dataUrl: galDataUrl }] } };
  await vm.runInContext('handleEventGalleryFile(__galFileEvent)', sandbox);

  vm.runInContext("customCalendar={'2026-11-25':{track:'road_atlanta'}}", sandbox);
  await vm.runInContext('saveRemote()', sandbox);

  const lastPost = calls.filter(c => c.url === `/api/events/${lolaSlug}/data` && c.method === 'POST').at(-1);
  assert.equal(lastPost.body.eventInfo.briefing, 'Briefing spécial championnat historique.');
  assert.equal(lastPost.body.galleryImages.length, 1);
  assert.equal(lastPost.body.galleryImages[0].caption, 'Départ à Riverside');

  await vm.runInContext("go('event')", sandbox);
  const updatedEvHome = getElementById('app').innerHTML;
  assert.match(updatedEvHome, /Briefing spécial championnat historique\./);
  assert.match(updatedEvHome, /Mercredi 21h15/);
  assert.match(updatedEvHome, /Règlement de l&#39;événement/);
  assert.match(updatedEvHome, /Pack Skins \/ Téléchargement/);
  assert.match(updatedEvHome, /Galerie de l'événement/);
  assert.match(updatedEvHome, /Départ à Riverside/);
  assert.match(updatedEvHome, /road_atlanta/);
  assert.match(updatedEvHome, /À VENIR/);

  // 4) Sub-tab navigation inside Event Shell & dynamic top nav label when switching events
  vm.runInContext("setEventSubTab('classement')", sandbox);
  assert.equal(vm.runInContext('page', sandbox), 'classement');
  assert.match(getElementById('app').innerHTML, /Classement général/);

  vm.runInContext('openEventRoundResult(1)', sandbox);
  assert.equal(vm.runInContext('page', sandbox), 'manches');
  assert.equal(vm.runInContext('round', sandbox), 1);

  await vm.runInContext('removeEventGalleryImage(0)', sandbox);
  assert.equal(storedLolaData.galleryImages, undefined);

  await vm.runInContext("switchEvent('alfa-gta-2026')", sandbox);
  assert.equal(vm.runInContext('page', sandbox), 'event');
  assert.match(getElementById('nav').innerHTML, /Coppa Alfa Romeo GTA/);
  assert.match(getElementById('app').innerHTML, /CHAMPIONNAT À VENIR/);
});




test('Commission round selector retains the displayed selection after switching and rerendering', async () => {
  const { sandbox } = makeBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(vm.runInContext('rounds().length >= 2', sandbox));
  // Each call to rounds() returns fresh objects, as in the administration render.
  for (const index of [0, 1, 0, 1]) {
    vm.runInContext(`selectedRaceAdj=${index}`, sandbox);
    const html = vm.runInContext('renderAdjPanel(rounds()[selectedRaceAdj])', sandbox);
    const select = html.match(/<select[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.match(select, new RegExp(`<option value="${index}" selected>`));
    assert.equal((select.match(/ selected/g) || []).length, 1);
    const expectedTrack = vm.runInContext('esc(track(rounds()[selectedRaceAdj].track))', sandbox);
    assert.ok(select.includes(`selected>Manche ${index + 1} · ${expectedTrack}</option>`));
  }
});


test('Global levels follow fixed displayed-score bands rather than population quartiles', async () => {
  const { sandbox } = makeBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  for (const [score, level] of [[0,4],[40,4],[40.49,4],[40.5,3],[41,3],[60,3],[60.5,2],[61,2],[80,2],[80.5,1],[81,1],[100,1]]) {
    assert.equal(vm.runInContext(`globalLevelForScore(${score})`, sandbox), level, `score ${score}`);
  }
  const ratings = vm.runInContext('globalPerformanceRatings()', sandbox);
  for (const driver of ratings) {
    const score = Math.round(driver.score);
    assert.equal(driver.level, score >= 81 ? 1 : score >= 61 ? 2 : score >= 41 ? 3 : 4);
  }
});

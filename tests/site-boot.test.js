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

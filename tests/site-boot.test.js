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

function makeBrowser() {
  const elements = new Map();
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
    data: { sessions: [priorRound, ...fixture.sessions], penMap: fixture.penMap, manualDrivers: null, customCalendar: null }
  };
  const events = [{
    slug: event.slug, name: event.name, kind: event.kind,
    points_config: event.points_config, updated_at: event.updated_at
  }];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    document: { getElementById, querySelectorAll() { return []; }, readyState: 'complete' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async url => {
      if (url === '/api/global-exclusions') return response({ ids: {} });
      if (url === '/api/events') return response({ events });
      if (url === '/api/events/' + encodeURIComponent(event.slug)) return response(event);
      return response({}, 404);
    },
    scrollTo() {},
    prompt() { return '0'; },
    confirm() { return false; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URL, Blob, Date, Math, Map, Set, Promise
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(siteSource, sandbox);
  vm.runInContext(patchSource, sandbox);
  return { sandbox, getElementById };
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
  assert.match(resultHtml, /Karl74/);
  assert.match(resultHtml, /\+22\.098 s/);

  vm.runInContext("addAdjustment(1,2,'fixture-dnf',0,false,false,'Abandon',{dnf:true})", sandbox);
  assert.equal(vm.runInContext("penMap['1:2:fixture-dnf'].dnf", sandbox), true);
  assert.equal(vm.runInContext("penMap['1:2:fixture-dnf'].timeAdd", sandbox), 0);
});

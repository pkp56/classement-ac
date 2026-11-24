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

function makeBrowser(extraEvents = [], extraFetch = null, browserOptions = {}) {
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
    AbortController, URL, URLSearchParams, Blob, Date, Math, Map, Set, Promise
  };
  Object.assign(sandbox, browserOptions);
  sandbox.window = sandbox;
  sandbox.gdspAuth = {fetch:(...args)=>sandbox.fetch(...args),session:async()=>({authenticated:!!browserOptions.authenticatedSession})};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root,'assets/global-rating.js'),'utf8'), sandbox);
  vm.runInContext(siteSource, sandbox);
  vm.runInContext(patchSource, sandbox);
  return { sandbox, getElementById, calls, storage };
}

test('moteur mobile : mêmes classements et points par session que le site PC', async () => {
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setImmediate(resolve));
  const event=JSON.parse(vm.runInContext('JSON.stringify({slug:eventContext.slug,points_config:eventContext.pointsConfig,data:eventContext.data})',sandbox));
  const expected=JSON.parse(vm.runInContext(`JSON.stringify((()=>{const rows=calculate().sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));return {standings:rows.map(({id,total,joker,meritTotal})=>({id,total,joker,meritTotal})),points:rounds().map(r=>r.sessions.filter(s=>s.type==='QUALIFY'||s.type==='RACE').map(s=>Array.from(sessionPoints(s).entries())))};})())`,sandbox));
  const mobile={console,Map,Set,Date,Math,Promise};mobile.window=mobile;vm.createContext(mobile);
  vm.runInContext(fs.readFileSync(path.join(root,'mobile/results-engine.js'),'utf8'),mobile);
  vm.runInContext(patchSource,mobile);
  const result=mobile.gdspMobileResults.calculate(event);
  const actual=JSON.parse(JSON.stringify({standings:result.standings.map(({id,total,joker,meritTotal})=>({id,total,joker,meritTotal})),points:result.rounds.map(r=>r.sessions.map(s=>s.results.map(p=>[p.id,p.points])))}));
  assert.deepEqual(actual.standings,expected.standings);
  for(let i=0;i<actual.points.length;i++)for(let j=0;j<actual.points[i].length;j++){
    assert.deepEqual(Object.fromEntries(actual.points[i][j]),Object.fromEntries(expected.points[i][j]));
  }
});

test('moteur mobile : sanctions, changements de pilote et barème personnalisé restent identiques au PC', async () => {
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`eventContext.slug='test-cup'; eventContext.pointsConfig={pointsScale:[30,20,10],polePoints:2,doubleLongRaces:false,jokerCount:1};
    const firstRace=rounds()[1].sessions.findIndex(s=>s.type==='RACE');
    const ids=rounds()[1].sessions[firstRace].results.map(r=>r.id);
    penMap={['1:'+firstRace+':'+ids[0]]:{timeAdd:30},['1:'+firstRace+':'+ids[1]]:{dq:true},['1:'+firstRace+':'+ids[2]]:{dnf:true},['1:'+firstRace+':'+ids[3]]:{dns:true},['points:'+ids[0]]:{pointsAdd:-3}};
    sessions.forEach(s=>s.results.forEach(r=>{if(r.id===ids[0]){r.name='Nouveau Nom';r.team='Nouvelle équipe';}}));`,sandbox);
  const event=JSON.parse(vm.runInContext('JSON.stringify({slug:eventContext.slug,points_config:eventContext.pointsConfig,data:{sessions,penMap}})',sandbox));
  const before=JSON.stringify(event);
  const expected=JSON.parse(vm.runInContext(`JSON.stringify((()=>{const ds=calculate().sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));return {standings:ds.map(({id,name,team,total,joker,meritTotal})=>({id,name,team,total,joker,meritTotal})),sessions:rounds().map(r=>r.sessions.filter(s=>s.type==='QUALIFY'||s.type==='RACE').map(s=>s.results.map(p=>({id:p.id,comDQ:p.comDQ,comDNF:p.comDNF,comDNS:p.comDNS,finalTime:p.finalTime}))))};})())`,sandbox));
  const mobile={console,Map,Set,Date,Math,Promise};mobile.window=mobile;vm.createContext(mobile);
  vm.runInContext(fs.readFileSync(path.join(root,'mobile/results-engine.js'),'utf8'),mobile);vm.runInContext(patchSource,mobile);
  const out=mobile.gdspMobileResults.calculate(event);
  const actual=JSON.parse(JSON.stringify({standings:out.standings.map(({id,name,team,total,joker,meritTotal})=>({id,name,team,total,joker,meritTotal})),sessions:out.rounds.map(r=>r.sessions.map(s=>s.results.map(p=>({id:p.id,comDQ:p.comDQ,comDNF:p.comDNF,comDNS:p.comDNS,finalTime:p.finalTime}))))}));
  assert.deepEqual(actual,expected);assert.equal(JSON.stringify(event),before);
});

test('profils mobiles : copies des fonctions PC contrôlées et classements identiques', async () => {
  const mobileSource=fs.readFileSync(path.join(root,'mobile/profile-engine.js'),'utf8');
  for(const [start,end] of [['const FAULT_SIDE_Z=','// Encadré « Analyse du rythme'],['function globalLevelForScore(','function globalRatingStatus('],['function performanceRatings(){','function ratingCard('],['function eventGlobalWeight(','// ---------- Points config']]){
    const part=siteSource.slice(siteSource.indexOf(start),siteSource.indexOf(end));
    assert.ok(part.length>100&&mobileSource.includes(part),'La copie mobile doit suivre les règles PC : '+start);
  }
  const {sandbox}=makeBrowser();await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setImmediate(resolve));
  const original=JSON.parse(vm.runInContext('JSON.stringify({slug:eventContext.slug,name:eventContext.name,kind:eventContext.kind,points_config:eventContext.pointsConfig,data:eventContext.data})',sandbox));
  // Plusieurs week-ends construits à partir de vraies sessions de fixture :
  // >= 5 courses, joker, poids, exclusion et sanctions Commission.
  const prototype=original.data.sessions.filter(s=>s.type==='RACE'||s.type==='QUALIFY');
  original.data.sessions=Array.from({length:6},(_,i)=>prototype.map(s=>({...s,date:`2026-${String(i+1).padStart(2,'0')}-10T${s.type==='RACE'?'21:00:00':'20:00:00'}Z`}))).flat();
  const id=original.data.sessions.find(s=>s.results.length).results[0].id;
  original.data.penMap={['0:1:'+id]:{timeAdd:3},['1:1:'+id]:{conduct:{version:1,reviewed:true,incidents:[{severity:'minor',returned:true}],reason:'Examen'}}};
  const other=JSON.parse(JSON.stringify(original));other.slug='test-cup';other.name='Cup';other.kind='cup';other.points_config={globalCoef:0.75};
  other.data.sessions=other.data.sessions.map(s=>({...s,date:s.date.replace('2026-','2025-')}));
  const excluded=JSON.parse(JSON.stringify(other));excluded.slug='fiesta';excluded.kind='fiesta';excluded.points_config={globalCoef:0};
  const all=[original,other,excluded],before=JSON.stringify(all);sandbox.testEvents=JSON.parse(before);sandbox.testHidden={};
  vm.runInContext('events=testEvents;globalHidden=testHidden',sandbox);
  const expected=JSON.parse(vm.runInContext('JSON.stringify(globalPerformanceRatings())',sandbox));assert.ok(expected.length>0);
  const mobile={console,Map,Set,Date,Math,Promise};mobile.window=mobile;vm.createContext(mobile);
  vm.runInContext(fs.readFileSync(path.join(root,'assets/global-rating.js'),'utf8'),mobile);vm.runInContext(mobileSource,mobile);
  const computed=mobile.gdspMobileProfiles.global(all,{});
  assert.deepEqual(JSON.parse(JSON.stringify(computed.ratings)),expected);assert.equal(JSON.stringify(all),before);
  const hidden={[expected[0].id]:true};sandbox.testHidden=hidden;vm.runInContext('globalHidden=testHidden',sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(mobile.gdspMobileProfiles.global(all,hidden).ratings)),JSON.parse(vm.runInContext('JSON.stringify(globalPerformanceRatings())',sandbox)));
  sandbox.testEvent=JSON.parse(JSON.stringify(original));vm.runInContext('sessions=testEvent.data.sessions;penMap=testEvent.data.penMap;eventContext={slug:testEvent.slug,pointsConfig:testEvent.points_config}',sandbox);
  const expectedEvent=JSON.parse(vm.runInContext('JSON.stringify(performanceRatings())',sandbox));
  const eventResult=mobile.gdspMobileProfiles.event(original);
  assert.deepEqual(JSON.parse(JSON.stringify(eventResult.ratings)),expectedEvent);
  assert.ok(eventResult.history(id).length>=6);assert.ok(computed.history(id).length>=6);
});

test('un lien événement reste prioritaire malgré une session administrateur', async () => {
  const slug=fixture.event.slug;
  const {sandbox}=makeBrowser([],url=>url==='/api/admin/verify'?response({ok:true,user:'Admin'}):null,{location:{pathname:'/evenements/'+slug+'/voiture'},authenticatedSession:true});
  await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('adminAuth',sandbox),true);
  assert.equal(vm.runInContext('page',sandbox),'voiture');
  assert.equal(vm.runInContext('currentSlug',sandbox),slug);
});

test('le lien direct /admin ouvre la connexion quand aucune session ne préexiste', async () => {
  const {sandbox,getElementById}=makeBrowser([],null,{location:{pathname:'/admin'}});
  await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('page',sandbox),'admin');
  assert.match(getElementById('app').innerHTML,/id="adminuser"/);
  assert.match(getElementById('app').innerHTML,/id="adminpass"/);
});

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

test('Administration → Événements can rename an event without changing its URL slug',async()=>{
  const {sandbox,getElementById,calls}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const slug=fixture.event.slug,newName='International Series Lola T290 — Saison de démonstration';
  sandbox.prompt=()=>newName;
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()",sandbox);
  await vm.runInContext(`renameEvent(${JSON.stringify(slug)})`,sandbox);
  const put=calls.find(call=>call.url==='/api/events/'+slug&&call.method==='PUT');
  assert.equal(put.body.name,newName);
  assert.equal(vm.runInContext('eventContext.name',sandbox),newName);
  assert.equal(vm.runInContext(`events.find(event=>event.slug===${JSON.stringify(slug)}).name`,sandbox),newName);
  assert.match(getElementById('app').innerHTML,/Modifier le titre/);
  assert.match(getElementById('app').innerHTML,/International Series Lola T290 — Saison de démonstration/);
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

test('Unified Event tab includes Circuit and Voiture, and persists rich Accueil content, editable sporting rules, and gallery', async () => {
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

  // 2) Every event exposes Circuit and Voiture alongside its existing tabs.
  await vm.runInContext("go('event')", sandbox);
  const evHomeHtml = getElementById('app').innerHTML;
  assert.match(evHomeHtml, /class="ev-shell"/);
  assert.doesNotMatch(evHomeHtml, /ev-banner-right|ev-back-hub|Changer d’événement|Changer d'événement/);
  assert.match(evHomeHtml, /Accueil <span class="ev-subtab-badge">Affiche &amp; Infos<\/span>/);
  assert.match(evHomeHtml, /Classements <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Résultats <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Circuit <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Voiture <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Pilotes <span class="ev-subtab-badge">/);
  assert.match(evHomeHtml, /Calendrier des manches/);
  assert.match(evHomeHtml, /Podium provisoire/);

  // 3) Admin can customize rich text, rule lines, links, calendar, and gallery; saves preserve them.
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()", sandbox);
  getElementById('evinfo-car').value = 'Lola T290 · 1972';
  getElementById('evinfo-schedule').value = 'Mercredi 21h15';
  getElementById('evinfo-briefing').value = 'Briefing spécial championnat historique. [Consignes](https://example.com/briefing).';
  getElementById('evinfo-format').value = '4 sprints + 2 endurances · https://example.com/format';
  getElementById('evinfo-rules').value = 'https://example.com/reglement.pdf';
  getElementById('evinfo-skins').value = 'https://example.com/skins.zip';
  getElementById('evinfo-registration').value = 'https://example.org/inscription';
  getElementById('evinfo-discord').value = 'https://discord.gg/kDZXwRgRS';
  getElementById('evinfo-rules-count').value = '2';
  getElementById('evinfo-rule-label-0').value = 'Distance minimale';
  getElementById('evinfo-rule-value-0').value = '75 % pour marquer';
  getElementById('evinfo-rule-label-1').value = 'Règlement particulier';
  getElementById('evinfo-rule-value-1').value = '[Lire le règlement](https://example.com/reglement-sportif)';
  await vm.runInContext('saveEventInfoForm()', sandbox);

  const galDataUrl = 'data:image/jpeg;base64,Z2FsbGVyeWltZw==';
  getElementById('evgal-caption').value = 'Départ à Riverside';
  sandbox.__galFileEvent = { target: { files: [{ dataUrl: galDataUrl }] } };
  await vm.runInContext('handleEventGalleryFile(__galFileEvent)', sandbox);

  vm.runInContext("customCalendar={'2026-11-25':{track:'road_atlanta'}}", sandbox);
  await vm.runInContext('saveRemote()', sandbox);

  const lastPost = calls.filter(c => c.url === `/api/events/${lolaSlug}/data` && c.method === 'POST').at(-1);
  assert.equal(lastPost.body.eventInfo.briefing, 'Briefing spécial championnat historique. [Consignes](https://example.com/briefing).');
  assert.deepEqual(lastPost.body.eventInfo.sportingRules,[
    {label:'Distance minimale',value:'75 % pour marquer'},
    {label:'Règlement particulier',value:'[Lire le règlement](https://example.com/reglement-sportif)'}
  ]);
  assert.equal(lastPost.body.galleryImages.length, 1);
  assert.equal(lastPost.body.galleryImages[0].caption, 'Départ à Riverside');

  await vm.runInContext("go('event')", sandbox);
  const updatedEvHome = getElementById('app').innerHTML;
  assert.match(updatedEvHome, /<a class="ev-register" href="https:\/\/example.org\/inscription" target="_blank"/);
  assert.match(updatedEvHome,/Inscriptions<svg aria-hidden="true"/);
  assert.match(updatedEvHome, /Briefing spécial championnat historique\./);
  assert.match(updatedEvHome, /href="https:\/\/example\.com\/briefing"[^>]*>Consignes<\/a>/);
  assert.match(updatedEvHome, /href="https:\/\/example\.com\/format"/);
  assert.match(updatedEvHome, /Distance minimale/);
  assert.match(updatedEvHome, /href="https:\/\/example\.com\/reglement-sportif"[^>]*>Lire le règlement<\/a>/);
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




test('Les liens des encadrés sont cliquables sans laisser passer du HTML ou un protocole dangereux',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const html=vm.runInContext("renderEventRichText('Ligne 1\\n[Consignes](https://example.com/rules) et https://example.com/format. [Refusé](javascript:alert(1)) <img src=x onerror=alert(1)>')",sandbox);
  assert.match(html,/<br>/);
  assert.match(html,/href="https:\/\/example\.com\/rules"/);
  assert.match(html,/href="https:\/\/example\.com\/format"/);
  assert.doesNotMatch(html,/href="javascript:/i);
  assert.doesNotMatch(html,/<img\b/i);
  assert.match(html,/&lt;img/);
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


test('Permanent event landing URL restores the intended event and supports Back to home', async () => {
  const handlers = {};
  const location = {pathname:'/evenements/'+encodeURIComponent(fixture.event.slug)};
  const history = {pushState(_state,_title,path){location.pathname=path}};
  const {sandbox,getElementById}=makeBrowser([],null,{location,history,addEventListener(type,fn){handlers[type]=fn}});
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('page',sandbox),'event');
  assert.equal(vm.runInContext('currentSlug',sandbox),fixture.event.slug);
  assert.match(getElementById('app').innerHTML,/ev-shell/);
  location.pathname='/';await handlers.popstate();
  assert.equal(vm.runInContext('page',sandbox),'hub');
  assert.match(getElementById('app').innerHTML,/href="\/evenements\//);
  await sandbox.switchEvent(fixture.event.slug);
  assert.equal(location.pathname,'/evenements/'+encodeURIComponent(fixture.event.slug));
  location.pathname='/evenements/'+encodeURIComponent(fixture.event.slug)+'/voiture';
  await handlers.popstate();
  assert.equal(vm.runInContext('page',sandbox),'voiture');
  assert.match(getElementById('app').innerHTML,/FICHE VOITURE/);
});

test('Temporary events outage preserves GDSP hub, Global navigation and admin login; retry recovers', async () => {
  let offline=true;
  const {sandbox,getElementById,calls}=makeBrowser([],url=>{
    if(url==='/api/events'&&offline)return response({error:'Unavailable'},503);
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('backendMulti',sandbox),true);
  assert.match(getElementById('nav').innerHTML,/GLOBAL/);
  assert.match(getElementById('app').innerHTML,/Connexion au serveur interrompue/);
  assert.match(getElementById('app').innerHTML,/La piste,<br>entre gentlemen/);
  assert.equal(calls.filter(c=>c.url==='/api/events').length,2);
  await sandbox.go('admin');
  assert.match(getElementById('app').innerHTML,/id="adminuser"/);
  assert.match(getElementById('app').innerHTML,/id="adminpass"/);
  offline=false;await sandbox.retryBackend();
  assert.equal(vm.runInContext('backendError',sandbox),'');
  assert.ok(vm.runInContext('events.length',sandbox)>0);
  assert.equal(calls.some(c=>c.url==='/api/championship'),false);
});

test('Cold-start events failure retries successfully without falling back to Lola legacy',async()=>{
  let attempts=0;
  const {sandbox,getElementById}=makeBrowser([],url=>{
    if(url==='/api/events'&&attempts++===0)return response({},502);
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('backendMulti',sandbox),true);
  assert.equal(vm.runInContext('backendError',sandbox),'');
  assert.match(getElementById('app').innerHTML,/La piste,<br>entre gentlemen/);
});

test('Malformed events response is an outage, not a successful empty catalog or legacy detection',async()=>{
  const {sandbox}=makeBrowser([],url=>url==='/api/events'?response({unexpected:true}):null);
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('backendMulti',sandbox),true);
  assert.ok(vm.runInContext('backendError',sandbox));
});

test("L'onglet LIVE est détecté avant le premier rendu (pas seulement après navigation)", () => {
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','site.js'),'utf8');
  const boot=src.indexOf('// ---------- BOOTSTRAP ----------');
  assert.ok(boot>0,'bootstrap introuvable');
  const after=src.slice(boot);
  const iDetect=after.indexOf('detectLiveTiming()');
  const iFirstRender=after.indexOf('render()');
  assert.ok(iDetect>0 && iFirstRender>0,'appels introuvables dans le bootstrap');
  assert.ok(iDetect<iFirstRender, "detectLiveTiming doit précéder le premier render (onglet LIVE visible tout de suite)");
  // La détection n'accepte pas n'importe quelle réponse 200 : elle exige du JSON.
  assert.match(src,/content-type[^\n]*json/i);
});

test('Global v2 exposes its window and pending commission without changing sporting standings', async()=>{
  const {sandbox,getElementById}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext(`loadEvent(${JSON.stringify(fixture.event.slug)})`,sandbox);
  vm.runInContext("adminAuth=true;adminTab='adjust';selectedRaceAdj=1;page='admin';render()",sandbox);
  assert.match(getElementById('app').innerHTML,/Propreté :/);
  assert.match(getElementById('app').innerHTML,/qualifie chaque incident/);
  const before=JSON.stringify(vm.runInContext('calculate().map(d=>({id:d.id,total:d.total}))',sandbox));
  vm.runInContext("globalThis.conductKey=Object.keys(penMap).find(k=>/^\\d+:\\d+:/.test(k));globalThis.originalAdj=JSON.stringify(penMap[conductKey]);",sandbox);
  const prompts=['1','3','Contact responsable, attente validée sur replay'];
  sandbox.prompt=()=>prompts.shift()??null;
  sandbox.confirm=text=>!text.includes('acte volontaire');
  await vm.runInContext("adminToken='tok';qualifyConduct(conductKey)",sandbox);
  assert.equal(vm.runInContext('penMap[conductKey].conduct.incidents[0].severity',sandbox),'major');
  assert.equal(vm.runInContext('penMap[conductKey].conduct.incidents[0].returned',sandbox),true);
  assert.equal(vm.runInContext('penMap[conductKey].conduct.incidents[0].intentional',sandbox),false);
  const after=JSON.stringify(vm.runInContext('calculate().map(d=>({id:d.id,total:d.total}))',sandbox));
  assert.equal(after,before);
  const old=JSON.parse(vm.runInContext('originalAdj',sandbox));
  for(const [k,v] of Object.entries(old))assert.equal(JSON.stringify(vm.runInContext(`penMap[conductKey][${JSON.stringify(k)}]`,sandbox)),JSON.stringify(v));
});

test('Commission qualification is cancelled atomically and unauthenticated calls cannot change it', async()=>{
  const {sandbox}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext(`loadEvent(${JSON.stringify(fixture.event.slug)})`,sandbox);
  vm.runInContext("globalThis.testKey=Object.keys(penMap).find(k=>/^\\d+:\\d+:/.test(k));globalThis.beforeReview=JSON.stringify(penMap);adminAuth=true",sandbox);
  sandbox.prompt=()=>null;
  await vm.runInContext('qualifyConduct(testKey)',sandbox);
  assert.equal(vm.runInContext('JSON.stringify(penMap)===beforeReview',sandbox),true);
  vm.runInContext('adminAuth=false',sandbox);
  sandbox.prompt=()=>{throw Error('No prompt without authentication')};
  await vm.runInContext('qualifyConduct(testKey)',sandbox);
});

test('Catalogue local : menus même sans événements, variantes et sélections historiques conservées',async()=>{
  const catalog={scannedAt:'2026-11-11T12:00:00Z',sources:[{id:'source-1',path:'D:\\content',status:'available'}],cars:[{id:'lola',name:'Lola <test>',brand:'Lola',source:'source-1',metadataAvailable:true}],tracks:[{id:'spa/short',trackId:'spa',layoutId:'short',name:'Spa court',source:'source-1',metadataAvailable:true}],warnings:[]};
  const {sandbox,getElementById}=makeBrowser([],url=>url.startsWith('/api/admin/local-mods')?response(catalog):null);
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("adminAuth=true;adminTab='events';page='admin';events=[];render()",sandbox);
  assert.match(getElementById('app').innerHTML,/Actualiser les voitures et circuits/);
  assert.match(getElementById('app').innerHTML,/Créer un événement/);
  await vm.runInContext('loadLocalMods(true)',sandbox);
  assert.match(getElementById('app').innerHTML,/Lola &lt;test&gt;/);
  assert.match(getElementById('app').innerHTML,/spa\/short/);
  vm.runInContext("eventContext={data:{modSelection:{cars:[{id:'missing',name:'Ancienne voiture'}],track:{id:'old/layout',trackId:'old',layoutId:'layout',name:'Ancien tracé'}}}};render()",sandbox);
  assert.match(getElementById('app').innerHTML,/disponibilité à vérifier/);
  getElementById('local-mod-cars').selectedOptions=[{value:'missing'}];
  getElementById('local-mod-track').value='old/layout';
  const selection=vm.runInContext('readLocalModSelection()',sandbox);
  assert.equal(selection.cars[0].id,'missing');assert.equal(selection.track.layoutId,'layout');
  sandbox.document.querySelectorAll=selector=>selector==='#local-mod-cars input[data-local-car-id]'?[
    {value:'lola',checked:false},{value:'missing',checked:true}
  ]:[];
  const checkboxSelection=vm.runInContext('readLocalModSelection()',sandbox);
  assert.deepEqual(Array.from(checkboxSelection.cars,car=>car.id),['missing'],'la sélection par cases à cocher doit conserver uniquement les voitures cochées');
});

test('Catalogue local : sélection et calendrier persistés sans effacer les sessions ou la commission',async()=>{
  let remote=null;
  const catalog={scannedAt:'2026-11-11T12:00:00Z',sources:[],cars:[{id:'lola',name:'Lola T290',brand:'Lola',category:'race',year:'1972',country:'Great Britain',author:'ACTK',version:'v2.1',url:'http://www.assetto-fr.tk',description:"Lola's historic prototype.\n\nLucas fuel injection.",tags:['#ACL Prototypes','rwd'],specs:{bhp:'260 bhp',torque:'230Nm',weight:'610kg',topspeed:'280+km/h',pwratio:'2.41kg/cv'},powerCurve:[[0,0],[8000,247.245],[9000,260]],torqueCurve:[[0,0],[7000,230],[9000,209.09]],metadataAvailable:true}],tracks:[{id:'spa/short',trackId:'spa',layoutId:'short',name:'Spa court'}],warnings:[]};
  const {sandbox,getElementById,calls}=makeBrowser([], (url,opts)=>{
    if(url.startsWith('/api/admin/local-mods'))return response(catalog);
    if(url==='/api/admin/circuits/import-local')return response({ok:true,round:{
      id:'local:2027-03-10:spa/short',date:'2027-03-10',name:'Spa court fiche',shortName:'Spa court',round:1,label:'M1',
      driverFolder:'spa',trackId:'spa',layoutId:'short',layout:'Short',country:'Belgique',countryCode:'BEL',status:'upcoming',source:'Mod local Assetto Corsa',
      officialLength:'4.260 km',officialLengthM:4260,lengthM:4258,lengthStr:'4,258 km',width:'10 m',year:'2026',author:'GDSP',version:'1.0',
      outline:{path:'M34 34 L500 80 Z',viewBox:'0 0 1000 560',start:{x:34,y:34},sectors:[],corners:[]},profile:{path:'M0 100 L1000 0',min:0,max:100,delta:100},profiles:{},
      sectorSplits:[{label:'S1',from:0,to:4258}],surfaces:[{key:'ROAD',label:'Asphalte',grip:99,valid:true,pit:false,note:'Surface de course principale'}],
      surfaceFile:'short/data/surfaces.ini',overlaysFile:'short/overlays.ini',description:'Circuit local',tags:['historic'],trackUrl:'https://example.com/spa',
      importWarnings:['surfaces.ini absent du mod sélectionné'],importedFiles:['short/ai/fast_lane.ai','ui/short/ui_track.json']
    },warnings:['surfaces.ini absent du mod sélectionné']});
    if(remote&&url==='/api/events/'+fixture.event.slug)return response(remote);
    if(remote&&url==='/api/events/'+fixture.event.slug+'/data'&&opts.method==='POST'){
      remote.data=JSON.parse(opts.body);return response({ok:true});
    }
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext(`loadEvent(${JSON.stringify(fixture.event.slug)})`,sandbox);
  remote={slug:fixture.event.slug,data:JSON.parse(vm.runInContext('JSON.stringify(eventContext.data)',sandbox))};
  const driveFiche={id:'drive-existing-round',round:7,label:'M7',name:'Fiche conservée depuis Drive',source:'Google Drive'};
  remote.data.circuitRounds=[driveFiche];
  vm.runInContext(`eventContext.data.circuitRounds=${JSON.stringify([driveFiche])}`,sandbox);
  const originalSessions=JSON.stringify(remote.data.sessions),originalPen=JSON.stringify(remote.data.penMap);
  vm.runInContext("adminAuth=true;adminToken='tok';adminTab='events';page='admin'",sandbox);
  await vm.runInContext('loadLocalMods(true)',sandbox);
  getElementById('local-mod-cars').selectedOptions=[{value:'lola'}];getElementById('local-mod-track').value='spa/short';
  await vm.runInContext('saveLocalModSelection()',sandbox);
  assert.equal(remote.data.modSelection.track.layoutId,'short');
  assert.equal(remote.data.eventInfo.car,'Lola T290');
  assert.equal(remote.data.carSheets[0].specs.bhp,'260 bhp');
  assert.equal(remote.data.carSheets[0].specs.torque,'230Nm');
  assert.equal(remote.data.carSheets[0].year,'1972');
  assert.equal(remote.data.carSheets[0].country,'Great Britain');
  assert.equal(remote.data.carSheets[0].url,'http://www.assetto-fr.tk');
  assert.deepEqual(remote.data.carSheets[0].powerCurve,[{rpm:0,value:0},{rpm:8000,value:247.245},{rpm:9000,value:260}]);
  assert.deepEqual(remote.data.carSheets[0].torqueCurve,[{rpm:0,value:0},{rpm:7000,value:230},{rpm:9000,value:209.09}]);
  assert.equal(JSON.stringify(remote.data.sessions),originalSessions);assert.equal(JSON.stringify(remote.data.penMap),originalPen);
  getElementById('local-mod-cars').selectedOptions=[{value:'lola'}];getElementById('local-mod-track').value='spa/short';getElementById('local-mod-date').value='2027-03-10';
  await vm.runInContext('addLocalModRound()',sandbox);
  assert.equal(remote.data.customCalendar['2027-03-10'].layout,'short');
  assert.equal(remote.data.circuitRounds[0].name,'Fiche conservée depuis Drive');
  assert.equal(remote.data.circuitRounds[0].source,'Google Drive');
  assert.equal(remote.data.circuitRounds[1].name,'Spa court fiche');
  assert.equal(remote.data.circuitRounds[1].round,8,'la fiche locale ne remplace ni la fiche Drive ni les six fiches statiques Lola');
  assert.equal(remote.data.circuitRounds[1].officialLengthM,4260);
  assert.equal(remote.data.circuitRounds[1].surfaces[0].label,'Asphalte');
  assert.equal(remote.data.circuitRounds[1].importedFiles[0],'short/ai/fast_lane.ai');
  await vm.runInContext('saveRemote()',sandbox);
  const saved=calls.filter(c=>c.url.endsWith('/data')&&c.method==='POST').at(-1).body;
  assert.equal(saved.modSelection.track.id,'spa/short');
  assert.equal(saved.customCalendar['2027-03-10'].trackName,'Spa court');
  assert.equal(saved.circuitRounds[0].name,'Fiche conservée depuis Drive');
  assert.equal(saved.circuitRounds[1].name,'Spa court fiche');
  assert.equal(saved.circuitRounds[1].officialLength,'4.260 km');
  assert.equal(saved.circuitRounds[1].officialLengthM,4260);
  assert.equal(saved.circuitRounds[1].description,'Circuit local');
  assert.deepEqual(Array.from(saved.circuitRounds[1].tags),['historic']);
  assert.equal(saved.circuitRounds[1].trackUrl,'https://example.com/spa');
  assert.deepEqual(Array.from(saved.circuitRounds[1].surfaces, row=>row.label),['Asphalte']);
  assert.deepEqual(Array.from(saved.circuitRounds[1].importWarnings),['surfaces.ini absent du mod sélectionné']);
  await vm.runInContext("setEventSubTab('voiture')",sandbox);
  const carSheetHtml=getElementById('app').innerHTML;
  assert.match(carSheetHtml,/FICHE VOITURE/);
  assert.match(carSheetHtml,/Lola T290/);
  assert.match(carSheetHtml,/260 bhp/);
  assert.match(carSheetHtml,/610kg/);
  assert.match(carSheetHtml,/Great Britain/);
  assert.match(carSheetHtml,/1972/);
  assert.match(carSheetHtml,/Courbes moteur/);
  assert.match(carSheetHtml,/Puissance moteur/);
  assert.match(carSheetHtml,/Couple moteur/);
  assert.match(carSheetHtml,/230 Nm/);
  assert.match(carSheetHtml,/href="http:\/\/www\.assetto-fr\.tk"/);
  assert.match(carSheetHtml,/Lucas fuel injection/);
  assert.match(carSheetHtml,/Afficher les 3 valeurs/);
});

test('Manche locale sans fast_lane.ai : l’entrée calendrier est conservée sans fausse fiche Circuit',async()=>{
  let remote=null;
  const catalog={scannedAt:'2026-11-11T12:00:00Z',sources:[],cars:[],tracks:[{id:'track/layout',trackId:'track',layoutId:'layout',name:'Circuit incomplet'}],warnings:[]};
  const {sandbox,getElementById}=makeBrowser([], (url,opts)=>{
    if(url.startsWith('/api/admin/local-mods'))return response(catalog);
    if(url==='/api/admin/circuits/import-local')return response({ok:true,round:null,warnings:['fast_lane.ai absent du mod sélectionné : fiche technique non importée']});
    if(remote&&url==='/api/events/'+fixture.event.slug)return response(remote);
    if(remote&&url==='/api/events/'+fixture.event.slug+'/data'&&opts.method==='POST'){
      remote.data=JSON.parse(opts.body);return response({ok:true});
    }
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext(`loadEvent(${JSON.stringify(fixture.event.slug)})`,sandbox);
  remote={slug:fixture.event.slug,data:JSON.parse(vm.runInContext('JSON.stringify(eventContext.data)',sandbox))};
  vm.runInContext("adminAuth=true;adminToken='tok'",sandbox);
  await vm.runInContext('loadLocalMods(true)',sandbox);
  getElementById('local-mod-cars').selectedOptions=[];
  getElementById('local-mod-track').value='track/layout';
  getElementById('local-mod-date').value='2027-04-01';
  await vm.runInContext('addLocalModRound()',sandbox);
  assert.equal(remote.data.customCalendar['2027-04-01'].track,'track');
  assert.equal(remote.data.circuitRounds,undefined);
});

test('Création depuis le catalogue : identifiants, calendrier et fiche locale inclus dans le POST initial',async()=>{
  const image='assets/mod-previews/'+'f'.repeat(64)+'.jpg';
  const {sandbox,getElementById,calls}=makeBrowser([], (url,opts)=>{
    if(url==='/api/admin/cars/import-liveries')return response({liveries:[{name:'GT Racing',image,number:'12'}]});
    if(url==='/api/admin/circuits/import-local')return response({ok:true,round:{
      id:'local:2027-04-01:track/layout',name:'Circuit variante · fiche',date:'2027-04-01',round:1,label:'M1',
      driverFolder:'track',trackId:'track',layoutId:'layout',status:'upcoming',officialLength:'3200',officialLengthM:3200,
      description:'Circuit historique',tags:['historic'],trackUrl:'https://example.com/track',
      surfaces:[{key:'ROAD',label:'Asphalte',grip:99,valid:true,pit:false,note:'Surface de course principale'}],
      importWarnings:['fast_lane.ai absent'],importedFiles:['ui/layout/ui_track.json']
    },warnings:['fast_lane.ai absent']});
    if(url==='/api/events'&&opts.method==='POST')return response({error:'Arrêt du scénario de test après capture'},409);
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  sandbox.initialCatalog={scannedAt:'2026-11-11',sources:[],cars:[{id:'car',name:'Voiture GT',brand:'Constructeur',category:'GT historique',year:'1974',specs:{bhp:'250 ch',weight:'900 kg'},metadataAvailable:true}],tracks:[{id:'track/layout',trackId:'track',layoutId:'layout',name:'Circuit variante'}],warnings:[]};
  vm.runInContext('localModsCatalog=initialCatalog;adminAuth=true',sandbox);
  getElementById('local-mod-cars').selectedOptions=[{value:'car'}];
  getElementById('local-mod-track').value='track/layout';getElementById('local-mod-date').value='2027-04-01';
  const prompts=['Nouvel open','open','nouvel-open','0.5','25,18,15','0'];sandbox.prompt=()=>prompts.shift();
  await vm.runInContext('createEventPrompt()',sandbox);
  const body=calls.find(c=>c.url==='/api/events'&&c.method==='POST').body;
  assert.equal(body.data.modSelection.cars[0].id,'car');assert.equal(body.data.modSelection.cars[0].name,'Voiture GT');assert.equal(body.data.modSelection.track.layoutId,'layout');
  assert.equal(body.data.eventInfo.car,'Voiture GT');
  assert.equal(body.data.carSheets[0].specs.bhp,'250 ch');
  assert.equal(body.data.carSheets[0].category,'GT historique');
  assert.equal(body.data.carSheets[0].liveries[0].image,image);
  assert.equal(body.data.customCalendar['2027-04-01'].track,'track');
  assert.equal(body.data.circuitRounds[0].name,'Circuit variante · fiche');
  assert.equal(body.data.circuitRounds[0].round,1);
  assert.equal(body.data.circuitRounds[0].officialLengthM,3200);
  assert.equal(body.data.circuitRounds[0].description,'Circuit historique');
  assert.deepEqual(Array.from(body.data.circuitRounds[0].tags),['historic']);
  assert.equal(body.data.circuitRounds[0].surfaces[0].label,'Asphalte');
  assert.deepEqual(Array.from(body.data.circuitRounds[0].importedFiles),['ui/layout/ui_track.json']);
});

test('Événement non-Lola : Circuit est créé dès la sélection même sans fast_lane.ai, et Voiture reste accessible sans plateau',async()=>{
  const cup={slug:'gt-open-2027',name:'GT Open 2027',kind:'open',points_config:{},data:{
    modSelection:{version:1,cars:[],track:{id:'spa/gp',trackId:'spa',layoutId:'gp',name:'Spa Grand Prix',country:'Belgique'}}
  }};
  const {sandbox,getElementById}=makeBrowser([cup],url=>url==='/api/events/gt-open-2027'?response(cup):null);
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('gt-open-2027')",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='event';render()",sandbox);
  const homeHtml=getElementById('app').innerHTML;
  assert.match(homeHtml,/Circuit <span class="ev-subtab-badge">M1/);
  assert.match(homeHtml,/Voiture <span class="ev-subtab-badge">À définir/);
  await vm.runInContext("setEventSubTab('circuit')",sandbox);
  const circuitHtml=getElementById('app').innerHTML;
  assert.match(circuitHtml,/Spa Grand Prix/);
  assert.match(circuitHtml,/Fiche technique partielle/);
  assert.match(circuitHtml,/fast_lane\.ai/);
  await vm.runInContext("setEventSubTab('voiture')",sandbox);
  assert.match(getElementById('app').innerHTML,/Aucune voiture n’est encore associée/);
});

test('Circuit : la manche planifiée sans fiche locale conserve sa variante et les dates répétées',async()=>{
  const cup={slug:'historic-open-2027',name:'Historic Open 2027',kind:'open',points_config:{},data:{
    customCalendar:{
      '2027-04-01':{track:'spa',layout:'gp',trackName:'Spa Grand Prix'},
      '2027-05-01':{track:'spa',layout:'gp',trackName:'Spa Grand Prix'}
    },
    modSelection:{version:1,cars:[],track:{id:'spa/gp',trackId:'spa',layoutId:'gp',name:'Spa Grand Prix'}}
  }};
  const {sandbox}=makeBrowser([cup],url=>url==='/api/events/historic-open-2027'?response(cup):null);
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('historic-open-2027')",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  const circuitRounds=vm.runInContext('circuitsCache.rounds',sandbox);
  assert.equal(circuitRounds.length,2,'deux dates sur le même tracé doivent donner deux manches');
  assert.deepEqual(Array.from(circuitRounds,round=>round.date),['2027-04-01','2027-05-01']);
  assert.ok(circuitRounds.every(round=>round.layoutId==='gp'&&round.technicalUnavailable));
});

test('Circuit local partiel : affiche les métadonnées et les avertissements sans carte vide ni HTML',async()=>{
  const {sandbox,getElementById}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`eventContext={slug:'local-track-open',name:'Open circuit local',kind:'open',pointsConfig:{},data:{}};currentSlug='local-track-open';page='circuit';circuitsCache={totalCount:1,completedCount:0,seasonBest:null,rounds:[{
    id:'local:undated:test-track/gp',round:1,label:'M1',name:'Test Track GP',shortName:'Test Track',status:'upcoming',date:null,country:'France',countryCode:'FRA',city:'Hillion',layout:'Grand Prix',layoutKey:'gp',trackId:'test-track',layoutId:'gp',driverFolder:'test-track',
    direction:'clockwise',pitboxes:'24',width:'10 m',year:'2026',author:'GDSP',version:'1.0',format:'À confirmer',source:'Mod local Assetto Corsa',driveName:'test-track',officialLength:'4.260 km',officialLengthM:4260,lengthM:null,lengthStr:'4,260 km (ui_track.json)',elevation:null,outline:null,profile:null,profiles:{},sectorSplits:[{label:'S1',from:0,to:2130},{label:'S2',from:2130,to:4260}],sectorFractions:[{label:'S1',from:0,to:0.5},{label:'S2',from:0.5,to:1}],sectorCount:2,cornerCount:0,surfaces:[{key:'ROAD',label:'Asphalte',grip:99,valid:true,pit:false,note:'Surface de course principale'}],surfaceFile:'gp/data/surfaces.ini',overlaysFile:'gp/overlays.ini',technicalUnavailable:true,description:'Description <img src=x onerror=alert(1)>',tags:['historique','mod local'],trackUrl:'https://example.com/track',importWarnings:['fast_lane.ai absent : tracé non dessiné'],importedFiles:['ui/gp/ui_track.json','gp/data/surfaces.ini']
  }]};render()`,sandbox);
  const html=getElementById('app').innerHTML;
  assert.match(html,/Fiche technique partielle/);
  assert.match(html,/Tracé indisponible/);
  assert.match(html,/Description &lt;img/);
  assert.doesNotMatch(html,/<img src=x/);
  assert.match(html,/href="https:\/\/example\.com\/track"/);
  assert.match(html,/fast_lane\.ai absent/);
  assert.match(html,/ui\/gp\/ui_track\.json/);
  assert.match(html,/Asphalte/);
  assert.match(html,/4\.260 km/);
  vm.runInContext("setCircMode('sectors')",sandbox);
  const sectorHtml=getElementById('app').innerHTML;
  assert.match(sectorHtml,/Bornes lues dans les fichiers locaux disponibles/);
  assert.match(sectorHtml,/2 130 m/);
  assert.match(sectorHtml,/m annoncés/);
});

test('Circuit : résultats QUALIFY/RACE importés font passer la manche à Disputée sans recalculer les classements',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const fiche={
    id:'local:2027-04-14:spa/gp',round:1,label:'M1',name:'Spa Grand Prix',shortName:'Spa',
    driverFolder:'spa',trackId:'spa',layoutId:'gp',date:'2027-04-14',status:'upcoming',
    layout:'Grand Prix',layoutKey:'gp',country:'Belgique',city:'Spa',countryCode:'BEL',
    direction:'clockwise',pitboxes:24,width:'10 m',lengthM:7000,lengthStr:'7,000 km',
    elevation:{min:0,max:100,delta:100},profile:{path:'M0 100 L1000 0',closed:'M0 100 L1000 0 L1000 120 L0 120 Z',min:0,max:100,delta:100},
    outline:{path:'M34 34 L500 80 L34 34 Z',viewBox:'0 0 1000 560',start:{x:34,y:34},sectors:[],corners:[]},
    profiles:{},sectorSplits:[{label:'S1',from:0,to:7000}],surfaces:[],stats:null,format:null,
    source:'Mod local Assetto Corsa',hero:null
  };
  const sessions=[
    {date:'2027-04-14T20:00:00Z',track:'spa',type:'QUALIFY',results:[{id:'p1',name:'Pilote test',best:90000}]},
    {date:'2027-04-14T21:00:00Z',track:'spa',type:'RACE',results:[{id:'p1',name:'Pilote test',best:91000,time:100000}]}
  ];
  vm.runInContext(`eventContext={slug:'spa-cup',name:'Open de Spa',kind:'open',pointsConfig:{},data:{circuitRounds:[${JSON.stringify(fiche)}]}};currentSlug='spa-cup';sessions.length=0;sessions.push(...${JSON.stringify(sessions)});circuitsCache=null;circuitsError=''`,sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  assert.equal(vm.runInContext('circuitsCache.rounds[0].status',sandbox),'done');
  assert.equal(vm.runInContext('circuitsCache.rounds[0].resultsImported',sandbox),true);
  assert.equal(vm.runInContext('circuitsCache.completedCount',sandbox),1);
  const html=vm.runInContext('circuit()',sandbox);
  assert.match(html,/Disputée/);
  assert.match(html,/Résultats disponibles/);
  assert.match(html,/disponibles dans l’onglet Résultats/);
  assert.doesNotMatch(html,/Manche<\/small>à venir/i);
  assert.doesNotMatch(html,/n'a pas encore été disputée/);
  vm.runInContext("sessions.splice(0,sessions.length,{date:'2027-04-14T21:00:00Z',track:'spa',type:'PRACTICE',results:[{id:'p1',name:'Pilote test'}]});circuitsCache=null",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  assert.equal(vm.runInContext('circuitsCache.rounds[0].status',sandbox),'upcoming','PRACTICE ne suffit pas à déclarer une manche disputée');
  const upcoming=vm.runInContext('circuit()',sandbox);
  assert.match(upcoming,/Cal\.<\/i> 14 avril 2027/);
  assert.match(upcoming,/À venir · 14 avril 2027/);
  vm.runInContext("eventContext.data.circuitRounds[0].date=null;eventContext.data.customCalendar={'2027-04-14':{track:'spa',layout:'gp'}};circuitsCache=null",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  assert.match(vm.runInContext('circuit()',sandbox),/Cal\.<\/i> 14 avril 2027/);
  assert.equal(vm.runInContext("circuitDateLabel({status:'upcoming'})",sandbox),'Date à confirmer');
});

test('Global incomplet : garde les données en mémoire, propose un nouvel essai sans faux classement',async()=>{
  const extra={slug:'offline-cup',name:'Cup indisponible',kind:'archive'};
  const {sandbox}=makeBrowser([extra],url=>url==='/api/events/offline-cup'?response({error:'unavailable'},503):null);
  await new Promise(resolve=>setImmediate(resolve));
  const html=await vm.runInContext('globalRanking()',sandbox);
  assert.match(html,/Aucun classement partiel/);assert.match(html,/Réessayer/);
  assert.equal(vm.runInContext("events.find(e=>e.slug==='offline-cup').__loaded",sandbox),false);
});

test('Exclusions indisponibles : secours visible et échec de sauvegarde annoncé',async()=>{
  const {sandbox,getElementById}=makeBrowser([],url=>url==='/api/global-exclusions'?response({error:'unavailable'},503):null);
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext('loadGlobalHidden()',sandbox);
  assert.match(vm.runInContext('exclusionsStatus()',sandbox),/copie locale/);
  const alerts=[];sandbox.alert=message=>alerts.push(message);
  vm.runInContext('adminAuth=true',sandbox);
  await vm.runInContext('saveGlobalHidden()',sandbox);
  assert.match(alerts[0],/sauvegarde serveur non confirmée/);
});

test('Le jeton administrateur n’est plus écrit dans localStorage',()=>{
  assert.doesNotMatch(siteSource,/localStorage\.setItem\(['"]gdsp_admin_token/);
  assert.doesNotMatch(siteSource,/sessionStorage\.(getItem|setItem)\(['"]gdsp_admin_token/);
  assert.match(siteSource,/gdspAuth/);
  const telemetry=fs.readFileSync(path.join(root,'telemetry.html'),'utf8');
  assert.doesNotMatch(telemetry,/localStorage\.setItem\(STORAGE_KEY/);
  assert.doesNotMatch(telemetry,/sessionStorage\.(getItem|setItem)\(STORAGE_KEY/);
  assert.match(telemetry,/gdspAuth/);
  assert.doesNotMatch(siteSource,/cdn\.discordapp\.com[^"\s]*Reglement_Piste_GDSP/);
  assert.match(siteSource,/\/docs\/reglement-piste-gdsp-v2024-12\.pdf/);
});

test('cookie existant : rétablit l’interface administrateur au chargement, sans jeton stocké',async()=>{
  const {sandbox}=makeBrowser([],null,{authenticatedSession:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('adminAuth',sandbox),true);
  assert.equal(vm.runInContext('adminToken',sandbox),true);
  assert.equal(vm.runInContext('page',sandbox),'admin');
  assert.doesNotMatch(siteSource,/Authorization.*Bearer/);
});

test('les tableaux débordants sont signalés et accessibles au clavier uniquement sur mobile',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const makeWrap=(scrollWidth,clientWidth)=>{
    const attrs=new Map(),classes=new Set();
    return{
      scrollWidth,clientWidth,
      classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name)},contains(name){return classes.has(name)}},
      setAttribute(name,value){attrs.set(name,String(value))},
      getAttribute(name){return attrs.has(name)?attrs.get(name):null},
      removeAttribute(name){attrs.delete(name)}
    };
  };
  const overflowing=makeWrap(620,340),fitting=makeWrap(340,340);
  sandbox.document.querySelectorAll=selector=>selector==='#app .table-wrap'?[overflowing,fitting]:[];
  sandbox.matchMedia=query=>({matches:query==='(max-width: 800px)'});

  vm.runInContext('updateTableScrollHints()',sandbox);
  assert.equal(overflowing.classList.contains('has-overflow'),true);
  assert.equal(overflowing.getAttribute('role'),'region');
  assert.equal(overflowing.getAttribute('tabindex'),'0');
  assert.match(overflowing.getAttribute('aria-label'),/Faites glisser/);
  assert.equal(fitting.classList.contains('has-overflow'),false);
  assert.equal(fitting.getAttribute('role'),null);

  sandbox.matchMedia=()=>({matches:false});
  vm.runInContext('updateTableScrollHints()',sandbox);
  assert.equal(overflowing.classList.contains('has-overflow'),false);
  assert.equal(overflowing.getAttribute('role'),null);
  assert.equal(overflowing.getAttribute('tabindex'),null);
});

test('traduction par événement : original conservé, sauvegarde ordinaire et retour à l’original', async()=>{
  const {sandbox,calls}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const run=code=>vm.runInContext(code,sandbox);
  await run(`loadEvent(${JSON.stringify(fixture.event.slug)})`);
  run(`adminAuth=true;adminToken='test';eventContext.data.carSheets=[{id:'gt',description:'English text'}];`);
  const button={parentElement:{querySelector:()=>({dataset:{key:'car:gt'},value:'Texte français <b>'})}};
  await sandbox.saveSheetTranslation(button);
  assert.match(run('carSheet()'),/Texte français &lt;b&gt;/);
  assert.equal(run('eventCarSheets()[0].description'),'English text');
  await run('saveRemote()');
  assert.equal(calls.at(-1).body.sheetTranslations['car:gt'],'Texte français <b>');
  button.parentElement.querySelector=()=>({dataset:{key:'car:gt'},value:' '});
  await sandbox.saveSheetTranslation(button);
  assert.match(run('carSheet()'),/English text/);
});

for(const drive of [false,true])test(`actualisation ${drive?'Drive':'locale'} en place, puis source absente`,async()=>{
  const slug='open-test',url='/api/events/'+slug;
  const old={id:'fiche',name:'GP',round:2,date:'2027-05-01',status:'done',...(drive?{driveFolderId:'dossier'}:{trackId:'test',layoutId:'gp'})};
  const ev={slug,name:'Open',data:{sessions:[],penMap:{},circuitRounds:[old],sheetTranslations:{'track:fiche':'Traduction'}}};
  let available=true,writes=0;
  const {sandbox,calls}=makeBrowser([],async(path,opts)=>{
    if(path===url)return response(ev);
    if(path===url+'/data'){ev.data=JSON.parse(opts.body);writes++;return response({ok:true});}
    if(path==='/api/admin/circuits/import'+(drive?'':'-local'))return response(available?{round:{name:'GP actualisé',description:'New text',status:'upcoming',date:null},files:{},warnings:[]}:{round:null,warnings:['Circuit absent']});
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext(`loadEvent('${slug}')`,sandbox);
  vm.runInContext("adminAuth=true;adminToken='test'",sandbox);
  await sandbox.refreshEventCircuit(0,{});
  assert.equal(writes,1);
  assert.deepEqual(ev.data.circuitRounds.map(r=>[r.id,r.round,r.date,r.status,r.description]),[['fiche',2,'2027-05-01','done','New text']]);
  const args=calls.find(c=>c.url.startsWith('/api/admin/circuits/import')).body;
  assert.equal(drive?args.driveUrl:args.layoutId,drive?'dossier':'gp');
  assert.equal(ev.data.sheetTranslations['track:fiche'],'Traduction');
  available=false;
  await sandbox.refreshEventCircuit(0,{});
  assert.equal(writes,1,'un échec ne doit pas remplacer la fiche');
});

test('Onglets du tracé : splits et positions réels survivent à la sauvegarde, sans mélanger les variantes',async()=>{
  const {sandbox,calls}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const run=src=>vm.runInContext(src,sandbox);
  const fiche=JSON.parse(fs.readFileSync(path.join(root,'data/circuits.json'))).rounds[0];
  const raw={TrackName:fiche.driverFolder,TrackConfig:fiche.layoutKey,Cars:[{CarId:0,Driver:{Name:'Alice',Guid:'aa'}},{CarId:1,Driver:{Name:'Bob',Guid:'bb'}}],Result:[{CarId:0},{CarId:1}]};
  const lap=(CarId,Sectors,Cuts=0)=>({CarId,Sectors,Cuts,LapTime:Sectors.reduce((a,b)=>a+b,0)});
  const event={Type:'COLLISION_WITH_CAR',CarId:0,OtherCarId:1,ImpactSpeed:30};
  const rows=[
    {...raw,Type:'QUALIFY',Laps:[lap(0,[24000,31000,25000]),lap(0,[900,900,900],1)]},
    {...raw,Type:'RACE',Laps:[lap(1,[25000,27000,26000])],Events:[{...event,RelPosition:{X:1,Z:2}},{...event,WorldPosition:{X:10,Z:20}}]},
    {...raw,TrackConfig:'other',Type:'RACE',Laps:[lap(1,[1000,1000,1000])]},
  ];
  run('sessions=[];adminToken="ok"');
  rows.forEach((r,i)=>{sandbox.json=JSON.stringify({...r,Date:`2026-09-09T2${i}:00:00Z`});assert.equal(run('importSessionJson(json,"",{silent:true})'),true)});
  await run('saveRemote()');
  sandbox.saved=calls.findLast(c=>c.body?.sessions)?.body.sessions;
  sandbox.fixtureRound=fiche;
  run(`sessions=saved; circuitsCache={rounds:[fixtureRound]};eventContext={name:'Open',data:{}};page='circuit';setCircMode('sectors')`);
  const html=run('circuit()');
  assert.match(html,/S1<\/td><td>0:24\.000<\/td><td>Alice<small>Qualification/);
  assert.match(html,/S2<\/td><td>0:27\.000<\/td><td>Bob<small>Course/);
  assert.match(html,/S3<\/td><td>0:25\.000<\/td><td>Alice/);
  run("setCircMode('collisions')");
  const collisions=run('circuit()');
  assert.match(collisions,/Position indisponible/);
  assert.equal((collisions.match(/<g class="cir-crash /g)||[]).length,1);
  assert.match(collisions,/<text [^>]+>2<\/text><title>Alice \/ Bob/);
});

test('Direction de course : espaces distincts, imports conservés et miniatures propres à l’événement',async()=>{
  const {sandbox,calls}=makeBrowser();await new Promise(r=>setImmediate(r));
  const run=src=>vm.runInContext(src,sandbox);
  run("adminAuth=true;adminToken='ok';adminTab='desk';page='admin'");
  assert.match(run('admin()'),/Événement sélectionné[\s\S]+Administration générale[\s\S]+Télémétrie/);
  assert.match(run('admin()'),/Pilotes[\s\S]+Équipes/);
  assert.match(run('admin()'),/Télémétrie[\s\S]+Serveurs CM/);
  assert.doesNotMatch(run('admin()'),/adminTabs\('race-control'\)/);
  const savedEvent=run("eventContext");
  run("adminTab='race-control';eventContext=null");
  assert.match(run('admin()'),/Ouvrir le configurateur Race Control/);
  assert.match(run('admin()'),/href="\/race-control.html"/);
  assert.doesNotMatch(run('admin()'),/Sélectionne un championnat ou un open/);
  run("adminTab='servers'");
  assert.match(run('admin()'),/Serveurs CM[\s\S]+brouillon/);
  assert.match(run('admin()'),/Serveur CM 1[\s\S]+Serveur CM 2/);
  sandbox.savedEvent=savedEvent;run("eventContext=savedEvent");
  run("adminTab='import'");assert.match(run('admin()'),/ahImport\(\)[\s\S]+bulkImport\(event\)/);
  const id=run('allDrivers()[0].id');sandbox.id=id;
  const src='data:image/jpeg;base64,dGVzdA==';sandbox.file={files:[{type:'image/jpeg',size:10,dataUrl:src}]};
  await run('updateDriverPhoto(id,file)');await run('saveRemote()');
  assert.equal(calls.filter(c=>c.url.endsWith('/data')).at(-1).body.driverPhotos[id],src);
  assert.ok(run('driverGrid(allDrivers())').includes(src));
  run("eventContext={slug:'autre',name:'Autre',kind:'open',data:{}};");assert.equal(run('driverPhoto(id)'),'');
});

test('Direction de course : enregistrer une équipe conserve le nom et les résultats du pilote',async()=>{
  const {sandbox,calls}=makeBrowser();await new Promise(r=>setImmediate(r));
  const run=src=>vm.runInContext(src,sandbox);run("adminAuth=true;adminToken='ok';adminTab='teams';page='admin'");
  const driver=run('allDrivers()[0]');sandbox.button={parentElement:{dataset:{id:driver.id},querySelector:()=>({value:'  Écurie Armor  '})}};
  await run('saveDriverTeam(button)');const post=calls.findLast(c=>c.url.endsWith('/data'));
  assert.deepEqual(post.body.manualDrivers[driver.id],{name:driver.name,team:'Écurie Armor'});
  assert.equal(run('allDrivers()[0].team'),'Écurie Armor');assert.ok(post.body.sessions.length);
});

test('Gestion du paddock : onglet Circuit retiré, 2 onglets dans Événements et thème du site appliqué',async()=>{
  const {sandbox}=makeBrowser();await new Promise(r=>setImmediate(r));
  const run=src=>vm.runInContext(src,sandbox);
  run("adminAuth=true;adminToken='ok';adminTab='general';page='admin'");
  const generalHtml=run('admin()');
  assert.match(generalHtml,/class="adm-shell"[\s\S]*class="adm-banner"[\s\S]*class="adm-nav"/);
  assert.match(generalHtml,/Événements[\s\S]+Serveurs AssettoHosting[\s\S]+Exclusions globales/);
  assert.doesNotMatch(generalHtml,/adminOpenTool\('circuits'\)/);
  run("adminTab='events'");
  const catalogHtml=run('admin()');
  assert.match(catalogHtml,/id="adm-ev-tab-catalog"[^>]*aria-selected="true"/);
  assert.match(catalogHtml,/id="adm-ev-panel-catalog"[^>]*>/);
  assert.doesNotMatch(catalogHtml,/id="adm-ev-panel-catalog"[^>]*hidden/);
  assert.match(catalogHtml,/id="adm-ev-panel-editor"[^>]*hidden/);
  assert.match(catalogHtml,/Catalogue des événements[\s\S]+Création &amp; modification d’événement/);
  run("openEventsSubTab('editor')");
  const editorHtml=run('admin()');
  assert.match(editorHtml,/id="adm-ev-tab-editor"[^>]*aria-selected="true"/);
  assert.match(editorHtml,/id="adm-ev-panel-catalog"[^>]*hidden/);
  assert.doesNotMatch(editorHtml,/id="adm-ev-panel-editor"[^>]*hidden/);
  assert.match(editorHtml,/Préparer le plateau et le circuit[\s\S]+Onglet Accueil public/);
  const paddockCss=fs.readFileSync(path.join(root,'assets/admin-paddock.css'),'utf8');
  assert.match(paddockCss,/var\(--ink\)/);
  assert.match(paddockCss,/Impact/);
  assert.match(paddockCss,/\.adm-tabpanel\[hidden\]\s*\{\s*display:none/);
  assert.doesNotMatch(paddockCss,/#213b36|Georgia/);
});

test('Event kinds endurance, cup, fiesta, trackday : hub, switcher, poids Global et menu Accueil public', async () => {
  const mkRace = (date, trackName, bestMs) => ({
    date,
    track: trackName,
    type: 'RACE',
    results: [
      { id: 'd1', name: 'Pilote Un', laps: 10, time: 900000, best: bestMs },
      { id: 'd2', name: 'Pilote Deux', laps: 10, time: 910000, best: bestMs + 500 }
    ],
    laps: [
      { id: 'd1', time: bestMs + 2000 }, { id: 'd1', time: bestMs }, { id: 'd1', time: bestMs + 100 }, { id: 'd1', time: bestMs + 200 },
      { id: 'd2', time: bestMs + 2500 }, { id: 'd2', time: bestMs + 500 }, { id: 'd2', time: bestMs + 700 }, { id: 'd2', time: bestMs + 900 }
    ]
  });
  const baseEvents = [
    { slug: 'champ-1', name: 'Champ Principale', kind: 'championship', points_config: { globalCoef: 1 }, updated_at: '2026-11-01T10:00:00Z',
      data: { sessions: [mkRace('2026-10-01T20:00:00Z', 'spa', 90000), mkRace('2026-10-08T20:00:00Z', 'monza', 91000), mkRace('2026-10-15T20:00:00Z', 'imola', 92000)] } },
    { slug: 'endur-1', name: 'Endurance 2h', kind: 'endurance', points_config: { globalCoef: 1 }, updated_at: '2026-11-02T10:00:00Z',
      data: { sessions: [mkRace('2026-10-22T20:00:00Z', 'lemans', 180000)] } },
    { slug: 'cup-1', name: 'Porsche Cup', kind: 'cup', points_config: { globalCoef: 0.75 }, updated_at: '2026-11-03T10:00:00Z',
      data: { sessions: [mkRace('2026-10-29T20:00:00Z', 'mugello', 95000)] } },
    { slug: 'open-1', name: 'Open Estival', kind: 'open', points_config: { globalCoef: 0.5 }, updated_at: '2026-11-04T10:00:00Z',
      data: { sessions: [] } },
    { slug: 'fiesta-1', name: 'Fiesta Fun', kind: 'fiesta', points_config: { globalCoef: 0 }, updated_at: '2026-11-05T10:00:00Z',
      data: { sessions: [mkRace('2026-11-01T20:00:00Z', 'brands', 85000)] } },
    { slug: 'trackday-1', name: 'Trackday Libre', kind: 'trackday', points_config: { globalCoef: 0 }, updated_at: '2026-11-06T10:00:00Z',
      data: { sessions: [mkRace('2026-11-02T20:00:00Z', 'zandvoort', 86000)] } }
  ];
  const { sandbox, getElementById, calls } = makeBrowser(baseEvents, (url, opts = {}) => {
    const match = url.match(/^\/api\/events\/([^/]+)$/);
    if (!match) return null;
    const slug = decodeURIComponent(match[1]);
    const ev = baseEvents.find(e => e.slug === slug);
    if (!ev) return null;
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (body.kind) {
        ev.kind = body.kind;
        const map = { championship: 1, endurance: 1, cup: 0.75, open: 0.5, fiesta: 0, trackday: 0 };
        if (body.kind !== 'archive') ev.points_config = { ...(ev.points_config || {}), globalCoef: map[body.kind] };
      }
      return response({ status: 'ok', event: ev });
    }
    return response(ev);
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));

  const hubHtml = getElementById('app').innerHTML;
  assert.match(hubHtml, /Championnats<\/div><strong>02<\/strong>/);
  assert.match(hubHtml, /Événements<\/div><strong>07<\/strong>/);
  assert.match(hubHtml, /Endurances[\s\S]+Cups & trophées[\s\S]+Opens & week-ends[\s\S]+Fiestas[\s\S]+Trackdays/);
  assert.match(hubHtml, /coeff 0\.75/);
  assert.match(hubHtml, /coeff 0\.0/);
  const switcherHtml = getElementById('event-switcher').innerHTML;
  assert.match(switcherHtml, /optgroup label="Endurances"[\s\S]+optgroup label="Cups"[\s\S]+optgroup label="Opens"[\s\S]+optgroup label="Fiestas"[\s\S]+optgroup label="Trackdays"/);

  // Fiesta & Trackday (globalCoef = 0) are excluded from Global (5 races total from champ-1 + endur-1 + cup-1, not 7)
  const ratings = vm.runInContext('globalPerformanceRatings()', sandbox);
  assert.equal(ratings[0].count, 5);

  // Admin: Événement courant · Onglet Accueil public exposes the kind selector and updates via PUT
  await vm.runInContext("loadEvent('open-1')", sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';eventsSubTab='editor';page='admin';render()", sandbox);
  const editorHtml = getElementById('app').innerHTML;
  assert.match(editorHtml, /id="evinfo-kind"/);
  assert.match(editorHtml, /value="endurance"[^>]*>Endurance — poids Global ×1\.0/);
  assert.match(editorHtml, /value="cup"[^>]*>Cup — poids Global ×0\.75/);
  assert.match(editorHtml, /value="fiesta"[^>]*>Fiesta — poids Global ×0\.0/);
  assert.match(editorHtml, /value="trackday"[^>]*>Trackday — poids Global ×0\.0/);

  await vm.runInContext("changeCurrentEventKind('cup')", sandbox);
  const putCall = calls.filter(c => c.url === '/api/events/open-1' && c.method === 'PUT').at(-1);
  assert.deepEqual(putCall.body, { kind: 'cup' });
  assert.equal(vm.runInContext('eventContext.kind', sandbox), 'cup');
  assert.equal(vm.runInContext('eventContext.pointsConfig.globalCoef', sandbox), 0.75);
});

test('Fiche Voiture Kunos : logo importé, métadonnées skins/skin.ini et import manuel de fichiers AC', async () => {
  const logo='assets/mod-previews/'+'a'.repeat(64)+'.png';
  const image='assets/mod-previews/'+'b'.repeat(64)+'.jpg';
  let remote={slug:'alfa-gta',name:'Alfa GTA Classic',kind:'cup',points_config:{},data:{
    carSheets:[{id:'ks_alfa_romeo_giulia_gta',name:'Alfa Romeo Giulia GTA',brand:'Alfa Romeo',year:'Années 1970',country:'Italie',author:'Kunos Simulazioni',logo,liveries:[{image,name:'Misano Red',team:'',number:''}],specs:{},metadataSource:'skins',metadataAvailable:true}]
  }};
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/alfa-gta'&&(!opts||!opts.method||opts.method==='GET'))return response(remote);
    if(url==='/api/events/alfa-gta/data'&&opts.method==='POST'){
      remote={...remote,data:opts.body};
      return response({ok:true});
    }
    if(url==='/api/admin/cars/import-liveries')return response({liveries:[{name:'Misano Red',image,number:''}],logo});
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('alfa-gta')",sandbox);
  vm.runInContext("page='voiture';render()",sandbox);
  const html=getElementById('app').innerHTML;
  assert.match(html,/Alfa Romeo Giulia GTA/);
  assert.match(html,/Kunos Simulazioni/);
  assert.match(html,/Années 1970/);
  assert.match(html,/car-sheet-logo/);
  assert.match(html,/skin\.ini/);

  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()",sandbox);
  assert.doesNotMatch(getElementById('app').innerHTML,/car-files-import|track-files-import/);
});

test('Fiche Circuit estimée depuis cameras.ini sans imports manuels', async () => {
  let remote={slug:'prague-cup',name:'Prague Cup',kind:'cup',points_config:{},data:{
    circuitRounds:[{
      id:'local:undated:prague',round:1,label:'M1',name:'Prague',shortName:'Prague',trackId:'prague',layoutId:'',
      country:'République tchèque',city:'Prague',author:'Kavoriken, leBluem',version:'1.6',year:'2021',
      lengthM:5522,lengthStr:'5,522 km',elevation:{min:-73.9,max:-2.5,delta:71.4},
      outline:{path:'M0 0 L10 10 Z',viewBox:'0 0 100 100',samples:[],sectors:[],corners:[{id:1,dist:120,norm:0.1}]},
      profile:{path:'M0 10 L10 5',closed:'M0 10 L10 5 L10 120 L0 120 Z',min:-73.9,max:-2.5,delta:71.4},
      profiles:{default:{path:'M0 10 L10 5',closed:'M0 10 L10 5 L10 120 L0 120 Z',min:-73.9,max:-2.5,delta:71.4}},
      sectorSplits:[{label:'S1',from:0,to:1841},{label:'S2',from:1841,to:3681},{label:'S3',from:3681,to:5522}],
      surfaces:[{key:'COBBLE',label:'Pavés',grip:null,valid:true,note:'Détecté dans ext_config.ini'}],
      approximateOutline:true,outlineSource:'cameras.ini',technicalUnavailable:false,status:'upcoming'
    }]
  }};
  const {sandbox,getElementById}=makeBrowser([remote],(url)=>{
    if(url==='/api/events/prague-cup')return response(remote);
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('prague-cup')",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='circuit';render()",sandbox);
  const html=getElementById('app').innerHTML;
  assert.match(html,/tracé estimé depuis cameras\.ini/);
  assert.match(html,/5,522 km/);
  assert.match(html,/Pavés/);
});

test('Manche multi-circuits : calendrier, fiches Circuit, résultats et administration', async () => {
  const catalog={scannedAt:'2026-11-19T12:00:00Z',sources:[],cars:[],tracks:[
    {id:'spa/short',trackId:'spa',layoutId:'short',name:'Spa court',country:'Belgique',length:'4.26 km',metadataAvailable:true},
    {id:'monza/gp',trackId:'monza',layoutId:'gp',name:'Monza GP',country:'Italie',length:'5.79 km',metadataAvailable:true}
  ],warnings:[]};
  let remote={
    slug:'multi-circuit-cup',name:'Multi Circuit Cup',kind:'cup',points_config:{},
    data:{
      sessions:[
        {date:'2027-03-10T20:00:00Z',type:'RACE',track:'spa',results:[{id:'p1',name:'Alice',team:'Red',best:90000,laps:10,totalTime:900000,grid:1}]},
        {date:'2027-03-10T21:00:00Z',type:'RACE',track:'monza',results:[{id:'p1',name:'Alice',team:'Red',best:105000,laps:10,totalTime:1050000,grid:1}]}
      ],
      penMap:{}
    }
  };
  const {sandbox,getElementById}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/multi-circuit-cup'&&(!opts||!opts.method||opts.method==='GET'))return response(remote);
    if(url==='/api/events/multi-circuit-cup/data'&&opts.method==='POST'){
      remote={...remote,data:JSON.parse(opts.body)};
      return response({ok:true});
    }
    if(url.startsWith('/api/admin/local-mods'))return response(catalog);
    if(url==='/api/admin/circuits/import-local'){
      const body=JSON.parse(opts.body);
      const isMonza=body.trackId==='monza';
      return response({ok:true,round:{
        id:`local:${body.date||'undated'}:${body.trackId}/${body.layoutId}`,
        date:body.date||null,
        name:isMonza?'Monza GP':'Spa court',
        shortName:isMonza?'Monza':'Spa',
        round:body.round||1,
        label:`M${body.round||1}`,
        trackId:body.trackId,localTrackId:body.trackId,
        layoutId:body.layoutId,localLayoutId:body.layoutId,
        lengthM:isMonza?5793:4260,lengthStr:isMonza?'5,793 km':'4,260 km',
        elevation:{min:0,max:20,delta:20},
        outline:{path:'M0 0 L10 10 Z',viewBox:'0 0 100 100',samples:[],sectors:[],corners:[]},
        profile:{path:'M0 10 L10 5',closed:'M0 10 L10 5 L10 120 L0 120 Z',min:0,max:20,delta:20},
        sectorSplits:[{label:'S1',from:0,to:2000}],surfaces:[],status:'upcoming'
      },warnings:[]});
    }
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('multi-circuit-cup')",sandbox);

  // 1. rounds() regroupe les 2 sessions du 2027-03-10 et expose les 2 circuits
  const rs=vm.runInContext('rounds()',sandbox);
  assert.equal(rs.length,1);
  assert.equal(rs[0].tracks.length,2);
  assert.match(rs[0].track,/spa/i);
  assert.match(rs[0].track,/monza/i);

  // 2. Ajout de 2 circuits dans la même manche via queueLocalModTrack + addLocalModRound
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin'",sandbox);
  await vm.runInContext('loadLocalMods(true)',sandbox);
  getElementById('local-mod-track').value='spa/short';
  vm.runInContext('queueLocalModTrack()',sandbox);
  getElementById('local-mod-track').value='monza/gp';
  getElementById('local-mod-date').value='2027-03-10';
  await vm.runInContext('addLocalModRound()',sandbox);

  assert.equal(remote.data.customCalendar['2027-03-10'].tracks.length,2);
  assert.equal(remote.data.circuitRounds.length,2);
  assert.equal(remote.data.circuitRounds[0].round,1);
  assert.equal(remote.data.circuitRounds[1].round,1,'les 2 circuits partagent le même numéro de manche M1');

  // 3. Onglet Circuit affiche les 2 pastilles M1 · 1/2 et M1 · 2/2 et bascule bien vers le 2e circuit
  vm.runInContext('circuitsCache=null',sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='circuit';setCircuitRound(1)",sandbox);
  assert.match(getElementById('app').innerHTML,/M1 · 1\/2/);
  assert.match(getElementById('app').innerHTML,/M1 · 2\/2/);
  assert.match(getElementById('app').innerHTML,/4,260 km/);
  vm.runInContext('setCircuitRound(2)',sandbox);
  assert.match(getElementById('app').innerHTML,/5,793 km/);

  // 4. Depuis la 2e fiche circuit, openCircuitRoundResult(1) ouvre directement la 2e session (Monza)
  vm.runInContext('openCircuitRoundResult(1)',sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('round',sandbox),0);
  assert.equal(vm.runInContext('sessionIndex',sandbox),1);
  assert.match(getElementById('app').innerHTML,/<h2>[^<]*Monza/i);

  // 5. Ajout d'une manche planifiée multi-circuits par addRound / addCircuitToPlannedRound / removeCircuitFromPlannedRound
  let prompts=['2027-04-14','spa_1970, monza'];
  sandbox.prompt=()=>prompts.shift()??null;
  await vm.runInContext('addRound()',sandbox);
  assert.equal(vm.runInContext("customCalendar['2027-04-14'].tracks.length",sandbox),2);
  prompts=['mugello'];
  await vm.runInContext("addCircuitToPlannedRound('2027-04-14')",sandbox);
  assert.equal(vm.runInContext("customCalendar['2027-04-14'].tracks.length",sandbox),3);
  await vm.runInContext("removeCircuitFromPlannedRound('2027-04-14',1)",sandbox);
  assert.deepEqual(Array.from(vm.runInContext("customCalendar['2027-04-14'].tracks.map(t=>t.trackId)",sandbox)),['spa_1970','mugello']);
});

test('Import automatique AH : actualise collisions et meilleurs temps sur des sessions déjà importées', async () => {
  const existingSession={
    date:'2026-10-21T19:55:00.000Z',
    track:'mid_ohio',
    type:'RACE',
    results:[{id:'p1',name:'Alice',team:'Red',grid:1,laps:5,best:0,time:450000},{id:'p2',name:'Bob',team:'Blue',grid:2,laps:5,best:0,time:455000}],
    laps:[{id:'p1',time:91200,cuts:0}],
    events:[{a:'Alice',b:'Bob',aid:'p1',bid:'p2',speed:12}]
  };
  let remote={
    slug:'ah-refresh-cup',name:'AH Refresh Cup',kind:'cup',points_config:{},
    data:{
      ahServer:'https://fr2.assettohosting.com:50648',
      ahUuid:'11111111-1111-1111-1111-111111111111',
      sessions:[existingSession],
      penMap:{'0:0:p1':{timeAdd:5000,note:'Avantage'}},
      circuitRounds:[{
        id:'local:2026-10-21:mid_ohio',round:1,label:'M1',name:'Mid-Ohio',shortName:'Mid-Ohio',
        trackId:'mid_ohio',localTrackId:'mid_ohio',date:'2026-10-21',lengthM:3634,lengthStr:'3,634 km',
        outline:{path:'M0 0 L10 10 Z',viewBox:'0 0 100 100',worldProjection:{originX:50,originY:50,scale:0.1},samples:[],sectors:[],corners:[]},
        profile:{path:'M0 10 L10 5',closed:'M0 10 L10 5 L10 120 L0 120 Z',min:0,max:10,delta:10},
        sectorSplits:[{label:'S1',from:0,to:1200},{label:'S2',from:1200,to:2400},{label:'S3',from:2400,to:3634}],
        surfaces:[],status:'done'
      }]
    }
  };
  const ahExportJson={
    Type:'RACE',
    Date:'2026-10-21T21:55:00+02:00',
    TrackName:'mid_ohio',
    TrackConfig:'chicane',
    Cars:[
      {CarId:0,Driver:{Name:'Alice',Guid:'aa',Team:'Red'}},
      {CarId:1,Driver:{Name:'Bob',Guid:'bb',Team:'Blue'}}
    ],
    Result:[
      {CarId:0,GridPosition:1,NumLaps:5,BestLap:999999999,TotalTime:450000},
      {CarId:1,GridPosition:2,NumLaps:5,BestLap:91800,TotalTime:455000}
    ],
    Laps:[
      {CarId:0,LapTime:90500,Sectors:[28000,32000,30500],Cuts:0,Timestamp:1792610800},
      {CarId:0,LapTime:89000,Sectors:[27000,31500,30500],Cuts:1,Timestamp:1792610900},
      {CarId:1,LapTime:91800,Sectors:[28500,32500,30800],Cuts:0,Timestamp:1792610810}
    ],
    Events:[
      {
        Type:'COLLISION_WITH_CAR',CarId:0,OtherCarId:1,ImpactSpeed:28.5,Timestamp:1792610726,
        WorldPosition:{X:100,Y:0,Z:200},RelPosition:{X:0.9,Y:0,Z:0.1}
      }
    ]
  };
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/ah-refresh-cup'&&(!opts||!opts.method||opts.method==='GET'))return response(remote);
    if(url==='/api/events/ah-refresh-cup/data'&&opts.method==='POST'){
      remote={...remote,data:JSON.parse(opts.body)};
      return response({ok:true});
    }
    if(url.startsWith('/api/ah-championship-sessions')){
      return response({
        championship:'AH Refresh Cup',events:1,
        items:[{source:'export',server:'https://fr2.assettohosting.com:50648',eventId:'ev1',rawType:'RACE',sessionType:'RACE',date:'2026-10-21T19:55:00.000Z',track:'mid_ohio',eventName:'Manche 1'}]
      });
    }
    if(url.startsWith('/api/ah-championship-session-json')){
      return {ok:true,status:200,json:async()=>ahExportJson,text:async()=>JSON.stringify(ahExportJson)};
    }
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('ah-refresh-cup')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='import';page='admin';render()",sandbox);
  // Comme dans le vrai DOM, render remplace le panneau et son élément de résultat.
  let visibleResult=getElementById('ah-result');
  const originalGet=sandbox.document.getElementById;
  sandbox.document.getElementById=id=>id==='ah-result'?visibleResult:originalGet(id);
  sandbox.replaceImportResult=()=>{visibleResult={id:'ah-result',innerHTML:'',style:{}};};
  vm.runInContext('const originalRenderForImportTest=render; render=function(){originalRenderForImportTest();replaceImportResult()}',sandbox);

  await vm.runInContext('ahImport()',sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(visibleResult.innerHTML,/Import terminé/);
  assert.match(visibleResult.innerHTML,/Sauvegarde serveur confirmée/);

  const sessFetch=calls.find(c=>c.url.startsWith('/api/ah-championship-session-json'));
  assert.ok(sessFetch,'la session déjà importée est bien re-téléchargée');
  assert.equal(remote.data.sessions.length,1,'aucun doublon créé malgré le décalage horaire +02:00 vs Z');
  const updated=remote.data.sessions[0];
  assert.equal(updated.trackConfig,'chicane');
  assert.deepEqual(updated.events[0].WorldPosition,{X:100,Z:200});
  assert.deepEqual(updated.events[0].RelPosition,{X:0.9,Y:0,Z:0.1});
  assert.equal(updated.results[0].best,90500,'meilleur tour propre recalculé depuis Laps quand BestLap vaut 999999999');
  assert.equal(updated.results[1].best,91800);
  assert.deepEqual(updated.laps[0].sectors,[28000,32000,30500]);
  assert.deepEqual(remote.data.penMap['0:0:p1'],{timeAdd:5000,note:'Avantage'});
  assert.match(visibleResult.innerHTML,/0 nouvelle\(s\), 1 actualisée\(s\)/);

  // Vérifier que l'onglet Circuit expose bien le meilleur tour calculé et la collision géolocalisée
  vm.runInContext('circuitsCache=null',sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='circuit';setCircMode('collisions')",sandbox);
  const cirHtml=getElementById('app').innerHTML;
  assert.match(cirHtml,/1:30\.500/);
  assert.match(cirHtml,/class="cir-crash hard"/);
});

test('Import automatique AH : recalibre worldProjection manquant et met à jour les meilleurs secteurs même sur tracé unique',async()=>{
  const existingSession={
    date:'2026-11-18T20:55:00.000Z',
    track:'charade_test',
    trackConfig:'gp',
    type:'RACE',
    results:[
      {id:'p1',name:'Alice',team:'Red',grid:1,laps:5,best:95000,time:480000},
      {id:'p2',name:'Bob',team:'Blue',grid:2,laps:5,best:96000,time:485000}
    ],
    laps:[{id:'p1',time:95000,cuts:0}],
    events:[{type:'COLLISION_WITH_CAR',a:'Alice',b:'Bob',aid:'p1',bid:'p2',speed:32.1}]
  };
  let remote={
    slug:'open-charade',
    name:'Open Charade',
    kind:'open',
    points_config:{scale:[25,18,15],pole:1,bestLap:1,minPct:75,ignoreWorst:0},
    data:{
      ahServer:'https://fr5.assettohosting.com:50648',
      ahUuid:'22222222-2222-2222-2222-222222222222',
      sessions:[existingSession],
      circuitRounds:[{
        id:'local:2026-11-18:charade_test',round:1,label:'M1',name:'Charade',shortName:'Charade',
        trackId:'charade_test',localTrackId:'charade_test',localLayoutId:'',date:'2026-11-18',
        lengthM:3521,lengthStr:'3,521 km',
        outline:{path:'M0 0 L100 100 Z',viewBox:'0 0 1000 560',samples:[],sectors:[],corners:[]},
        profile:{path:'M0 10 L10 5',closed:'M0 10 L10 5 L10 120 L0 120 Z',min:0,max:10,delta:10},
        sectorSplits:[{label:'S1',from:0,to:1174},{label:'S2',from:1174,to:2347},{label:'S3',from:2347,to:3521}],
        surfaces:[],status:'done'
      }]
    }
  };
  const ahExportJson={
    Type:'RACE',
    Date:'2026-11-18T21:55:00+01:00',
    TrackName:'charade_test',
    TrackConfig:'gp',
    Cars:[
      {CarId:0,Driver:{Name:'Alice',Guid:'aa',Team:'Red'}},
      {CarId:1,Driver:{Name:'Bob',Guid:'bb',Team:'Blue'}}
    ],
    Result:[
      {CarId:0,GridPosition:1,NumLaps:5,BestLap:91200,TotalTime:460000},
      {CarId:1,GridPosition:2,NumLaps:5,BestLap:91900,TotalTime:465000}
    ],
    Laps:[
      {CarId:0,LapTime:91200,Sectors:[28100,32400,30700],Cuts:0,Timestamp:1795035300},
      {CarId:1,LapTime:91900,Sectors:[28500,31900,31500],Cuts:0,Timestamp:1795035310}
    ],
    Events:[
      {
        Type:'COLLISION_WITH_CAR',CarId:0,OtherCarId:1,ImpactSpeed:32.1,Timestamp:1795035250,
        WorldPosition:{X:120,Y:0,Z:240},RelPosition:{X:0.5,Y:0,Z:0.2}
      }
    ]
  };
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/open-charade'&&(!opts||!opts.method||opts.method==='GET'))return response(remote);
    if(url==='/api/events/open-charade/data'&&opts.method==='POST'){
      remote={...remote,data:JSON.parse(opts.body)};
      return response({ok:true});
    }
    if(url.startsWith('/api/ah-championship-sessions')){
      assert.match(url,/refresh=1/);
      return response({
        championship:'Open Charade',events:1,
        items:[{source:'export',server:'https://fr5.assettohosting.com:50648',eventId:'ev1',rawType:'RACE',sessionType:'RACE',date:'2026-11-18T20:55:00.000Z',track:'charade_test',eventName:'Manche 1'}]
      });
    }
    if(url.startsWith('/api/ah-championship-session-json')){
      assert.match(url,/refresh=1/);
      return {ok:true,status:200,json:async()=>ahExportJson,text:async()=>JSON.stringify(ahExportJson)};
    }
    if(url==='/api/admin/circuits/import-local'&&opts.method==='POST'){
      return response({
        round:{
          id:'local:2026-11-18:charade_test',round:1,name:'Charade',trackId:'charade_test',localTrackId:'charade_test',localLayoutId:'',
          outline:{path:'M0 0 L100 100 Z',viewBox:'0 0 1000 560',worldProjection:{originX:40,originY:60,scale:0.25},samples:[],sectors:[],corners:[]}
        }
      });
    }
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('open-charade')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='import';page='admin';render()",sandbox);

  await vm.runInContext('ahImport()',sandbox);
  assert.ok(remote.data.circuitRounds[0].outline.worldProjection,'worldProjection doit être sauvegardé automatiquement');
  assert.ok(calls.some(c=>c.url==='/api/events/open-charade/data'&&c.method==='POST'),'la sauvegarde serveur est attendue avant la fin de ahImport');
  assert.match(getElementById('ah-result').innerHTML,/Sauvegarde serveur confirmée/);
  assert.match(getElementById('ah-result').innerHTML,/recalibrée/);

  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='circuit';setCircMode('collisions')",sandbox);
  const colHtml=getElementById('app').innerHTML;
  assert.match(colHtml,/class="cir-crash hard"/,'la collision doit être placée sur le tracé');
  assert.doesNotMatch(colHtml,/Position indisponible/);

  vm.runInContext("setCircMode('sectors')",sandbox);
  const secHtml=getElementById('app').innerHTML;
  assert.match(secHtml,/S1<\/td><td>0:28\.100<\/td><td>Alice/);
  assert.match(secHtml,/S2<\/td><td>0:31\.900<\/td><td>Bob/);
  assert.match(secHtml,/S3<\/td><td>0:30\.700<\/td><td>Alice/);
});

test('Carte des collisions : explique l’absence de repère GPS quand worldProjection manque encore',async()=>{
  const remote={
    slug:'open-noproj',
    name:'Open Sans GPS',
    kind:'open',
    points_config:{scale:[25,18],pole:1,bestLap:1,minPct:75,ignoreWorst:0},
    data:{
      sessions:[{
        date:'2026-11-18T20:55:00.000Z',track:'charade_test',trackConfig:'gp',type:'RACE',
        results:[{id:'p1',name:'Alice',laps:5,best:91200},{id:'p2',name:'Bob',laps:5,best:91900}],
        laps:[{id:'p1',time:91200,sectors:[28100,32400,30700],cuts:0}],
        events:[{type:'COLLISION_WITH_CAR',a:'Alice',b:'Bob',aid:'p1',bid:'p2',speed:22,WorldPosition:{X:120,Z:240}}]
      }],
      circuitRounds:[{
        id:'local:2026-11-18:charade_test',round:1,label:'M1',name:'Charade',shortName:'Charade',
        trackId:'charade_test',localTrackId:'charade_test',localLayoutId:'',date:'2026-11-18',
        lengthM:3521,lengthStr:'3,521 km',
        outline:{path:'M0 0 L100 100 Z',viewBox:'0 0 1000 560',samples:[],sectors:[],corners:[]},
        sectorSplits:[{label:'S1',from:0,to:1174},{label:'S2',from:1174,to:2347},{label:'S3',from:2347,to:3521}],
        surfaces:[],status:'done'
      }]
    }
  };
  const {sandbox,getElementById}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/open-noproj'&&(!opts||!opts.method||opts.method==='GET'))return response(remote);
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('open-noproj')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok'",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  vm.runInContext("page='circuit';setCircMode('collisions')",sandbox);
  const html=getElementById('app').innerHTML;
  assert.match(html,/Tracé importé sans repère GPS/);
  assert.match(html,/Position indisponible \(tracé sans repère GPS\)/);
  assert.match(html,/refreshCircuitRoundFromInspector/);
});




test('Actualiser événement AH : choix, aperçu, application sélective et conservation des données',async()=>{
  const server='https://fr2.assettohosting.com:50648';
  const uuid='11111111-1111-1111-1111-111111111111';
  let remote={slug:'cup-sync',name:'Cup locale',kind:'cup',updated_at:'2026-11-20T10:00:00Z',points_config:{pointsScale:[10,8],globalCoef:0.75},data:{
    sessions:[{date:'2026-11-01',track:'spa',type:'RACE',results:[{id:'a',name:'Alice',team:'A',laps:2,best:90000,time:200000}],laps:[],events:[]}],
    penMap:{'0:0:a':{timeAdd:2}},posterImage:'data:image/png;base64,AAAA',
    eventInfo:{car:'Voiture choisie',briefing:'Texte personnel',formatText:'Format personnel'},
    customCalendar:{'2026-12-10':{track:'spa'}}
  }};
  const summary={server,uuid,name:'Cup AH',briefing:'Texte AH',car:'modele_ah',formatText:'Course : 15 min',registrationUrl:server+'/championship/'+uuid,
    entrantsAvailable:true,entrants:[{name:'Pilote B',team:'Bleu',car:'modele_ah'}],rounds:[{name:'Manche',date:'2026-12-01',track:'monza',layout:'junior',format:'Course : 15 min'},{name:'Sans date',date:'',track:'spa',layout:''}],points:{pointsScale:[13,11],polePoints:1},note:''};
  const listed=[{server,uuid:'22222222-2222-2222-2222-222222222222',name:'Autre source',progress:0},{server,uuid,name:'Cup AH',progress:0}];
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url.startsWith('/api/ah-championships?'))return response({items:listed,errors:[]});
    if(url.startsWith('/api/admin/ah-championship-preview?'))return response(summary);
    if(url==='/api/events/cup-sync'&&(!opts.method||opts.method==='GET'))return response(JSON.parse(JSON.stringify(remote)));
    if(url==='/api/events/cup-sync'&&opts.method==='PUT'){
      const body=JSON.parse(opts.body);remote={...remote,...(body.name?{name:body.name}:{}),...(body.pointsConfig?{points_config:body.pointsConfig}:{}),data:body.data,updated_at:'2026-11-20T10:01:00Z'};
      return response({event:remote});
    }
    if(url==='/api/events/cup-sync/data'&&opts.method==='POST'){remote={...remote,data:JSON.parse(opts.body)};return response({ok:true});}
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('cup-sync')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok';adminUser='Admin';adminTab='events';page='admin';render()",sandbox);
  assert.match(getElementById('app').innerHTML,/Actualiser depuis AssettoHosting/);
  await vm.runInContext('scanCurrentEventAH()',sandbox);
  assert.match(getElementById('ah-current-sync').innerHTML,/Autre source/);
  getElementById('ah-current-choice').value='1';
  await vm.runInContext('previewCurrentEventAH()',sandbox);
  assert.match(getElementById('ah-current-preview').innerHTML,/date non renseignée/);
  assert.match(getElementById('ah-current-preview').innerHTML,/Texte personnel/);
  assert.ok(!calls.some(c=>c.url==='/api/events/cup-sync'&&c.method==='PUT'),'aucune écriture avant confirmation');
  for(const key of ['link','format','entrants','calendar','points'])getElementById('ah-sync-'+key).checked=true;
  await vm.runInContext('applyCurrentEventAH()',sandbox);
  assert.equal(remote.name,'Cup locale');
  assert.equal(remote.data.eventInfo.briefing,'Texte personnel');
  assert.equal(remote.data.eventInfo.car,'Voiture choisie');
  assert.equal(remote.data.eventInfo.formatText,'Course : 15 min');
  assert.equal(remote.data.ahUuid,uuid);
  assert.equal(remote.data.ahEntrants[0].name,'Pilote B');
  assert.equal(remote.data.sessions.length,1);assert.equal(remote.data.penMap['0:0:a'].timeAdd,2);
  assert.equal(remote.data.customCalendar['2026-12-01'].track,'monza');
  assert.ok(remote.data.customCalendar['2026-12-10']);assert.equal(Object.keys(remote.data.customCalendar).length,2);
  assert.deepEqual(remote.points_config.pointsScale,[13,11]);assert.equal(remote.points_config.globalCoef,0.75);
  assert.equal(remote.data.posterImage,'data:image/png;base64,AAAA');
  vm.runInContext("page='event';render()",sandbox);
  assert.match(getElementById('app').innerHTML,/Pilote B/);
  await vm.runInContext('saveRemote()',sandbox);
  assert.equal(remote.data.ahEntrants[0].name,'Pilote B','une sauvegarde ultérieure conserve les inscrits');
});

test('Actualiser événement AH : refuse un aperçu périmé ou une source différente',async()=>{
  const server='https://fr2.assettohosting.com:50648',uuid='11111111-1111-1111-1111-111111111111';
  let remote={slug:'cup-conflict',name:'Cup',kind:'cup',updated_at:'v1',points_config:{},data:{sessions:[],penMap:{},eventInfo:{briefing:'Origine'}}};
  const summary={server,uuid,name:'Cup AH',briefing:'Nouveau',car:'',formatText:'',registrationUrl:'',entrants:[],rounds:[],points:null,note:''};
  const alerts=[];
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url.startsWith('/api/ah-championships?'))return response({items:[{server,uuid,name:'Cup AH',progress:0}],errors:[]});
    if(url.startsWith('/api/admin/ah-championship-preview?'))return response(summary);
    if(url==='/api/events/cup-conflict'&&(!opts.method||opts.method==='GET'))return response(JSON.parse(JSON.stringify(remote)));
    return null;
  },{alert:msg=>alerts.push(msg)});
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("loadEvent('cup-conflict')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok'",sandbox);
  await vm.runInContext('scanCurrentEventAH()',sandbox);
  getElementById('ah-current-choice').value='0';
  await vm.runInContext('previewCurrentEventAH()',sandbox);
  getElementById('ah-sync-briefing').checked=true;
  getElementById('ah-current-choice').value='1';
  await vm.runInContext('applyCurrentEventAH()',sandbox);
  assert.match(alerts.pop(),/source a changé/);
  getElementById('ah-current-choice').value='0';
  remote={...remote,updated_at:'v2',data:{...remote.data,eventInfo:{briefing:'Modification concurrente'}}};
  await vm.runInContext('applyCurrentEventAH()',sandbox);
  assert.match(alerts.pop(),/a changé depuis la comparaison/);
  assert.ok(!calls.some(c=>c.url==='/api/events/cup-conflict'&&c.method==='PUT'));
});

test('Livrées AH : engagés sans résultats, fiches pilote et voiture, conservation sans confusion',async()=>{
  const server='https://fr2.assettohosting.com:50648';
  let remote={slug:'skin-cup',name:'Cup',kind:'cup',points_config:{},data:{sessions:[],penMap:{},ahEntrantsServer:server,ahEntrants:[{name:'Alice',team:'GDSP',car:'alfa',skin:'blue'}]}};
  const {sandbox,getElementById}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/skin-cup'&&(!opts.method||opts.method==='GET'))return response(JSON.parse(JSON.stringify(remote)));
    if(url==='/api/events/skin-cup/data'&&opts.method==='POST'){remote={...remote,data:JSON.parse(opts.body)};return response({ok:true});}
    return null;
  });
  await new Promise(resolve=>setImmediate(resolve));await vm.runInContext("loadEvent('skin-cup')",sandbox);
  vm.runInContext("page='pilotes';render()",sandbox);
  let html=getElementById('app').innerHTML;
  assert.match(html,/Alice/);assert.match(html,/api\/ah-skin-preview\?/);assert.match(html,/model=alfa/);assert.match(html,/skin=blue/);
  vm.runInContext("driverId=eventDrivers()[0].id;render()",sandbox);
  html=getElementById('app').innerHTML;assert.match(html,/Aperçu de la voiture de Alice/);assert.match(html,/skin=blue/);
  vm.runInContext("page='voiture';render()",sandbox);
  html=getElementById('app').innerHTML;assert.match(html,/gdsp-liveries/);assert.match(html,/skin=blue/);
  vm.runInContext("adminToken='token'",sandbox);await vm.runInContext('saveRemote()',sandbox);
  assert.equal(remote.data.ahEntrantsServer,server);assert.equal(remote.data.ahEntrants[0].skin,'blue');
  assert.equal(vm.runInContext("driverSkin({name:'Alice'})",sandbox).includes('skin=blue'),true);
  vm.runInContext("eventContext.data.ahEntrants.push({name:'Alice',car:'autre',skin:'rouge'})",sandbox);
  assert.equal(vm.runInContext("driverSkin({name:'Alice'})",sandbox),'','homonymes : aucune livrée attribuée arbitrairement');
});

test('validation des liens : refuse les URL externes sans protocole', () => {
  const source = siteSource.match(/function isSafeHttpUrl\(u\)\{[\s\S]*?\n\}/)[0];
  const validate = vm.runInNewContext('(' + source + ')');
  for (const value of ['//example.com/path', '///example.com', 'javascript:alert(1)', '/\\example.com']) assert.equal(validate(value), false, value);
  for (const value of ['/docs/reglement.pdf', '/live-timing?source=test', 'https://example.com/path', 'http://example.com']) assert.equal(validate(value), true, value);
});

test('Circuit : quatre courses le même jour restent une manche et distinguent les variantes', async () => {
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const fiches=['', 'prague_short', 'prague_rev', 'prague_short_rev'].map((layout,i)=>({
    id:'local:undated:prague/'+layout,round:i+1,label:'M'+(i+1),name:'Prague '+(layout||'normal'),
    trackId:'prague',driverFolder:'prague',layoutId:layout,localLayoutId:layout,status:'upcoming',date:null
  }));
  const races=fiches.map((f,i)=>({date:`2026-04-22T${20+i}:00:00Z`,track:'prague',trackConfig:f.layoutId,type:'RACE',results:[{id:'p',name:'Pilote',laps:1,time:100000}]}));
  vm.runInContext(`eventContext={slug:'prague',name:'Prague',kind:'archive',data:{circuitRounds:${JSON.stringify(fiches)}}};sessions.splice(0,sessions.length,...${JSON.stringify(races)});circuitsCache=null;circuitsError=''`,sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  const data=vm.runInContext('circuitsCache',sandbox);
  assert.equal(vm.runInContext('rounds().length',sandbox),1);
  assert.equal(vm.runInContext('rounds()[0].sessions.length',sandbox),4);
  assert.equal(data.totalCount,1);
  assert.equal(data.completedCount,1);
  assert.deepEqual(Array.from(data.rounds,r=>[r.round,r.label,r.date,r.status]),fiches.map(()=>[1,'M1','2026-04-22','done']));
  for(let i=0;i<4;i++){
    vm.runInContext(`openCircuitRoundResult(${i})`,sandbox);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(vm.runInContext('sessionIndex',sandbox),i);
  }
});

test('Circuit : variante et jour ambigus ne sont jamais attribués au hasard', async () => {
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const fiches=[{name:'Prague',trackId:'prague',layoutId:'',round:1,status:'upcoming'},
    {name:'Prague Short',trackId:'prague',layoutId:'prague_short',round:2,status:'upcoming'}];
  const race={date:'2026-04-22T20:00:00Z',track:'prague',type:'RACE',results:[{id:'p'}]};
  vm.runInContext(`eventContext={slug:'prague',name:'Prague',kind:'archive',data:{circuitRounds:${JSON.stringify(fiches)}}};sessions.splice(0,sessions.length,${JSON.stringify(race)});circuitsCache=null;circuitsError=''`,sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  assert.ok(vm.runInContext("circuitsCache.rounds.every(r=>r.status==='unconfirmed'&&r.date==='2026-04-22'&&r.round===1&&!r.resultsImported)",sandbox));
  assert.match(vm.runInContext('circuitStatusLabel(circuitsCache.rounds[0])',sandbox),/À vérifier/);
  vm.runInContext("eventContext.data.circuitRounds=[eventContext.data.circuitRounds[0]];sessions.push({...sessions[0],date:'2026-05-01T20:00:00Z'});circuitsCache=null",sandbox);
  await vm.runInContext('circuitsData()',sandbox);
  assert.notEqual(vm.runInContext('circuitsCache.rounds[0].status',sandbox),'done');
  assert.ok(!vm.runInContext('circuitsCache.rounds[0].date',sandbox));
});

test('Commission : incidents réciproques et décor sont conservés sans modifier les sanctions',async()=>{
  const {sandbox,calls}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const raw={Type:'RACE',Date:'2026-11-04T22:42:00+01:00',TrackName:'mexico',
    Cars:[{CarId:0,Driver:{Guid:'alice',Name:'Alice'}},{CarId:1,Driver:{Guid:'bob',Name:'Bob'}}],
    Result:[{CarId:0,TotalTime:100000,NumLaps:1,BestLap:100000},{CarId:1,TotalTime:101000,NumLaps:1,BestLap:101000}],Laps:[],
    Events:[
      {Type:'COLLISION_WITH_CAR',CarId:0,OtherCarId:1,Timestamp:1793826722,ImpactSpeed:12,WorldPosition:{X:1,Z:2}},
      {Type:'COLLISION_WITH_CAR',CarId:1,OtherCarId:0,Timestamp:1793826723,ImpactSpeed:10,WorldPosition:{X:2,Z:3}},
      {Type:'COLLISION_WITH_ENV',CarId:0,Timestamp:1793826730,AfterSessionEnd:true,WorldPosition:{X:4,Z:5}}
    ]};
  vm.runInContext(`sessions=[];penMap={'0:0:alice':{timeAdd:5,note:'Commission'}};currentSlug='test';eventContext={slug:'test',name:'Test',data:{}};adminAuth=true;adminToken='token';adminTab='adjust';page='admin'`,sandbox);
  assert.equal(vm.runInContext(`importSessionJson(${JSON.stringify(JSON.stringify(raw))},'course.json',{silent:true})`,sandbox),true);
  assert.equal(vm.runInContext('sessions[0].events.length',sandbox),2,'les calculs sportifs gardent seulement les contacts entre voitures');
  assert.equal(vm.runInContext('sessions[0].incidentEvents.length',sandbox),3);
  const html=vm.runInContext('admin()',sandbox);
  assert.match(html,/Journal des incidents/);assert.match(html,/Décor/);assert.match(html,/Correspondance possible : #2/);
  assert.match(html,/après session/);assert.match(html,/Vitesse indisponible/);
  assert.equal(vm.runInContext("penMap['0:0:alice'].timeAdd",sandbox),5);
  vm.runInContext("commissionIncidentPilot=sessions[0].incidentEvents[0].aid",sandbox);
  assert.match(vm.runInContext('admin()',sandbox),/3 signalement\(s\) affiché/);
  await vm.runInContext('saveRemote()',sandbox);
  const saved=calls.filter(c=>c.url==='/api/events/test/data'&&c.method==='POST').at(-1).body;
  assert.equal(saved.sessions[0].incidentEvents.length,3);
  assert.equal(saved.sessions[0].incidentEvents[2].afterSessionEnd,true);
  assert.equal(saved.sessions[0].events.length,2);
  const partial={...raw,Events:null};
  vm.runInContext(`importSessionJson(${JSON.stringify(JSON.stringify(partial))},'course.json',{silent:true})`,sandbox);
  assert.equal(vm.runInContext('sessions[0].incidentEvents.length',sandbox),3,'une actualisation incomplète ne détruit pas le journal');
});

test('Commission : rapprochements prudents et anciens imports partiels',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`adminAuth=true;eventContext={slug:'x',name:'X',data:{}};sessions=[{type:'RACE',date:'2026-11-04T20:00:00Z',track:'x',results:[],events:[
    {type:'COLLISION_WITH_CAR',aid:'a',bid:'b',a:'<Alice>',b:'Bob',timestamp:100,WorldPosition:{X:0,Z:0}},
    {type:'COLLISION_WITH_CAR',aid:'b',bid:'a',a:'Bob',b:'<Alice>',timestamp:101,WorldPosition:{X:100,Z:0}},
    {type:'COLLISION_WITH_CAR',aid:'b',bid:'a',a:'Bob',b:'<Alice>',timestamp:null,WorldPosition:{X:0,Z:0}}
  ]}];commissionIncidentSession='';commissionIncidentPilot=''`,sandbox);
  const html=vm.runInContext('renderCommissionIncidents(rounds())',sandbox);
  assert.match(html,/Archive partielle/);assert.match(html,/&lt;Alice&gt;/);assert.doesNotMatch(html,/<Alice>/);
  assert.doesNotMatch(html,/Correspondance possible : #/);
  assert.match(html,/Heure indisponible/);
  vm.runInContext("commissionIncidentPilot='b'",sandbox);
  assert.match(vm.runInContext('renderCommissionIncidents(rounds())',sandbox),/3 signalement\(s\) affiché/);
});

test('Commission : filtrage par session et pilote, suggestions non destructives',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const row=(a,b,t,x)=>({type:'COLLISION_WITH_CAR',aid:a,bid:b,a,b,timestamp:t,WorldPosition:{X:x,Z:0},speed:5});
  const group=[row('Alice','Bob',1793826722,0),row('Bob','Alice',1793826723,1),row('Bob','Alice',1793826724,2),row('Charlie','David',1793826750,1)];
  vm.runInContext(`adminAuth=true;eventContext={slug:'x',name:'X',data:{}};sessions=[{type:'RACE',date:'2026-11-04T20:00:00Z',track:'x',results:[],incidentEvents:${JSON.stringify(group)}},{type:'RACE',date:'2026-11-04T21:00:00Z',track:'y',results:[],incidentEvents:[{type:'COLLISION_WITH_ENV',aid:'c',a:'Charlie',timestamp:1793826723}]}];commissionIncidentSession='0:0';commissionIncidentPilot='Alice'`,sandbox);
  const html=vm.runInContext('renderCommissionIncidents(rounds())',sandbox);
  assert.match(html,/3 signalement\(s\) affiché\(s\) sur 4/);
  assert.match(html,/Correspondance possible : #2, #3/);
  assert.equal(vm.runInContext('sessions[0].incidentEvents.length',sandbox),4);
  vm.runInContext("commissionIncidentSession='0:1';commissionIncidentPilot=''",sandbox);
  const other=vm.runInContext('renderCommissionIncidents(rounds())',sandbox);
  assert.match(other,/1 signalement\(s\) affiché\(s\) sur 1/);assert.match(other,/Décor/);
  vm.runInContext('adminAuth=false',sandbox);
  assert.equal(vm.runInContext('renderCommissionIncidents(rounds())',sandbox),'');
});

test('Analyse après-course : tours ordonnés, secteurs et régularité sans toucher aux résultats', async()=>{
  const {sandbox}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  const race={type:'RACE',date:'2026-11-04T21:00:00Z',track:'mexico',results:[
    {id:'a',name:'Alice',laps:5,time:500000,best:90000},{id:'b',name:'Bob',laps:2,time:200000,best:95000}
  ],laps:[
    {id:'a',time:91000,cuts:0,sectors:[30000,null,61000],timestamp:103},
    {id:'a',time:110000,cuts:0,sectors:[40000,40000,30000],timestamp:100},
    {id:'a',time:90000,cuts:0,sectors:[29000,31000,30000],timestamp:102},
    {id:'a',time:85000,cuts:1,sectors:[10000,30000,45000],timestamp:101},
    {id:'a',time:125000,cuts:0,sectors:[45000,45000,35000],timestamp:104},
    {id:'b',time:95000,cuts:0,timestamp:100}
  ]};
  vm.runInContext(`eventContext={slug:'test',name:'Test',kind:'open',data:{}};backendMulti=true;sessions=${JSON.stringify([race])};round=0;sessionIndex=0;eventtab='analyse';analysisDriverId='a';penMap={}`,sandbox);
  const before=vm.runInContext('JSON.stringify(sessions)',sandbox);
  const html=vm.runInContext('manche()',sandbox);
  assert.match(html,/Analyse après-course/);assert.match(html,/5 tour\(s\) enregistré\(s\) sur 5/);
  assert.match(html,/\+1\.000 s \(2 tours retenus\)/);assert.match(html,/S1 : 0:29\.000/);assert.doesNotMatch(html,/S1 : 0:10\.000/);
  assert.match(html,/S1 0:30\.000 · S2 — · S3 1:01\.000/);assert.match(html,/Coupé \(1\)/);
  assert.match(html,/Graphiques de positions et d’écarts non disponibles/);
  assert.equal(vm.runInContext('JSON.stringify(sessions)',sandbox),before);
  const bob=vm.runInContext("raceAnalysisDriver(sessions[0],sessions[0].results[1])",sandbox);
  assert.equal(bob.consistency,null);assert.equal(bob.complete,false);
  vm.runInContext("analysisDriverId='b'",sandbox);
  assert.match(vm.runInContext('manche()',sandbox),/Historique incomplet ou ordre non vérifiable/);
});

test('Analyse après-course : ordre ambigu et secteurs absents ne sont pas inventés', async()=>{
  const {sandbox}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  const race={type:'RACE',date:'2026-11-04T21:00:00Z',track:'x',results:[{id:'a',name:'<Alice>',laps:3,time:300000}],laps:[
    {id:'a',time:90000,cuts:0,sectors:[30000,null,30000],timestamp:100},
    {id:'a',time:91000,cuts:0,sectors:[30000,31000,30000],timestamp:100},
    {id:'a',time:92000,cuts:0}
  ]};
  vm.runInContext(`sessions=${JSON.stringify([race])};analysisDriverId='a'`,sandbox);
  const before=vm.runInContext('JSON.stringify(sessions)',sandbox);
  const html=vm.runInContext('renderRaceAnalysis(sessions[0])',sandbox);
  assert.match(html,/Historique incomplet ou ordre non vérifiable/);assert.match(html,/Indisponible/);
  assert.match(html,/&lt;Alice&gt;/);assert.doesNotMatch(html,/<Alice>/);
  assert.match(html,/S1 0:30\.000 · S2 — · S3 0:30\.000/);
  assert.equal(vm.runInContext('JSON.stringify(sessions)',sandbox),before);
});

test('Import et sauvegarde : un secteur absent ne décale pas les suivants',async()=>{
  const {sandbox,calls}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  const raw={Type:'RACE',Date:'2026-11-04T20:00:00Z',TrackName:'x',Cars:[{CarId:0,Driver:{Guid:'a',Name:'Alice'}}],Result:[{CarId:0,TotalTime:90000,NumLaps:1,BestLap:90000}],Laps:[{CarId:0,LapTime:90000,Cuts:0,Timestamp:100,Sectors:[30000,0,30000]}]};
  vm.runInContext("sessions=[];currentSlug='test';eventContext={slug:'test',name:'Test',data:{}};adminAuth=true;adminToken='token'",sandbox);
  assert.equal(vm.runInContext(`importSessionJson(${JSON.stringify(JSON.stringify(raw))},'course.json',{silent:true})`,sandbox),true);
  assert.deepEqual(Array.from(vm.runInContext('sessions[0].laps[0].sectors',sandbox)),[30000,null,30000]);
  await vm.runInContext('saveRemote()',sandbox);
  const saved=calls.filter(c=>c.url==='/api/events/test/data'&&c.method==='POST').at(-1).body;
  assert.deepEqual(saved.sessions[0].laps[0].sectors,[30000,null,30000]);
});

test('Import automatique : aucun scan global ni sauvegarde pour un événement non lié', async () => {
  const {sandbox,getElementById,calls}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("currentSlug='open-sugo';ahConfig=null;adminToken='tok';",sandbox);
  const before=vm.runInContext('JSON.stringify({sessions,penMap})',sandbox);
  const start=calls.length;
  await vm.runInContext('ahImport()',sandbox);
  assert.match(getElementById('ah-result').innerHTML,/Import automatique indisponible/);
  assert.match(getElementById('ah-result').innerHTML,/fichiers JSON manuellement/);
  assert.deepEqual(calls.slice(start),[]);
  assert.equal(vm.runInContext('JSON.stringify({sessions,penMap})',sandbox),before);
  // La protection couvre également le mode historique et les liens incomplets.
  for(const setup of ["currentSlug='';ahConfig=null", "currentSlug='open-sugo';ahConfig={server:'https://example.org'}"]){
    vm.runInContext(setup,sandbox);
    const count=calls.length;
    await vm.runInContext('ahImport()',sandbox);
    assert.equal(calls.length,count);
  }
});

test('Liaison AH manuelle : confirmation, conservation des sessions et décisions, puis import lié', async () => {
  const champ={server:'https://fr2.assettohosting.com:50648',uuid:'11111111-1111-1111-1111-111111111111',name:'Open #5 Charade'};
  let remote={slug:'open-charade',name:'Open #5 Charade',kind:'open',points_config:{},data:{sessions:[{date:'2026-09-02',type:'RACE',track:'charade',results:[],laps:[],events:[]}],penMap:{'0:0:p':{timeAdd:5}},extra:'conservé'}};
  const {sandbox,getElementById,calls}=makeBrowser([remote],(url,opts)=>{
    if(url==='/api/events/open-charade')return response(remote);
    if(url==='/api/ah-championships')return response({items:[champ],errors:[]});
    if(url==='/api/events/open-charade/ah-link') {remote={...remote,data:{...remote.data,ahServer:champ.server,ahUuid:champ.uuid}};return response({status:'ok'});}
    if(url.startsWith('/api/ah-championship-sessions'))return response({championship:champ.name,items:[],events:1});
    return null;
  });
  await new Promise(r=>setImmediate(r));
  await vm.runInContext("loadEvent('open-charade')",sandbox);
  vm.runInContext("adminAuth=true;adminToken='tok';adminTab='import';page='admin';render()",sandbox);
  const before=JSON.stringify(remote.data);
  await vm.runInContext('ahLinkScan()',sandbox);
  assert.match(getElementById('ah-link-result').innerHTML,/Open #5 Charade/);
  getElementById('ah-link-choice').value='0';
  sandbox.confirm=()=>false;
  await vm.runInContext('ahLinkSave()',sandbox);
  assert.equal(JSON.stringify(remote.data),before);
  assert.equal(calls.filter(c=>c.url.endsWith('/ah-link')).length,0);
  sandbox.confirm=()=>true;
  await vm.runInContext('ahLinkSave()',sandbox);
  assert.equal(remote.data.sessions.length,1);
  assert.equal(remote.data.penMap['0:0:p'].timeAdd,5);
  assert.equal(remote.data.extra,'conservé');
  assert.equal(vm.runInContext('ahConfig.uuid',sandbox),champ.uuid);
  assert.equal(calls.filter(c=>c.url.startsWith('/api/ah-championship-sessions')).length,0,'la liaison ne lance aucun import');
  await vm.runInContext('ahImport()',sandbox);
  assert.ok(calls.some(c=>c.url.includes('/api/ah-championship-sessions?')&&c.url.includes(champ.uuid)));
  assert.match(getElementById('ah-result').innerHTML,/aucune session récupérable/);
  await vm.runInContext("loadEvent('open-charade')",sandbox);
  assert.equal(vm.runInContext('ahConfig.uuid',sandbox),champ.uuid,'la liaison persiste au rechargement');
});

test('Miniatures Lola manquantes : visuels du classement, alias Christophe et priorité aux images personnalisées', async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("eventContext={slug:ACTIVE_LOLA_SLUG,name:'Lola',data:{driverPhotos:{custom:'data:image/jpeg;base64,dGVzdA=='}}}",sandbox);
  for(const [name,file] of [['Kami_Kaze31','kami'],['Tx3Rony68z','rony'],['Pikoupok','pikoupok'],['thibjedi','thibjedi'],['[APR] Christophe','holden'],['Christophe [APR]','holden']]){
    sandbox.testName=name;
    assert.match(vm.runInContext("car(testName,'id')",sandbox),new RegExp('/assets/'+file+'\\.jpg'));
    assert.ok(fs.existsSync(path.join(root,'assets',file+'.jpg')));
  }
  sandbox.testName='Pikoupok';
  assert.equal(vm.runInContext('number(testName)',sandbox),'—','ne pas inventer de numéro');
  assert.match(vm.runInContext("car(testName,'custom')",sandbox),/data:image\/jpeg;base64/);
  vm.runInContext("eventContext={slug:'autre-event',name:'Autre',data:{}}",sandbox);
  assert.doesNotMatch(vm.runInContext("car(testName,'id')",sandbox),/pikoupok\.jpg/);
});

test('Essai sans plugin CM exige une seconde confirmation explicite',async()=>{
 let attempts=0,confirmations=[];
 const {sandbox,getElementById,calls}=makeBrowser([],async(url)=>{
  if(url==='/api/server-manager/presets/local1/start'){
   attempts++;return attempts===1?response({code:'CM_PLUGIN_TEST_CONFIRM'},409):response({message:'Lancement demandé sans le plugin CM.'});
  }
  return null;
 });
 await new Promise(resolve=>setImmediate(resolve));getElementById('cm-server-select').value='local1';
 sandbox.confirm=text=>{confirmations.push(text);return true;};
 await vm.runInContext("cmControl('start')",sandbox);
 const requests=calls.filter(c=>c.url==='/api/server-manager/presets/local1/start');
 assert.equal(requests.length,2);assert.equal(requests[0].body.withoutCmPlugin,undefined);assert.equal(requests[1].body.withoutCmPlugin,true);
 assert.equal(confirmations.length,2);assert.match(confirmations[1],/plugin interne Content Manager NE sera PAS lancé/);
});

test('Refuser la seconde confirmation ne lance pas le serveur',async()=>{
 let count=0;
 const {sandbox,getElementById,calls}=makeBrowser([],async url=>url==='/api/server-manager/presets/local1/start'?response({code:'CM_PLUGIN_TEST_CONFIRM'},409):null);
 await new Promise(resolve=>setImmediate(resolve));getElementById('cm-server-select').value='local1';sandbox.confirm=()=>++count===1;
 await vm.runInContext("cmControl('start')",sandbox);
 assert.equal(calls.filter(c=>c.url==='/api/server-manager/presets/local1/start').length,1);
 assert.equal(getElementById('cm-server-status').textContent,'Lancement annulé.');
});

test('Événement clôturé : nombre de pilotes sans lien d’inscription, même sans résultat',async()=>{
  const {sandbox}=makeBrowser();await new Promise(r=>setImmediate(r));
  const run=src=>vm.runInContext(src,sandbox);
  run("eventContext={slug:'test',name:'Test',kind:'archive',data:{eventInfo:{registrationUrl:'https://example.org/inscription'}}}; rounds=()=>[]; allDrivers=()=>[{id:'a'},{id:'b'}]");
  const card=()=>run('eventHome()').match(/<div class="ev-kpi gold">[\s\S]*?<\/div>/)[0];
  assert.match(card(),/Pilotes engagés<\/span><strong>2<\/strong>/);
  assert.doesNotMatch(card(),/ev-register|Inscriptions|<svg/);
  run('allDrivers=()=>[]');
  assert.match(card(),/<strong>0<\/strong>/);assert.doesNotMatch(card(),/ev-register|Inscriptions|<svg/);
  run("eventContext.kind='championship'");
  assert.match(card(),/ev-register/);
  run("allDrivers=()=>[{id:'a'}]");assert.match(card(),/<strong>1<\/strong>[\s\S]*ev-register/);
});

test('Accueil événement : tableau lisible des inscrits, sans changer les données ou le classement',async()=>{
  const {sandbox}=makeBrowser();
  await new Promise(resolve=>setImmediate(resolve));
  const html=vm.runInContext(`
    eventContext={slug:'test-table',name:'Cup',kind:'cup',data:{
      ahEntrants:[
        {name:'Alice <img src=x>',team:'Équipe & Co',car:'alfa_romeo_giulietta_spider',skin:'188_kant-1'},
        {name:'Bob',team:'',car:'',skin:''}
      ],
      carSheets:[{id:'alfa_romeo_giulietta_spider',name:'Alfa Romeo Giulietta Spider Racer'}]
    }};
    rounds=()=>[];allDrivers=()=>[];
    eventHome();
  `,sandbox);
  const panel=html.match(/<section class="panel ev-entrants"[\s\S]*?<\/section>/)[0];
  assert.match(panel,/2 engagés/);
  assert.match(panel,/<table aria-label="Pilotes engagés">/);
  assert.match(panel,/<th scope="col">Pilote<\/th>/);
  assert.match(panel,/<th scope="col">Équipe<\/th>/);
  assert.match(panel,/<th scope="col">Voiture \/ livrée<\/th>/);
  assert.match(panel,/<th scope="row">Alice &lt;img src=x&gt;<\/th>/);
  assert.match(panel,/Équipe &amp; Co/);
  assert.match(panel,/Alfa Romeo Giulietta Spider Racer/);
  assert.match(panel,/Livrée · 188 kant 1/);
  assert.equal((panel.match(/Non renseignée/g)||[]).length,2);
  assert.doesNotMatch(panel,/<img src=x>/);
  assert.match(panel,/tabindex="0" role="region"/);
  assert.match(panel,/distincte des résultats et du classement/);
  assert.equal(vm.runInContext('eventContext.data.ahEntrants[0].car',sandbox),'alfa_romeo_giulietta_spider');
});

test('Accueil événement : identifiant de voiture lisible sans métadonnées, aucun tableau si liste vide',async()=>{
  const {sandbox}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  const html=vm.runInContext("eventContext={slug:'fallback',name:'Cup',kind:'cup',data:{ahEntrants:[{name:'Bob',car:'alfa_romeo_giulietta_spider'}]}};rounds=()=>[];allDrivers=()=>[];eventHome()",sandbox);
  assert.match(html,/Alfa romeo giulietta spider/);
  assert.doesNotMatch(html,/alfa_romeo_giulietta_spider/);
  assert.doesNotMatch(vm.runInContext('eventContext.data.ahEntrants=[];eventHome()',sandbox),/id="ev-entrants-title"/);
});

test('Briefing : drapeaux Unicode lisibles sur Windows, sans remplacer IT dans le texte ni exposer du HTML',async()=>{
  const {sandbox}=makeBrowser();await new Promise(resolve=>setImmediate(resolve));
  const html=vm.runInContext("renderEventRichText('Monza 🇮🇹\\nSpa 🇧🇪 et IT. <img src=x> [France 🇫🇷](https://example.com) 🇿🇿')",sandbox);
  assert.match(html,/<img class="event-country-flag" src="\/assets\/flags\/it\.svg" alt="Drapeau : Italie">/);
  assert.match(html,/\/assets\/flags\/be\.svg/);
  assert.match(html,/<a href="https:\/\/example\.com"[^>]*>France <img class="event-country-flag" src="\/assets\/flags\/fr\.svg"/);
  assert.match(html,/ et IT\./);
  assert.match(html,/🇿🇿/,'un code non pris en charge reste du texte');
  assert.match(html,/&lt;img src=x&gt;/);
  assert.doesNotMatch(html,/<img src=x>/);
  for(const code of vm.runInContext('[...eventFlagCodes]',sandbox))assert.ok(fs.existsSync(path.join(root,'assets/flags',code.toLowerCase()+'.svg')),code);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/m2-c2.json'), 'utf8'));
const patchSource = fs.readFileSync(path.join(root, 'patches-v71.js'), 'utf8');
const siteSource = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
const mancheStart = siteSource.indexOf('function manche(){');
const mancheEnd = siteSource.indexOf('// Performance ratings', mancheStart);
assert.ok(mancheStart >= 0 && mancheEnd > mancheStart, 'manche() renderer must be present in site.js');
const mancheSource = siteSource.slice(mancheStart, mancheEnd);

function makeContext() {
  const priorRound = {
    date: '2026-09-09T21:37:00+02:00',
    track: 'mt-tremblant_69',
    type: 'QUALIFY',
    results: []
  };
  const initialSessions = [priorRound, ...fixture.sessions];
  const sandbox = {
    console,
    localStorage: { setItem() {}, getItem() { return null; } },
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    prompt() { return '0'; },
    confirm() { return false; },
    window: null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    let sessions = ${JSON.stringify(initialSessions)};
    let penMap = ${JSON.stringify(fixture.penMap)};
    let eventContext = {slug:${JSON.stringify(fixture.event.slug)},pointsConfig:${JSON.stringify(fixture.event.points_config)}};
    let page = 'hub', round = 1, sessionIndex = 2, eventtab = 'resultats';
    let backendMulti = true;
    const DEFAULT_POINTS = {pointsScale:[41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],polePoints:1,doubleLongRaces:true,longRaceMinutes:60,minPercentDistance:.75,jokerCount:8,globalCoef:1};
    function track(x){return x;}
    function rounds(){const m=new Map();for(const s of sessions)if(s&&s.date){const d=String(s.date).slice(0,10);if(!m.has(d))m.set(d,[]);m.get(d).push(s);}const order={QUALIFY:0,RACE:1,PRACTICE:2};return [...m.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,list],i)=>{list.sort((a,b)=>(order[a.type]??9)-(order[b.type]??9)||String(a.date||'').localeCompare(String(b.date||'')));return {date,sessions:list,track:track(list[0].track),number:i+1};});}
    function findSessionIdx(sess){const rs=rounds();for(let i=0;i<rs.length;i++){const j=rs[i].sessions.indexOf(sess);if(j>=0)return [i,j];}return [-1,-1];}
    function pointsConfig(){return Object.assign({},DEFAULT_POINTS,eventContext&&eventContext.pointsConfig||{});}
    function allDrivers(){const m=new Map();for(const s of sessions)for(const r of s.results||[])if(!m.has(r.id))m.set(r.id,{...r});return [...m.values()];}
    function saveState(){}
    function render(){}
    function addAdjustment(rj,sj,id,timeAdd,dq,warning,note){penMap[rj+':'+sj+':'+id]={timeAdd,dq,warning,note};}
    async function loadEvent(){return {slug:eventContext.slug};}
    async function loadRemoteLegacy(){return {ok:true};}
    function head(){return '';}
    function hub(){return '<hub>';}
    function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function date(x){return String(x);}
    function fmt(t){if(!t||t<0||t>99999999)return '—';const m=Math.floor(t/60000),s=((t%60000)/1000).toFixed(3);return m+':'+s.padStart(6,'0');}
    function tabs(){return '';}
    function table(headers,rows){return '<table><thead><tr>'+headers.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+(rows||[]).join('')+'</tbody></table>';}
  `;
  vm.runInContext(prelude, sandbox);
  vm.runInContext(patchSource, sandbox);
  vm.runInContext(mancheSource, sandbox);
  return sandbox;
}

test('default boot stays on the home page; event groups and penalties use lexical app state', async () => {
  const ctx = makeContext();
  await vm.runInContext('loadEvent()', ctx);

  assert.equal(vm.runInContext('page', ctx), 'hub', 'the results patch must not redirect the home page');
  assert.equal(vm.runInContext('rounds().length', ctx), 2);
  assert.deepEqual(Array.from(vm.runInContext('rounds()[1].sessions.map(s=>s.type)', ctx)), ['QUALIFY', 'RACE', 'RACE']);

  const beforeTime = vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='Karl74').time", ctx);
  assert.equal(beforeTime, 1531653);
  assert.equal(vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='Karl74').penaltyTime", ctx), 0);
  assert.equal(vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='51R Sherman').hasPenalty", ctx), false);

  const cfg = vm.runInContext('pointsConfig()', ctx);
  assert.equal(cfg.doubleLongRaces, true, 'the Lola championship keeps its one-race double-points rule');
});

test('M2 C2 results show commission penalties and the expected adjusted gaps', async () => {
  const ctx = makeContext();
  await vm.runInContext('loadEvent()', ctx);
  const html = vm.runInContext('manche()', ctx);
  assert.match(html, /<th>Pénal\.<\/th>/);

  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map(match => match[1]);
  const rowOf = name => rows.find(row => row.includes(`<b>${name}</b>`));
  const expected = [
    ['Karl74', 10, '+5s', '+22.098 s'],
    ['Thomas PONGE', 12, '+5s', '+29.413 s'],
    ['Yohana.L', 21, '+30s', '+56.270 s'],
    ['Pikoupok', 23, '+10s', '+99.865 s'],
    ['51R Sherman', 11, '—', '+26.478 s']
  ];
  for (const [name, position, penalty, gap] of expected) {
    const row = rowOf(name);
    assert.ok(row, `missing results row for ${name}`);
    if (position !== null) assert.match(row, new RegExp(`class="pos">0*${position}<\\/td>`));
    assert.ok(row.includes(`class="${penalty === '—' ? 'muted' : 'penalty'}">${penalty}</td>`), `${name}: missing ${penalty}`);
    assert.ok(row.includes(`<td>${gap}</td>`), `${name}: missing expected gap ${gap}`);
  }
});

test('overall calculation applies Commission repeatedly without changing source times', async () => {
  const ctx = makeContext();
  await vm.runInContext('loadEvent()', ctx);
  const first = vm.runInContext('calculate()', ctx);
  const karlTime1 = vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='Karl74')._t", ctx);
  const second = vm.runInContext('calculate()', ctx);
  const karlTime2 = vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='Karl74')._t", ctx);

  assert.ok(first.some(d => d.name === 'Karl74'));
  assert.ok(second.some(d => d.name === 'Yohana.L'));
  assert.equal(karlTime1, 1536653);
  assert.equal(karlTime2, karlTime1);
  assert.equal(vm.runInContext("rounds()[1].sessions[2].results.find(r=>r.name==='Karl74').time", ctx), 1531653);
});

test('qualification time penalties are displayed/sorted without compounding on rerender', async () => {
  const ctx = makeContext();
  await vm.runInContext('loadEvent()', ctx);
  const result = vm.runInContext(`
    const q=rounds()[1].sessions[0];
    const id=q.results[0].id;
    penMap['1:0:'+id]={timeAdd:5,dq:false,warning:false};
    const original=q.results[0].best;
    const first=sortSession(q).find(r=>r.id===id)._adjustedBest;
    const second=sortSession(q).find(r=>r.id===id)._adjustedBest;
    ({original,stored:q.results[0].best,first,second})
  `, ctx);
  assert.equal(result.stored, result.original);
  assert.equal(result.first, result.original + 5000);
  assert.equal(result.second, result.first);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const snapshot = require('../assets/trueskill-rating');

const nearly = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);
const players = () => [
  {id: 'a', name: 'Alice', team: 'A', mu: snapshot.INITIAL_MU, sigma: snapshot.INITIAL_SIGMA, rank: 1},
  {id: 'b', name: 'Bob', team: 'B', mu: snapshot.INITIAL_MU, sigma: snapshot.INITIAL_SIGMA, rank: 2},
  {id: 'c', name: 'Chris', team: 'C', mu: snapshot.INITIAL_MU, sigma: snapshot.INITIAL_SIGMA, rank: 2},
  {id: 'd', name: 'Darren', team: 'D', mu: snapshot.INITIAL_MU, sigma: snapshot.INITIAL_SIGMA, rank: 4}
];

test('le portage reproduit les valeurs de référence du graphe TrueSkill', () => {
  const output = snapshot.adjustRace(players(), {beta: snapshot.INITIAL_SIGMA / 2, sigmaDrift: 0, drawProbability: 0.1});
  const byId = Object.fromEntries(output.map(player => [player.id, player.after]));
  nearly(byId.a.mu, 31.56483337506063);
  nearly(byId.a.sigma, 6.404441592921178);
  nearly(byId.b.mu, 24.99310858789835);
  nearly(byId.b.sigma, 5.559087686214837);
  nearly(byId.c.mu, 25.00688427829391);
  nearly(byId.c.sigma, 5.559130208565418);
  nearly(byId.d.mu, 18.43639922882849);
  nearly(byId.d.sigma, 6.404413630120918);
});

test('un résultat inattendu modifie davantage un pilote peu sûr de lui qu’un favori établi', () => {
  const input = [
    {id: 'rookie', name: 'Rookie', mu: 25, sigma: 8, rank: 1},
    {id: 'veteran', name: 'Vétéran', mu: 25, sigma: 2, rank: 2}
  ];
  const [rookie, veteran] = snapshot.adjustRace(input, {beta: 5.5, sigmaDrift: 0});
  assert.ok(rookie.deltaMu > veteran.deltaMu, `rookie ${rookie.deltaMu} doit gagner plus que vétéran ${veteran.deltaMu}`);
  assert.ok(rookie.after.sigma < rookie.before.sigma);
  assert.ok(veteran.after.sigma <= veteran.before.sigma + 1e-12);
});

test('replay rejette ou ignore proprement les entrées non admissibles sans toucher au reste', () => {
  const courses = [
    {key: 'bad-zero', date: '2026-01-01', globalWeight: 0, entries: [{id: 'x', name: 'X', outcome: 'classified'}, {id: 'y', name: 'Y', outcome: 'classified'}]},
    {key: 'race-1', date: '2026-01-02', globalWeight: 1, entries: [
      {id: 'service', name: 'Broadcast', outcome: 'classified', service: true, rank: 1},
      {id: 'dns', name: 'DNS', outcome: 'dns'},
      {id: 'alice', name: 'Alice', outcome: 'classified', rank: 2},
      {id: 'bob', name: 'Bob', outcome: 'dq_sporting', rank: 3},
      {id: 'charlie', name: 'Charlie', outcome: 'dnf_unqualified'}
    ]},
    {key: 'race-2', date: '2026-01-03', globalWeight: 1, entries: [
      {id: 'alice', name: 'Alice', outcome: 'classified'}, {id: 'bob', name: 'Bob', outcome: 'classified'}
    ]}
  ];
  const result = snapshot.replay(courses, {minRaces: 1, beta: 5.5});
  assert.deepEqual(result.diagnostics.skipped.map(x => x.reason), ['Coefficient Global nul']);
  assert.equal(result.diagnostics.coursesUsed, 2);
  const all = Object.fromEntries(result.all.map(r => [r.id, r]));
  assert.equal(all.service, undefined);
  assert.equal(all.dns, undefined);
  assert.equal(all.charlie, undefined);
  assert.deepEqual(all.alice.history.map(h => h.rank), [1, 1]);
  assert.deepEqual(all.bob.history.map(h => h.rank), [2, 2]);
});

test('le coefficient réduit la taille du mouvement pour une même surprise', () => {
  const low = snapshot.replay([{key: 'r', date: '2026-01-01', globalWeight: 0.5, entries: [{id: 'a', name: 'A', outcome: 'classified'}, {id: 'b', name: 'B', outcome: 'classified'}]}], {minRaces: 1, beta: 5.5});
  const high = snapshot.replay([{key: 'r', date: '2026-01-01', globalWeight: 1, entries: [{id: 'a', name: 'A', outcome: 'classified'}, {id: 'b', name: 'B', outcome: 'classified'}]}], {minRaces: 1, beta: 5.5});
  const lowA = low.all.find(r => r.id === 'a'), highA = high.all.find(r => r.id === 'a');
  assert.ok(Math.abs(lowA.history[0].deltaMu) < Math.abs(highA.history[0].deltaMu));
});

test('le replay est chronologique, déterministe et respecte les exclusions administration', () => {
  const make = () => [
    {key: 'later', date: '2026-02-01', globalWeight: 1, entries: [{id: 'alice', name: 'Alice', outcome: 'classified'}, {id: 'bob', name: 'Bob', outcome: 'classified'}, {id: 'cara', name: 'Cara', outcome: 'classified'}]},
    {key: 'earlier', date: '2026-01-01', globalWeight: 1, entries: [{id: 'bob', name: 'Bob', outcome: 'classified'}, {id: 'alice', name: 'Alice', outcome: 'classified'}, {id: 'cara', name: 'Cara', outcome: 'classified'}]}
  ];
  const first = snapshot.replay(make(), {minRaces: 2, beta: 5.5});
  const second = snapshot.replay(make(), {minRaces: 2, beta: 5.5});
  assert.deepEqual(first.all.map(r => r.history.map(h => h.key)), first.all.map(() => ['earlier', 'later']));
  assert.equal(JSON.stringify(first.all), JSON.stringify(second.all));
  const hidden = snapshot.replay(make(), {minRaces: 1, hidden: {alice: true}, beta: 5.5});
  assert.equal(hidden.all.find(r => r.id === 'alice'), undefined);
  assert.deepEqual(hidden.all.map(r => r.id).sort(), ['bob', 'cara']);
});

test('un tableau de courses vide ou une entrée rangée sans elle-même reste géré proprement', () => {
  assert.deepEqual(snapshot.replay([], {}).ratings, []);
  assert.throws(() => snapshot.adjustRace([{id: 'solo', name: 'Solo', mu: 25, sigma: 8, rank: 1}]), /au moins deux/);
  const tied = snapshot.adjustRace([{id: 'a', name: 'A', mu: 25, sigma: 8, rank: 1}, {id: 'b', name: 'B', mu: 25, sigma: 8, rank: 1}], {beta: 5.5});
  assert.equal(tied.length, 2);
});

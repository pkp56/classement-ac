#!/usr/bin/env node
/* GDSP — benchmark walk-forward de l'indice TrueSkill expérimental.
 *
 * Usage : node tools/trueskill-benchmark.js <export.json> [--beta=5.5]
 *
 * <export.json> : soit un tableau d'événements GDSP
 *   [{ slug, name, kind, points_config, data: { sessions, penMap } }, …]
 *   soit la structure de la fixture m2-c2 : { event, sessions, penMap }.
 *
 * Pour chaque course k, l'indice est calculé sur les courses 1…k−1 uniquement,
 * puis comparé au résultat réel. Le même protocole est appliqué à une baseline
 * Elo pairwise et à une baseline « plus expérimenté ». Les courses sont les
 * mêmes que celles rejouées par l'interface : RACE, coefficient Global > 0,
 * corrections Commission appliquées, DNF non qualifiés et DNS exclus.
 *
 * Aucune donnée n'est modifiée. L'outil ne tranche pas l'adoption : il produit
 * des métriques que la Commission doit geler AVANT de regarder les résultats.
 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = require('../assets/trueskill-rating');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const betaArg = args.find(a => a.startsWith('--beta='));
const beta = betaArg ? Number(betaArg.split('=')[1]) : 5.5;
const inputPath = args.find(a => !a.startsWith('--'));
if (!inputPath) {
  console.error('Usage : node tools/trueskill-benchmark.js <export.json> [--beta=5.5]');
  process.exit(2);
}
if (!Number.isFinite(beta) || beta <= 0) {
  console.error('--beta doit être un nombre strictement positif.');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
let events;
if (Array.isArray(raw)) {
  events = raw;
} else if (raw && raw.event && Array.isArray(raw.sessions)) {
  events = [{ slug: raw.event.slug, name: raw.event.slug, kind: 'championship', points_config: raw.event.points_config || {}, data: { sessions: raw.sessions, penMap: raw.penMap || {} } }];
} else {
  console.error('Format non reconnu : tableau d’événements ou { event, sessions, penMap } attendu.');
  process.exit(2);
}

// Profilage côté Node avec les MÊMES copies de fonctions que l'application mobile
// (groupSessionsByDate, sortSessionForPerf, eventGlobalWeight…) : zéro divergence.
const context = { console, Map, Set, Date, Math, JSON, Object, Array, String, Number, RegExp, Error, TypeError, RangeError };
context.window = context;
vm.createContext(context);
for (const file of ['assets/global-rating.js', 'assets/entrant-roles.js', 'assets/trueskill-rating.js', 'assets/trueskill-gdsp.js', 'mobile/profile-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const internals = vm.runInContext('gdspMobileProfiles.internals', context);
const built = JSON.parse(JSON.stringify(context.GDSPTrueSkillAdapter.buildCourses(JSON.parse(JSON.stringify(events)), {
  ...internals,
  serviceOf: entrant => context.GDSPEntrantRoles.serviceRole(entrant)
})));

const INCLUDED = new Set(engine.INCLUDED_OUTCOMES);
const raceSummaries = [];

// État TrueSkill et Elo en cours de rejeu.
const ts = new Map(), elo = new Map();
const metrics = { trueskill: [], elo: [], experienced: [] };
const state = id => {
  if (!ts.has(id)) ts.set(id, { id, mu: engine.INITIAL_MU, sigma: engine.INITIAL_SIGMA, races: 0 });
  return ts.get(id);
};
const eloState = id => {
  if (!elo.has(id)) elo.set(id, { rating: 1500 });
  return elo.get(id);
};
function metricsFor(predOrder, actualOrder) {
  // predOrder : ids triés du plus fort au plus faible ; actualOrder : ids du 1er au dernier.
  const pos = new Map(actualOrder.map((id, i) => [id, i + 1]));
  const predPos = new Map(predOrder.map((id, i) => [id, i + 1]));
  const common = actualOrder.filter(id => predPos.has(id));
  if (common.length < 2) return null;
  const winner = actualOrder[0] === predOrder[0] ? 1 : 0;
  const podiumActual = new Set(actualOrder.slice(0, 3));
  const podiumPred = new Set(predOrder.slice(0, 3));
  const podium = [...podiumActual].filter(id => podiumPred.has(id)).length / Math.min(3, podiumActual.size);
  const mae = common.reduce((sum, id) => sum + Math.abs(predPos.get(id) - pos.get(id)), 0) / common.length;
  return { winner, podium, mae, n: common.length };
}
for (const course of built) {
  const included = course.entries.filter(e => INCLUDED.has(e.outcome)).slice().sort((a, b) => a.rank - b.rank);
  if (included.length < 2) continue;
  const ids = included.map(e => e.id);
  // Prédictions AVANT la course k.
  const predTrueSkill = ids.slice().sort((a, b) => (state(b).mu - 3 * state(b).sigma) - (state(a).mu - 3 * state(a).sigma) || a.localeCompare(b, 'fr'));
  const predElo = ids.slice().sort((a, b) => eloState(b).rating - eloState(a).rating || a.localeCompare(b, 'fr'));
  const predExperienced = ids.slice().sort((a, b) => state(b).races - state(a).races || state(b).mu - state(a).mu || a.localeCompare(b, 'fr'));
  for (const [key, pred] of [['trueskill', predTrueSkill], ['elo', predElo], ['experienced', predExperienced]]) {
    const m = metricsFor(pred, ids);
    if (m) metrics[key].push(m);
  }
  // Mise à jour TrueSkill (identique à GDSPTrueSkill.replay : β / sqrt(w), dérive σ).
  const players = included.map(e => { const s = state(e.id); s.races += 1; return { id: e.id, name: e.name, team: e.team, mu: s.mu, sigma: s.sigma, rank: e.rank }; });
  const updated = engine.adjustRace(players, { beta: beta / Math.sqrt(course.globalWeight || 1), sigmaDrift: engine.DEFAULT_SIGMA_DRIFT });
  for (const u of updated) { const s = state(u.id); s.mu = u.after.mu; s.sigma = u.after.sigma; }
  // Mise à jour Elo pairwise (K = 32 / (n−1) par comparaison, zero-sum par paire).
  const K = 32 / Math.max(1, included.length - 1);
  for (let i = 0; i < included.length; i++) {
    for (let j = i + 1; j < included.length; j++) {
      const a = eloState(included[i].id), b = eloState(included[j].id);
      const expected = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
      a.rating += K * (1 - expected);
      b.rating += K * (0 - (1 - expected));
    }
  }
  raceSummaries.push({ label: course.label, date: course.date, participants: included.length });
}

const summarize = list => {
  if (!list.length) return { races: 0, winner: 0, podium: 0, mae: 0 };
  return {
    races: list.length,
    winner: list.reduce((n, m) => n + m.winner, 0) / list.length,
    podium: list.reduce((n, m) => n + m.podium, 0) / list.length,
    mae: list.reduce((n, m) => n + m.mae, 0) / list.length
  };
};
const report = Object.fromEntries(Object.entries(metrics).map(([key, list]) => [key, summarize(list)]));
const pct = v => (100 * v).toFixed(1) + ' %';
console.log('GDSP — benchmark walk-forward TrueSkill (expérimental)');
console.log('Courses évaluées :', raceSummaries.length, '· β_GDSP =', beta, '· (DNF/DNS/services exclus, coefficient Global appliqué)');
console.log('');
console.log('                  Victoire   Podium    MAE position');
for (const key of ['trueskill', 'elo', 'experienced']) {
  const r = report[key];
  console.log(key.padEnd(15), pct(r.winner).padEnd(10), pct(r.podium).padEnd(9), r.mae.toFixed(2));
}
console.log('');
console.log('Lecture : chaque course est prédite à partir des seules courses antérieures.');
console.log('Aucune métrique ne prouve à elle seule l’adoption : la Commission doit geler les seuils');
console.log('AVANT de lire ces résultats, et l’export complet de l’historique est nécessaire.');
void raceSummaries;

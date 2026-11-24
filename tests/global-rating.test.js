const {test}=require('node:test');
const assert=require('node:assert/strict');
const {conduct,aggregate,percentile}=require('../assets/global-rating');
const review=(incidents=[])=>conduct({conduct:{version:1,reviewed:true,incidents,reason:'Décision validée'}});
function record(i,options={}){
  const score=options.score??80,c=options.conduct||review();
  return {id:'pilot',key:'race-'+i,ts:i,date:String(i),label:'Course '+i,name:'Pilote',
    conduct:c,axes:{regularite:score,proprete:c.score,vitesse:score,resultats:score},...options};
}
const rate=records=>aggregate(records,{minRaces:1})[0];
test('barème explicite, zéro incident et plancher',()=>{
  assert.equal(review().score,100);
  for(const [severity,points] of Object.entries({warning:5,minor:10,major:20,severe:35,dq:50}))assert.equal(review([{severity}]).score,100-points);
  assert.equal(review(Array(4).fill({severity:'severe'})).score,0);
});
test('attendre atténue uniquement un incident éligible, sans bonus',()=>{
  assert.equal(review([{severity:'major',returned:true}]).score,90);
  assert.equal(review([{severity:'major',returned:true},{severity:'major'}]).score,70);
  assert.equal(review([{severity:'severe',returned:true}]).score,65);
  assert.equal(review([{severity:'dq',returned:true}]).score,50);
  assert.equal(review([{severity:'major',returned:true,intentional:true}]).score,80);
});
test('pas de déduction depuis secondes, commentaire, DT supposé ou points',()=>{
  const c=conduct({timeAdd:5,note:'a attendu, drive through'});
  assert.equal(c.score,null);assert.equal(c.pending,true);
  assert.equal(conduct({warning:true}).pending,true);
  assert.equal(conduct({dq:true}).pending,true);
  for(const adj of [{},{dnf:true},{dns:true},{pointsDelta:-5},{hasPenalty:true}]){
    assert.equal(conduct(adj).score,100);assert.equal(conduct(adj).reviewed,false);
  }
});
test('un examen ne double pas avertissement, temps et incident qualifié',()=>{
  assert.equal(conduct({warning:true,timeAdd:15,conduct:{version:1,reviewed:true,incidents:[{severity:'major'}]}}).score,80);
  assert.equal(conduct({conduct:{version:1,reviewed:true,incidents:[{severity:'unknown'}]}}).score,null);
});
test('pas de joker avant 10 ; 9 retenues exactement dès 10',()=>{
  const nine=rate(Array.from({length:9},(_,i)=>record(i)));
  assert.equal(nine.joker,null);assert.equal(nine.retainedCount,9);assert.equal(nine.provisional,true);
  const ten=rate(Array.from({length:10},(_,i)=>record(i,{score:i===0?0:80})));
  assert.equal(ten.joker.key,'race-0');assert.equal(ten.retainedCount,9);assert.equal(ten.provisional,false);
  assert.equal(ten.details.resultats,80);
});
test('fenêtre chronologique de 10, indépendante de l’ordre et de l’âge absolu',()=>{
  const a=Array.from({length:15},(_,i)=>record(i,{score:i}));
  const r=rate(a),backwards=rate([...a].reverse());
  assert.equal(r.count,15);assert.equal(r.windowCount,10);assert.deepEqual(r,backwards);
  assert(!r.window.some(x=>x.key==='race-4'));
});
test('le joker ne gomme jamais la propreté ni une décision non qualifiée',()=>{
  const records=Array.from({length:10},(_,i)=>record(i,{score:i===0?0:80}));
  records[0]=record(0,{score:0,conduct:review([{severity:'dq'}])});
  const r=rate(records);assert.equal(r.joker.key,'race-0');assert.equal(r.details.proprete,95);
  records[0]=record(0,{score:0,conduct:conduct({timeAdd:5})});
  const p=rate(records);assert.equal(p.conductPending,1);assert.equal(p.provisional,true);
});
test('données manquantes neutres et statuts visibles, pas de faux examen',()=>{
  const r=rate([record(1,{conduct:conduct({warning:true})})]);
  assert.equal(r.details.proprete,50);assert.equal(r.conductPending,1);assert.equal(r.conductReviewed,0);
  const unknown=rate(Array.from({length:10},(_,i)=>record(i,{conduct:conduct()})));
  assert.equal(unknown.details.proprete,100);assert.equal(unknown.conductReviewed,0);
  // Nouvelle règle : la détection auto évalue une course sans examen Commission,
  // donc 10 courses évaluées ne sont plus « provisoires » pour absence d'examen.
  const auto=rate(Array.from({length:10},(_,i)=>record(i,{conduct:conduct(undefined,{score:94,cuts:3,lossSec:0,incidents:0})})));
  assert.equal(auto.details.proprete,94);assert.equal(auto.provisional,false);assert.equal(auto.conductAuto,10);assert.equal(auto.conductReviewed,0);
});
test('détection auto en secours de la Commission, jamais si décision à qualifier',()=>{
  const {conduct:conductWithAuto,autoConduct}=require('../assets/global-rating');
  // cut = 2 pts, choc arrière = secondes perdues ÷ 2 ; côte à côte et <1,5 s exclus en amont
  assert.equal(autoConduct({cuts:3,lossSec:0,incidents:[]}).score,94);
  assert.equal(autoConduct({cuts:0,lossSec:3.0,incidents:[{lossSec:3.0}]}).score,98.5);
  assert.equal(autoConduct({cuts:2,lossSec:4.0,incidents:[{lossSec:4.0}]}).score,94);
  assert.equal(autoConduct(undefined).score,100);
  // Commission (examen validé) prime sur l'auto
  const commission=conductWithAuto({conduct:{version:1,reviewed:true,incidents:[{severity:'major'}],reason:'Validé'}},{score:10,cuts:5,lossSec:10,incidents:[{lossSec:10}]});
  assert.equal(commission.score,80);assert.equal(commission.reviewed,true);assert.equal(commission.auto,undefined);
  // Décision à qualifier : ni examen ni auto ne comptent
  const pending=conductWithAuto({warning:true},{score:10,cuts:5,lossSec:10,incidents:[{lossSec:10}]});
  assert.equal(pending.score,null);assert.equal(pending.pending,true);
  // Sinon, l'auto s'applique
  const auto=conductWithAuto({},{score:88,cuts:2,lossSec:4,incidents:[{lossSec:4}]});
  assert.equal(auto.score,88);assert.equal(auto.auto,true);assert.equal(auto.cuts,2);
});
test('DNS, non-partants, doublons, exclusions et minimum cinq',()=>{
  const records=Array.from({length:5},(_,i)=>record(i));
  assert.equal(aggregate(records).length,1);
  assert.equal(aggregate([...records,record(1)])[0].count,5);
  assert.equal(aggregate(records,{hidden:{pilot:true}}).length,0);
  records[0].dns=true;assert.equal(aggregate(records).length,0);
  records[0].dns=false;records[0].started=false;assert.equal(aggregate(records).length,0);
});
test('percentiles : données absentes, égalités et classement',()=>{
  assert.deepEqual(percentile([{x:10},{x:20},{x:null}],'x'),[100,0,null]);
  assert.deepEqual(percentile([{x:10},{x:10}],'x'),[50,50]);
  assert.deepEqual(percentile([{x:10}],'x'),[null]);
});

test('vérification serveur indépendante de l’ordre des clés JSONB',()=>{
  const {reviewSignature}=require('../assets/global-rating');
  assert.equal(reviewSignature({a:1,b:{x:2,y:3}}),reviewSignature({b:{y:3,x:2},a:1}));
  assert.notEqual(reviewSignature(undefined),reviewSignature({}));
});

test('pondération Global : poids 0 exclu et moyenne pondérée pour 1 / 0.75 / 0.5',()=>{
  const base=Array.from({length:5},(_,i)=>record(i,{score:100,weight:1}));
  const zero=Array.from({length:5},(_,i)=>record(10+i,{score:0,weight:0}));
  const onlyBase=aggregate([...base,...zero],{minRaces:5})[0];
  assert.equal(onlyBase.count,5);
  assert.equal(onlyBase.score,100);
  assert.equal(aggregate(zero,{minRaces:1}).length,0);

  const weighted=[
    record(1,{score:100,weight:1}),
    record(2,{score:100,weight:1}),
    record(3,{score:100,weight:1}),
    record(4,{score:60,weight:0.5}),
    record(5,{score:80,weight:0.75})
  ];
  const r=aggregate(weighted,{minRaces:5})[0];
  const expected=((100*3)+(60*0.5)+(80*0.75))/(3+0.5+0.75);
  assert.ok(Math.abs(r.details.resultats-expected)<1e-9);
});

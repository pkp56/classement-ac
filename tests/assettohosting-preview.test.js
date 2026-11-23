'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeChampionship,frenchDate}=require('../tools/lib/assettohosting-preview');
const server='https://fr2.assettohosting.com:50648';
const uuid='11111111-1111-1111-1111-111111111111';
function exportFixture(){return {
  ID:uuid,Name:'Cup des pilotes',Info:'Briefing de course',ReplacementPassword:'secret-ne-pas-exposer',SignUpForm:{Enabled:true,Responses:[{Email:'private@example.test'}]},
  Classes:[{AvailableCars:['voiture_a'],Points:{Places:[13,11,0],PolePosition:1,BestLap:0,MostLapsLed:0,SecondRaceMultiplier:1,RequiredRaceTimePercentage:0},Entrants:{
    a:{Name:'Pilote A',Team:'Équipe A',Model:'voiture_a',Skin:'bleu',GUID:'secret-id'},b:{Name:'',GUID:''},c:{Name:'Spectateur',ConnectAsSpectator:true}
  }}],
  Events:[{Scheduled:'2026-11-30T21:00:00+01:00',RaceWeekend:{Name:'Manche 1',Sessions:[
    {RaceConfig:{Track:'monza',TrackLayout:'junior',Sessions:{QUALIFY:{Name:'Qualifying',Time:10,Laps:0}}}},
    {RaceConfig:{Track:'monza',TrackLayout:'junior',Sessions:{RACE:{Name:'Course 1',Time:15,Laps:0}}}}
  ]}},{Scheduled:'0001-01-01T00:00:00Z',RaceWeekend:{Name:'Manche 2',Sessions:[
    {RaceConfig:{Track:'spa',Sessions:{QUALIFY:{Name:'Qualifying',Time:10},RACE:{Name:'Course 1',Time:15}}}}
  ]}}]
}}

test('aperçu AH : projection utile, dates réelles, pas de secrets ni identifiants Steam',()=>{
  const out=summarizeChampionship(exportFixture(),server,uuid);
  assert.equal(out.name,'Cup des pilotes');assert.equal(out.briefing,'Briefing de course');assert.equal(out.car,'voiture_a');
  assert.equal(out.registrationUrl,server+'/championship/'+uuid);
  assert.equal(out.entrantsAvailable,true);
  assert.deepEqual(out.entrants,[{name:'Pilote A',team:'Équipe A',car:'voiture_a',skin:'bleu'}]);
  assert.equal(out.rounds[0].date,'2026-11-30');assert.equal(out.rounds[1].date,'');
  assert.equal(out.formatText,'Qualifying : 10 min · Course 1 : 15 min');
  assert.deepEqual(out.points.pointsScale,[13,11,0]);assert.equal(out.points.bestLapPoints,0);assert.equal(out.points.minPercentDistance,undefined);
  const serialized=JSON.stringify(out);assert.doesNotMatch(serialized,/secret|GUID|private@example/);
});

test('pas de date ni format inventés et pas de barème ambigu en multiclasse',()=>{
  assert.equal(frenchDate('0001-01-01T00:00:00Z'),'');
  assert.equal(frenchDate('2026-11-30T21:00:00'),'');
  assert.equal(frenchDate('2026-11-30T23:30:00Z'),'2026-12-01');
  const data=exportFixture();data.Classes.push({Points:{Places:[1]}});data.Events[1].RaceWeekend.Sessions[0].RaceConfig.Sessions.RACE.Time=20;
  const out=summarizeChampionship(data,server,uuid);
  assert.equal(out.formatText,'');assert.match(out.note,/diffèrent/);assert.equal(out.points,null);
  assert.throws(()=>summarizeChampionship({...data,ID:'wrong'},server,uuid),/ne correspond pas/);
});

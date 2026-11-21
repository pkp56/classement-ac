'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {retainVerifiedSessions}=require('../tools/lib/ah-session-safety');

test('Un résultat voisin dans le temps ne prouve pas son appartenance au championnat',()=>{
  const items=[{source:'export',eventId:'confirmed'},{source:'url',eventId:'unverified',date:'2026-11-18T21:54:00Z'}];
  const diagnostics={missing:[],ignored:[]};
  assert.deepEqual(retainVerifiedSessions(items,diagnostics).map(x=>x.eventId),['confirmed']);
  assert.equal(diagnostics.missing[0].eventId,'unverified');
});

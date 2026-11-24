'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validSlug,calendar,eventCard,eventDetail,liveView,filterEventsList}=require('../mobile/mobile');
const root=path.resolve(__dirname,'..');

test('application mobile : manifeste local, portée limitée et icônes installables',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'mobile/manifest.webmanifest'),'utf8'));
  assert.equal(manifest.start_url,'/mobile/');assert.equal(manifest.scope,'/mobile/');assert.equal(manifest.display,'standalone');
  for(const icon of manifest.icons){
    assert.match(icon.src,/^\/mobile\/icons\//);const bytes=fs.readFileSync(path.join(root,icon.src));
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    const [w,h]=icon.sizes.split('x').map(Number);assert.equal(bytes.readUInt32BE(16),w);assert.equal(bytes.readUInt32BE(20),h);
  }
  const sw=fs.readFileSync(path.join(root,'mobile/sw.js'),'utf8');
  assert.match(sw,/req\.method!==\x27GET\x27/);assert.match(sw,/SHELL\.includes/);assert.doesNotMatch(sw,/['"]\/api\//);
  assert.match(sw,/gdsp-mobile-shell-v10/);assert.match(sw,/self\.skipWaiting\(\)/);assert.match(sw,/self\.clients\.claim\(\)/);
  const html=fs.readFileSync(path.join(root,'mobile/index.html'),'utf8');
  assert.match(html,/mobile\.js\?v=6/);assert.match(html,/mobile\.css\?v=5/);assert.match(html,/app-update-banner/);
  assert.match(html,/results-engine\.js\?v=5/);assert.match(html,/event-views\.js\?v=5/);assert.match(html,/profile-engine\.js\?v=7/);assert.match(html,/profile-views\.js\?v=10/);assert.match(html,/global-rating\.js/);assert.match(html,/trueskill-rating\.js\?v=1/);assert.match(html,/trueskill-gdsp\.js\?v=1/);assert.match(html,/patches-v71\.js/);
});

test('événements mobiles : échappement, liens locaux, pas de classement inventé',()=>{
  assert.ok(validSlug('open-2026'));for(const x of ['','../x','a/b','HTTPS://a','a b'])assert.equal(validSlug(x),false);
  assert.equal(eventCard({slug:'../x',name:'Mauvais'}),'');
  const card=eventCard({slug:'cup',name:'<img src=x>',kind:'cup'});
  assert.match(card,/&lt;img src=x&gt;/);assert.doesNotMatch(card,/<img/);
  const html=eventDetail({slug:'cup',name:'Cup',kind:'cup',data:{eventInfo:{briefing:'<script>alert(1)</script> [Lien](https://example.com) [Piège](javascript:alert(1))'},ahEntrants:[{name:'A & B',team:'<b>x</b>',car:'alfa_spider'}]}});
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/A &amp; B/);
  assert.match(html,/href="https:\/\/example\.com"/);assert.doesNotMatch(html,/href="javascript:/);
  assert.match(html,/Liste distincte des résultats et du classement/);assert.match(html,/href="#detail=cup"/);
  assert.match(html,/href="#car=cup"/);assert.match(html,/href="#circuit=cup"/);
  assert.doesNotMatch(html,/\bpoints\b|<table/i);
});

test('catalogue mobile : mêmes tombstones et doublon historique que le PC, archives conservées',()=>{
  const input=[
    {slug:'lola-t290-2026',name:'Ancienne Lola',kind:'championship'},
    {slug:'lola-t290-gdsp-championnat-2026',name:'Lola',kind:'archive'},
    {slug:'supprime',name:'[DELETED]'},
    {slug:'supprime-2',name:'Supprimé',points_config:{_deleted:true}},
    {slug:'supprime-3',name:'Supprimé localement'},
    {slug:'actif',name:'Cup',kind:'cup'}
  ];
  const shown=filterEventsList(input,{'supprime-3':true});
  assert.deepEqual(shown.map(e=>[e.slug,e.kind]),[['lola-t290-gdsp-championnat-2026','archive'],['actif','cup']]);
  assert.equal(filterEventsList([{slug:'lola-t290-2026',name:'Seule Lola'}]).length,1);
});
test('direct mobile : instantané échappé sans cadre PC',()=>{
  const html=liveView({status:{status:'online'},server:{name:'GDSP',track:'Spa'},cars:[{connected:true,position:1,name:'<Pilote>',laps:4,bestLap:'1:42.500',gap:'leader'},{connected:false,name:'Absent'}]});
  assert.match(html,/&lt;Pilote&gt;/);assert.match(html,/1:42.500/);assert.match(html,/Leader/);assert.doesNotMatch(html,/<iframe|Absent/);
});

test('engagés mobiles : services séparés sans toucher aux données sauvegardées',()=>{
  const ev={slug:'lola',name:'Lola',data:{ahEntrants:[{name:'Broadcast',car:'camera'},{name:'PaceCar',car:'safety'},{name:'Alice',car:'lola'}]}};
  const before=JSON.stringify(ev),html=eventDetail(ev);
  assert.match(html,/1 pilote engagé/);assert.match(html,/Véhicules de service/);assert.match(html,/Broadcast/);assert.match(html,/PaceCar/);assert.equal(JSON.stringify(ev),before);
  const cars=require('../mobile/event-views').carsFor(ev);assert.deepEqual(cars.map(c=>c.id),['lola']);
});
test('calendrier mobile : plusieurs circuits par date et aucune date vide inventée',()=>{
  const rows=calendar({sessions:[{date:'2026-12-10T21:00:00Z',track:'spa'}],customCalendar:{'2026-12-10':{tracks:[{trackId:'spa',trackName:'Spa'}, {trackId:'monza',trackName:'Monza'}]},'2026-12-17':'vallelunga','':{track:'x'}}});
  assert.deepEqual(rows.map(x=>[x.day,x.label,x.done]),[['2026-12-10','Monza',false],['2026-12-10','Spa',true],['2026-12-17','vallelunga',false]]);
  const variants=calendar({customCalendar:{'2026-12-10':{tracks:[{trackId:'monza',layoutId:'junior'},{trackId:'monza',layoutId:'full'}]}}});
  assert.deepEqual(variants.map(x=>x.label),['monza · full','monza · junior']);
});

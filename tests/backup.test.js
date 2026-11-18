'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const backup=require('../tools/backup/backup');
const env={DATABASE_URL:'postgresql://postgres:private%40password@127.0.0.1:5432/gdsp_local'};
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gdsp-backup-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const configFile=path.join(root,'fixture.env');fs.writeFileSync(configFile,'DATABASE_URL=secret-fixture-only');
  const calls=[];
  const execute=(bin,name,args,config)=>{
    calls.push({name,args,config});
    if(name==='pg_dump')fs.writeFileSync(args[args.indexOf('--file')+1],'PGDMP test archive');
    return 'test archive catalog';
  };
  return {destination:path.join(root,'backups'),bin:'/test/bin',env,execute,configFile,localFiles:[],calls,root};
}
test('connexion locale seulement, secrets decodes, pas de parametres arbitraires',()=>{
  const c=backup.connection(env.DATABASE_URL);assert.equal(c.PGPASSWORD,'private@password');assert.equal(c.PGDATABASE,'gdsp_local');
  for(const raw of ['https://127.0.0.1/db','postgresql://user:secret@example.com/db','postgresql://user:secret@localhost/db?options=sql','postgresql://localhost/'])assert.throws(()=>backup.connection(raw));
  assert.throws(()=>backup.outsideRepo(path.resolve(__dirname,'..')));
  assert.throws(()=>backup.outsideRepo(path.resolve(__dirname,'../data/backups')));
  assert.throws(()=>backup.databases({}));
  assert.equal(backup.databases({...env,EVENTS_DATABASE_URL:env.DATABASE_URL}).length,1);
  assert.equal(backup.databases({...env,EVENTS_DATABASE_URL:'postgresql://postgres:secret@localhost/events'}).length,2);
});
test('archive complete, manifeste SHA256 et secrets absents des arguments et du manifeste',t=>{
  const ctx=setup(t);const folder=backup.backup(ctx);
  assert.match(path.basename(folder),/^gdsp-\d{8}T\d{9}Z-[a-f0-9]{8}$/);
  assert.equal(fs.readFileSync(path.join(folder,'config.env'),'utf8'),'DATABASE_URL=secret-fixture-only');
  assert.equal(backup.verify({...ctx,folder}).dumps.length,1);
  assert.ok(ctx.calls.some(c=>c.name==='pg_restore'&&c.args[0]==='--list'));
  assert.doesNotMatch(JSON.stringify(ctx.calls.map(c=>c.args)),/private@password|private%40password|postgresql:\/\//);
  assert.doesNotMatch(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'),/private@password|private%40password|postgresql:\/\//);
  fs.appendFileSync(path.join(folder,'main.dump'),'corruption');assert.throws(()=>backup.verify({...ctx,folder}),/altérée/);
});
test('echec pg_dump ou pg_restore : aucune archive complete, pas de retention destructive',t=>{
  const ctx=setup(t);const folder=backup.backup(ctx);
  for(const failure of ['pg_dump','pg_restore']){
    assert.throws(()=>backup.backup({...ctx,execute:(...args)=>{if(args[1]===failure)throw Error('simulated failure');return ctx.execute(...args);}}),/simulated/);
    assert.ok(fs.existsSync(folder));assert.equal(fs.readdirSync(ctx.destination).length,1);
  }
  assert.throws(()=>backup.backup({...ctx,configFile:path.join(ctx.root,'missing.env')}));
  assert.equal(fs.readdirSync(ctx.destination).length,1);
});
test('verrou exclusif : pas de double sauvegarde et verrou existant conserve',t=>{
  const ctx=setup(t);fs.mkdirSync(ctx.destination);
  const lock=path.join(ctx.destination,'.gdsp-backup.lock');fs.writeFileSync(lock,'existing');
  assert.throws(()=>backup.backup(ctx),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'existing');assert.equal(ctx.calls.length,0);
});
test('retention : seulement les 14 archives completes, dossiers inconnus et corrompus gardes',t=>{
  const ctx=setup(t);
  for(let i=0;i<16;i++){
    const folder=backup.backup(ctx);
    const name='gdsp-202601'+String(i+1).padStart(2,'0')+'T120000000Z-abcdef12';
    fs.renameSync(folder,path.join(ctx.destination,name));
  }
  fs.mkdirSync(path.join(ctx.destination,'documents-personnels'));
  fs.mkdirSync(path.join(ctx.destination,'gdsp-20250101T120000000Z-abcdef12'));
  backup.prune(ctx.destination);
  assert.equal(fs.readdirSync(ctx.destination).length,16);
  assert.ok(fs.existsSync(path.join(ctx.destination,'documents-personnels')));
  assert.ok(fs.existsSync(path.join(ctx.destination,'gdsp-20250101T120000000Z-abcdef12')));
});
test('restauration test : nouvelle base seulement, jamais --clean ni la base officielle comme cible',t=>{
  const ctx=setup(t),folder=backup.backup(ctx);ctx.calls.length=0;
  const target=backup.restoreTest({...ctx,folder,label:'main'});
  assert.match(target,/^gdsp_restore_test_\d+_[a-f0-9]+$/);
  const create=ctx.calls.find(c=>c.name==='createdb');assert.deepEqual(create.args,['--no-password',target]);
  const restore=ctx.calls.find(c=>c.name==='pg_restore'&&c.args.includes('--dbname'));
  assert.equal(restore.args[restore.args.indexOf('--dbname')+1],target);
  assert.equal(restore.config.PGDATABASE,target);assert.ok(!restore.args.includes('--clean'));
  assert.throws(()=>backup.restoreTest({...ctx,folder,label:'production'}));
});

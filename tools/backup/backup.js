'use strict';
// Les secrets passent exclusivement dans l'environnement des outils PostgreSQL.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
function outsideRepo(destination){
  const resolved=path.resolve(destination),relative=path.relative(ROOT,resolved);
  if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Le dossier de sauvegarde doit être hors du dépôt.');
  return resolved;
}
function connection(raw){
  const u=new URL(raw);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Cet outil est réservé aux bases PostgreSQL locales.');
  const database=decodeURIComponent(u.pathname.slice(1));
  if(!database||!u.username)throw Error('Connexion PostgreSQL incomplète.');
  if([...u.searchParams.keys()].some(k=>!['sslmode'].includes(k)))throw Error('Paramètre PostgreSQL non pris en charge : vérifier la configuration sans publier le secret.');
  return {PGHOST:u.hostname.replace(/^\[|\]$/g,''),PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:database,PGSSLMODE:u.searchParams.get('sslmode')||'prefer'};
}
function databases(env){
  const entries=[];
  for(const [label,key]of [['main','DATABASE_URL'],['events','EVENTS_DATABASE_URL']]){
    if(!env[key])continue;
    const config=connection(env[key]);
    if(!entries.some(e=>['PGHOST','PGPORT','PGDATABASE'].every(k=>e.config[k]===config[k])))entries.push({label,config});
  }
  if(!entries.length)throw Error('DATABASE_URL ou EVENTS_DATABASE_URL est absent.');
  return entries;
}
function runTool(bin,name,args,config){
  const exe=path.join(bin,name+(process.platform==='win32'?'.exe':''));
  // Ne pas hériter des options de connexion PG* du shell (service, options SQL…).
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)&&!['DATABASE_URL','EVENTS_DATABASE_URL','ADMIN_PASSWORD','JWT_SECRET'].includes(k)));
  const result=spawnSync(exe,args,{env:{...env,...config,PGCONNECT_TIMEOUT:'15'},encoding:'utf8',windowsHide:true,timeout:30*60*1000,maxBuffer:8*1024*1024});
  if(result.error||result.status!==0)throw Error(name+' a échoué. Vérifier sa version, la base, les droits et l’espace disque. Aucun secret ni sortie PostgreSQL affiché.');
  return result.stdout;
}
function digest(file){
  const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');
  try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));return hash.digest('hex');}
  finally{fs.closeSync(fd);}
}
function manifestFor(dir){
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  if(manifest.format!=='gdsp-backup-v1'||manifest.status!=='complete'||!Array.isArray(manifest.files)||!Array.isArray(manifest.dumps)||!manifest.dumps.length)throw Error('Manifeste de sauvegarde invalide.');
  for(const f of manifest.files){
    if(!f||typeof f.name!=='string'||!/^[a-zA-Z0-9._-]+$/.test(f.name)||f.name==='.'||f.name==='..')throw Error('Nom de fichier invalide.');
    const file=path.join(dir,f.name);
    if(fs.lstatSync(file).isSymbolicLink()||digest(file)!==f.sha256)throw Error('Sauvegarde altérée ou incomplète.');
  }
  for(const d of manifest.dumps)if(!['main','events'].includes(d.label)||!manifest.files.some(f=>f.name===d.file&&f.name===d.label+'.dump'))throw Error('Dump absent du manifeste.');
  return manifest;
}
function prune(destination,keep=14){
  const valid=[];
  for(const entry of fs.readdirSync(destination,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^gdsp-\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(entry.name))continue;
    const folder=path.join(destination,entry.name);
    try{manifestFor(folder);valid.push(entry.name);}catch(e){/* Ne pas supprimer les dossiers inconnus ou incomplets. */}
  }
  for(const name of valid.sort().reverse().slice(keep))fs.rmSync(path.join(destination,name),{recursive:true});
}
function backup({destination,bin,env=process.env,execute=runTool,configFile=path.join(ROOT,'.env'),localFiles}){
  destination=outsideRepo(destination);
  const dbs=databases(env); // Valider avant toute écriture.
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const lock=path.join(destination,'.gdsp-backup.lock');
  const fd=fs.openSync(lock,'wx',0o600);fs.closeSync(fd);
  let working;
  try{
    const id='gdsp-'+new Date().toISOString().replace(/[-: .]/g,'')+'-'+crypto.randomBytes(4).toString('hex');
    working=path.join(destination,'.partial-'+id);fs.mkdirSync(working,{mode:0o700});
    const dumps=[];
    for(const db of dbs){
      const file=db.label+'.dump';
      execute(bin,'pg_dump',['--format=custom','--no-password','--file',path.join(working,file)],db.config);
      if(!fs.statSync(path.join(working,file)).size)throw Error('Dump vide.');
      execute(bin,'pg_restore',['--list',path.join(working,file)],db.config);
      dumps.push({label:db.label,file});
    }
    // Une configuration manquante est un échec, pas une sauvegarde déclarée complète.
    fs.copyFileSync(configFile,path.join(working,'config.env'));
    const exclusions=env.GLOBAL_EXCLUSIONS_FILE?path.resolve(env.GLOBAL_EXCLUSIONS_FILE):path.join(ROOT,'data/global-exclusions.json');
    const optional=localFiles||[['global-exclusions.json',exclusions],['telemetry-store.json',path.join(ROOT,'data/telemetry-store.json')],['live-history.json',path.join(ROOT,'data/live-history.json')]];
    const missing=[];
    for(const [name,source]of optional){if(fs.existsSync(source))fs.copyFileSync(source,path.join(working,name));else missing.push(name);}
    const files=fs.readdirSync(working).map(name=>({name,sha256:digest(path.join(working,name))}));
    fs.writeFileSync(path.join(working,'manifest.json'),JSON.stringify({format:'gdsp-backup-v1',status:'complete',createdAt:new Date().toISOString(),dumps,files,optionalFilesAbsent:missing},null,2),{mode:0o600});
    manifestFor(working);
    const complete=path.join(destination,id);fs.renameSync(working,complete);working=null;
    // La rétention ne démarre qu'après la réussite complète de la nouvelle sauvegarde.
    prune(destination,14);
    return complete;
  }finally{
    if(working)fs.rmSync(working,{recursive:true,force:true});
    fs.unlinkSync(lock);
  }
}
function verify({folder,bin,execute=runTool}){
  const manifest=manifestFor(folder);
  for(const dump of manifest.dumps)execute(bin,'pg_restore',['--list',path.join(folder,dump.file)],{});
  return manifest;
}
function restoreTest({folder,bin,label,env=process.env,execute=runTool}){
  const manifest=verify({folder,bin,execute});
  const dump=manifest.dumps.find(d=>d.label===label);
  if(!dump)throw Error('Choisir un dump main ou events présent dans cette sauvegarde.');
  const db=databases(env).find(d=>d.label===label);
  if(!db)throw Error('Connexion locale correspondante absente.');
  const target='gdsp_restore_test_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex');
  // Jamais --clean, jamais de connexion à la base officielle pour restaurer.
  execute(bin,'createdb',['--no-password',target],{...db.config,PGDATABASE:'postgres'});
  execute(bin,'pg_restore',['--no-password','--exit-on-error','--no-owner','--no-privileges','--dbname',target,path.join(folder,dump.file)],{...db.config,PGDATABASE:target});
  return target; // Gardée pour inspection. Aucune suppression automatique de base.
}
if(require.main===module){
  try{
    const [mode,destination,bin,label]=process.argv.slice(2);
    if(!destination||!bin)throw Error('Utiliser le lanceur PowerShell documenté.');
    if(mode==='backup')console.log('Sauvegarde terminée : '+backup({destination,bin}));
    else if(mode==='verify'){verify({folder:destination,bin});console.log('Intégrité et catalogue PostgreSQL vérifiés. Cela ne remplace pas un essai de restauration.');}
    else if(mode==='restore-test')console.log('Restauration réussie dans la base de test : '+restoreTest({folder:destination,bin,label}));
    else throw Error('Mode inconnu.');
  }catch(e){console.error('Échec sauvegarde/vérification. '+(e instanceof URIError||e instanceof TypeError?'Configuration invalide.':e.message));process.exitCode=1;}
}
module.exports={connection,databases,outsideRepo,manifestFor,prune,backup,verify,restoreTest};

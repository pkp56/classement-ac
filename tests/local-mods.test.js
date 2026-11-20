const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const express=require('express');
const {configuredRoots,DEFAULT_ROOTS,scanCatalog,mountLocalMods}=require('../tools/lib/local-mods');
async function fixture(t){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-mods-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const c=path.join(temp,'C-content'),d=path.join(temp,'D-content'),e=path.join(temp,'E-content');
  await fs.mkdir(c);await fs.mkdir(d);
  async function write(root,file,data){const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,typeof data==='string'?data:JSON.stringify(data));}
  return {c,d,e,temp,write};
}
test('racines Windows demandées par défaut et surcharge sans ambiguïté des espaces',()=>{
  assert.deepEqual(configuredRoots({}),DEFAULT_ROOTS);
  assert.deepEqual(configuredRoots({AC_CONTENT_ROOTS:' C:/Program Files (x86)/Steam/content ;D:/content; E:/content '}),['C:/Program Files (x86)/Steam/content','D:/content','E:/content']);
  assert.deepEqual(configuredRoots({AC_CONTENT_ROOTS:''}),[]);
});
test('catalogue multi-disques, priorité, doublons et variantes distinctes',async t=>{
  const {c,d,e,write}=await fixture(t);
  await write(c,'cars/lola/ui/ui_car.json',{name:'Lola T290',brand:'Lola'});
  await write(d,'cars/lola/ui/ui_car.json',{name:'Autre Lola'});
  await write(d,'cars/alfa/ui/ui_car.json','\uFEFF'+JSON.stringify({name:'Alfa',brand:'<b>Alfa Romeo</b>'}));
  await write(d,'tracks/spa/ui/short/ui_track.json',{name:'Spa court',country:'Belgique',length:'4 km'});
  await write(d,'tracks/spa/ui/long/ui_track.json',{name:'Spa long'});
  const r=await scanCatalog([c,d,e]);
  assert.equal(r.cars.length,2);assert.equal(r.tracks.length,2);
  assert.equal(r.cars.find(x=>x.id==='lola').name,'Lola T290');
  assert.deepEqual(r.cars.find(x=>x.id==='lola').alsoAvailableIn,['source-2']);
  assert.equal(r.cars.find(x=>x.id==='alfa').brand,'Alfa Romeo');
  assert.deepEqual(r.tracks.map(x=>x.id).sort(),['spa/long','spa/short']);
  assert.equal(r.sources[2].status,'missing');
  assert(!JSON.stringify(r.cars).includes(c));assert(!JSON.stringify(r.tracks).includes(d));
});
test('ui_car.json expose une fiche locale limitée aux champs techniques utiles, sans HTML ni chemin disque',async t=>{
  const {c,write}=await fixture(t);
  await write(c,'cars/lola_t290/ui/ui_car.json',{
    name:'Lola <b>T290</b>',brand:'Lola',class:'Prototype historique',year:1972,author:'GDSP',version:'2.1',
    description:'Prototype <script>alert(1)</script> de course',tags:['Historic','Group 5'],
    specs:{bhp:'300 bhp',torque:'320 Nm',weight:'650 kg',topspeed:'280 km/h',acceleration:'3.5 s',pwratio:'2.1 kg/hp',ignored:{secret:'no'}}
  });
  const result=await scanCatalog([c]);
  const car=result.cars[0];
  assert.equal(car.name,'Lola T290');assert.equal(car.brand,'Lola');assert.equal(car.category,'Prototype historique');
  assert.equal(car.year,'1972');assert.equal(car.author,'GDSP');assert.equal(car.version,'2.1');
  assert.equal(car.description,'Prototype alert(1) de course');assert.deepEqual(car.tags,['Historic','Group 5']);
  assert.deepEqual(car.specs,{bhp:'300 bhp',torque:'320 Nm',weight:'650 kg',topspeed:'280 km/h',acceleration:'3.5 s',pwratio:'2.1 kg/hp'});
  assert.equal(car.metadataAvailable,true);
  assert(!JSON.stringify(car).includes(c));
});
test('ui_car.json conserve les champs Drive, le texte lisible et les courbes moteur locales',async t=>{
  const {c,write}=await fixture(t);
  await write(c,'cars/actk_lola_t290/ui/ui_car.json',{
    name:'Lola T290',brand:'Lola',description:"Lola&#39;s prototype.<br><br>Lucas fuel injection.",class:'race',
    tags:['#ACL Prototypes','rwd'],torqueCurve:[[0,0],[7000,230],[9000,209.09]],
    powerCurve:[[0,0],[8000,247.245],[9000,260]],year:1972,country:'Great Britain',author:'ACTK',
    url:'http://www.assetto-fr.tk',version:'v2.1',
    specs:{bhp:'260 bhp',torque:'230Nm',weight:'610kg',topspeed:'280+km/h',acceleration:null,pwratio:'2.41kg/cv'}
  });
  await write(c,'cars/unsafe_url/ui/ui_car.json',{name:'Unsafe URL',url:'javascript:alert(1)',powerCurve:[[-1,2],[1000,-1],[20001,10],[2000,100]]});
  const result=await scanCatalog([c]);
  const car=result.cars.find(item=>item.id==='actk_lola_t290');
  assert.equal(car.name,'Lola T290');assert.equal(car.category,'race');assert.equal(car.year,'1972');
  assert.equal(car.country,'Great Britain');assert.equal(car.author,'ACTK');assert.equal(car.version,'v2.1');
  assert.equal(car.url,'http://www.assetto-fr.tk');
  assert.equal(car.description,"Lola's prototype.\n\nLucas fuel injection.");
  assert.deepEqual(car.specs,{bhp:'260 bhp',torque:'230Nm',weight:'610kg',topspeed:'280+km/h',pwratio:'2.41kg/cv'});
  assert.deepEqual(car.powerCurve,[{rpm:0,value:0},{rpm:8000,value:247.245},{rpm:9000,value:260}]);
  assert.deepEqual(car.torqueCurve,[{rpm:0,value:0},{rpm:7000,value:230},{rpm:9000,value:209.09}]);
  const unsafe=result.cars.find(item=>item.id==='unsafe_url');
  assert.equal(unsafe.url,'');assert.deepEqual(unsafe.powerCurve,[{rpm:2000,value:100}]);
  assert(!JSON.stringify(result.cars).includes(c));
});
test('nom de dossier conservé si métadonnées absentes, invalides ou trop grandes',async t=>{
  const {c,d,write}=await fixture(t);
  await fs.mkdir(path.join(c,'cars/no-ui'),{recursive:true});
  await write(c,'cars/broken/ui/ui_car.json','{broken');
  await write(c,'tracks/huge/ui/ui_track.json','x'.repeat(1024*1024+1));
  const r=await scanCatalog([c,d]);
  assert.deepEqual(r.cars.map(x=>x.name),['broken','no-ui']);
  assert.equal(r.tracks[0].id,'huge');assert.equal(r.tracks[0].metadataAvailable,false);
  assert.equal(r.warnings.length,2);
});
test('jonction vers un disque autorisé acceptée, sortie vers un autre dossier refusée',async t=>{
  const {c,d,temp,write}=await fixture(t);
  await write(d,'cars/lola/ui/ui_car.json',{name:'Lola'});
  await fs.mkdir(path.join(c,'cars'),{recursive:true});
  await fs.symlink(path.join(d,'cars/lola'),path.join(c,'cars/lola'),'junction');
  const outside=path.join(temp,'private');
  await write(outside,'ui/ui_car.json',{name:'SECRET'});
  await fs.symlink(outside,path.join(c,'cars/escape'),'junction');
  const r=await scanCatalog([c,d]);
  assert.equal(r.cars.length,1);assert.equal(r.cars[0].name,'Lola');
  assert(r.warnings.some(w=>w.includes('escape')));
});
test('pas de lecture hors racines par un lien de fichier UI',async t=>{
  const {c,temp,write}=await fixture(t);
  await write(temp,'private.json',{name:'SECRET'});
  await fs.mkdir(path.join(c,'cars/car/ui'),{recursive:true});
  await fs.symlink(path.join(temp,'private.json'),path.join(c,'cars/car/ui/ui_car.json'));
  const r=await scanCatalog([c]);assert.equal(r.cars[0].name,'car');assert(r.warnings.length);
});
test('limite de scan signalée, aucun disque présent et catalogue vide valides',async t=>{
  const {c,e,write}=await fixture(t);
  await write(c,'cars/a/ui/ui_car.json',{});await write(c,'cars/b/ui/ui_car.json',{});
  const limited=await scanCatalog([c],{maxEntries:1});assert.equal(limited.cars.length,1);assert(limited.warnings.some(w=>w.includes('Limite')));
  const missing=await scanCatalog([e]);assert.equal(missing.sources[0].status,'missing');assert.deepEqual(missing.cars,[]);
});
test('API réservée aux administrateurs ; chemins du corps ignorés ; rescan explicite',async t=>{
  const {c,d,write}=await fixture(t);await write(c,'cars/car/ui/ui_car.json',{name:'Voiture'});
  const app=express();app.use(express.json());
  mountLocalMods(app,{roots:[c],authorize:async(req,res)=>{
    if(req.headers.authorization==='Bearer test')return true;
    res.status(401).json({error:'auth'});return false;
  }});
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port+'/api/admin/local-mods';
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url+'/scan',{method:'POST'})).status,401);
  const headers={authorization:'Bearer test','content-type':'application/json'};
  let response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).scannedAt,null);
  response=await fetch(url+'/scan',{method:'POST',headers,body:JSON.stringify({roots:[d]})});
  assert.equal((await response.json()).cars[0].name,'Voiture');
  await write(c,'cars/added/ui/ui_car.json',{name:'Ajout'});
  assert.equal((await (await fetch(url,{headers})).json()).cars.length,1);
  assert.equal((await (await fetch(url+'/scan',{method:'POST',headers,body:'{}'})).json()).cars.length,2);
});
test('voiture Kunos (ks_*) sans ui_car.json : extrait marque, ère, auteur Kunos, logo et données data/ / skins',async t=>{
  const {c,write}=await fixture(t);
  const logoBytes=await fs.readFile(path.resolve(__dirname,'../assets/logo.png'));
  await write(c,'cars/ks_alfa_romeo_giulia_gta/skins/01_red/skin.ini','[driver_70]\nSUIT=\\sparco\\red\n\n[CREW]\nBRAND=\\alfa\n');
  await write(c,'cars/ks_alfa_romeo_giulia_gta/skins/01_red/ui_skin.json',{skinname:'Misano Red',number:'0'});
  await fs.writeFile(path.join(c,'cars/ks_alfa_romeo_giulia_gta/logo.png'),logoBytes);

  await write(c,'cars/ks_porsche_911_rsr_1974/data/car.ini','[INFO]\nSCREEN_NAME=Porsche 911 Carrera RSR 3.0\n[BASIC]\nTOTALMASS=900\n');
  await write(c,'cars/ks_porsche_911_rsr_1974/data/engine.ini','[ENGINE_DATA]\nTORQUE_CURVE=power.lut\n');
  await write(c,'cars/ks_porsche_911_rsr_1974/data/power.lut','0|0\n4000|290\n7500|300\n');
  await write(c,'cars/ks_porsche_911_rsr_1974/data/drivetrain.ini','[TRACTION]\nTYPE=RWD\n');

  const r=await scanCatalog([c]);
  const alfa=r.cars.find(x=>x.id==='ks_alfa_romeo_giulia_gta');
  assert.equal(alfa.name,'Alfa Romeo Giulia GTA');
  assert.equal(alfa.brand,'Alfa Romeo');
  assert.equal(alfa.country,'Italie');
  assert.equal(alfa.author,'Kunos Simulazioni');
  assert.equal(alfa.year,'Années 1970');
  assert.equal(alfa.hasLogo,true);
  assert.equal(alfa.metadataSource,'skins');
  assert.equal(alfa.metadataAvailable,true);

  const porsche=r.cars.find(x=>x.id==='ks_porsche_911_rsr_1974');
  assert.equal(porsche.name,'Porsche 911 Carrera RSR 3.0');
  assert.equal(porsche.brand,'Porsche');
  assert.equal(porsche.country,'Allemagne');
  assert.equal(porsche.author,'Kunos Simulazioni');
  assert.equal(porsche.year,'1974');
  assert.equal(porsche.specs.weight,'900 kg');
  assert.equal(porsche.specs.torque,'300 Nm');
  assert.equal(porsche.specs.bhp,'316 bhp');
  assert.deepEqual(porsche.tags,['rwd']);
  assert.equal(porsche.torqueCurve.length,3);
  assert.equal(porsche.powerCurve.length,3);
  assert.equal(porsche.metadataSource,'data');
  assert.equal(porsche.metadataAvailable,true);
});

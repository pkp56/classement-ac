'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {cachePreview,importLiveries,importCarLogo}=require('../tools/lib/mod-previews');

test('les fiches ne publient que les aperçus internes ; images identiques dédupliquées',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-preview-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'content'),skins=path.join(root,'cars','nissan','skins'),out=path.join(temp,'cache');
  const bytes=await fs.readFile(path.resolve(__dirname,'../assets/logo.png'));
  for(const name of ['bleu','rouge','absent','texte','jonction'])await fs.mkdir(path.join(skins,name),{recursive:true});
  await fs.writeFile(path.join(skins,'bleu','preview.png'),bytes);
  await fs.writeFile(path.join(skins,'rouge','preview.png'),bytes);
  await fs.writeFile(path.join(skins,'bleu','ui_skin.json'),JSON.stringify({skinname:'Bleue',team:'GDSP',number:12}));
  await fs.writeFile(path.join(skins,'texte','preview.jpg'),'<html>');
  const outside=path.join(temp,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'preview.png'),bytes);
  await fs.symlink(outside,path.join(skins,'externe'),'junction');
  const items=await importLiveries([root],'nissan',out);
  assert.deepEqual(items.map(x=>x.name),['Bleue','rouge']);
  assert.equal(items[0].number,'12');assert.equal(items[0].team,'GDSP');
  assert.match(items[0].image,/^assets\/mod-previews\/[a-f\d]{64}\.png$/);
  assert.deepEqual(await fs.readdir(out),[path.basename(items[0].image)]);
  assert.equal(await cachePreview(root,[path.join(outside,'preview.png')],out),null);
  assert.equal(await importLiveries([root],'missing',out),null);
  await assert.rejects(importLiveries([root],'..',out));
});

test('importCarLogo et repli livery.png sur les voitures Kunos',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gdsp-kunos-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'content'),car=path.join(root,'cars','ks_alfa_romeo_giulia_gta'),out=path.join(temp,'cache');
  const bytes=await fs.readFile(path.resolve(__dirname,'../assets/logo.png'));
  await fs.mkdir(path.join(car,'skins','01_alfa'),{recursive:true});
  await fs.writeFile(path.join(car,'logo.png'),bytes);
  await fs.writeFile(path.join(car,'skins','01_alfa','livery.png'),bytes);
  await fs.writeFile(path.join(car,'skins','01_alfa','ui_skin.json'),JSON.stringify({skinname:'',drivername:'',country:'',team:'',number:'0'}));
  const logo=await importCarLogo([root],'ks_alfa_romeo_giulia_gta',out);
  assert.match(logo,/^assets\/mod-previews\/[a-f\d]{64}\.png$/);
  const liveries=await importLiveries([root],'ks_alfa_romeo_giulia_gta',out);
  assert.equal(liveries.length,1);
  assert.equal(liveries[0].name,'01_alfa');
  assert.equal(liveries[0].number,'');
});

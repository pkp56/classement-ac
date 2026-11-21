'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('Configurateur CSP initialise et génère les paramètres choisis sans requête réseau',()=>{
  const html=fs.readFileSync(path.join(root,'race-control.html'),'utf8');
  const elements={};
  for(const match of html.matchAll(/<(input|select|textarea|button|div|span|p)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag=match[0], id=match[2];
    elements[id]={value:'',checked:false,type:/type="checkbox"/.test(tag)?'checkbox':'text',classList:{toggle(){},remove(){}},style:{},addEventListener(type,fn){this[type]=fn;},appendChild(){},replaceChildren(){},select(){}};
  }
  const document={getElementById:id=>elements[id]||null,createElement:()=>({style:{},appendChild(){},addEventListener(){}}),querySelectorAll:()=>[]};
  const context={window:{},document,URL,console,setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root,'race-control/encoder.js'),'utf8'),context);
  context.GDSPRaceEncoder=context.window.GDSPRaceEncoder;
  vm.runInContext(fs.readFileSync(path.join(root,'race-control/configurator.js'),'utf8'),context);
  assert.equal(elements.scriptUrl.value,'https://gdsp.duckdns.org/csp/rolling_start.lua');
  assert.match(elements.iniOut.value,/SCRIPT=https:\/\/gdsp\.duckdns\.org\/csp\/rolling_start\.lua/);
  elements.autoFormation.checked=true;
  elements.cutEnabled.checked=false;
  vm.runInContext('generateOutputs()',context);
  assert.match(elements.iniOut.value,/\nautoFormation=1\n/);
  assert.match(elements.iniOut.value,/\ncutEnabled=0\n/);
  elements.scriptUrl.value='https://test.invalid/\n[EVIL]';
  vm.runInContext('generateOutputs()',context);
  assert.equal(elements.iniOut.value,'');
  assert.ok(elements.configError.textContent);
});

test('Page et script CSP publics sont disponibles sans modification du serveur AC',async t=>{
  const sock=net.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(r=>sock.close(r));
  const child=spawn(process.execPath,['app.js'],{cwd:root,env:{...process.env,PORT:String(port),LIVE_TIMING_ENABLED:'false'},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('démarrage trop long')),15000);child.stdout.on('data',d=>{if(String(d).includes('démarré')){clearTimeout(timer);resolve()}});child.on('exit',()=>{clearTimeout(timer);reject(Error('serveur arrêté'))})});
  const base=`http://127.0.0.1:${port}`;
  const page=await fetch(base+'/race-control.html');assert.equal(page.status,200);assert.match(await page.text(),/race-control\/configurator\.js/);
  const js=await fetch(base+'/race-control/configurator.js');assert.equal(js.status,200);
  const encoder=await fetch(base+'/race-control/encoder.js');assert.equal(encoder.status,200);
  const lua=await fetch(base+'/csp/rolling_start.lua');assert.equal(lua.status,200);assert.match(lua.headers.get('content-type'),/^text\/plain/);assert.match(await lua.text(),/^-- GDSP Rolling Start & Race Control/);
});

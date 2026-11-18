const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const seo=require('../seo');
const event={slug:'test-cup',name:'Cup <GT>',data:{eventInfo:{briefing:'Une course & des amis',schedule:'21 h'},sessions:[{date:'2027-01-15T21:00:00Z',track:'Spa'}],customCalendar:{'2027-02-15':{track:'Monza'}}}};
test('Public landing content escapes data and contains readable calendars and crawlable links',()=>{
  assert.match(seo.homeContent([event]), /historique et vintage/);
  assert.match(seo.homeContent([event]), /opens et championnats Assetto Corsa/);
  const html=seo.eventContent(event);
  assert.match(html,/Cup &lt;GT&gt;/);
  assert.match(html,/Une course &amp; des amis/);
  assert.match(html,/Spa/);assert.match(html,/Monza/);
  assert.match(seo.homeContent([event]),/href="\/evenements\/test-cup"/);
});
for(const configuredOrigin of ['https://gdsp.example',''])test('HTTP SEO : routes, erreurs et domaine '+(configuredOrigin||'par défaut'),async t=>{
  const origin=configuredOrigin||'https://gdsp.duckdns.org';
  let catalogOffline=true;
  const backend=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/events'&&catalogOffline){res.statusCode=503;return res.end('{}')}
    if(req.url==='/api/events')return res.end(JSON.stringify({events:[event]}));
    if(req.url==='/api/events/test-cup')return res.end(JSON.stringify(event));
    res.statusCode=req.url.includes('missing')?404:500;res.end('{}');
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  t.after(()=>backend.close());
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,['app.js'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,EVENTS_SOURCE:'backend',PORT:String(port),BACKEND_URL:`http://127.0.0.1:${backend.address().port}`,PUBLIC_SITE_URL:configuredOrigin}});
  t.after(()=>child.kill());
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server startup timeout')),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('démarré')){clearTimeout(timeout);resolve()}});
    child.on('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code))});
  });
  const get=p=>fetch(`http://127.0.0.1:${port}${p}`);
  let res=await get('/sitemap.xml');
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/application\/xml/);
  const fallback=await res.text();
  assert.ok(fallback.includes('<loc>'+origin+'/'+'</loc>'));
  assert.doesNotMatch(fallback,/test-cup/);
  catalogOffline=false;
  res=await get('/');assert.equal(res.status,200);assert.match(await res.text(),/href="\/evenements\/test-cup"/);
  res=await get('/evenements/test-cup');assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/<title>Cup &lt;GT&gt; \| GDSP Assetto Corsa<\/title>/);
  assert.ok(html.includes('rel="canonical" href="'+origin+'/evenements/test-cup"'));
  assert.match(html,/Spa/);assert.match(html,/Monza/);assert.match(html,/name="description"/);
  res=await get('/evenements/missing');assert.equal(res.status,404);
  res=await get('/evenements/broken');assert.equal(res.status,503);assert.equal(res.headers.get('retry-after'),'60');
  res=await get('/robots.txt');assert.ok((await res.text()).includes('Sitemap: '+origin+'/sitemap.xml'));
  res=await get('/sitemap.xml');assert.ok((await res.text()).includes('<loc>'+origin+'/evenements/test-cup</loc>'));
  res=await get('/site.js?v=93');assert.equal(res.headers.get('cache-control'),'no-cache');
  res=await get('/seo.js');assert.equal(res.status,404);
  res=await fetch(`http://127.0.0.1:${port}/index.html?source=test`,{redirect:'manual'});
  assert.equal(res.status,301);assert.equal(res.headers.get('location'),'/?source=test');
  res=await fetch(`http://127.0.0.1:${port}/index.html`,{method:'HEAD',redirect:'manual'});
  assert.equal(res.status,301);assert.equal(res.headers.get('location'),'/');
  for(const unknown of ['/adresse-inconnue','/evenements/test-cup/inconnu','/image-absente.png']){
    res=await get(unknown);assert.equal(res.status,404,unknown);
    const errorHtml=await res.text();assert.match(errorHtml,/Page introuvable/);
    assert.match(errorHtml,/noindex,follow/);assert.doesNotMatch(errorHtml,/<script\b/);
  }
  res=await get('/evenements/test-cup/circuit');assert.equal(res.status,200);
  assert.ok((await res.text()).includes('rel="canonical" href="'+origin+'/evenements/test-cup"'));
  res=await get('/evenements/missing/circuit');assert.equal(res.status,404);
  res=await get('/admin');assert.equal(res.status,200);assert.equal(res.headers.get('x-robots-tag'),'noindex, follow');
  for(const existing of ['/live-timing','/telemetry','/circuits.html','/assets/logo.png']){
    res=await get(existing);assert.equal(res.status,200,existing);
  }
  res=await get('/evenements/missing');const missingHtml=await res.text();assert.match(missingHtml,/noindex,follow/);assert.doesNotMatch(missingHtml,/<script\b/);
  assert.ok(html.includes('property="og:url" content="'+origin+'/evenements/test-cup"'));
  assert.ok(html.includes('property="og:image" content="'+origin+'/assets/logo.png"'));
  assert.doesNotMatch(html,/classement-ac-1\.onrender\.com/);
});


test('origine publique : valeur par défaut DuckDNS, normalisation et configurations invalides',()=>{
  assert.equal(seo.siteOrigin(),'https://gdsp.duckdns.org');
  assert.equal(seo.siteOrigin(' https://gdsp.duckdns.org/ '),'https://gdsp.duckdns.org');
  for(const value of ['javascript:alert(1)','https://user:secret@example.org','https://example.org/path','https://example.org?x=1','https://example.org/#fragment','[https://gdsp.duckdns.org](https://gdsp.duckdns.org)'])assert.throws(()=>seo.siteOrigin(value));
});

test('balises de partage : échappement HTML, image absolue et absence sur pages d’erreur',()=>{
  const template='<html><head><title>GDSP</title></head><body><div class="page" id="app"></div><script src="/site.js"></script></body></html>';
  const html=seo.renderPage(template,{title:'Cup <GT> "GDSP"',description:'Course & amis',canonical:'https://gdsp.duckdns.org/evenements/test',content:'<h1>Test</h1>'});
  assert.match(html,/og:title" content="Cup &lt;GT&gt; &quot;GDSP&quot;/);
  assert.match(html,/og:description" content="Course &amp; amis/);
  assert.match(html,/twitter:card" content="summary/);
  assert.match(html,/og:image" content="https:\/\/gdsp.duckdns.org\/assets\/logo.png/);
  assert.equal((html.match(/rel="canonical"/g)||[]).length,1);
  assert.match(html,/<script src=/);
  const error=seo.renderPage(template,{title:'Introuvable',description:'Erreur',content:'<h1>404</h1>',noindex:true,interactive:false});
  assert.match(error,/noindex,follow/);assert.doesNotMatch(error,/og:url|rel="canonical"|<script/);
});

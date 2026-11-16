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
test('HTTP public pages render without JavaScript, return correct errors, robots and sitemap',async t=>{
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
  const child=spawn(process.execPath,['app.js'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BACKEND_URL:`http://127.0.0.1:${backend.address().port}`,PUBLIC_SITE_URL:'https://gdsp.example'}});
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
  assert.match(fallback,/<loc>https:\/\/gdsp.example\/<\/loc>/);
  assert.doesNotMatch(fallback,/test-cup/);
  catalogOffline=false;
  res=await get('/');assert.equal(res.status,200);assert.match(await res.text(),/href="\/evenements\/test-cup"/);
  res=await get('/evenements/test-cup');assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/<title>Cup &lt;GT&gt; \| GDSP Assetto Corsa<\/title>/);
  assert.match(html,/rel="canonical" href="https:\/\/gdsp.example\/evenements\/test-cup"/);
  assert.match(html,/Spa/);assert.match(html,/Monza/);assert.match(html,/name="description"/);
  res=await get('/evenements/missing');assert.equal(res.status,404);
  res=await get('/evenements/broken');assert.equal(res.status,503);assert.equal(res.headers.get('retry-after'),'60');
  res=await get('/robots.txt');assert.match(await res.text(),/Sitemap: https:\/\/gdsp.example\/sitemap.xml/);
  res=await get('/sitemap.xml');assert.match(await res.text(),/<loc>https:\/\/gdsp.example\/evenements\/test-cup<\/loc>/);
  res=await get('/site.js?v=93');assert.equal(res.headers.get('cache-control'),'no-cache');
  res=await get('/seo.js');assert.equal(res.status,404);
});

// --- Origine publique et balises de partage -------------------------------
test('renderPage résout la canonique en absolu, échappe les métadonnées et publie le JSON-LD',()=>{
  const html=seo.renderPage('<head><title>x</title></head><body><div class="page" id="app"></div></body>',{
    title:'Nom "cité"',description:'d',content:'<p>ok</p>',canonical:'/evenements/a',origin:'http://gdsp.duckdns.org/',ogType:'article',
    jsonLd:seo.breadcrumb([{name:'Accueil',url:'http://gdsp.duckdns.org/'},{name:'A'}])
  });
  assert.match(html,/rel="canonical" href="http:\/\/gdsp\.duckdns\.org\/evenements\/a"/);
  assert.match(html,/property="og:image" content="http:\/\/gdsp\.duckdns\.org\/hero-gdsp\.jpg"/);
  assert.match(html,/property="og:type" content="article"/);
  assert.match(html,/name="twitter:card" content="summary_large_image"/);
  assert.match(html,/name="theme-color"/);
  const ld=JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(ld['@type'],'BreadcrumbList');
  assert.equal(ld.itemListElement.length,2);
});
test('sans PUBLIC_SITE_URL, robots, canonique et sitemap utilisent le domaine de la requête',async t=>{
  const backend=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/events')return res.end(JSON.stringify({events:[event]}));
    if(req.url==='/api/events/test-cup')return res.end(JSON.stringify(event));
    res.statusCode=404;res.end('{}');
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  t.after(()=>backend.close());
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const env={...process.env,PORT:String(port),BACKEND_URL:`http://127.0.0.1:${backend.address().port}`};
  delete env.PUBLIC_SITE_URL;delete env.RENDER_EXTERNAL_URL;
  const child=spawn(process.execPath,['app.js'],{cwd:require('node:path').resolve(__dirname,'..'),env});
  t.after(()=>child.kill());
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server startup timeout')),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('démarré')){clearTimeout(timeout);resolve()}});
    child.on('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code))});
  });
  const host='gdsp.duckdns.org';
  // fetch interdit de forcer l'en-tête Host : on passe par http.get pour
  // simuler un visiteur qui arrive bien par gdsp.duckdns.org.
  const get=p=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port,path:p,headers:{host}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:()=>Promise.resolve(Buffer.concat(chunks).toString('utf8'))}));
      res.on('error',reject);
    });
    req.on('error',reject);
  });

  let res=await get('/');
  assert.equal(res.status,200);
  const home=await res.text();
  assert.match(home,/rel="canonical" href="http:\/\/gdsp\.duckdns\.org\/"/);
  assert.match(home,/property="og:url" content="http:\/\/gdsp\.duckdns\.org\/"/);

  res=await get('/evenements/test-cup');
  const page=await res.text();
  assert.match(page,/rel="canonical" href="http:\/\/gdsp\.duckdns\.org\/evenements\/test-cup"/);
  assert.match(page,/application\/ld\+json/);

  // La vue Circuit est rendue mais explicitement hors index (canonique = événement).
  res=await get('/evenements/test-cup/circuit');
  assert.equal(res.status,200);
  assert.match(res.headers['x-robots-tag']||'',/noindex/i);
  assert.match(await res.text(),/rel="canonical" href="http:\/\/gdsp\.duckdns\.org\/evenements\/test-cup"/);

  res=await get('/robots.txt');
  const robots=await res.text();
  assert.match(robots,/Sitemap: http:\/\/gdsp\.duckdns\.org\/sitemap\.xml/);
  assert.doesNotMatch(robots,/onrender/);

  res=await get('/sitemap.xml');
  const xml=await res.text();
  assert.match(xml,/<loc>http:\/\/gdsp\.duckdns\.org\/<\/loc>/);
  assert.match(xml,/<loc>http:\/\/gdsp\.duckdns\.org\/evenements\/test-cup<\/loc>/);
  assert.doesNotMatch(xml,/onrender/);
});

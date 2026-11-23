'use strict';
// Le cache contient uniquement la coque publique. Jamais les API, sessions,
// classements ou réponses d'administration : aucune donnée périmée hors ligne.
const CACHE='gdsp-mobile-shell-v1';
const SHELL=['/mobile/','/mobile/mobile.css?v=1','/mobile/mobile.js?v=1','/mobile/icons/icon-192.png','/mobile/icons/icon-512.png','/mobile/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('gdsp-mobile-shell-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname+url.search))return;
  event.respondWith(fetch(req).catch(()=>caches.match(req)));
});

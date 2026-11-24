'use strict';
// Le cache contient uniquement la coque publique. Jamais les API, sessions,
// classements ou réponses d'administration : aucune donnée périmée hors ligne.
const CACHE='gdsp-mobile-shell-v10';
const SHELL=['/mobile/','/mobile/mobile.css?v=5','/mobile/mobile.js?v=6','/mobile/results-engine.js?v=5','/mobile/event-views.js?v=5','/assets/global-rating.js?v=1','/assets/entrant-roles.js?v=1','/assets/trueskill-rating.js?v=1','/assets/trueskill-gdsp.js?v=1','/mobile/profile-engine.js?v=7','/mobile/profile-views.js?v=10','/patches-v71.js?v=97','/mobile/icons/icon-192.png','/mobile/icons/icon-512.png','/mobile/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('gdsp-mobile-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname+url.search))return;
  event.respondWith(fetch(req).catch(()=>caches.match(req)));
});

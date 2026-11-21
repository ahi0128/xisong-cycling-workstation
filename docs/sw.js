const cacheName='xisong-parent-dues-v1';
const files=['./','./index.html','./style.css','./app.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(files)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('xisong-parent-dues-')&&key!==cacheName).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||!files.some(file=>new URL(file,self.registration.scope).href===request.url))return;
 event.respondWith(fetch(request).then(async response=>{
  if(response.ok){const cache=await caches.open(cacheName);await cache.put(request,response.clone())}
  return response;
 }).catch(async()=>await caches.match(request)||Response.error()));
});
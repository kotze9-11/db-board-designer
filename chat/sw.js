// Chat service worker: shows notifications sent by the chat-push server function.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("push",e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(err){}
  e.waitUntil(self.registration.showNotification(d.title||"Chat",{body:d.body||"New message",tag:d.tag||"chat",renotify:true,icon:"icon-192.png",badge:"icon-192.png",data:{url:"./"}}));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{for(const w of ws){if("focus" in w)return w.focus()}return self.clients.openWindow("./")}));
});

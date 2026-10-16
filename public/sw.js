// ProfToPdf installation worker. Deliberately network-only: private data and
// application versions must never be retained in a service-worker cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  if (
    event.request.method === "GET" &&
    new URL(event.request.url).origin === self.location.origin
  ) {
    event.respondWith(fetch(event.request));
  }
});

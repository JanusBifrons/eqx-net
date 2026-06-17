// EQX Peri — Web Push service-worker handlers.
//
// This file is imported into the vite-plugin-pwa generated service worker via
// `workbox.importScripts(['push-sw.js'])` (see vite.config.ts). It runs in the
// SW global scope and registers the `push` + `notificationclick` listeners.
//
// The push PAYLOAD is the JSON our server sends through `web-push`
// (src/server/push/PushNotifier.ts → { title, body, tag, ... }). Kept as a
// hand-written static asset (NOT bundled) so the push handlers are independent
// of the Workbox precache strategy. See docs/architecture/web-push.md.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'EQX Peri';
  const options = {
    body: data.body || 'Something is happening in your sector.',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: data.tag || 'eqx-alert',
    renotify: true,
    data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
      return undefined;
    }),
  );
});

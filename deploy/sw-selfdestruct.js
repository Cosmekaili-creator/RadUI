// SPDX-License-Identifier: AGPL-3.0-or-later
// Self-removing service worker: the recovery and rollback worker (see docs/pwa.md and docs/UPGRADE-UI.md).
//
// Deploy it by hand under the name sw.js (it is NOT part of the shipped app tree and is not listed in
// sw-manifest.js), and serve it with `Cache-Control: no-cache`. A browser that finds it in place of the real
// worker installs it at once, deletes every `radui-shell-*` cache, unregisters itself and reloads the open
// pages from the network. Keep it in place for at least the browsers' worker update interval (a day or more;
// longer for devices that are rarely opened), then deploy the real sw.js again or remove the file.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('radui-shell-')) await caches.delete(name);
      }
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        try {
          client.navigate(client.url);
        } catch (_err) {
          // a client that cannot be navigated is reloaded by the user; nothing else to do
        }
      }
    })(),
  );
});

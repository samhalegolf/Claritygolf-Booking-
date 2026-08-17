/* Clarity Booking service worker.
 *
 * Deliberately minimal: it exists to receive push messages and open the app
 * when one is clicked. It does not cache anything — the app is served from
 * Netlify with its own cache headers, and a caching service worker here would
 * be a second, silent source of truth about which build the coach is running.
 */

self.addEventListener("install", () => {
  // A new worker should take over straight away rather than waiting for every
  // Clarity tab to close, otherwise a notification fix can sit undeployed for
  // days on a machine that never closes the tab.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: "Clarity Booking", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Clarity Booking";
  const options = {
    body: data.body || "",
    icon: "/assets/clarity-icon-192.png",
    badge: "/assets/clarity-badge-96.png",
    tag: data.tag || "clarity-booking",
    // Same tag replaces the previous pop-up, but still alerts — without this a
    // cancellation would silently overwrite the booking notification.
    renotify: Boolean(data.tag),
    timestamp: Date.now(),
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus a Clarity tab if one is already open rather than piling up a new
      // window every time the coach taps a notification.
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          return client.focus().then((focused) => (focused && "navigate" in focused ? focused.navigate(target) : focused));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

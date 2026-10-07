// Service worker: shows push notifications for the owner dashboard.

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: event.data && event.data.text() };
    }
    event.waitUntil(self.registration.showNotification(data.title || '💬 Naya message', {
        body: data.body || '',
        tag: data.tag,
        renotify: Boolean(data.tag),
        data: { url: data.url || '/dashboard' },
    }));
});

// Clicking a notification focuses an open dashboard (and opens that chat),
// or opens a new one.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/dashboard';

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const dashboard = windows.find((w) => new URL(w.url).pathname === '/dashboard');
        if (dashboard) {
            await dashboard.focus();
            dashboard.postMessage({ type: 'open', url });
        } else {
            await self.clients.openWindow(url);
        }
    })());
});

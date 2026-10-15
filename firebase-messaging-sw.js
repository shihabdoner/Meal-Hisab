importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAfp6ACmE3d-9iAieAp1knA40qKEbdcx7Y",
  authDomain: "khaddo-tothyo.firebaseapp.com",
  projectId: "khaddo-tothyo",
  storageBucket: "khaddo-tothyo.firebasestorage.app",
  messagingSenderId: "221896509109",
  appId: "1:221896509109:web:a36edd0b6f0ab4a8c020fc"
};
const messaging = firebase.messaging();

// Data-only messages (no "notification" block) are shown here.
// If you send a "notification" block, Chrome shows it automatically and this is skipped.
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  if (payload.notification) return;
  self.registration.showNotification(d.title || "খাদ্য তথ্য", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "badge-96.png",
    tag: d.tag || "khaddo",
    data: { link: d.link || "./" }
  });
});

// Tapping a notification opens (or focuses) the app.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "./";
  const url = new URL(link, self.location.origin + self.location.pathname.replace(/[^/]*$/, "")).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

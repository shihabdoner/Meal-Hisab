importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
});

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

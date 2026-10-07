# Anonymous Chat

Inspired by NGL, but with two-way chat. Create a room, share its link on
WhatsApp status, an Instagram story or anywhere else, and visitors can chat with
you after giving any name and their relation to you.

If the same visitor comes back with a different name or relation, the dashboard
shows it.

## How it works

| Page | URL | Who |
|---|---|---|
| Create a room | `/` | Owner: just a name, no signup |
| Chat | `/c/<slug>` | Visitor: name + relation, then chat |
| Dashboard | `/dashboard` | Owner: every visitor, every chat, replies |

**Owner login without signup:** creating a room returns a secret owner key. It is
saved in the browser, and the **secret owner link** (`/dashboard#key=...`) opens
the dashboard on any other device. The server stores only a SHA-256 hash of the key.

**Visitor detection:**

1. **Device ID**: a random ID kept in localStorage, a cookie and IndexedDB.
   Same device ID = same visitor record, and every name/relation they use is
   saved in `aliases`. When they switch to a new name, their chat starts empty
   for them, but the owner sees the full history with a "🔄 Naya naam" marker.
2. **Fingerprint**: a hash of browser/device traits (screen, GPU, timezone,
   canvas…). If a *new* device ID has the same fingerprint as an existing
   visitor, both are linked:
   - `fingerprint+ip`: same traits **and** same network → ⚠️ very likely the same person
   - `fingerprint`: same traits, different network → 🤔 possibly the same person
     (phones of the same model can look identical)

IP addresses are never stored, only salted hashes.

**Real-time (Socket.IO):** new messages, edits and deletes appear instantly, along with
"typing…", ✓ sent / ✓✓ seen ticks, 🟢 online status for both sides, and unread
counts (also in the tab title). Sockets only carry small signals; messages are
still sent and loaded through the REST API, so validation and rate limits stay
in one place. Presence is kept in memory, so run a **single instance**.

**Owner notifications:** the 🔕 Notifications button on the dashboard turns on Web
Push. With no dashboard open, a new visitor message arrives as a phone or desktop
notification. When the dashboard is open but in a background tab, the page shows
the notification itself. On iPhone, push only works after "Add to Home Screen".

**Owner tools on the dashboard:**
- 📤 **Share**: links for WhatsApp, Facebook, X, Instagram, plus a **📸 story image**
  (1080×1920) to post as a story, with the link added as a "Link" sticker.
- 📊 **Stats**: link opens, visitors, estimated real people (visitors linked by
  same device + same network count as one), name changers, messages, and charts
  for the last 7 days and visitors by relation.
- ⚙️ **Settings**: edit the question, the relation options (up to 12), close the room
  (old chats stay readable, nothing new comes in), and the bad-word filter.
- 🚫 **Block**: a blocked visitor is disconnected at once and can't come back with a
  new name or through incognito on the same device (their fingerprint is blocked too).
- 📲 **Install**: the app is a PWA, so the dashboard can be installed like an app.

The bad-word list is in `profanity.js`. Masking is applied only to what the owner
sees, and the original text stays stored.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI, IP_SALT and the VAPID keys
npx web-push generate-vapid-keys   # paste the output into .env
npm run dev
```

Open http://localhost:5000.

## Deploy on Render

1. Push this repo to GitHub.
2. On Render: **New → Blueprint**, then pick the repo. `render.yaml` sets everything up.
3. Set `MONGODB_URI`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
   (`mailto:you@...`) in the Render dashboard. `IP_SALT` is generated automatically.
   Never change the VAPID keys later.
4. In MongoDB Atlas → Network Access, allow Render's outbound IPs (or `0.0.0.0/0`).

## Project structure

```
server.js        Express API + page routes
models.js        Room, Visitor, Message, PushSubscription schemas
realtime.js      Socket.IO: auth, presence, typing, seen
push.js          Web Push (VAPID) notifications
profanity.js     bad-word filter (edit the word list here)
public/
  sw.js          service worker that shows push notifications
  manifest.webmanifest, icons/   PWA install
  index.html     create a room
  chat.html      visitor chat
  dashboard.html owner dashboard
  style.css
  js/common.js   API, DOM, sharing, device ID, fingerprint helpers
  js/home.js, js/chat.js, js/dashboard.js
```

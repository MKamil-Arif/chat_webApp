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

**Live updates:** new messages, edits and deletes, "typing…", ✓ sent / ✓✓ seen
ticks, 🟢 online status for both sides, and unread counts (also in the tab title).
Messages are always sent and loaded through the REST API; live updates only
carry small "something changed" signals, in one of two modes:

- **Socket.IO** on a normal long-running server (`npm start`): instant.
- **Polling** on Vercel (serverless functions can't hold sockets): pages check
  `/api/.../poll` every 3 seconds (15 seconds in a background tab). Each change
  bumps a version counter in MongoDB, and presence/typing are timestamps there.

`GET /api/config` tells the pages which mode to use. Run `REALTIME=off npm start`
to try polling mode locally.

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
cp .env.example .env   # then fill in MONGODB_URI
npm run dev
```

Open http://localhost:5000.

## Deploy on Vercel

`vercel.json` serves `public/` from the CDN and sends every `/api/*` request to
`api/index.js`, which runs the Express app as a serverless function.

1. In MongoDB Atlas → **Network Access**, allow `0.0.0.0/0`. Vercel has no fixed IPs.
2. Set `MONGODB_URI` in the Vercel project: either connect MongoDB Atlas from the
   project's **Storage** tab (Vercel sets the variable itself), or add it under
   Settings → Environment Variables. `IP_SALT` and the VAPID keys are optional: when
   they are missing, the app generates them once and keeps them in the database
   (`secrets.js`).
3. Deploy with `vercel --prod`, or connect the GitHub repo in Vercel for automatic deploys.

Limits of the serverless mode: rate limits are counted per function instance,
and polling uses ~20 requests per minute per open chat tab.

## Project structure

```
server.js        Express API + page routes (exports app; listens when run directly)
api/index.js     Vercel serverless entry (re-exports the app)
vercel.json      Vercel rewrites, headers, static output
models.js        Room, Visitor, Message, PushSubscription schemas
realtime.js      live updates: Socket.IO or polling; presence, typing, seen
push.js          Web Push (VAPID) notifications
secrets.js       IP salt + VAPID keys: from env, or generated once and stored in the DB
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

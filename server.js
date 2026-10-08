require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { Room, Visitor, Message } = require('./models');
const push = require('./push');
const { getSecrets } = require('./secrets');
const { maskProfanity } = require('./profanity');
const realtime = require('./realtime');

const { chatChanged, isOwnerOnline, isVisitorOnline } = realtime;

const MAX_MESSAGE = 1000;
const MAX_RELATIONS = 12;
const PUBLIC_DIR = path.join(__dirname, 'public');


const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

// ============================================
// HELPERS
// ============================================

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Trim a string, drop control characters and check its length.
// Returns null when the value is missing or invalid.
function cleanText(value, min, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  return text.length >= min && text.length <= max ? text : null;
}

const isId = (value) => mongoose.isValidObjectId(value);
const isDeviceId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(value);
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Wrap async route handlers so thrown errors reach the error middleware.
const route = (handler) => (req, res, next) => handler(req, res, next).catch(next);

async function generateSlug(ownerName) {
  const base = ownerName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'chat';
  for (;;) {
    const slug = `${base}-${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;
    if (!(await Room.exists({ slug }))) return slug;
  }
}

// Find other visitors in the same room whose browser fingerprint matches,
// and link both records so the owner sees "this might be the same person".
async function linkSimilarVisitors(visitor) {
  if (!visitor.fpHash) return;
  const known = new Set(visitor.links.map((l) => String(l.visitor)));
  const matches = await Visitor.find({
    room: visitor.room,
    fpHash: visitor.fpHash,
    _id: { $ne: visitor._id },
  }).select('_id ipHash');

  for (const other of matches) {
    if (known.has(String(other._id))) continue;
    const reason = visitor.ipHash && other.ipHash === visitor.ipHash ? 'fingerprint+ip' : 'fingerprint';
    visitor.links.push({ visitor: other._id, reason });
    await Visitor.updateOne(
      { _id: other._id, 'links.visitor': { $ne: visitor._id } },
      { $push: { links: { visitor: visitor._id, reason } } }
    );
  }
  await visitor.save();
}

// `mask`: hide bad words in visitor messages (owner view, when the room's
// filter is on). The original text stays in the database.
function publicMessage(msg, { mask = false } = {}) {
  return {
    _id: msg._id,
    fromOwner: msg.fromOwner,
    text: mask && !msg.fromOwner ? maskProfanity(msg.text) : msg.text,
    aliasName: msg.aliasName,
    aliasRelation: msg.aliasRelation,
    editedAt: msg.editedAt,
    seenAt: msg.seenAt,
    createdAt: msg.createdAt,
  };
}

// Push a notification to the owner's devices, but only when no dashboard is
// open: an open dashboard already shows the message live. Awaited, because a
// serverless function may be frozen as soon as the response is sent.
async function pushToOwner(room, visitor, text) {
  if (isOwnerOnline(room)) return;
  if (room.filterProfanity) text = maskProfanity(text);
  try {
    await push.notifyRoom(room._id, {
      title: `💬 ${visitor.name} (${visitor.relation})`,
      body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      tag: String(visitor._id),
      url: `/dashboard?room=${encodeURIComponent(room.slug)}&v=${visitor._id}`,
    });
  } catch (error) {
    console.error('Push failed:', error.message);
  }
}

// ============================================
// LOOKUPS (shared by REST and Socket.IO)
// ============================================

async function findOwnerRoom(ownerKey) {
  if (typeof ownerKey !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(ownerKey)) return null;
  return Room.findOne({ ownerKeyHash: sha256(ownerKey) });
}

async function findVisitor(slug, deviceId) {
  if (typeof slug !== 'string' || !isDeviceId(deviceId)) return null;
  const room = await Room.findOne({ slug });
  const visitor = room && (await Visitor.findOne({ room: room._id, deviceHash: sha256(deviceId) }));
  return visitor ? { room, visitor } : null;
}

// ============================================
// DATABASE
// ============================================

// One connection per process. On Vercel the process (and this promise)
// survives between requests while the function stays warm.
let dbPromise = null;
function connectDb() {
  if (!dbPromise) {
    dbPromise = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 })
      .then(() => console.log('✅ MongoDB Connected Successfully!'))
      .catch((error) => {
        dbPromise = null; // retry on the next request
        throw error;
      });
  }
  return dbPromise;
}

app.use('/api', (req, res, next) => connectDb().then(() => next(), next));

// ============================================
// RATE LIMITS
// ============================================

const limiter = (windowMinutes, max) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a little while.' },
});

app.use('/api', limiter(15, 3000)); // polling clients make ~20 requests/minute
const createRoomLimit = limiter(60, 10);
const sendLimit = limiter(1, 30);

// ============================================
// AUTH MIDDLEWARE
// ============================================

const BLOCKED_TEXT = 'This chat is no longer available to you.';
const CLOSED_TEXT = 'This room is closed right now.';

// Owner: "Authorization: Bearer <ownerKey>"
const requireOwner = route(async (req, res, next) => {
  const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  const room = match && (await findOwnerRoom(match[1]));
  if (!room) return res.status(401).json({ error: 'Invalid owner key.' });
  req.room = room;
  next();
});

// Visitor: room slug in the URL + "X-Device-Id" header
const requireVisitor = route(async (req, res, next) => {
  if (!(await Room.exists({ slug: req.params.slug }))) return res.status(404).json({ error: 'Room not found.' });
  const found = await findVisitor(req.params.slug, req.get('x-device-id'));
  if (!found) return res.status(401).json({ error: 'Please enter your name first.' });
  if (found.visitor.blocked) return res.status(403).json({ error: BLOCKED_TEXT, code: 'blocked' });
  req.room = found.room;
  req.visitor = found.visitor;
  next();
});

// ============================================
// ROOMS (public)
// ============================================

app.post('/api/rooms', createRoomLimit, route(async (req, res) => {
  const ownerName = cleanText(req.body.ownerName, 1, 40);
  const prompt = req.body.prompt ? cleanText(req.body.prompt, 1, 120) : '';
  if (!ownerName || prompt === null) {
    return res.status(400).json({ error: 'Name must be 1-40 characters and the question up to 120.' });
  }
  const ownerKey = crypto.randomBytes(24).toString('base64url');
  const room = await Room.create({
    slug: await generateSlug(ownerName),
    ownerName,
    prompt,
    ownerKeyHash: sha256(ownerKey),
  });
  res.status(201).json({ slug: room.slug, ownerName: room.ownerName, ownerKey });
}));

app.get('/api/rooms/:slug', route(async (req, res) => {
  const room = await Room.findOne({ slug: req.params.slug });
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ ownerName: room.ownerName, prompt: room.prompt, relations: room.relations, isOpen: room.isOpen });
}));

// The chat link was opened. The page calls this once per browser session.
app.post('/api/rooms/:slug/view', route(async (req, res) => {
  const result = await Room.updateOne({ slug: req.params.slug }, { $inc: { views: 1 } });
  res.status(result.matchedCount ? 204 : 404).end();
}));

// ============================================
// VISITOR
// ============================================

app.post('/api/rooms/:slug/join', route(async (req, res) => {
  const room = await Room.findOne({ slug: req.params.slug });
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const name = cleanText(req.body.name, 1, 40);
  if (!room.isOpen) return res.status(403).json({ error: CLOSED_TEXT, code: 'closed' });
  const relation = room.relations.includes(req.body.relation) ? req.body.relation : null;
  const { deviceId, fp } = req.body;
  if (!name || !relation || !isDeviceId(deviceId)) {
    return res.status(400).json({ error: 'Name and relation are both required.' });
  }

  const deviceHash = sha256(deviceId);
  const fpHash = isHash(fp) ? sha256(fp) : '';
  // IPs are never stored, only salted hashes (salt: see secrets.js).
  const ipHash = sha256((await getSecrets()).ipSalt + req.ip);
  const now = new Date();

  let visitor = await Visitor.findOne({ room: room._id, deviceHash });
  // Blocked device, or a new device that looks like a blocked one.
  if (visitor?.blocked || (fpHash && room.blockedFps.includes(fpHash))) {
    return res.status(403).json({ error: BLOCKED_TEXT, code: 'blocked' });
  }
  if (!visitor) {
    visitor = new Visitor({
      room: room._id, deviceHash, fpHash, ipHash, name, relation,
      aliases: [{ name, relation, at: now }],
      sessionStart: now,
    });
  } else {
    const changed = visitor.name.toLowerCase() !== name.toLowerCase() || visitor.relation !== relation;
    if (changed) {
      visitor.aliases.push({ name, relation, at: now });
      visitor.sessionStart = now; // fresh-looking chat for the visitor
    }
    visitor.name = name;
    visitor.relation = relation;
    if (fpHash) visitor.fpHash = fpHash;
    visitor.ipHash = ipHash;
  }
  await visitor.save();
  await linkSimilarVisitors(visitor);
  await chatChanged(room._id, visitor._id);

  res.json({ name: visitor.name, relation: visitor.relation });
}));

app.get('/api/rooms/:slug/me', requireVisitor, (req, res) => {
  res.json({ name: req.visitor.name, relation: req.visitor.relation });
});

app.get('/api/rooms/:slug/messages', requireVisitor, route(async (req, res) => {
  const messages = await Message.find({
    visitor: req.visitor._id,
    createdAt: { $gte: req.visitor.sessionStart },
  }).sort({ createdAt: 1 }).limit(500);
  res.json(messages.map((m) => publicMessage(m)));
}));

app.post('/api/rooms/:slug/messages', sendLimit, requireVisitor, route(async (req, res) => {
  if (!req.room.isOpen) return res.status(403).json({ error: CLOSED_TEXT, code: 'closed' });
  const text = cleanText(req.body.text, 1, MAX_MESSAGE);
  if (!text) return res.status(400).json({ error: `Message must be 1-${MAX_MESSAGE} characters.` });
  const message = await Message.create({
    room: req.room._id,
    visitor: req.visitor._id,
    text,
    aliasName: req.visitor.name,
    aliasRelation: req.visitor.relation,
  });
  await Visitor.updateOne({ _id: req.visitor._id }, { lastMessageAt: message.createdAt });
  await chatChanged(req.room._id, req.visitor._id);
  await pushToOwner(req.room, req.visitor, text);
  res.status(201).json(publicMessage(message));
}));

app.put('/api/rooms/:slug/messages/:id', requireVisitor, route(async (req, res) => {
  const text = cleanText(req.body.text, 1, MAX_MESSAGE);
  if (!text || !isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const message = await Message.findOneAndUpdate(
    { _id: req.params.id, visitor: req.visitor._id, fromOwner: false },
    { text, editedAt: new Date() },
    { new: true }
  );
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  await chatChanged(req.room._id, req.visitor._id);
  res.json(publicMessage(message));
}));

// Polling mode (serverless): what changed since the last poll, plus typing
// and seen, which socket clients send over the socket instead.
app.get('/api/rooms/:slug/poll', requireVisitor, route(async (req, res) => {
  res.json(await realtime.visitorSnapshot(req.room, req.visitor));
}));

app.post('/api/rooms/:slug/typing', requireVisitor, route(async (req, res) => {
  await realtime.visitorTyping(req.room._id, req.visitor._id);
  res.status(204).end();
}));

app.post('/api/rooms/:slug/seen', requireVisitor, route(async (req, res) => {
  await realtime.markSeenByVisitor(req.room._id, req.visitor._id);
  res.status(204).end();
}));

// ============================================
// OWNER
// ============================================

function roomSettings(room) {
  const { slug, ownerName, prompt, relations, isOpen, filterProfanity } = room;
  return { slug, ownerName, prompt, relations, isOpen, filterProfanity };
}

app.get('/api/owner/room', requireOwner, (req, res) => res.json(roomSettings(req.room)));

app.patch('/api/owner/room', requireOwner, route(async (req, res) => {
  const { room } = req;
  const body = req.body || {};

  if (body.prompt !== undefined) {
    const prompt = body.prompt === '' ? '' : cleanText(body.prompt, 1, 120);
    if (prompt === null) return res.status(400).json({ error: 'The question can be up to 120 characters.' });
    room.prompt = prompt;
  }
  if (body.relations !== undefined) {
    if (!Array.isArray(body.relations)) return res.status(400).json({ error: 'Invalid relations.' });
    const relations = [...new Set(body.relations.map((r) => cleanText(r, 1, 30)).filter(Boolean))];
    if (relations.length < 1 || relations.length > MAX_RELATIONS) {
      return res.status(400).json({ error: `Use 1 to ${MAX_RELATIONS} relations (up to 30 characters each).` });
    }
    room.relations = relations;
  }
  if (typeof body.isOpen === 'boolean') room.isOpen = body.isOpen;
  if (typeof body.filterProfanity === 'boolean') room.filterProfanity = body.filterProfanity;

  await room.save();
  await realtime.roomSettingsChanged(room._id);
  res.json(roomSettings(room));
}));

app.get('/api/owner/visitors', requireOwner, route(async (req, res) => {
  const visitors = await Visitor.find({ room: req.room._id })
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .populate('links.visitor', 'name relation')
    .lean();

  const counts = await Message.aggregate([
    { $match: { room: req.room._id, fromOwner: false } },
    {
      $group: {
        _id: '$visitor',
        count: { $sum: 1 },
        unread: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$seenAt', null] }, null] }, 1, 0] } },
      },
    },
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c]));

  res.json(visitors.map((v) => ({
    _id: v._id,
    name: v.name,
    relation: v.relation,
    aliases: v.aliases,
    links: v.links
      .filter((l) => l.visitor)
      .map((l) => ({ _id: l.visitor._id, name: l.visitor.name, relation: l.visitor.relation, reason: l.reason })),
    messageCount: countById.get(String(v._id))?.count || 0,
    unread: countById.get(String(v._id))?.unread || 0,
    online: isVisitorOnline(v),
    blocked: v.blocked,
    lastMessageAt: v.lastMessageAt,
    createdAt: v.createdAt,
  })));
}));

app.get('/api/owner/visitors/:id/messages', requireOwner, route(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const messages = await Message.find({ room: req.room._id, visitor: req.params.id })
    .sort({ createdAt: 1 })
    .limit(1000);
  res.json(messages.map((m) => publicMessage(m, { mask: req.room.filterProfanity })));
}));

app.post('/api/owner/visitors/:id/messages', sendLimit, requireOwner, route(async (req, res) => {
  const text = cleanText(req.body.text, 1, MAX_MESSAGE);
  if (!text || !isId(req.params.id)) return res.status(400).json({ error: `Message must be 1-${MAX_MESSAGE} characters.` });
  const visitor = await Visitor.findOne({ _id: req.params.id, room: req.room._id });
  if (!visitor) return res.status(404).json({ error: 'Visitor not found.' });
  const message = await Message.create({
    room: req.room._id,
    visitor: visitor._id,
    fromOwner: true,
    text,
    aliasName: visitor.name,
    aliasRelation: visitor.relation,
  });
  await chatChanged(req.room._id, visitor._id);
  res.status(201).json(publicMessage(message));
}));

app.put('/api/owner/messages/:id', requireOwner, route(async (req, res) => {
  const text = cleanText(req.body.text, 1, MAX_MESSAGE);
  if (!text || !isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const message = await Message.findOneAndUpdate(
    { _id: req.params.id, room: req.room._id, fromOwner: true },
    { text, editedAt: new Date() },
    { new: true }
  );
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  await chatChanged(req.room._id, message.visitor);
  res.json(publicMessage(message));
}));

app.delete('/api/owner/messages/:id', requireOwner, route(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const message = await Message.findOneAndDelete({ _id: req.params.id, room: req.room._id });
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  await chatChanged(req.room._id, message.visitor);
  res.json({ success: true });
}));

app.get('/api/owner/poll', requireOwner, route(async (req, res) => {
  res.json(await realtime.ownerSnapshot(req.room));
}));

app.post('/api/owner/visitors/:id/typing', requireOwner, route(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  await realtime.ownerTyping(req.room._id, req.params.id);
  res.status(204).end();
}));

app.post('/api/owner/visitors/:id/seen', requireOwner, route(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  await realtime.markSeenByOwner(req.room._id, req.params.id);
  res.status(204).end();
}));

// Block or unblock a visitor. Blocking also remembers their fingerprint, so
// clearing storage or using incognito on the same device doesn't get around it.
app.post('/api/owner/visitors/:id/block', requireOwner, route(async (req, res) => {
  if (!isId(req.params.id) || typeof req.body.blocked !== 'boolean') return res.status(400).json({ error: 'Invalid request.' });
  const visitor = await Visitor.findOne({ _id: req.params.id, room: req.room._id });
  if (!visitor) return res.status(404).json({ error: 'Visitor not found.' });

  visitor.blocked = req.body.blocked;
  await visitor.save();
  if (visitor.fpHash) {
    const update = visitor.blocked ? { $addToSet: { blockedFps: visitor.fpHash } } : { $pull: { blockedFps: visitor.fpHash } };
    await Room.updateOne({ _id: req.room._id }, update);
  }
  if (visitor.blocked) realtime.disconnectVisitor(req.room._id, visitor._id);
  await chatChanged(req.room._id, visitor._id);
  res.json({ blocked: visitor.blocked });
}));

// Numbers for the stats panel. `tz` is the browser's UTC offset ("+05:00") so
// "per day" means the owner's days.
app.get('/api/owner/stats', requireOwner, route(async (req, res) => {
  const roomId = req.room._id;
  const tz = /^[+-]\d{2}:\d{2}$/.test(req.query.tz) ? req.query.tz : '+00:00';
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [visitors, received, replies, perDay] = await Promise.all([
    Visitor.find({ room: roomId }).select('relation aliases links blocked').lean(),
    Message.countDocuments({ room: roomId, fromOwner: false }),
    Message.countDocuments({ room: roomId, fromOwner: true }),
    Message.aggregate([
      { $match: { room: roomId, fromOwner: false, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, count: { $sum: 1 } } },
    ]),
  ]);

  // Visitors linked by fingerprint are probably one person: count groups.
  const parent = new Map(visitors.map((v) => [String(v._id), String(v._id)]));
  const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
  for (const v of visitors) {
    for (const l of v.links) {
      if (l.reason === 'fingerprint+ip' && parent.has(String(l.visitor))) {
        parent.set(find(String(v._id)), find(String(l.visitor)));
      }
    }
  }
  const people = new Set(visitors.map((v) => find(String(v._id)))).size;

  const byRelation = new Map();
  for (const v of visitors) byRelation.set(v.relation, (byRelation.get(v.relation) || 0) + 1);

  res.json({
    views: req.room.views,
    visitors: visitors.length,
    people,
    nameChangers: visitors.filter((v) => v.aliases.length > 1).length,
    blocked: visitors.filter((v) => v.blocked).length,
    received,
    replies,
    byRelation: [...byRelation].map(([relation, count]) => ({ relation, count })).sort((a, b) => b.count - a.count),
    perDay: perDay.map((d) => ({ date: d._id, count: d.count })),
  });
}));

// ============================================
// PUSH NOTIFICATIONS (owner)
// ============================================

// Tells pages whether to use Socket.IO or polling.
app.get('/api/config', (req, res) => res.json({ realtime: realtime.socketsEnabled() }));

app.get('/api/push/key', route(async (req, res) => res.json({ publicKey: await push.publicKey() })));

app.post('/api/owner/push/subscribe', requireOwner, route(async (req, res) => {
  const { endpoint, keys } = req.body.subscription || {};
  const valid = typeof endpoint === 'string' && /^https:\/\//.test(endpoint) && endpoint.length < 1000
    && keys && typeof keys.p256dh === 'string' && typeof keys.auth === 'string'
    && keys.p256dh.length < 200 && keys.auth.length < 100;
  if (!valid) return res.status(400).json({ error: 'Invalid subscription.' });
  await push.subscribe(req.room._id, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  res.status(201).json({ success: true });
}));

app.post('/api/owner/push/unsubscribe', requireOwner, route(async (req, res) => {
  if (typeof req.body.endpoint !== 'string') return res.status(400).json({ error: 'Invalid request.' });
  await push.unsubscribe(req.room._id, req.body.endpoint);
  res.json({ success: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ============================================
// PAGES
// ============================================

app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/c/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chat.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again in a little while.' });
});

// ============================================
// START
// ============================================

// Vercel imports `app` as a serverless function (see api/index.js): no
// listening and no Socket.IO there. Run directly, it is a normal server.
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  const server = http.createServer(app);
  // REALTIME=off simulates Vercel's polling mode locally.
  if (process.env.REALTIME !== 'off') realtime.setupRealtime(server, { findOwnerRoom, findVisitor });

  connectDb()
    .then(() => server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error('❌ MongoDB Connection Error:', err.message);
      process.exit(1);
    });
}

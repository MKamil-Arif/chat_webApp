const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { Room, Visitor, Message } = require('./models');

// Live updates work in two modes:
//
// 1. Socket.IO, on a normal long-running server (local, Render, a VPS).
// 2. Polling, on serverless hosts like Vercel, where no process stays alive to
//    hold sockets open. Pages ask GET /api/.../poll every few seconds instead.
//
// Both modes share the code below. Every change bumps a version counter in the
// database (what polling clients compare) and also emits a socket event (what
// socket clients listen to). Presence and typing are kept as timestamps in the
// database for polling, and in memory for sockets.
//
// Socket channels:
//   owner:<roomId>               every open dashboard of a room
//   visitors:<roomId>            every visitor connected to a room
//   visitor:<roomId>:<visitorId> one visitor (all their tabs)

const ONLINE_MS = 15_000; // polling: "online" if seen this recently
const TYPING_MS = 4_000; // polling: "typing" if a keystroke was this recent
const TOUCH_EVERY_MS = 10_000; // don't write lastActiveAt on every poll
const TYPING_THROTTLE_MS = 1000;

let io = null;
const ownerSockets = new Map(); // roomId -> open dashboards
const visitorSockets = new Map(); // visitorId -> open tabs

const socketsEnabled = () => io !== null;

function count(map, key, delta) {
  const n = (map.get(key) || 0) + delta;
  if (n > 0) map.set(key, n);
  else map.delete(key);
  return n;
}

const recent = (date, ms) => Boolean(date) && Date.now() - new Date(date).getTime() < ms;

// ============================================
// PRESENCE
// ============================================

function isOwnerOnline(room) {
  return ownerSockets.has(String(room._id)) || recent(room.ownerActiveAt, ONLINE_MS);
}

function isVisitorOnline(visitor) {
  return visitorSockets.has(String(visitor._id)) || recent(visitor.lastActiveAt, ONLINE_MS);
}

// Called on every poll; writes at most once per TOUCH_EVERY_MS.
async function touchOwner(room) {
  const cutoff = new Date(Date.now() - TOUCH_EVERY_MS);
  await Room.updateOne(
    { _id: room._id, $or: [{ ownerActiveAt: null }, { ownerActiveAt: { $lt: cutoff } }] },
    { ownerActiveAt: new Date() }
  );
}

async function touchVisitor(visitor) {
  const cutoff = new Date(Date.now() - TOUCH_EVERY_MS);
  await Visitor.updateOne(
    { _id: visitor._id, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lt: cutoff } }] },
    { lastActiveAt: new Date() }
  );
}

// ============================================
// CHANGES
// ============================================

function notifyOwner(roomId, event, data = {}) {
  if (io) io.to(`owner:${roomId}`).emit(event, data);
}

function notifyVisitor(roomId, visitorId, event, data = {}) {
  if (io) io.to(`visitor:${roomId}:${visitorId}`).emit(event, data);
}

// A chat changed (new/edited/deleted message, seen ticks, new visitor, block...).
async function chatChanged(roomId, visitorId) {
  await Promise.all([
    Room.updateOne({ _id: roomId }, { $inc: { version: 1 } }),
    Visitor.updateOne({ _id: visitorId }, { $inc: { version: 1 } }),
  ]);
  notifyOwner(roomId, 'visitor:changed', { visitorId: String(visitorId) });
  notifyVisitor(roomId, visitorId, 'messages:changed');
}

// The owner edited the room settings (prompt, relations, open/closed).
async function roomSettingsChanged(roomId) {
  await Room.updateOne({ _id: roomId }, { $inc: { settingsVersion: 1 } });
  if (io) io.to(`visitors:${roomId}`).emit('room:changed');
}

// The owner is looking at this visitor's chat: mark their messages seen.
async function markSeenByOwner(roomId, visitorId) {
  const result = await Message.updateMany(
    { room: roomId, visitor: visitorId, fromOwner: false, seenAt: null },
    { seenAt: new Date() }
  );
  if (result.modifiedCount) await chatChanged(roomId, visitorId);
}

// The visitor is looking at the chat: mark the owner's replies seen. Only
// replies from the current alias's session count, since those are the only
// ones the visitor can see.
async function markSeenByVisitor(roomId, visitorId) {
  const visitor = await Visitor.findById(visitorId).select('sessionStart');
  if (!visitor) return;
  const result = await Message.updateMany(
    { visitor: visitorId, fromOwner: true, seenAt: null, createdAt: { $gte: visitor.sessionStart } },
    { seenAt: new Date() }
  );
  if (result.modifiedCount) await chatChanged(roomId, visitorId);
}

async function visitorTyping(roomId, visitorId) {
  notifyOwner(roomId, 'typing', { visitorId: String(visitorId) });
  if (!io) await Visitor.updateOne({ _id: visitorId }, { typingAt: new Date() });
}

async function ownerTyping(roomId, visitorId) {
  notifyVisitor(roomId, visitorId, 'typing');
  if (!io) await Visitor.updateOne({ _id: visitorId, room: roomId }, { ownerTypingAt: new Date() });
}

// ============================================
// POLLING SNAPSHOTS
// ============================================

async function visitorSnapshot(room, visitor) {
  await touchVisitor(visitor);
  return {
    version: visitor.version,
    settingsVersion: room.settingsVersion,
    ownerOnline: isOwnerOnline(room),
    ownerTyping: recent(visitor.ownerTypingAt, TYPING_MS),
  };
}

async function ownerSnapshot(room) {
  await touchOwner(room);
  const since = new Date(Date.now() - ONLINE_MS);
  const active = await Visitor.find({
    room: room._id,
    $or: [{ lastActiveAt: { $gte: since } }, { typingAt: { $gte: since } }],
  }).select('_id lastActiveAt typingAt').lean();
  return {
    version: room.version,
    online: active.filter((v) => isVisitorOnline(v)).map((v) => String(v._id)),
    typing: active.filter((v) => recent(v.typingAt, TYPING_MS)).map((v) => String(v._id)),
  };
}

// ============================================
// SOCKET.IO
// ============================================

// Kick a (just blocked) visitor's open tabs.
function disconnectVisitor(roomId, visitorId) {
  if (io) io.in(`visitor:${roomId}:${visitorId}`).disconnectSockets(true);
}

// Drop typing events that arrive faster than once per second.
function throttled(socket) {
  const now = Date.now();
  if (now - (socket.data.lastTyping || 0) < TYPING_THROTTLE_MS) return true;
  socket.data.lastTyping = now;
  return false;
}

const logError = (label) => (error) => console.error(`${label} failed:`, error.message);

function onOwnerConnect(socket) {
  const { roomId } = socket.data;
  socket.join(`owner:${roomId}`);
  if (count(ownerSockets, roomId, 1) === 1) io.to(`visitors:${roomId}`).emit('owner:presence', { online: true });

  socket.on('typing', ({ visitorId } = {}) => {
    if (!mongoose.isValidObjectId(visitorId) || throttled(socket)) return;
    ownerTyping(roomId, visitorId).catch(logError('typing'));
  });
  socket.on('seen', ({ visitorId } = {}) => {
    if (!mongoose.isValidObjectId(visitorId)) return;
    markSeenByOwner(roomId, visitorId).catch(logError('seen (owner)'));
  });
  socket.on('disconnect', () => {
    if (count(ownerSockets, roomId, -1) === 0) io.to(`visitors:${roomId}`).emit('owner:presence', { online: false });
  });
}

function onVisitorConnect(socket) {
  const { roomId, visitorId } = socket.data;
  socket.join([`visitors:${roomId}`, `visitor:${roomId}:${visitorId}`]);
  socket.emit('owner:presence', { online: ownerSockets.has(roomId) });
  if (count(visitorSockets, visitorId, 1) === 1) notifyOwner(roomId, 'presence', { visitorId, online: true });

  socket.on('typing', () => {
    if (!throttled(socket)) visitorTyping(roomId, visitorId).catch(logError('typing'));
  });
  socket.on('seen', () => markSeenByVisitor(roomId, visitorId).catch(logError('seen (visitor)')));
  socket.on('disconnect', () => {
    if (count(visitorSockets, visitorId, -1) === 0) notifyOwner(roomId, 'presence', { visitorId, online: false });
  });
}

// findOwnerRoom(key) -> room | null
// findVisitor(slug, deviceId) -> { room, visitor } | null
function setupRealtime(server, { findOwnerRoom, findVisitor }) {
  io = new Server(server, { maxHttpBufferSize: 10_000 });

  io.use(async (socket, next) => {
    try {
      const { role, key, slug, deviceId } = socket.handshake.auth || {};
      if (role === 'owner') {
        const room = await findOwnerRoom(key);
        if (room) {
          socket.data = { role, roomId: String(room._id) };
          return next();
        }
      } else if (role === 'visitor') {
        const found = await findVisitor(slug, deviceId);
        if (found && !found.visitor.blocked) {
          socket.data = { role, roomId: String(found.room._id), visitorId: String(found.visitor._id) };
          return next();
        }
      }
      next(new Error('unauthorized'));
    } catch (error) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'owner') onOwnerConnect(socket);
    else onVisitorConnect(socket);
  });
}

module.exports = {
  setupRealtime,
  socketsEnabled,
  chatChanged,
  roomSettingsChanged,
  markSeenByOwner,
  markSeenByVisitor,
  visitorTyping,
  ownerTyping,
  visitorSnapshot,
  ownerSnapshot,
  disconnectVisitor,
  isOwnerOnline,
  isVisitorOnline,
};

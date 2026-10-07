const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { Visitor, Message } = require('./models');

// Socket.IO only pushes small signals ("something changed", typing, presence).
// Messages themselves are still sent and loaded through the REST API, so
// validation and rate limits live in one place.
//
// Channels:
//   owner:<roomId>               every open dashboard of a room
//   visitors:<roomId>            every visitor connected to a room
//   visitor:<roomId>:<visitorId> one visitor (all their tabs)

let io = null;
// Presence is kept in memory, which is fine for a single server instance.
const ownerSockets = new Map(); // roomId -> open dashboards
const visitorSockets = new Map(); // visitorId -> open tabs
const TYPING_THROTTLE_MS = 1000;

function count(map, key, delta) {
  const n = (map.get(key) || 0) + delta;
  if (n > 0) map.set(key, n);
  else map.delete(key);
  return n;
}

const isOwnerOnline = (roomId) => ownerSockets.has(String(roomId));
const isVisitorOnline = (visitorId) => visitorSockets.has(String(visitorId));

function notifyOwner(roomId, event, data = {}) {
  if (io) io.to(`owner:${roomId}`).emit(event, data);
}

function notifyVisitor(roomId, visitorId, event, data = {}) {
  if (io) io.to(`visitor:${roomId}:${visitorId}`).emit(event, data);
}

function notifyAllVisitors(roomId, event, data = {}) {
  if (io) io.to(`visitors:${roomId}`).emit(event, data);
}

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

function onOwnerConnect(socket) {
  const { roomId } = socket.data;
  socket.join(`owner:${roomId}`);
  if (count(ownerSockets, roomId, 1) === 1) io.to(`visitors:${roomId}`).emit('owner:presence', { online: true });

  socket.on('typing', ({ visitorId } = {}) => {
    if (!mongoose.isValidObjectId(visitorId) || throttled(socket)) return;
    notifyVisitor(roomId, visitorId, 'typing');
  });

  // The owner is looking at this visitor's chat: mark their messages seen.
  socket.on('seen', async ({ visitorId } = {}) => {
    if (!mongoose.isValidObjectId(visitorId)) return;
    try {
      const result = await Message.updateMany(
        { room: roomId, visitor: visitorId, fromOwner: false, seenAt: null },
        { seenAt: new Date() }
      );
      if (result.modifiedCount) {
        notifyVisitor(roomId, visitorId, 'messages:changed');
        notifyOwner(roomId, 'visitor:changed', { visitorId });
      }
    } catch (error) {
      console.error('seen (owner) failed:', error.message);
    }
  });

  socket.on('disconnect', () => {
    if (count(ownerSockets, roomId, -1) === 0) io.to(`visitors:${roomId}`).emit('owner:presence', { online: false });
  });
}

function onVisitorConnect(socket) {
  const { roomId, visitorId } = socket.data;
  socket.join([`visitors:${roomId}`, `visitor:${roomId}:${visitorId}`]);
  socket.emit('owner:presence', { online: isOwnerOnline(roomId) });
  if (count(visitorSockets, visitorId, 1) === 1) notifyOwner(roomId, 'presence', { visitorId, online: true });

  socket.on('typing', () => {
    if (!throttled(socket)) notifyOwner(roomId, 'typing', { visitorId });
  });

  // The visitor is looking at the chat: mark the owner's replies seen. Only
  // replies from the current alias's session count, since those are the
  // only ones the visitor can see.
  socket.on('seen', async () => {
    try {
      const visitor = await Visitor.findById(visitorId).select('sessionStart');
      if (!visitor) return;
      const result = await Message.updateMany(
        { visitor: visitorId, fromOwner: true, seenAt: null, createdAt: { $gte: visitor.sessionStart } },
        { seenAt: new Date() }
      );
      if (result.modifiedCount) {
        notifyOwner(roomId, 'visitor:changed', { visitorId });
        notifyVisitor(roomId, visitorId, 'messages:changed');
      }
    } catch (error) {
      console.error('seen (visitor) failed:', error.message);
    }
  });

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
  setupRealtime, notifyOwner, notifyVisitor, notifyAllVisitors, disconnectVisitor, isOwnerOnline, isVisitorOnline,
};

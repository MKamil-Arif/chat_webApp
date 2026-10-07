const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// A chat room owned by one person. The owner proves ownership with a secret
// key; only its SHA-256 hash is stored.
const DEFAULT_RELATIONS = ['Friend', 'Best Friend', 'Family', 'Classmate', 'Colleague', 'Crush 👀', 'Stranger', 'Other'];

const roomSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  ownerName: { type: String, required: true },
  prompt: { type: String, default: '' },
  ownerKeyHash: { type: String, required: true, unique: true },
  // Options visitors can pick from ("Aap inke kya lagte hain?").
  relations: { type: [String], default: () => [...DEFAULT_RELATIONS] },
  // Closed rooms accept no new visitors or messages.
  isOpen: { type: Boolean, default: true },
  // Mask bad words in visitor messages shown to the owner.
  filterProfanity: { type: Boolean, default: true },
  // Fingerprints of blocked visitors, so they can't come back via incognito.
  blockedFps: { type: [String], default: [] },
  // How many times the chat link was opened (once per browser session).
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// One visitor = one device inside one room. A visitor can change their
// name/relation as often as they like; every alias is kept in `aliases`.
const visitorSchema = new mongoose.Schema({
  room: { type: ObjectId, ref: 'Room', required: true },
  deviceHash: { type: String, required: true },
  fpHash: { type: String, default: '' },
  ipHash: { type: String, default: '' },
  name: { type: String, required: true },
  relation: { type: String, required: true },
  aliases: [{
    name: String,
    relation: String,
    at: { type: Date, default: Date.now },
    _id: false,
  }],
  // Visitors only see messages from their current alias onwards, so a new
  // name looks like a fresh start to them. The owner sees everything.
  sessionStart: { type: Date, default: Date.now },
  // Other visitors in this room that look like the same person on a
  // different device/browser (e.g. cleared storage or incognito).
  links: [{
    visitor: { type: ObjectId, ref: 'Visitor' },
    reason: { type: String, enum: ['fingerprint+ip', 'fingerprint'] },
    _id: false,
  }],
  blocked: { type: Boolean, default: false },
  lastMessageAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
visitorSchema.index({ room: 1, deviceHash: 1 }, { unique: true });
visitorSchema.index({ room: 1, fpHash: 1 });

const messageSchema = new mongoose.Schema({
  room: { type: ObjectId, ref: 'Room', required: true },
  visitor: { type: ObjectId, ref: 'Visitor', required: true },
  fromOwner: { type: Boolean, default: false },
  text: { type: String, required: true },
  // The visitor's alias at the time this message was sent.
  aliasName: String,
  aliasRelation: String,
  editedAt: { type: Date, default: null },
  // When the other side saw this message (✓✓).
  seenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
messageSchema.index({ room: 1, visitor: 1, createdAt: 1 });

// A browser that asked to receive push notifications for a room's owner.
const pushSubscriptionSchema = new mongoose.Schema({
  room: { type: ObjectId, ref: 'Room', required: true },
  endpoint: { type: String, required: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  createdAt: { type: Date, default: Date.now },
});
pushSubscriptionSchema.index({ room: 1, endpoint: 1 }, { unique: true });

module.exports = {
  DEFAULT_RELATIONS,
  Room: mongoose.model('Room', roomSchema),
  Visitor: mongoose.model('Visitor', visitorSchema),
  Message: mongoose.model('Message', messageSchema),
  PushSubscription: mongoose.model('PushSubscription', pushSubscriptionSchema),
};

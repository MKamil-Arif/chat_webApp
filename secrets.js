const crypto = require('crypto');
const mongoose = require('mongoose');
const webpush = require('web-push');

// App secrets: the salt for hashing IPs and the VAPID key pair for push
// notifications. Environment variables win when set. Otherwise the secrets
// are generated once and stored in the database, so a fresh deployment (e.g.
// Vercel with only MONGODB_URI) needs no extra setup and the values stay the
// same across restarts and serverless instances.
//
// Never change them after launch: a new IP salt breaks "same internet"
// matching, and new VAPID keys break every saved push subscription.

const AppSecret = mongoose.model('AppSecret', new mongoose.Schema({
  _id: String,
  ipSalt: String,
  vapidPublicKey: String,
  vapidPrivateKey: String,
}));

let cached = null;

async function loadFromDb() {
  const keys = webpush.generateVAPIDKeys();
  // $setOnInsert: if two instances start at once, the first write wins and
  // both read the same document back.
  return AppSecret.findOneAndUpdate(
    { _id: 'app' },
    {
      $setOnInsert: {
        ipSalt: crypto.randomBytes(32).toString('hex'),
        vapidPublicKey: keys.publicKey,
        vapidPrivateKey: keys.privateKey,
      },
    },
    { upsert: true, new: true }
  ).lean();
}

function getSecrets() {
  if (!cached) {
    cached = (async () => {
      const env = process.env;
      const needDb = !env.IP_SALT || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY;
      const stored = needDb ? await loadFromDb() : {};
      const usingEnvVapid = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
      return {
        ipSalt: env.IP_SALT || stored.ipSalt,
        vapidPublicKey: usingEnvVapid ? env.VAPID_PUBLIC_KEY : stored.vapidPublicKey,
        vapidPrivateKey: usingEnvVapid ? env.VAPID_PRIVATE_KEY : stored.vapidPrivateKey,
      };
    })().catch((error) => {
      cached = null; // retry on the next request
      throw error;
    });
  }
  return cached;
}

module.exports = { getSecrets };

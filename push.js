const webpush = require('web-push');
const { PushSubscription } = require('./models');
const { getSecrets } = require('./secrets');

// VAPID keys identify this server to browser push services (see secrets.js).
async function vapid() {
  const { vapidPublicKey, vapidPrivateKey } = await getSecrets();
  return {
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
  };
}

async function publicKey() {
  return (await vapid()).publicKey;
}

async function subscribe(roomId, subscription) {
  await PushSubscription.updateOne(
    { room: roomId, endpoint: subscription.endpoint },
    { $set: { keys: subscription.keys } },
    { upsert: true }
  );
}

async function unsubscribe(roomId, endpoint) {
  await PushSubscription.deleteOne({ room: roomId, endpoint });
}

// Send a notification to every browser subscribed to this room. Expired
// subscriptions (404/410 from the push service) are removed.
async function notifyRoom(roomId, payload) {
  const subscriptions = await PushSubscription.find({ room: roomId });
  if (subscriptions.length === 0) return;
  const vapidDetails = await vapid();
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24, vapidDetails }
      );
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
      } else {
        console.error('Push failed:', error.statusCode || error.code || error.message || error.name);
      }
    }
  }));
}

module.exports = { publicKey, subscribe, unsubscribe, notifyRoom };

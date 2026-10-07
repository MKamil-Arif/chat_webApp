const webpush = require('web-push');
const { PushSubscription } = require('./models');

// VAPID keys identify this server to browser push services. Generate them once
// with `npx web-push generate-vapid-keys` and keep them in the environment:
// if they change, every saved subscription stops working.
let publicKey = process.env.VAPID_PUBLIC_KEY;
let privateKey = process.env.VAPID_PRIVATE_KEY;
if (!publicKey || !privateKey) {
  ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
  console.warn('⚠️  VAPID keys are not set; using temporary ones. Push subscriptions will break on restart.');
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey, privateKey);

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
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 }
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

module.exports = { publicKey: () => publicKey, subscribe, unsubscribe, notifyRoom };

const { AdminNotification, DeviceToken, User } = require('../models');
const { getMessaging } = require('../config/firebase');

const audienceRoles = (audience) => (audience === 'admin' ? ['admin'] : ['admin', 'staff']);

// Which notifications a role may see.
const audiencesFor = (role) => (role === 'admin' ? ['admin', 'operations'] : ['operations']);

const asStrings = (data = {}) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));

/**
 * Records a notification for the team and sends a browser push to anyone who
 * enabled it. Never throws: a failure here must not break the customer's
 * request that triggered it.
 */
const notifyTeam = async ({ type, audience = 'operations', title, body, link = '/', data = {} }) => {
  try {
    const notification = await AdminNotification.create({ type, audience, title, body, link, data });

    const messaging = getMessaging();
    if (!messaging) return notification;

    const recipients = await User.find({ role: { $in: audienceRoles(audience) }, isActive: true }).select('_id').lean();
    const tokens = await DeviceToken.find({
      userId: { $in: recipients.map((u) => u._id) },
      platform: 'web',
      isActive: true,
    }).select('fcmToken').lean();
    if (tokens.length === 0) return notification;

    const response = await messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.fcmToken),
      notification: { title, body },
      data: { ...asStrings(data), type, link },
      webpush: { fcmOptions: { link } },
    });
    const dead = [];
    response.responses.forEach((r, i) => {
      if (!r.success && /registration-token-not-registered|invalid-registration-token/.test(r.error?.code || '')) {
        dead.push(tokens[i].fcmToken);
      }
    });
    if (dead.length) await DeviceToken.updateMany({ fcmToken: { $in: dead } }, { $set: { isActive: false } });
    return notification;
  } catch (error) {
    console.error('Failed to notify the team:', error);
    return null;
  }
};

module.exports = { notifyTeam, audiencesFor };

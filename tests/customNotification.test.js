const assert = require('assert');

// Admin "Custom Notification": every selected person gets it in their in-app
// inbox; phones get a push in batches of 500; only dead tokens are dropped.
//
//   CUSTOM_NOTIFY_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_custom_notify_test?replicaSet=rs0' node tests/customNotification.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.CUSTOM_NOTIFY_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set CUSTOM_NOTIFY_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: CUSTOM_NOTIFY_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => {
  for (;;) {
    const candidate = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(candidate) && new Set(candidate).size > 4) return candidate;
  }
};

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, DeviceToken, Notification } = require('../src/models');
  const notificationService = require('../src/services/notificationService');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const made = [];
  const makeUser = async (role) => {
    const user = await User.create({ name: `CN ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  // A fake Firebase: records batches; some tokens are dead, one is flaky.
  const batches = [];
  const fakeMessaging = {
    async sendEachForMulticast({ tokens }) {
      batches.push(tokens.length);
      const responses = tokens.map((token) => {
        if (token.startsWith('dead-')) return { success: false, error: { code: 'messaging/registration-token-not-registered' } };
        if (token.startsWith('flaky-')) return { success: false, error: { code: 'messaging/internal-error' } };
        return { success: true };
      });
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },
  };

  try {
    const admin = await makeUser('admin');
    const withPhones = await makeUser('buyer');
    const noPhone = await makeUser('wholesaler');

    // 1. Firebase not set up: still saved for everyone, and the admin is told.
    notificationService.messaging = null;
    let res = await call('POST', '/admin/customers/notifications', {
      token: admin.token,
      body: { userIds: [String(noPhone.user._id)], title: 'Hello', body: 'Only someone without a phone' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.saved, 1);
    assert.strictEqual(res.json.data.pushConfigured, false);
    assert.match(res.json.message, /not sent/i);
    assert.ok(await Notification.findOne({ userId: noPhone.user._id, title: 'Hello' }), 'saved in the inbox');

    // 2. Many phones: batches of at most 500, dead tokens dropped, flaky kept.
    const tokens = [
      ...Array.from({ length: 1100 }, (_, i) => `ok-${i}`),
      'dead-1',
      'flaky-1',
    ];
    await DeviceToken.insertMany(tokens.map((fcmToken) => ({ userId: withPhones.user._id, fcmToken, isActive: true, platform: 'android' })));
    notificationService.messaging = fakeMessaging;
    res = await call('POST', '/admin/customers/notifications', {
      token: admin.token,
      body: { userIds: [String(withPhones.user._id), String(noPhone.user._id)], title: 'Sale', body: 'Big sale today' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.ok(batches.every((size) => size <= 500), `batches ${batches}`);
    assert.strictEqual(batches.reduce((a, b) => a + b, 0), 1102);
    assert.strictEqual(res.json.data.saved, 2);
    assert.strictEqual(res.json.data.phones, 1102);
    assert.strictEqual(res.json.data.delivered, 1100);
    assert.strictEqual(res.json.data.failed, 2);
    assert.match(res.json.message, /Saved for 2 people/);
    assert.match(res.json.message, /1100 of 1102 phones/);
    assert.strictEqual((await DeviceToken.findOne({ fcmToken: 'dead-1' })).isActive, false, 'dead token switched off');
    assert.strictEqual((await DeviceToken.findOne({ fcmToken: 'flaky-1' })).isActive, true, 'temporary error keeps the token');
    assert.strictEqual(await Notification.countDocuments({ title: 'Sale' }), 2);

    // 3. Unknown ids are ignored; nobody valid → a clear error.
    res = await call('POST', '/admin/customers/notifications', {
      token: admin.token,
      body: { userIds: [String(new mongoose.Types.ObjectId())], title: 'X', body: 'Y' },
    });
    assert.strictEqual(res.status, 400);

    console.log('customNotification.test.js: all checks passed');
  } finally {
    notificationService.messaging = null;
    await Promise.all([
      DeviceToken.deleteMany({ userId: { $in: made } }),
      Notification.deleteMany({ userId: { $in: made } }),
      User.deleteMany({ _id: { $in: made } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

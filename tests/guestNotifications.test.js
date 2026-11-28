const assert = require('assert');

// Custom notifications to phones that aren't signed in ("guests"): the public
// guest-token route, signing in taking the phone off the list, the count and
// "installed in the last N days" filter, links allowed for these phones,
// English/Hindi per phone, uninstalled phones removed, and the History row.
//
//   GUEST_NOTIFY_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_guest_notify_test?replicaSet=rs0' node tests/guestNotifications.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.GUEST_DEVICE_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.GUEST_NOTIFY_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set GUEST_NOTIFY_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: GUEST_NOTIFY_TEST_MONGODB_URI must point at a database on this machine');
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
  const {
    User, DeviceToken, GuestDevice, Notification, NotificationCampaign,
  } = require('../src/models');
  const notificationService = require('../src/services/notificationService');

  await connectDB();
  await GuestDevice.init();
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
  const code = (res) => res.json.error?.code || res.json.code;
  const suffix = Date.now().toString(36);
  const tok = (name) => `guest${name}${suffix}:APA91b_abcdefghijklmnop`;
  const madeUsers = [];
  const makeUser = async (role) => {
    const user = await User.create({ name: `Guest test ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    madeUsers.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  let multicasts = [];
  let eachCalls = [];
  notificationService.messaging = {
    async sendEachForMulticast(message) {
      multicasts.push(message);
      const responses = message.tokens.map((t) => (t.includes('dead')
        ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : { success: true }));
      return { responses, successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length };
    },
    async sendEach(messages) {
      eachCalls.push(messages);
      return { responses: messages.map(() => ({ success: true })), successCount: messages.length, failureCount: 0 };
    },
  };

  try {
    await GuestDevice.deleteMany({});
    const admin = await makeUser('admin');
    const join = (body) => call('POST', '/notifications/guest-token', { body });

    // 1. The public route: no sign-in, checks what it's given.
    let res = await join({ fcmToken: tok('a'), platform: 'android', language: 'en', appVersion: '1.2.34+37' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await join({ fcmToken: tok('hi'), language: 'hi' });
    assert.strictEqual(res.status, 200);
    res = await join({ fcmToken: 'short' });
    assert.strictEqual(res.status, 400, 'a too-short token is refused');
    res = await join({ fcmToken: `${tok('x')}<script>` });
    assert.strictEqual(res.status, 400, 'odd characters are refused');
    res = await join({ fcmToken: tok('a'), language: 'fr' });
    assert.strictEqual(res.status, 400, 'only en or hi');
    // Joining again only refreshes it.
    res = await join({ fcmToken: tok('a'), language: 'hi' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await GuestDevice.countDocuments({ fcmToken: tok('a') }), 1);
    assert.strictEqual((await GuestDevice.findOne({ fcmToken: tok('a') })).language, 'hi');
    await join({ fcmToken: tok('a'), language: 'en' });
    console.log('ok - phones join the list without an account');

    // 2. Signing in takes the phone off the list.
    const buyer = await makeUser('buyer');
    await join({ fcmToken: tok('signin') });
    res = await call('POST', '/notifications/register-token', { token: buyer.token, body: { fcmToken: tok('signin'), platform: 'android' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await GuestDevice.countDocuments({ fcmToken: tok('signin') }), 0);
    // A late not-signed-in report from a signed-in phone is not counted or sent to.
    await join({ fcmToken: tok('signin') });
    console.log('ok - signing in takes the phone off the list');

    // A query object instead of a token is refused (it would have switched
    // off every other account's pushes and emptied this list).
    const other = await makeUser('buyer');
    await DeviceToken.create({ userId: other.user._id, fcmToken: tok('other'), platform: 'android' });
    for (const path of ['/notifications/register-token', '/notifications/unregister-token']) {
      res = await call('POST', path, { token: buyer.token, body: { fcmToken: { $exists: true } } });
      assert.strictEqual(res.status, 400, path);
    }
    assert.strictEqual((await DeviceToken.findOne({ fcmToken: tok('other') })).isActive, true, 'other accounts untouched');
    assert.strictEqual(await GuestDevice.countDocuments({ fcmToken: tok('a') }), 1, 'the list is untouched');
    console.log('ok - a query object is not accepted as a token');

    // 3. Count, with Hindi phones and the install filter.
    const count = (body) => call('POST', '/admin/customers/notifications/count', { token: admin.token, body });
    await GuestDevice.create({ fcmToken: tok('old'), createdAt: new Date(Date.now() - 20 * 86400000), lastSeenAt: new Date() });
    res = await count({ audience: 'guests' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual([res.json.data.phones, res.json.data.hindi], [3, 1], JSON.stringify(res.json.data));
    res = await count({ audience: 'guests', installedWithinDays: 7 });
    assert.strictEqual(res.json.data.phones, 2);
    res = await count({ audience: 'guests', installedWithinDays: 30 });
    assert.strictEqual(res.json.data.phones, 3);
    res = await count({ audience: 'guests', installedWithinDays: 5 });
    assert.strictEqual(res.status, 400, 'only 7 or 30 days');
    console.log('ok - the count leaves out signed-in phones and filters by install');

    // 4. Links: only pages that work without an account; Create account only here.
    const send = (body) => call('POST', '/admin/customers/notifications', { token: admin.token, body: { audience: 'guests', title: 'Welcome {name}', body: 'Hello', ...body } });
    for (const page of ['cart', 'wishlist', 'orders', 'wholesaler', 'negotiations']) {
      res = await send({ link: { type: 'page', page } });
      assert.strictEqual(res.status, 400, page);
      assert.strictEqual(code(res), 'PAGE_NEEDS_ACCOUNT', page);
    }
    res = await call('POST', '/admin/customers/notifications', {
      token: admin.token, body: { audience: 'buyers', title: 'x', body: 'y', link: { type: 'page', page: 'signup' } },
    });
    assert.strictEqual(code(res), 'PAGE_NOT_FOR_AUDIENCE', 'Create account is not for accounts');
    assert.strictEqual(await NotificationCampaign.countDocuments({ audience: 'guests' }), 0, 'nothing sent yet');
    console.log('ok - only pages that work without an account');

    // 5. One message for all ({name} → "there"); no inbox rows.
    multicasts = [];
    const inboxBefore = await Notification.countDocuments({});
    res = await send({ link: { type: 'page', page: 'signup' }, installedWithinDays: 30, sendId: `guest-${suffix}-1` });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(multicasts.length, 1);
    assert.strictEqual(multicasts[0].tokens.length, 3);
    assert.ok(!multicasts[0].tokens.includes(tok('signin')), 'the signed-in phone is left out');
    assert.strictEqual(multicasts[0].notification.title, 'Welcome there');
    assert.deepStrictEqual([multicasts[0].data.link, multicasts[0].data.page], ['page', 'signup']);
    assert.strictEqual(await Notification.countDocuments({}), inboxBefore, 'no inbox rows');
    const row = await NotificationCampaign.findOne({ sendId: `guest-${suffix}-1` }).lean();
    assert.deepStrictEqual(
      [row.audience, row.installedWithinDays, row.recipients, row.phones, row.delivered, row.status],
      ['guests', 30, 3, 3, 3, 'sent']
    );
    res = await send({ sendId: `guest-${suffix}-1` });
    assert.strictEqual(res.status, 409, 'the same send is never sent twice');
    console.log('ok - sent to every phone that is not signed in');

    // 6. With Hindi: each phone in its language.
    eachCalls = [];
    res = await send({ titleHi: 'नमस्ते {name}', bodyHi: 'खाता बनाएँ', link: null });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const sent = Object.fromEntries(eachCalls.flat().map((m) => [m.token, m.notification.title]));
    assert.strictEqual(sent[tok('hi')], 'नमस्ते जी');
    assert.strictEqual(sent[tok('a')], 'Welcome there');
    console.log('ok - Hindi phones get the Hindi text');

    // 7. An uninstalled phone leaves the list.
    await join({ fcmToken: tok('dead') });
    multicasts = [];
    res = await send({ installedWithinDays: 7 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await GuestDevice.countDocuments({ fcmToken: tok('dead') }), 0);
    console.log('ok - uninstalled phones are removed');

    // 8. Nobody to send to.
    await GuestDevice.deleteMany({});
    res = await send({});
    assert.strictEqual(code(res), 'NO_RECIPIENTS');
    console.log('ok - an empty list is reported');

    console.log('guestNotifications.test.js: all checks passed');
  } finally {
    await GuestDevice.deleteMany({});
    await NotificationCampaign.deleteMany({ audience: 'guests' });
    await DeviceToken.deleteMany({ userId: { $in: madeUsers } });
    await User.deleteMany({ _id: { $in: madeUsers } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

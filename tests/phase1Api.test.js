const assert = require('assert');

// Phase 1 API behaviour against a real (local) database: forced-update
// settings, terms acceptance, language preference, push-token ownership and
// localized notifications. Only runs against a database on this machine:
//
//   PHASE1_TEST_MONGODB_URI=mongodb://127.0.0.1:27231/oxon_phase1_test node tests/phase1Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '10000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.REQUIRE_TERMS_ACCEPTANCE;

const uri = process.env.PHASE1_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE1_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE1_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, DeviceToken, Notification, Settings } = require('../src/models');
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
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
  };

  const created = { users: [] };
  try {
    // --- Forced update settings -------------------------------------------
    await Settings.deleteOne({ _id: 'app_settings' });
    let res = await call('GET', '/settings/mobile-app');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.strictEqual(res.json.data.android.enabled, false);
    assert.strictEqual(res.json.data.ios.latestBuildNumber, 0);

    const admin = await User.create({ name: 'Phase1 Admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    created.users.push(admin._id);
    const adminToken = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    res = await call('PUT', '/admin/settings', { token: adminToken, body: { mobileApp: { android: { enabled: true, latestVersion: '1.2.0', latestBuildNumber: 7, storeUrl: 'https://play.google.com/store/apps/details?id=com.veepeeimpex.oxon', title: 'Update', message: 'Please update' } } } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('GET', '/settings/mobile-app');
    assert.strictEqual(res.json.data.android.enabled, true);
    assert.strictEqual(res.json.data.android.latestBuildNumber, 7);
    assert.strictEqual(res.json.data.android.title, 'Update');

    res = await call('PUT', '/admin/settings', { token: adminToken, body: { mobileApp: { android: { storeUrl: 'https://evil.example.com/app' } } } });
    assert.strictEqual(res.status, 400, 'a non-store link must be rejected');
    res = await call('GET', '/settings/mobile-app');
    assert.strictEqual(res.json.data.android.storeUrl.startsWith('https://play.google.com/'), true);

    // --- Terms acceptance --------------------------------------------------
    const phoneA = randomPhone();
    res = await call('POST', '/auth/register-phone', { body: { name: 'Asha', phone: phoneA, password: 'secret1', termsAccepted: true, privacyPolicyAccepted: true, termsVersion: '2026-10-12', privacyPolicyVersion: '2026-10-12' } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const userA = await User.findOne({ phone: phoneA });
    created.users.push(userA._id);
    assert.ok(userA.termsAcceptedAt && userA.privacyAcceptedAt, 'acceptance time stored');
    assert.strictEqual(userA.termsAcceptedVersion, '2026-10-12');
    assert.strictEqual(userA.preferredLanguage, 'en');
    const tokenA = res.json.data.accessToken;
    const refreshA = res.json.data.refreshToken;

    // An older app that sends nothing can still sign up (not required yet)...
    const phoneOld = randomPhone();
    res = await call('POST', '/auth/register-phone', { body: { name: 'Old App', phone: phoneOld, password: 'secret1' } });
    assert.strictEqual(res.status, 201);
    const userOld = await User.findOne({ phone: phoneOld });
    created.users.push(userOld._id);
    assert.strictEqual(userOld.termsAcceptedAt, null);

    // ...until acceptance is made mandatory.
    process.env.REQUIRE_TERMS_ACCEPTANCE = 'true';
    res = await call('POST', '/auth/register-phone', { body: { name: 'No Terms', phone: randomPhone(), password: 'secret1' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code, 'TERMS_NOT_ACCEPTED');
    res = await call('POST', '/auth/register-phone/wholesaler', { body: { name: 'W', phone: randomPhone(), password: 'secret1', termsAccepted: true } });
    assert.strictEqual(res.status, 400, 'privacy acceptance is also required');
    delete process.env.REQUIRE_TERMS_ACCEPTANCE;

    // --- Language preference ----------------------------------------------
    res = await call('PUT', '/auth/preferences', { token: tokenA, body: { language: 'hi' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await User.findById(userA._id)).preferredLanguage, 'hi');
    res = await call('PUT', '/auth/preferences', { token: tokenA, body: { language: 'fr' } });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/auth/preferences', { body: { language: 'hi' } });
    assert.strictEqual(res.status, 401);

    // --- Localized notification --------------------------------------------
    await notificationService.sendOrderStatusUpdate(userA._id, new mongoose.Types.ObjectId(), 'shipped');
    const stored = await Notification.findOne({ userId: userA._id }).sort({ createdAt: -1 });
    assert.strictEqual(stored.title, 'ऑर्डर भेज दिया गया!');
    assert.strictEqual(stored.type, 'order_update');
    await call('PUT', '/auth/preferences', { token: tokenA, body: { language: 'en' } });
    await notificationService.sendOrderStatusUpdate(userA._id, new mongoose.Types.ObjectId(), 'shipped');
    const storedEn = await Notification.findOne({ userId: userA._id }).sort({ createdAt: -1 });
    assert.strictEqual(storedEn.title, 'Order Shipped!');

    // --- Push token ownership and logout -----------------------------------
    const phoneB = randomPhone();
    res = await call('POST', '/auth/register-phone', { body: { name: 'Bala', phone: phoneB, password: 'secret1' } });
    const userB = await User.findOne({ phone: phoneB });
    created.users.push(userB._id);
    const tokenB = res.json.data.accessToken;
    const refreshB = res.json.data.refreshToken;

    const device = `device-token-${Date.now()}`;
    res = await call('POST', '/notifications/register-token', { token: tokenA, body: { fcmToken: device, platform: 'android' } });
    assert.strictEqual(res.status, 200);
    res = await call('POST', '/notifications/register-token', { token: tokenB, body: { fcmToken: device, platform: 'android' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await DeviceToken.findOne({ userId: userA._id, fcmToken: device })).isActive, false, 'previous owner stops receiving');
    assert.strictEqual((await DeviceToken.findOne({ userId: userB._id, fcmToken: device })).isActive, true);

    res = await call('POST', '/auth/logout', { token: tokenB, body: { refreshToken: refreshB, fcmToken: device } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await DeviceToken.findOne({ userId: userB._id, fcmToken: device })).isActive, false, 'logout deactivates this device');

    // Old clients that call logout with only a refresh token still work.
    res = await call('POST', '/auth/logout', { token: tokenA, body: { refreshToken: refreshA } });
    assert.strictEqual(res.status, 200);

    console.log('phase1 api tests passed');
  } finally {
    await User.deleteMany({ _id: { $in: created.users } });
    await DeviceToken.deleteMany({ userId: { $in: created.users } });
    await Notification.deleteMany({ userId: { $in: created.users } });
    await Settings.deleteOne({ _id: 'app_settings' });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

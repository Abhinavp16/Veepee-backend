const assert = require('assert');

// The Razorpay gateway is removed: its routes are gone, the app is told it's
// off, and old keys in the database are never sent or saved.
//
//   RAZORPAY_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_razorpay_test?replicaSet=rs0' node tests/razorpayRemoved.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_leftover';
process.env.RAZORPAY_KEY_SECRET = 'leftover-secret';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.RAZORPAY_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set RAZORPAY_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: RAZORPAY_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Settings } = require('../src/models');

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
    const user = await User.create({ name: `Rzp ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.push(user._id);
    return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  };
  const settingsCollection = mongoose.connection.collection('settings');

  try {
    await Settings.getSettings();
    const saved = await settingsCollection.findOne({ _id: 'app_settings' });
    // Old keys left in the database from before.
    await settingsCollection.updateOne({ _id: 'app_settings' }, { $set: { razorpayEnabled: true, razorpayKeyId: 'rzp_live_old', razorpayKeySecret: 'old-secret' } });
    const buyer = await makeUser('buyer');
    const admin = await makeUser('admin');

    // 1. The routes are gone, even with keys in the environment.
    const orderId = String(new mongoose.Types.ObjectId());
    let res = await call('POST', '/razorpay/verify', {
      token: buyer,
      body: { orderId, razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'sig' },
    });
    assert.strictEqual(res.status, 404, 'verify is gone');
    res = await call('POST', '/razorpay/create-order', { token: buyer, body: { orderId } });
    assert.strictEqual(res.status, 404, 'create-order is gone');
    res = await call('GET', '/razorpay/key');
    assert.strictEqual(res.status, 404, 'key is gone');

    // 2. The app is told online payment is off.
    res = await call('GET', '/settings/payment-options');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.razorpayEnabled, false);
    assert.strictEqual(res.json.data.razorpayKeyId, null);

    // 3. Admin settings never send or save the old keys.
    res = await call('GET', '/admin/settings', { token: admin });
    assert.strictEqual(res.status, 200);
    for (const key of ['razorpayKeyId', 'razorpayKeySecret', 'razorpayEnabled']) {
      assert.ok(!(key in res.json.data), `GET leaves out ${key}`);
    }
    res = await call('PUT', '/admin/settings', { token: admin, body: { razorpayKeyId: 'rzp_live_new', razorpayEnabled: true } });
    assert.ok(res.status === 200 || res.status === 400, `status ${res.status}`);
    assert.ok(!('razorpayKeySecret' in (res.json.data || {})), 'PUT leaves out the secret');
    const after = await settingsCollection.findOne({ _id: 'app_settings' });
    assert.strictEqual(after.razorpayKeyId, 'rzp_live_old', 'new keys are not saved');

    await settingsCollection.replaceOne({ _id: 'app_settings' }, saved);
    console.log('razorpayRemoved.test.js: all checks passed');
  } finally {
    await User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

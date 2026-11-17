const assert = require('assert');

// Admin panel "What's new": each staff member's seen features are kept on
// their account, so the highlights clear on every device.
//
//   WHATS_NEW_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_whats_new_test?replicaSet=rs0' node tests/whatsNew.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.WHATS_NEW_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set WHATS_NEW_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: WHATS_NEW_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const made = [];
  const makeUser = async (role) => {
    const user = await User.create({ name: `WN ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');

    // 1. Nothing seen yet.
    let res = await call('GET', '/admin/whats-new/seen', admin.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json, { success: true, data: { ids: [] } });
    console.log('ok - a new account has seen nothing');

    // 2. Admin and staff can each save and read their own.
    res = await call('POST', '/admin/whats-new/seen', admin.token, { ids: ['product-templates'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.ids, ['product-templates']);
    res = await call('POST', '/admin/whats-new/seen', staff.token, { ids: ['notification-link-picture'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('GET', '/admin/whats-new/seen', staff.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.ids, ['notification-link-picture']);
    console.log('ok - admin and staff save and read their own');

    // 3. One person's seen list doesn't change another's.
    res = await call('GET', '/admin/whats-new/seen', admin.token);
    assert.deepStrictEqual(res.json.data.ids, ['product-templates']);
    console.log("ok - one person's seen list doesn't affect another's");

    // 4. Saving the same id again doesn't store it twice.
    res = await call('POST', '/admin/whats-new/seen', admin.token, { ids: ['product-templates', 'notification-link-picture', 'product-templates'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.ids, ['product-templates', 'notification-link-picture']);
    const stored = await User.findById(admin.user._id).select('seenFeatures').lean();
    assert.deepStrictEqual(stored.seenFeatures, ['product-templates', 'notification-link-picture']);
    console.log('ok - duplicates are stored once');

    // 5. Customers and wholesalers are refused; signed-out is refused.
    for (const person of [buyer, wholesaler]) {
      res = await call('GET', '/admin/whats-new/seen', person.token);
      assert.strictEqual(res.status, 403, JSON.stringify(res.json));
      res = await call('POST', '/admin/whats-new/seen', person.token, { ids: ['product-templates'] });
      assert.strictEqual(res.status, 403, JSON.stringify(res.json));
    }
    res = await call('GET', '/admin/whats-new/seen');
    assert.strictEqual(res.status, 401, JSON.stringify(res.json));
    assert.deepStrictEqual((await User.findById(buyer.user._id).select('seenFeatures').lean()).seenFeatures, []);
    console.log('ok - customers get 403, signed-out gets 401');

    // 6. Bad ids are refused.
    const bad = [
      {},
      { ids: [] },
      { ids: 'product-templates' },
      { ids: ['Product-Templates'] },
      { ids: ['-leading-dash'] },
      { ids: ['has space'] },
      { ids: ['a'.repeat(65)] },
      { ids: [''] },
      { ids: [42] },
      { ids: ['$where'] },
      { ids: Array.from({ length: 51 }, (_, i) => `f${i}`) },
    ];
    for (const body of bad) {
      res = await call('POST', '/admin/whats-new/seen', staff.token, body);
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
    }
    res = await call('GET', '/admin/whats-new/seen', staff.token);
    assert.deepStrictEqual(res.json.data.ids, ['notification-link-picture']);
    console.log('ok - bad ids get 400 and change nothing');

    // 7. At most 200 kept; the oldest go first.
    for (let batch = 0; batch < 5; batch += 1) {
      const ids = Array.from({ length: 50 }, (_, i) => `bulk-${batch}-${i}`);
      res = await call('POST', '/admin/whats-new/seen', staff.token, { ids });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    }
    assert.strictEqual(res.json.data.ids.length, 200);
    assert.ok(!res.json.data.ids.includes('notification-link-picture'), 'oldest trimmed');
    assert.ok(!res.json.data.ids.includes('bulk-0-0'), 'oldest trimmed');
    assert.ok(res.json.data.ids.includes('bulk-4-49'), 'newest kept');
    console.log('ok - only the newest 200 are kept');

    console.log('whatsNew.test.js: all checks passed');
  } finally {
    await User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

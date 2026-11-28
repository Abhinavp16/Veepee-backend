const assert = require('assert');

// Admin panel downloads: wholesaler proof photos (administrators only) and an
// order's payment screenshots, with clear file names. Without storage
// credentials (here) the links can't be signed: they come back as stored and
// signed is false.
//
//   DOWNLOADS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_downloads_test?replicaSet=rs0' node tests/fileDownloads.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.DOWNLOADS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set DOWNLOADS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: DOWNLOADS_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Order, Payment } = require('../src/models');
  const { storedObject, fileSlug, safeFileName } = require('../src/services/fileDownloads');

  // Only our storage, only the given folder.
  assert.deepStrictEqual(storedObject('https://storage.googleapis.com/b/proofs/u/1.webp', 'proofs/'), { bucket: 'b', path: 'proofs/u/1.webp' });
  assert.strictEqual(storedObject('https://storage.googleapis.com/b/payments/1.jpg', 'proofs/'), null);
  assert.strictEqual(storedObject('https://evil.example/b/proofs/1.webp', 'proofs/'), null);
  assert.strictEqual(storedObject('https://storage.googleapis.com/b/proofs/../x', 'proofs/'), null);
  assert.strictEqual(fileSlug('Sharma Traders & Sons!'), 'sharma-traders-sons');
  assert.strictEqual(fileSlug('शर्मा', 'customer'), 'customer');
  assert.strictEqual(safeFileName('a"; filename*=x.html\r\n.webp'), 'afilenamex.html.webp', 'nothing that could change the header');
  console.log('ok - only our own stored files, safe file names');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const made = { users: [], orders: [], payments: [] };
  const makeUser = async (role, extra = {}) => {
    const user = await User.create({ name: `Download ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return user;
  };
  const get = async (path, user) => {
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer', {
      businessInfo: {
        businessName: 'Sharma Traders',
        status: 'pending',
        proofImages: [
          'https://storage.googleapis.com/test-bucket/proofs/u1/a.webp',
          'https://storage.googleapis.com/test-bucket/proofs/u1/b.webp',
        ],
      },
    });

    // 1. Proof photos: administrators only.
    assert.strictEqual((await get(`/admin/customers/${buyer._id}/proofs/download`, staff)).status, 403);
    let res = await get(`/admin/customers/${buyer._id}/proofs/download`, admin);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(
      res.json.data.files.map((f) => f.name),
      [`sharma-traders-${buyer.phone}-proof-1.webp`, `sharma-traders-${buyer.phone}-proof-2.webp`]
    );
    assert.strictEqual(res.json.data.signed, false, 'no storage credentials here');
    assert.strictEqual(res.json.data.files[0].url, buyer.businessInfo.proofImages[0]);
    assert.ok(res.json.data.files.every((f) => f.signed === false), 'each file says whether it is signed');
    assert.strictEqual((await get(`/admin/customers/${admin._id}/proofs/download`, admin)).status, 404, 'not a customer');
    // A phone typed with odd characters never reaches the file name.
    await User.updateOne({ _id: buyer._id }, { $set: { phone: '98123"; filename*=x.html' } });
    res = await get(`/admin/customers/${buyer._id}/proofs/download`, admin);
    assert.strictEqual(res.json.data.files[0].name, 'sharma-traders-98123-proof-1.webp');
    console.log('ok - proof photos download with clear names (administrators only)');

    // 2. Payment screenshots: current and rejected ones, for the team.
    const orderId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, orderNumber: 'OX-DL-1' });
    made.orders.push(orderId);
    const paymentId = new mongoose.Types.ObjectId();
    await Payment.collection.insertOne({
      _id: paymentId,
      orderId,
      status: 'pending',
      screenshotUrl: 'https://storage.googleapis.com/test-bucket/payments/OX_new.png',
      previousAttempts: [{ screenshotUrl: 'https://storage.googleapis.com/test-bucket/payments/OX_old.jpg' }],
    });
    made.payments.push(paymentId);
    res = await get(`/admin/orders/${orderId}/payment-screenshots/download`, staff);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(
      res.json.data.files.map((f) => [f.name, f.label]),
      [['order-OX-DL-1-payment-rejected-1.jpg', 'rejected-1'], ['order-OX-DL-1-payment.png', 'current']]
    );
    assert.strictEqual((await get(`/admin/orders/${new mongoose.Types.ObjectId()}/payment-screenshots/download`, admin)).status, 404);
    assert.strictEqual((await get(`/admin/orders/${orderId}/payment-screenshots/download`, buyer)).status, 403, 'not for customers');
    console.log('ok - payment screenshots download, current and rejected');

    console.log('fileDownloads.test.js: all checks passed');
  } finally {
    await Payment.deleteMany({ _id: { $in: made.payments } });
    await Order.deleteMany({ _id: { $in: made.orders } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

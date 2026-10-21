const assert = require('assert');

// A rejected payment screenshot can be replaced: the customer sees why it was
// rejected, uploads a new one, and the team still sees the rejected one.
//
//   REUPLOAD_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_reupload_test?replicaSet=rs0' node tests/paymentReupload.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.REUPLOAD_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set REUPLOAD_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: REUPLOAD_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => {
  for (;;) {
    const candidate = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(candidate) && new Set(candidate).size > 4) return candidate;
  }
};

// No Firebase in tests: uploads go to a stand-in bucket.
const { Writable } = require('stream');
const firebase = require('../src/config/firebase');
const uploaded = [];
firebase.getStorage = () => ({
  name: 'test-bucket',
  file: (name) => ({
    createWriteStream: () => new Writable({
      write(chunk, encoding, done) { done(); },
      final(done) { uploaded.push(name); done(); },
    }),
    makePublic: async () => {},
  }),
});

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, Product, Cart, Order, Payment, Notification, StockLog } = require('../src/models');

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
  const upload = async (orderId, token) => {
    const form = new FormData();
    form.append('screenshot', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'proof.jpg');
    const res = await fetch(`${base}/payments/${orderId}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const made = { users: [], products: [], orders: [] };
  const makeUser = async (role) => {
    const user = await User.create({ name: `Reupload ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const suffix = Date.now().toString(36);
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const other = await makeUser('buyer');
    const product = await Product.create({
      name: `Reupload Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `RUP-${suffix}`, stock: 10, status: 'active',
    });
    made.products.push(product._id);

    let res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 2 }], shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const orderId = res.json.data.orderId;
    made.orders.push(orderId);
    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: admin.token, body: { deliveryCharge: 100 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));

    // 1. First screenshot, then the team rejects it.
    res = await upload(orderId, buyer.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await upload(orderId, buyer.token);
    assert.strictEqual(res.status, 400, 'no second upload while waiting');
    const payment = await Payment.findOne({ orderId });
    const firstScreenshot = payment.screenshotUrl;
    res = await call('PUT', `/admin/payments/${payment._id}/reject`, { token: admin.token, body: { reason: 'Amount does not match' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));

    // 2. The customer sees why.
    res = await call('GET', `/payments/${orderId}`, { token: buyer.token });
    assert.strictEqual(res.json.data.status, 'rejected');
    assert.strictEqual(res.json.data.rejectionReason, 'Amount does not match');

    // 3. Nobody else can upload for this order; the customer can.
    res = await upload(orderId, other.token);
    assert.strictEqual(res.status, 404);
    res = await upload(orderId, buyer.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.status, 'pending');

    // 4. The rejected screenshot is kept for the team.
    let saved = await Payment.findOne({ orderId }).lean();
    assert.notStrictEqual(saved.screenshotUrl, firstScreenshot, 'the new screenshot is current');
    assert.strictEqual(saved.status, 'pending');
    assert.strictEqual(saved.rejectionReason, null);
    assert.strictEqual(saved.verifiedBy, null);
    assert.strictEqual(saved.previousAttempts.length, 1);
    assert.strictEqual(saved.previousAttempts[0].screenshotUrl, firstScreenshot);
    assert.strictEqual(saved.previousAttempts[0].rejectionReason, 'Amount does not match');
    assert.strictEqual(String(saved.previousAttempts[0].rejectedBy), String(admin.user._id));
    let order = await Order.findById(orderId).lean();
    assert.strictEqual(order.status, 'payment_uploaded');
    assert.ok(order.statusHistory.at(-1).note.includes('after rejection'));
    assert.strictEqual(uploaded.length, 2);
    res = await call('GET', `/admin/orders/${orderId}`, { token: admin.token });
    assert.strictEqual(res.json.data.payment.previousAttempts.length, 1, 'the admin sees the earlier screenshot');

    // 5. Still only one upload while waiting; then the team verifies it.
    res = await upload(orderId, buyer.token);
    assert.strictEqual(res.status, 400);
    res = await call('PUT', `/admin/payments/${saved._id}/verify`, { token: admin.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    order = await Order.findById(orderId).lean();
    assert.strictEqual(order.status, 'processing');
    assert.strictEqual((await Product.findById(product._id).lean()).stock, 8, 'stock deducted once');
    res = await upload(orderId, buyer.token);
    assert.strictEqual(res.status, 400, 'no upload after verification');

    console.log('paymentReupload.test.js: all checks passed');
  } finally {
    await Promise.all([
      Order.deleteMany({ _id: { $in: made.orders } }),
      Payment.deleteMany({ orderId: { $in: made.orders } }),
      StockLog.deleteMany({ orderId: { $in: made.orders } }),
      Notification.deleteMany({ userId: { $in: made.users } }),
      Cart.deleteMany({ userId: { $in: made.users } }),
      User.deleteMany({ _id: { $in: made.users } }),
      Product.deleteMany({ _id: { $in: made.products } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

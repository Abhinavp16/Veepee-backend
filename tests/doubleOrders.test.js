const assert = require('assert');

// One checkout makes one order: repeated or simultaneous requests (double
// tap, Back and tap again, retries) get the same order back.
//
//   DOUBLE_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_double_test?replicaSet=rs0' node tests/doubleOrders.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.DOUBLE_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set DOUBLE_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: DOUBLE_TEST_MONGODB_URI must point at a database on this machine');
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
  const crypto = require('crypto');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, Product, Cart, Order, Payment, Negotiation, Notification } = require('../src/models');

  await connectDB();
  await Order.syncIndexes();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const made = { users: [], products: [] };
  const suffix = Date.now().toString(36);
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };
  const makeUser = async (role) => {
    const user = await User.create({ name: `Double ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const post = async (path, token, body, key) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(key && { 'Idempotency-Key': key }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');
    const product = await Product.create({
      name: `Double Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `DBL-${suffix}`, stock: 50, status: 'active',
    });
    made.products.push(product._id);
    const buyNow = { items: [{ productId: String(product._id), quantity: 1 }], shippingAddress: address };

    // 1. Buy Now tapped three times at once with one checkout key: one order.
    const key = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => post('/orders', buyer.token, buyNow, key)));
    for (const res of results) assert.ok([200, 201].includes(res.status), JSON.stringify(res.json));
    const ids = new Set(results.map((res) => String(res.json.data.orderId)));
    assert.strictEqual(ids.size, 1, 'every tap gets the same order');
    assert.strictEqual(results.filter((res) => res.status === 201).length, 1, 'only one was created');
    assert.strictEqual(await Order.countDocuments({ userId: buyer.user._id }), 1);
    assert.strictEqual(await Payment.countDocuments({ userId: buyer.user._id }), 1);

    // 2. Back and tap again later with the same key: still that order.
    let res = await post('/orders', buyer.token, buyNow, key);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(String(res.json.data.orderId), [...ids][0]);
    assert.ok(res.json.data.orderNumber);

    // 3. A new checkout (new key) is a new order; old apps without a key still work.
    res = await post('/orders', buyer.token, buyNow, crypto.randomUUID());
    assert.strictEqual(res.status, 201);
    res = await post('/orders', buyer.token, buyNow);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(await Order.countDocuments({ userId: buyer.user._id }), 3);

    // 4. Keys belong to one customer: someone else's key makes their own order.
    const other = await makeUser('buyer');
    res = await post('/orders', other.token, buyNow, key);
    assert.strictEqual(res.status, 201);
    assert.notStrictEqual(String(res.json.data.orderId), [...ids][0]);

    // 5. An accepted negotiation paid twice at once: one order.
    const negotiation = await Negotiation.create({
      wholesalerId: wholesaler.user._id, productId: product._id,
      productSnapshot: { name: product.name, price: 800 },
      requestedQuantity: 5, requestedPricePerUnit: 700, requestedTotalPrice: 3500,
      status: 'accepted', finalPricePerUnit: 700, finalTotalPrice: 3500,
      expiresAt: new Date(Date.now() + 86400000),
    });
    const both = await Promise.all([1, 2].map(() => post('/orders/from-negotiation', wholesaler.token, { negotiationId: String(negotiation._id), shippingAddress: address })));
    const okOnes = both.filter((r) => r.status === 201);
    assert.strictEqual(okOnes.length, 1, JSON.stringify(both.map((r) => [r.status, r.json.error?.code || r.json.message])));
    const loser = both.find((r) => r.status !== 201);
    assert.ok(loser.status === 409 || loser.status === 200, `the other tap: ${loser.status}`);
    assert.strictEqual(await Order.countDocuments({ userId: wholesaler.user._id }), 1);
    const converted = await Negotiation.findById(negotiation._id).lean();
    assert.strictEqual(converted.status, 'converted');
    assert.strictEqual(String(converted.orderId), String(okOnes[0].json.data.orderId));

    // 6. Back and pay again: the same order, not "not found".
    res = await post('/orders/from-negotiation', wholesaler.token, { negotiationId: String(negotiation._id), shippingAddress: address });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(String(res.json.data.orderId), String(okOnes[0].json.data.orderId));
    assert.strictEqual(await Order.countDocuments({ userId: wholesaler.user._id }), 1);

    // 7. A failed order frees the negotiation again (here: not enough stock).
    const second = await Negotiation.create({
      wholesalerId: wholesaler.user._id, productId: product._id,
      productSnapshot: { name: product.name, price: 800 },
      requestedQuantity: 500, requestedPricePerUnit: 700, requestedTotalPrice: 350000,
      status: 'accepted', finalPricePerUnit: 700, finalTotalPrice: 350000,
      expiresAt: new Date(Date.now() + 86400000),
    });
    res = await post('/orders/from-negotiation', wholesaler.token, { negotiationId: String(second._id), shippingAddress: address });
    assert.strictEqual(res.status, 400);
    const freed = await Negotiation.findById(second._id).lean();
    assert.strictEqual(freed.status, 'accepted');
    assert.strictEqual(freed.orderId, null, 'the claim is released');

    console.log('doubleOrders.test.js: all checks passed');
  } finally {
    const orders = await Order.find({ userId: { $in: made.users } }).select('_id').lean();
    await Promise.all([
      Payment.deleteMany({ orderId: { $in: orders.map((o) => o._id) } }),
      Order.deleteMany({ userId: { $in: made.users } }),
      Negotiation.deleteMany({ wholesalerId: { $in: made.users } }),
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

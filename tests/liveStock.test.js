const assert = require('assert');

// Price Management live stock: the current stock of the products on screen,
// and setting stock only if it is still the number the admin started from.
//
//   LIVE_STOCK_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_live_stock_test?replicaSet=rs0' node tests/liveStock.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.LIVE_STOCK_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set LIVE_STOCK_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: LIVE_STOCK_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, StockLog } = require('../src/models');

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
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  const sign = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });

  try {
    const admin = await User.create({ name: 'LS admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    const staff = await User.create({ name: 'LS staff', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'staff' });
    made.users.push(admin._id, staff._id);
    const token = sign(admin);

    const a = await Product.create({ name: `LS Pump A ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800, sku: `LS-A-${suffix}`, stock: 50, status: 'active' });
    const b = await Product.create({ name: `LS Pump B ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800, sku: `LS-B-${suffix}`, stock: 4, status: 'active' });
    made.products.push(a._id, b._id);

    // 1. The stock of the products on screen; bad ids are ignored.
    let res = await call('GET', `/admin/products/stock-snapshot?ids=${a._id},${b._id},nope,${a._id}`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const byId = Object.fromEntries(res.json.data.map((p) => [String(p._id), p]));
    assert.strictEqual(res.json.data.length, 2);
    assert.strictEqual(byId[String(a._id)].stock, 50);
    assert.strictEqual(byId[String(b._id)].stock, 4);
    assert.ok('lowStockThreshold' in byId[String(b._id)]);
    res = await call('GET', '/admin/products/stock-snapshot?ids=', token);
    assert.deepStrictEqual(res.json.data, []);
    res = await call('GET', `/admin/products/stock-snapshot?ids=${a._id}`, sign(staff));
    assert.strictEqual(res.status, 403, 'staff cannot read it here (Price Management is admin-only)');
    console.log('ok - stock snapshot for the products on screen');

    // 2. Set from the number on screen: saved, and logged with the reason.
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { stock: 45, expectedStock: 50, reason: 'Count correction' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.newStock, 45);
    assert.strictEqual(res.json.data.previousStock, 50);
    assert.strictEqual(res.json.data.change, -5);
    assert.strictEqual((await Product.findById(a._id)).stock, 45);
    const log = await StockLog.findOne({ productId: a._id }).sort({ createdAt: -1 }).lean();
    assert.strictEqual(log.action, 'manual_set');
    assert.strictEqual(log.quantityChange, -5);
    assert.strictEqual(log.reason, 'Count correction');
    console.log('ok - stock set from the number on screen, logged');

    // 3. An order changed it meanwhile: refused, nothing saved, the current
    //    number is returned.
    await Product.updateOne({ _id: a._id }, { $inc: { stock: -2 } }); // an order: 43
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { stock: 40, expectedStock: 45 });
    assert.strictEqual(res.status, 409, JSON.stringify(res.json));
    assert.strictEqual(res.json.error.code, 'STOCK_CHANGED');
    assert.strictEqual(res.json.error.details.currentStock, 43);
    assert.strictEqual((await Product.findById(a._id)).stock, 43, 'nothing saved');
    // "Set anyway": the admin sends the number now on screen.
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { stock: 40, expectedStock: 43 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual((await Product.findById(a._id)).stock, 40);
    console.log('ok - a change from an order meanwhile is never overwritten by mistake');

    // 4. Checks: expectedStock only with stock; no negatives; old ways still work.
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { adjustment: '+5', expectedStock: 40 });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { stock: -1, expectedStock: 40 });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { adjustment: '+5' });
    assert.strictEqual(res.status, 200);
    res = await call('PUT', `/admin/products/${a._id}/stock`, token, { stock: 10 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await Product.findById(a._id)).stock, 10);
    res = await call('PUT', `/admin/products/${a._id}/stock`, sign(staff), { stock: 1, expectedStock: 10 });
    assert.strictEqual(res.status, 403);
    console.log('ok - checks, and the existing add/set still work');

    console.log('liveStock.test.js: all checks passed');
  } finally {
    await StockLog.deleteMany({ productId: { $in: made.products } });
    await Product.deleteMany({ _id: { $in: made.products } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

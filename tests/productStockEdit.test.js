const assert = require('assert');

// Editing a product never changes its stock: a form opened before some sales
// would otherwise put the sold units back. Stock changes go through
// PUT /admin/products/:id/stock, which is logged.
//
//   STOCKEDIT_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_stockedit_test?replicaSet=rs0' node tests/productStockEdit.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.STOCKEDIT_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set STOCKEDIT_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: STOCKEDIT_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

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
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };

  try {
    const admin = await User.create({ name: 'Stock Admin', email: `stock-${suffix}@example.com`, passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.users.push(admin._id);
    const token = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const product = await Product.create({
      name: `Stock Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `STK-${suffix}`, stock: 10, status: 'active',
    });
    made.products.push(product._id);

    // The edit form opens with stock 10; meanwhile 3 are sold.
    await Product.updateOne({ _id: product._id }, { $inc: { stock: -3 } });

    // 1. Saving the form (with its old 10) keeps the live 7.
    let res = await call('PUT', `/admin/products/${product._id}`, { name: `Stock Pump ${suffix} v2`, stock: 10 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    let saved = await Product.findById(product._id).lean();
    assert.strictEqual(saved.name, `Stock Pump ${suffix} v2`, 'other fields are saved');
    assert.strictEqual(saved.stock, 7, 'stock is not overwritten by the edit');

    // 2. The form's own change (10 -> 15, i.e. +5) is added to the live stock and logged.
    res = await call('PUT', `/admin/products/${product._id}/stock`, { adjustment: '+5', reason: 'Product form: 10 → 15 (+5)' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    saved = await Product.findById(product._id).lean();
    assert.strictEqual(saved.stock, 12);
    const log = await StockLog.findOne({ productId: product._id }).lean();
    assert.strictEqual(log.action, 'manual_adjust');
    assert.strictEqual(log.quantityChange, 5);
    assert.strictEqual(log.previousStock, 7);
    assert.strictEqual(log.newStock, 12);
    assert.strictEqual(String(log.performedBy), String(admin._id));

    // 3. Removing more than is left is refused, not clipped.
    res = await call('PUT', `/admin/products/${product._id}/stock`, { adjustment: '-20' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await Product.findById(product._id).lean()).stock, 12);

    console.log('productStockEdit.test.js: all checks passed');
  } finally {
    await Promise.all([
      StockLog.deleteMany({ productId: { $in: made.products } }),
      Product.deleteMany({ _id: { $in: made.products } }),
      User.deleteMany({ _id: { $in: made.users } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

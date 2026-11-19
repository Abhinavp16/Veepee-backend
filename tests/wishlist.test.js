const assert = require('assert');

// The app's wishlist on the account: GET / PUT (replace) / POST and DELETE
// one product. Any signed-in account; at most 500 products.
//
//   WISHLIST_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_wishlist_test?replicaSet=rs0' node tests/wishlist.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.WISHLIST_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set WISHLIST_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: WISHLIST_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product } = require('../src/models');

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
  const makeUser = async (role) => {
    const user = await User.create({ name: `WL ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const makeProduct = async (n, status = 'active') => {
    const product = await Product.create({
      name: `WL Pump ${suffix} ${n}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `WL-${suffix}-${n}`, stock: 5, status,
    });
    made.products.push(product._id);
    return String(product._id);
  };

  try {
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');
    const [a, b, c] = [await makeProduct(1), await makeProduct(2), await makeProduct(3, 'archived')];
    const unknown = String(new mongoose.Types.ObjectId());

    // Signed in only.
    assert.strictEqual((await call('GET', '/wishlist')).status, 401);
    assert.strictEqual((await call('POST', `/wishlist/${a}`)).status, 401);

    // Empty to start.
    let res = await call('GET', '/wishlist', buyer.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json, { success: true, data: { productIds: [] } });

    // Add: idempotent; unknown product 404; bad id 400.
    res = await call('POST', `/wishlist/${a}`, buyer.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.productIds, [a]);
    res = await call('POST', `/wishlist/${a}`, buyer.token);
    assert.deepStrictEqual(res.json.data.productIds, [a], 'adding twice keeps one');
    res = await call('POST', `/wishlist/${c}`, buyer.token);
    assert.deepStrictEqual(res.json.data.productIds, [a, c], 'archived products can be saved too');
    res = await call('POST', `/wishlist/${unknown}`, buyer.token);
    assert.strictEqual(res.status, 404);
    res = await call('POST', '/wishlist/not-an-id', buyer.token);
    assert.strictEqual(res.status, 400);

    // Remove: idempotent.
    res = await call('DELETE', `/wishlist/${a}`, buyer.token);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.data.productIds, [c]);
    res = await call('DELETE', `/wishlist/${a}`, buyer.token);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.data.productIds, [c]);

    // Replace: unknown ids dropped, duplicates once, order kept.
    res = await call('PUT', '/wishlist', buyer.token, { productIds: [b, unknown, a, b] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.productIds, [b, a]);
    res = await call('GET', '/wishlist', buyer.token);
    assert.deepStrictEqual(res.json.data.productIds, [b, a]);
    res = await call('PUT', '/wishlist', buyer.token, { productIds: ['nope'] });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/wishlist', buyer.token, {});
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/wishlist', buyer.token, { productIds: Array.from({ length: 501 }, () => a) });
    assert.strictEqual(res.status, 400, 'over 500');
    res = await call('PUT', '/wishlist', buyer.token, { productIds: [] });
    assert.deepStrictEqual(res.json.data.productIds, []);

    // Each account has its own list; any role.
    res = await call('POST', `/wishlist/${b}`, wholesaler.token);
    assert.deepStrictEqual(res.json.data.productIds, [b]);
    res = await call('GET', '/wishlist', buyer.token);
    assert.deepStrictEqual(res.json.data.productIds, []);

    // Not sent with the profile.
    res = await call('GET', '/auth/me', wholesaler.token);
    if (res.status === 200) assert.strictEqual(JSON.stringify(res.json).includes('"wishlist"'), false);

    // Cap at 500: the 501st is refused, one already there is fine.
    const full = Array.from({ length: 500 }, () => new mongoose.Types.ObjectId());
    full[0] = new mongoose.Types.ObjectId(a);
    await User.updateOne({ _id: buyer.user._id }, { $set: { wishlist: full } });
    res = await call('POST', `/wishlist/${b}`, buyer.token);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'WISHLIST_FULL');
    res = await call('POST', `/wishlist/${a}`, buyer.token);
    assert.strictEqual(res.status, 200, 'already saved: fine even when full');
    assert.strictEqual(res.json.data.productIds.length, 500);

    // Deleting a product for good takes it off every wishlist.
    const gone = await makeProduct(4);
    await call('POST', `/wishlist/${gone}`, wholesaler.token);
    res = await call('GET', '/wishlist', wholesaler.token);
    assert.deepStrictEqual(res.json.data.productIds, [b, gone]);
    const { deleteProductPermanently } = require('../src/services/catalogDeletion');
    await deleteProductPermanently(await Product.findById(gone));
    res = await call('GET', '/wishlist', wholesaler.token);
    assert.deepStrictEqual(res.json.data.productIds, [b], 'removed from the wishlist');

    // Indexed for "who saved this product".
    const indexes = await User.collection.indexes();
    assert.ok(indexes.some((index) => index.key.wishlist === 1), 'wishlist index');

    console.log('wishlist.test.js: all checks passed');
  } finally {
    await Promise.all([
      User.deleteMany({ _id: { $in: made.users } }),
      Product.deleteMany({ _id: { $in: made.products } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

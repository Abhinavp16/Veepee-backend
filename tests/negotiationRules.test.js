const assert = require('assert');

// Bulk negotiation rules set by admin: the quick picks the app shows on the
// price step, and the lowest price a wholesaler may ask for (a new request,
// a counter-offer, or a price named for a cart requirement).
//
//   NEGOTIATION_RULES_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_negotiation_rules_test?replicaSet=rs0' node tests/negotiationRules.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const rules = require('../src/utils/negotiationRules');

// Rules without a database.
assert.deepStrictEqual(rules.normalizeQuickPicks([1, 2, 2, 0.2, 60, '5']), [5, 2, 1], 'distinct, in range, largest first');
assert.deepStrictEqual(rules.normalizeQuickPicks([1, 2, 3, 4, 5]), [5, 4, 3, 2], 'at most four');
assert.deepStrictEqual(rules.normalizeQuickPicks(undefined), [2, 1], 'default');
assert.deepStrictEqual(rules.normalizeQuickPicks([]), [], 'admin can remove them all');
assert.strictEqual(rules.lowestAllowedPrice(700, { negotiationMaxDiscountPercent: 10 }), 630);
assert.strictEqual(rules.lowestAllowedPrice(2350, {}), 2115, 'default 10%');
assert.strictEqual(rules.lowestAllowedPrice(999, { negotiationMaxDiscountPercent: 10 }), 900, 'rounded up to whole rupees');
console.log('ok - negotiation rules');

const uri = process.env.NEGOTIATION_RULES_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set NEGOTIATION_RULES_TEST_MONGODB_URI to a local MongoDB to run the API part');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: NEGOTIATION_RULES_TEST_MONGODB_URI must point at a database on this machine');
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
  const M = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  const before = (await M.Settings.getSettings()).toObject();

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const makeUser = async (role) => {
    const user = await M.User.create({ name: `NR ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  };

  try {
    const admin = await makeUser('admin');
    const wholesaler = await makeUser('wholesaler');
    const buyer = await makeUser('buyer');
    const product = await M.Product.create({
      name: `NR Product ${suffix}`, category: 'nr', mrp: 1000, retailPrice: 900, wholesalePrice: 700,
      sku: `NR-${suffix}`, stock: 500, status: 'active', minWholesaleQuantity: 1,
    });
    made.products.push(product._id);
    const id = String(product._id);

    // 1. Admin saves the rules; picks are tidied, bad ones refused.
    let res = await call('PUT', '/admin/settings', admin, { negotiationQuickPicks: [1, 3, 2], negotiationMaxDiscountPercent: 10 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.negotiationQuickPicks, [3, 2, 1]);
    res = await call('PUT', '/admin/settings', admin, { negotiationQuickPicks: [1, 1] });
    assert.strictEqual(res.status, 400, 'duplicates refused');
    res = await call('PUT', '/admin/settings', admin, { negotiationMaxDiscountPercent: 95 });
    assert.strictEqual(res.status, 400, 'floor above 90% refused');
    console.log('ok - admin saves the rules');

    // 2. Wholesalers get them with the product; customers don't.
    res = await call('GET', `/products/${id}`, wholesaler);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.data.negotiationRules, { quickPicks: [3, 2, 1], maxDiscountPercent: 10 });
    res = await call('GET', `/products/${id}`, buyer);
    assert.strictEqual(res.json.data.negotiationRules, undefined);
    console.log('ok - wholesalers get the rules with the product');

    // 3. A new request below the floor (₹630 on ₹700) is refused; at it, accepted.
    res = await call('POST', '/negotiations', wholesaler, { productId: id, quantity: 5, pricePerUnit: 600 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'NEGOTIATION_PRICE_TOO_LOW');
    assert.deepStrictEqual(res.json.error.details, { lowestPrice: 630, maxDiscountPercent: 10 });
    res = await call('POST', '/negotiations', wholesaler, { productId: id, quantity: 5, pricePerUnit: 630 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const negotiationId = res.json.data.id || res.json.data._id || res.json.data.negotiationId;
    assert.ok(negotiationId, JSON.stringify(res.json));
    console.log('ok - a new request respects the floor');

    // 4. The admin may counter lower; the wholesaler's own counter may not go below.
    res = await call('PUT', `/admin/negotiations/${negotiationId}/counter`, admin, { pricePerUnit: 600, message: 'Best we can do' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('POST', `/negotiations/${negotiationId}/counter`, wholesaler, { pricePerUnit: 620 });
    assert.strictEqual(codeOf(res), 'NEGOTIATION_PRICE_TOO_LOW', JSON.stringify(res.json));
    res = await call('POST', `/negotiations/${negotiationId}/counter`, wholesaler, { pricePerUnit: 650 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    console.log('ok - counter-offers respect the floor');

    // 5. A price named for a cart requirement is checked too.
    await M.Cart.deleteMany({ userId: made.users[1] });
    await M.Cart.create({ userId: made.users[1], items: [{ productId: product._id, quantity: 5, priceAtAdd: 700 }] });
    res = await call('POST', '/negotiations/from-cart', wholesaler, { offers: [{ productId: id, pricePerUnit: 500 }] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error.details.items[0].code, 'NEGOTIATION_PRICE_TOO_LOW', JSON.stringify(res.json));
    console.log('ok - cart requirements respect the floor');
  } finally {
    await M.Settings.updateOne({ _id: 'app_settings' }, {
      $set: {
        negotiationQuickPicks: before.negotiationQuickPicks ?? [2, 1],
        negotiationMaxDiscountPercent: before.negotiationMaxDiscountPercent ?? 10,
      },
    });
    await M.Negotiation.deleteMany({ productId: { $in: made.products } });
    await M.Cart.deleteMany({ userId: { $in: made.users } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS negotiationRules');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

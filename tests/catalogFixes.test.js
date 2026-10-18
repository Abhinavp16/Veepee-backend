const assert = require('assert');

// A-to-Z product lists, brands that link the categories their products use,
// a public health check without internals, and a cart add that still prices
// correctly after being made faster.
//
//   CATALOG_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_catalog_test?replicaSet=rs0' node tests/catalogFixes.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.CATALOG_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set CATALOG_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: CATALOG_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Category, Company, Cart } = require('../src/models');

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
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [], categories: [], companies: [] };

  try {
    const category = await Category.create({ name: `Sort ${suffix}`, slug: `sort-${suffix}`, isActive: true });
    const spare = await Category.create({ name: `Spare ${suffix}`, slug: `spare-${suffix}`, isActive: true, customerDiscountPercent: 10 });
    made.categories.push(category._id, spare._id);
    const brand = await Company.create({ name: `Brand ${suffix}`, isActive: true, categoryIds: [category._id] });
    made.companies.push(brand._id);

    let n = 0;
    const makeProduct = async (name, fields = {}) => {
      n += 1;
      const product = await Product.create({
        name, category: category.slug, categoryIds: [category._id], primaryCategoryId: category._id,
        mrp: 1200, retailPrice: 1000, wholesalePrice: 800, sku: `CF-${suffix}-${n}`, stock: 50, status: 'active',
        company: brand._id, ...fields,
      });
      made.products.push(product._id);
      return product;
    };
    // Created in an order that is not alphabetical.
    for (const name of ['Z - GX35 Valve', 'mini weeder', '6N200 Rice Mill', 'Air Compressor', '6N70 Rice Mill']) {
      await makeProduct(`${name} ${suffix}`);
    }

    // 1. A-to-Z ignores capital letters and orders numbers naturally.
    let res = await call('GET', `/products?categorySlug=${category.slug}&sort=name&limit=50`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const names = res.json.data.map((p) => p.name.replace(` ${suffix}`, ''));
    assert.deepStrictEqual(names, ['6N70 Rice Mill', '6N200 Rice Mill', 'Air Compressor', 'mini weeder', 'Z - GX35 Valve']);

    // 2. A brand lists every category its products use, linking it if needed.
    const sparePart = await makeProduct(`Spare Gasket ${suffix}`, {
      category: spare.slug, categoryIds: [spare._id], primaryCategoryId: spare._id,
    });
    const adminUser = await User.create({ name: 'CF Admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.users.push(adminUser._id);
    const adminToken = jwt.sign({ userId: adminUser._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res = await call('GET', `/companies/${brand._id}/categories`, { token: adminToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const linked = res.json.data.categories.map((c) => String(c._id));
    assert.ok(linked.includes(String(spare._id)), 'the used category is now linked');
    const saved = await Company.findById(brand._id).lean();
    assert.ok(saved.categoryIds.map(String).includes(String(spare._id)), 'and saved on the brand');

    // So that product can now be saved with its brand and category.
    res = await call('PUT', `/admin/products/${sparePart._id}`, {
      token: adminToken,
      body: { company: String(brand._id), categoryIds: [String(spare._id)], primaryCategoryId: String(spare._id) },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));

    // 3. The public health check no longer shows internals.
    res = await call('GET', '/health');
    assert.strictEqual(res.status, 200);
    const text = JSON.stringify(res.json);
    for (const secret of ['host', 'pid', 'memory', 'node', 'uptimeSec']) {
      assert.ok(!text.includes(`"${secret}"`), `health hides ${secret}`);
    }
    assert.strictEqual(res.json.status, 'ok');

    // 4. Adding to cart still prices with brand/category discounts.
    const buyer = await User.create({ name: 'CF Buyer', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'buyer' });
    made.users.push(buyer._id);
    const buyerToken = jwt.sign({ userId: buyer._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res = await call('POST', '/cart/items', { token: buyerToken, body: { productId: String(sparePart._id), quantity: 2 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const line = res.json.data.items.find((item) => String(item.productId) === String(sparePart._id));
    assert.strictEqual(line.quantity, 2);
    assert.strictEqual(line.currentPrice, 1080, '10% category discount off MRP 1200');
    assert.strictEqual(res.json.data.subtotal, 2160);
    res = await call('POST', '/cart/items', { token: buyerToken, body: { productId: String(sparePart._id), quantity: 999 } });
    assert.strictEqual(res.status, 400, 'stock is still checked');

    console.log('catalogFixes.test.js: all checks passed');
  } finally {
    await Promise.all([
      Cart.deleteMany({ userId: { $in: made.users } }),
      User.deleteMany({ _id: { $in: made.users } }),
      Product.deleteMany({ _id: { $in: made.products } }),
      Category.deleteMany({ _id: { $in: made.categories } }),
      Company.deleteMany({ _id: { $in: made.companies } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

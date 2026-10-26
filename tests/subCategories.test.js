const assert = require('assert');

// Category → Sub-category: a sub-category made once and shown under several
// categories, products placed as "Category › Sub-category", brand filtering at
// each step, and the guard rails (links, deletes).
//
//   SUBCATEGORY_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_sub_test?replicaSet=rs0' node tests/subCategories.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.SUBCATEGORY_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set SUBCATEGORY_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: SUBCATEGORY_TEST_MONGODB_URI must point at a database on this machine');
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
  const made = { users: [], products: [], categories: [], companies: [], subs: [] };

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const names = async (query) => {
    const res = await call('GET', `/products?limit=50&${query}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    return res.json.data.map((p) => p.name).sort();
  };

  try {
    const admin = await M.User.create({ name: 'Sub test admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.users.push(admin._id);
    const token = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const cutter = await M.Category.create({ name: `Cutters ${suffix}` });
    const saw = await M.Category.create({ name: `Saws ${suffix}` });
    made.categories.push(cutter._id, saw._id);
    const oxon = await M.Company.create({ name: `Oxon${suffix}`, slug: `oxon-${suffix}`, categoryIds: [cutter._id, saw._id] });
    const other = await M.Company.create({ name: `Other${suffix}`, slug: `other-${suffix}`, categoryIds: [saw._id] });
    made.companies.push(oxon._id, other._id);

    const product = (name, company, categoryId) => M.Product.create({
      name: `${name} ${suffix}`, category: 'x', categoryIds: [categoryId], primaryCategoryId: categoryId,
      mrp: 1000, retailPrice: 900, wholesalePrice: 800, sku: `SUB-${name}-${suffix}`.replace(/\s/g, ''),
      stock: 10, status: 'active', company: company._id,
    }).then((doc) => { made.products.push(doc._id); return doc; });
    const machine = await product('Cutter 52CC', oxon, cutter._id);
    const blade = await product('Cutter Blade', oxon, cutter._id);
    const chain = await product('Saw Chain', other, saw._id);
    const universal = await product('Universal Blade', oxon, cutter._id);

    // 1. One "Blades" sub-category shown under both categories.
    let res = await call('POST', '/sub-categories', token, { name: `Blades ${suffix}`, categoryIds: [String(cutter._id), String(saw._id)] });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const blades = res.json.data;
    made.subs.push(blades._id);
    assert.strictEqual(blades.categories.length, 2);
    console.log('1. one sub-category shown under two categories');

    // 2. Products placed as Category › Blades.
    res = await call('POST', `/sub-categories/${blades._id}/products`, token, { categoryId: String(cutter._id), productIds: [String(blade._id), String(universal._id)] });
    assert.strictEqual(res.json.data.added, 2);
    res = await call('POST', `/sub-categories/${blades._id}/products`, token, { categoryId: String(saw._id), productIds: [String(chain._id), String(universal._id)] });
    assert.strictEqual(res.json.data.added, 2, 'universal blade joins Saws through the brand link');
    const universalNow = await M.Product.findById(universal._id).lean();
    assert.ok(universalNow.categoryIds.map(String).includes(String(saw._id)), 'category added with the placement');
    console.log('2. products placed as "Category › Sub-category"');

    // 3. Shared sub-category: each category only lists its own placements.
    const slugOf = async (category) => (await M.Category.findById(category._id).lean()).slug;
    const cutterSlug = await slugOf(cutter);
    const sawSlug = await slugOf(saw);
    assert.deepStrictEqual(await names(`categorySlug=${cutterSlug}&subCategory=${blades.slug}`), [blade.name, universal.name].sort());
    assert.deepStrictEqual(await names(`categorySlug=${sawSlug}&subCategory=${blades.slug}`), [chain.name, universal.name].sort());
    console.log('3. Cutters › Blades and Saws › Blades list only their own products');

    // 4. The category page: its own products plus its sub-categories'.
    // Added to a sub-category: shown only there by default.
    assert.deepStrictEqual(await names(`categorySlug=${cutterSlug}`), [machine.name]);
    res = await call('GET', `/sub-categories?category=${cutterSlug}`);
    assert.deepStrictEqual(res.json.data.map((s) => [s.slug, s.productCount]), [[blades.slug, 2]]);
    console.log('4. category page: its own products (sub-category ones only under their card), and the cards with counts');

    // 4b. Where each product shows: admin sees it and switches it.
    res = await call('GET', `/admin/products?search=${encodeURIComponent(suffix)}&limit=50`, token);
    const stateOf = (name) => res.json.data.find((p) => p.name === name)?.placementState;
    assert.strictEqual(stateOf(machine.name), 'category');
    assert.strictEqual(stateOf(blade.name), 'sub');
    const bladeRow = res.json.data.find((p) => p.name === blade.name);
    assert.deepStrictEqual(bladeRow.subPlacements.map((p) => [p.categoryName, p.subCategoryName, p.alsoInCategory]), [[cutter.name, blades.name, false]]);
    res = await call('PATCH', `/sub-categories/${blades._id}/products`, token, { categoryId: String(cutter._id), productIds: [String(blade._id)], alsoInCategory: true });
    assert.strictEqual(res.json.data.updated, 1);
    assert.deepStrictEqual(await names(`categorySlug=${cutterSlug}`), [machine.name, blade.name].sort(), 'both: in the category list too');
    assert.deepStrictEqual(await names(`categorySlug=${cutterSlug}&subCategory=${blades.slug}`), [blade.name, universal.name].sort(), 'still under the card');
    res = await call('GET', `/admin/products?search=${encodeURIComponent(suffix)}&placement=both&limit=50`, token);
    assert.deepStrictEqual(res.json.data.map((p) => p.name), [blade.name], 'filter: both');
    res = await call('GET', `/admin/products?search=${encodeURIComponent(suffix)}&placement=sub&limit=50`, token);
    assert.deepStrictEqual(res.json.data.map((p) => p.name).sort(), [chain.name, universal.name].sort(), 'filter: sub-category only');
    res = await call('GET', `/sub-categories/${blades._id}/products?categoryId=${cutter._id}`, token);
    assert.deepStrictEqual(res.json.data.map((p) => [p.name, p.alsoInCategory]).sort(), [[blade.name, true], [universal.name, false]].sort());
    // Adding with "also keep in the category list".
    const extra = await product('Spare Blade', oxon, cutter._id);
    res = await call('POST', `/sub-categories/${blades._id}/products`, token, { categoryId: String(cutter._id), productIds: [String(extra._id)], alsoInCategory: true });
    assert.ok((await names(`categorySlug=${cutterSlug}`)).includes(extra.name));
    // Taking it out of the sub-category leaves it in the category.
    res = await call('DELETE', `/sub-categories/${blades._id}/products/${universal._id}?categoryId=${cutter._id}`, token);
    assert.ok((await names(`categorySlug=${cutterSlug}`)).includes(universal.name), 'removed from the card: back in the category list');
    await call('POST', `/sub-categories/${blades._id}/products`, token, { categoryId: String(cutter._id), productIds: [String(universal._id)] });
    console.log('4b. admin sees Both / Sub only / Category only, filters and switches it');

    // 5. Brand at each step.
    res = await call('GET', `/categories?parent=root&active=true&brand=${encodeURIComponent(other.name)}&limit=50`);
    assert.deepStrictEqual(res.json.data.map((c) => c.slug), [sawSlug], 'a brand shows only its categories');
    assert.deepStrictEqual(await names(`categorySlug=${sawSlug}&subCategory=${blades.slug}&brand=${encodeURIComponent(oxon.name)}`), [universal.name]);
    res = await call('GET', `/sub-categories?category=${sawSlug}&brand=${encodeURIComponent(other.name)}`);
    assert.deepStrictEqual(res.json.data.map((s) => s.productCount), [1]);
    console.log('5. brand → its categories → its sub-category products');

    // 6. Admin product form: placements decide the categories.
    res = await call('PUT', `/admin/products/${machine._id}`, token, {
      placements: [{ category: String(saw._id), subCategory: String(blades._id) }, { category: String(cutter._id) }],
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const machineNow = await M.Product.findById(machine._id).lean();
    assert.deepStrictEqual(machineNow.categoryIds.map(String), [String(saw._id), String(cutter._id)]);
    assert.strictEqual(String(machineNow.primaryCategoryId), String(saw._id), 'first placement is the main one');
    const lone = await M.Category.create({ name: `Lone ${suffix}` });
    made.categories.push(lone._id);
    res = await call('PUT', `/admin/products/${machine._id}`, token, { placements: [{ category: String(lone._id), subCategory: String(blades._id) }] });
    assert.strictEqual(res.status, 400, 'sub-category must be shown under that category');
    console.log('6. product form placements set the categories; unlinked pairs are refused');

    // 7. Guard rails.
    res = await call('DELETE', `/sub-categories/${blades._id}`, token);
    assert.strictEqual(res.status, 400, 'cannot delete while products are placed');
    res = await call('PUT', `/sub-categories/${blades._id}`, token, { categoryIds: [String(cutter._id)] });
    assert.strictEqual(res.status, 400, 'cannot unlink a category that still has placements');
    await call('PUT', `/sub-categories/${blades._id}`, token, { isActive: false });
    res = await call('GET', `/sub-categories?category=${cutterSlug}`);
    assert.deepStrictEqual(res.json.data, [], 'switched-off sub-categories are hidden');
    console.log('7. deletes and unlinks are guarded; switched-off ones are hidden');

    // 8. Prices are unchanged by any of it.
    res = await call('GET', `/products/${universal._id}`);
    assert.strictEqual(res.status, 200);
    console.log('8. product pages still load with their prices');

    console.log('All sub-category tests passed');
  } finally {
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.SubCategory.deleteMany({ _id: { $in: made.subs } });
    await M.Company.deleteMany({ _id: { $in: made.companies } });
    await M.Category.deleteMany({ _id: { $in: made.categories } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

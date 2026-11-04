const assert = require('assert');

// Deleting from admin: archived products don't stop a category, sub-category
// or brand being deleted; a product can be deleted for good unless an order
// in progress, an open price request or a running sale still needs it; an
// archived product can be restored.
//
//   CATALOG_DELETE_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_catalog_delete_test?replicaSet=rs0' node tests/catalogDeletion.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.CATALOG_DELETE_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set CATALOG_DELETE_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: CATALOG_DELETE_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function run() {
  const http = require('http');
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const M = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [], categories: [], subs: [], companies: [], orders: [], negotiations: [], sales: [], carts: [] };

  const call = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body && { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    const admin = await M.User.create({ name: 'Delete test admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    const buyer = await M.User.create({ name: 'Delete test buyer', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'buyer' });
    made.users.push(admin._id, buyer._id);
    const token = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    let sku = 0;
    const product = async (name, category, extra = {}) => {
      sku += 1;
      const doc = await M.Product.create({
        name: `${name} ${suffix}`, category: category.slug, categoryIds: [category._id], primaryCategoryId: category._id,
        placements: [{ category: category._id, subCategory: null }],
        sku: `DEL-${suffix}-${sku}`, mrp: 1000, retailPrice: 900, wholesalePrice: 700, stock: 10, status: 'active',
        images: [{ url: 'https://example.com/a.webp', publicId: `products/del-${suffix}-${sku}.webp`, isPrimary: true }],
        ...extra,
      });
      made.products.push(doc._id);
      return doc;
    };
    const category = async (name) => {
      const doc = await M.Category.create({ name: `${name} ${suffix}` });
      made.categories.push(doc._id);
      return doc;
    };
    const order = async (productDoc, status) => {
      const doc = await M.Order.create({
        userId: buyer._id, orderType: 'retail', status, total: 900, subtotal: 900,
        customerSnapshot: { name: 'Buyer', phone: '9812345670' },
        items: [{ productId: productDoc._id, productSnapshot: { name: productDoc.name, sku: productDoc.sku, image: 'https://example.com/a.webp' }, quantity: 1, pricePerUnit: 900, totalPrice: 900 }],
        shippingAddress: { fullName: 'A', phone: '9812345670', addressLine1: 'x', city: 'Raipur', state: 'CG', pincode: '492001' },
      });
      made.orders.push(doc._id);
      return doc;
    };

    // 1. A category whose only product is archived can be deleted; the
    //    archived product loses it. One with a live product can't.
    const pumps = await category('Pumps');
    const oldPump = await product('Old Pump', pumps, { status: 'archived' });
    let res = await call('DELETE', `/categories/${pumps._id}`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const detached = await M.Product.findById(oldPump._id).lean();
    assert.deepStrictEqual(detached.categoryIds, []);
    assert.deepStrictEqual(detached.placements, []);
    assert.strictEqual(detached.primaryCategoryId, null);
    console.log('ok - archived products no longer block deleting a category');

    const saws = await category('Saws');
    await product('Chain Saw', saws);
    res = await call('DELETE', `/categories/${saws._id}`, token);
    assert.strictEqual(res.status, 400);
    assert.match(res.json.message, /1 product/);
    console.log('ok - a live product still blocks deleting its category');

    // 2. Restore: refused while its category is gone, fine once it has one.
    res = await call('POST', `/admin/products/${oldPump._id}/restore`, token);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'PRODUCT_NEEDS_CATEGORY', JSON.stringify(res.json));
    const sprayers = await category('Sprayers');
    const oldSprayer = await product('Old Sprayer', sprayers, { status: 'archived' });
    res = await call('GET', '/admin/products?status=archived&limit=100', token);
    assert.ok(res.json.data.some((p) => String(p._id) === String(oldSprayer._id)), 'archived filter lists it');
    res = await call('GET', `/admin/products?limit=100&search=${encodeURIComponent('Old Sprayer')}`, token);
    assert.ok(!res.json.data.some((p) => String(p._id) === String(oldSprayer._id)), 'the normal list leaves it out');
    res = await call('GET', `/admin/products?status=all&limit=100&search=${encodeURIComponent('Old Sprayer')}`, token);
    assert.ok(res.json.data.some((p) => String(p._id) === String(oldSprayer._id)), 'status=all includes it');
    res = await call('POST', `/admin/products/${oldSprayer._id}/restore`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual((await M.Product.findById(oldSprayer._id).lean()).status, 'active');
    console.log('ok - an archived product can be restored (once it has a category)');

    // 3. Sub-category and brand: archived products don't block either.
    const sub = await M.SubCategory.create({ name: `Sprayer Spares ${suffix}`, categories: [{ category: sprayers._id, order: 1 }] });
    made.subs.push(sub._id);
    const spare = await product('Nozzle', sprayers, { status: 'archived', placements: [{ category: sprayers._id, subCategory: sub._id }] });
    res = await call('DELETE', `/sub-categories/${sub._id}`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const spareAfter = await M.Product.findById(spare._id).lean();
    assert.strictEqual(spareAfter.placements[0].subCategory, null);
    assert.strictEqual(String(spareAfter.placements[0].category), String(sprayers._id));

    const brand = await M.Company.create({ name: `Old Brand ${suffix}` });
    made.companies.push(brand._id);
    const branded = await product('Branded', sprayers, { status: 'archived', company: brand._id });
    res = await call('DELETE', `/companies/${brand._id}`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual((await M.Product.findById(branded._id).lean()).company, null);
    console.log('ok - archived products no longer block deleting a sub-category or brand');

    // 4. Delete permanently: refused while an order is in progress, an
    //    open price request or a running sale needs it.
    const busy = await product('Busy Pump', sprayers);
    const open = await order(busy, 'processing');
    res = await call('DELETE', `/admin/products/${busy._id}/permanent`, token);
    assert.strictEqual(res.status, 409);
    assert.match(res.json.message, /order/);
    await M.Order.updateOne({ _id: open._id }, { $set: { status: 'delivered' } });

    const negotiation = await M.Negotiation.create({
      wholesalerId: buyer._id, productId: busy._id, productSnapshot: { name: busy.name, price: 700 },
      requestedQuantity: 5, requestedPricePerUnit: 650, requestedTotalPrice: 3250, status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
    });
    made.negotiations.push(negotiation._id);
    res = await call('DELETE', `/admin/products/${busy._id}/permanent`, token);
    assert.strictEqual(res.status, 409);
    assert.match(res.json.message, /price request/);
    await M.Negotiation.updateOne({ _id: negotiation._id }, { $set: { status: 'rejected' } });

    const sale = await M.Sale.create({
      name: `Delete Sale ${suffix}`, startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000),
      status: 'published', customerPercent: 10, products: [{ productId: busy._id }],
    });
    made.sales.push(sale._id);
    res = await call('DELETE', `/admin/products/${busy._id}/permanent`, token);
    assert.strictEqual(res.status, 409);
    assert.match(res.json.message, /sale/);
    await M.Sale.updateOne({ _id: sale._id }, { $set: { endedAt: new Date() } });
    console.log('ok - delete permanently is refused while an order, price request or sale needs it');

    // 5. Once free: gone, out of carts; the delivered order keeps its copy.
    const cart = await M.Cart.create({ userId: buyer._id, items: [{ productId: busy._id, quantity: 1, priceAtAdd: 900 }] });
    made.carts.push(cart._id);
    await M.ProductAlert.create({ productId: busy._id, userId: buyer._id }).catch(() => {});
    res = await call('DELETE', `/admin/products/${busy._id}/permanent`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(await M.Product.exists({ _id: busy._id }), null);
    assert.strictEqual((await M.Cart.findById(cart._id).lean()).items.length, 0);
    assert.strictEqual(await M.ProductAlert.countDocuments({ productId: busy._id }), 0);
    const kept = await M.Order.findById(open._id).lean();
    assert.strictEqual(kept.items[0].productSnapshot.name, busy.name);
    console.log('ok - deleted for good: out of carts and alerts; past orders keep their copy');

    // 6. Archive still works as before, and an archived product can also be
    //    deleted for good.
    const plain = await product('Plain Drill', sprayers);
    res = await call('DELETE', `/admin/products/${plain._id}`, token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await M.Product.findById(plain._id).lean()).status, 'archived');
    res = await call('DELETE', `/admin/products/${plain._id}/permanent`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(await M.Product.exists({ _id: plain._id }), null);
    console.log('ok - archive, then delete permanently');
  } finally {
    await M.Cart.deleteMany({ _id: { $in: made.carts } });
    await M.Sale.deleteMany({ _id: { $in: made.sales } });
    await M.Negotiation.deleteMany({ _id: { $in: made.negotiations } });
    await M.Order.deleteMany({ _id: { $in: made.orders } });
    await M.ProductAlert.deleteMany({ productId: { $in: made.products } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.Company.deleteMany({ _id: { $in: made.companies } });
    await M.SubCategory.deleteMany({ _id: { $in: made.subs } });
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

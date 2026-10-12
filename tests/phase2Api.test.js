const assert = require('assert');

// Phase 2 API behaviour against a real local database: brand/category
// discounts, coming-soon products with "notify me", pack sizes and minimums.
//
//   PHASE2_TEST_MONGODB_URI=mongodb://127.0.0.1:27231/oxon_phase2_test node tests/phase2Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PHASE2_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE2_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE2_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Company, Category, Cart, Order, Notification, ProductAlert } = require('../src/models');
  const { sweepDueLaunches } = require('../src/services/productLaunchService');

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
  const made = { users: [], products: [], companies: [], categories: [] };
  const makeUser = async (role) => {
    const user = await User.create({ name: `P2 ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  let skuCounter = 0;
  const makeProduct = async (fields) => {
    skuCounter += 1;
    const product = await Product.create({
      name: `P2 Product ${suffix} ${skuCounter}`,
      category: 'p2-test',
      mrp: 1000,
      retailPrice: 900,
      wholesalePrice: 700,
      sku: `P2-${suffix}-${skuCounter}`,
      stock: 500,
      status: 'active',
      ...fields,
    });
    made.products.push(product._id);
    return product;
  };

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');

    // --- Brand / category discounts ----------------------------------------
    const parentCat = await Category.create({ name: `P2 Parent ${suffix}` });
    const childCat = await Category.create({ name: `P2 Child ${suffix}`, parent: parentCat._id });
    const brand = await Company.create({ name: `P2 Brand ${suffix}` });
    made.categories.push(parentCat._id, childCat._id);
    made.companies.push(brand._id);

    const branded = await makeProduct({ company: brand._id });
    const categorised = await makeProduct({ primaryCategoryId: childCat._id, categoryIds: [childCat._id] });
    const plain = await makeProduct({});

    let res = await call('GET', `/products/${branded.slug}`);
    assert.strictEqual(res.json.data.price, 900, 'no discount yet: retail price');

    res = await call('PUT', `/admin/discounts/company/${brand._id}`, { token: admin.token, body: { customerDiscountPercent: 10, wholesalerDiscountPercent: 30 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('PUT', `/admin/discounts/category/${parentCat._id}`, { token: admin.token, body: { customerDiscountPercent: 20 } });
    assert.strictEqual(res.status, 200);
    res = await call('PUT', `/admin/discounts/category/${parentCat._id}`, { token: admin.token, body: { customerDiscountPercent: 100 } });
    assert.strictEqual(res.status, 400, '100% is rejected');
    res = await call('PUT', `/admin/discounts/company/${brand._id}`, { token: buyer.token, body: { customerDiscountPercent: 50 } });
    assert.strictEqual(res.status, 403, 'customers cannot set discounts');

    res = await call('GET', `/products/${branded.slug}`);
    assert.strictEqual(res.json.data.price, 900, 'brand 10% off MRP 1000');
    assert.strictEqual(res.json.data.discountPercent, 10);
    res = await call('GET', `/products/${branded.slug}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.price, 700, 'wholesaler brand 30% off MRP');
    assert.strictEqual(res.json.data.retailPrice, 900, 'wholesaler also sees the customer price');
    res = await call('GET', `/products/${categorised.slug}`);
    assert.strictEqual(res.json.data.price, 800, 'child inherits parent category 20%');
    res = await call('GET', `/products/${categorised.slug}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.price, 700, 'no wholesaler % set: stored wholesale price');
    res = await call('GET', `/products/${plain.slug}`);
    assert.strictEqual(res.json.data.price, 900);

    res = await call('GET', `/products?limit=50`, { token: buyer.token });
    const listed = res.json.data.find((p) => String(p.id) === String(categorised._id));
    assert.strictEqual(listed.price, 800, 'lists use the same price');

    res = await call('GET', '/admin/discounts', { token: admin.token });
    assert.strictEqual(res.json.data.companies.find((c) => c.name === brand.name).wholesalerDiscountPercent, 30);
    res = await call('GET', '/companies?limit=100');
    const publicBrand = res.json.data.find((c) => c.name === brand.name);
    assert.ok(publicBrand && !('customerDiscountPercent' in publicBrand), 'percentages are not public');
    res = await call('GET', '/categories?limit=100');
    assert.ok(!JSON.stringify(res.json).includes('DiscountPercent'), 'category percentages are not public');

    // Cart and order use the same price.
    res = await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(categorised._id), quantity: 2 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.items[0].currentPrice, 800);
    assert.strictEqual(res.json.data.subtotal, 1600);
    const address = { fullName: 'P2 Buyer', phone: '9812345670', addressLine1: '1 Test Road', city: 'Raipur', state: 'CG', pincode: '492001' };
    res = await call('POST', '/orders', { token: buyer.token, body: { shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const order = await Order.findById(res.json.data.id || res.json.data._id || res.json.data.orderId);
    made.orderIds = [order._id];
    assert.strictEqual(order.items[0].pricePerUnit, 800, 'order line uses the discounted price');
    assert.strictEqual(order.subtotal, 1600);
    await Cart.deleteMany({ userId: buyer.user._id });

    // --- Not orderable: draft / archived -------------------------------------
    const draft = await makeProduct({ status: 'draft' });
    res = await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(draft._id), quantity: 1 } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'PRODUCT_UNAVAILABLE');
    res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(draft._id), quantity: 1 }], shippingAddress: address } });
    assert.strictEqual(res.status, 400, 'draft products cannot be bought directly either');

    // --- Coming soon ---------------------------------------------------------
    const future = new Date(Date.now() + 7 * 86400000);
    const upcoming = await makeProduct({ name: `Zqupcoming${suffix}`, comingSoon: true, expectedLaunchDate: future, hidePriceWhileComingSoon: true });
    const manual = await makeProduct({ comingSoon: true });

    res = await call('GET', '/products?limit=50');
    assert.ok(!res.json.data.some((p) => String(p.id) === String(upcoming._id)), 'hidden from normal lists');
    res = await call('GET', '/products?comingSoon=true&limit=50');
    assert.ok(res.json.data.some((p) => String(p.id) === String(upcoming._id)));
    assert.ok(!res.json.data.some((p) => String(p.id) === String(plain._id)), 'only coming-soon products');
    const row = res.json.data.find((p) => String(p.id) === String(upcoming._id));
    assert.strictEqual(row.comingSoon, true);
    assert.strictEqual(row.price, null, 'price hidden when the admin chose to hide it');
    res = await call('GET', '/products?includeComingSoon=true&limit=50');
    assert.ok(res.json.data.some((p) => String(p.id) === String(upcoming._id)) && res.json.data.some((p) => String(p.id) === String(plain._id)));
    res = await call('GET', `/products/search?q=${upcoming.name}`);
    assert.strictEqual(res.json.data.length, 0, 'search hides coming soon too');
    res = await call('GET', `/products/search?q=${upcoming.name}&comingSoon=true`);
    assert.strictEqual(res.json.data.length, 1, 'but can ask for coming soon');

    res = await call('GET', `/products/${manual.slug}`, { token: buyer.token });
    assert.strictEqual(res.json.data.comingSoon, true);
    assert.strictEqual(res.json.data.price, 900, 'price shown unless hidden');
    assert.strictEqual(res.json.data.notifyMe, false);

    res = await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(manual._id), quantity: 1 } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'PRODUCT_COMING_SOON');
    res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(manual._id), quantity: 1 }], shippingAddress: address } });
    assert.strictEqual(res.status, 400, 'cannot order a coming-soon product');

    res = await call('POST', `/products/${manual._id}/notify-me`, { token: buyer.token });
    assert.strictEqual(res.status, 200);
    res = await call('POST', `/products/${manual._id}/notify-me`, { token: buyer.token });
    assert.strictEqual(res.status, 200, 'subscribing twice is harmless');
    assert.strictEqual(await ProductAlert.countDocuments({ productId: manual._id }), 1);
    res = await call('GET', `/products/${manual.slug}`, { token: buyer.token });
    assert.strictEqual(res.json.data.notifyMe, true);
    res = await call('POST', `/products/${plain._id}/notify-me`, { token: buyer.token });
    assert.strictEqual(res.status, 400, 'only coming-soon products can be subscribed to');
    res = await call('POST', `/products/${manual._id}/notify-me`);
    assert.strictEqual(res.status, 401);

    // Unsubscribe, then subscribe again for the launch below.
    res = await call('DELETE', `/products/${manual._id}/notify-me`, { token: buyer.token });
    assert.strictEqual(res.json.data.notifyMe, false);
    assert.strictEqual(await ProductAlert.countDocuments({ productId: manual._id }), 0);
    await call('POST', `/products/${manual._id}/notify-me`, { token: buyer.token });
    await call('POST', `/products/${manual._id}/notify-me`, { token: wholesaler.token });

    // Manual go-live notifies everyone who asked, once.
    res = await call('PUT', `/admin/products/${manual._id}`, { token: admin.token, body: { comingSoon: false } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const alert = await Notification.findOne({ userId: buyer.user._id, type: 'product_launched' });
    assert.ok(alert, 'subscriber got a launch notification');
    assert.strictEqual(alert.title, 'Now available!');
    assert.ok(await Notification.findOne({ userId: wholesaler.user._id, type: 'product_launched' }));
    assert.strictEqual(await ProductAlert.countDocuments({ productId: manual._id }), 0, 'alerts are consumed');
    res = await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(manual._id), quantity: 1 } });
    assert.strictEqual(res.status, 200, 'orderable once live');
    await Cart.deleteMany({ userId: buyer.user._id });

    // Date-based go-live: passes the date and has stock => live at once, and the daily sweep records it.
    const due = await makeProduct({ comingSoon: true, expectedLaunchDate: new Date(Date.now() - 3600000), stock: 10 });
    const dueNoStock = await makeProduct({ comingSoon: true, expectedLaunchDate: new Date(Date.now() - 3600000), stock: 0 });
    res = await call('GET', `/products/${due.slug}`);
    assert.strictEqual(res.json.data.comingSoon, false, 'past launch date with stock is already live');
    await ProductAlert.create({ userId: buyer.user._id, productId: due._id });
    const swept = await sweepDueLaunches();
    assert.ok(swept.launched >= 1);
    assert.strictEqual((await Product.findById(due._id)).comingSoon, false);
    assert.strictEqual((await Product.findById(dueNoStock._id)).comingSoon, true, 'no stock: stays coming soon');
    assert.ok(await Notification.findOne({ userId: buyer.user._id, 'data.productId': String(due._id) }));
    const again = await sweepDueLaunches();
    assert.strictEqual(again.launched, 0, 'a second sweep announces nothing');

    // --- Pack sizes and minimum quantities -------------------------------------
    const packed = await makeProduct({ packSize: 12, priceUnit: 'packet', minWholesaleQuantity: 2, minCustomerQuantity: 3 });
    res = await call('GET', `/products/${packed.slug}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.minQuantity, 24);
    assert.strictEqual(res.json.data.quantityStep, 12);
    assert.strictEqual(res.json.data.priceUnit, 'packet');
    res = await call('GET', `/products/${packed.slug}`, { token: buyer.token });
    assert.strictEqual(res.json.data.minQuantity, 3);
    assert.strictEqual(res.json.data.quantityStep, 1);

    const add = (who, quantity) => call('POST', '/cart/items', { token: who.token, body: { productId: String(packed._id), quantity } });
    res = await add(wholesaler, 12);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'INVALID_QUANTITY');
    assert.strictEqual((await add(wholesaler, 24)).status, 200);
    assert.strictEqual((await add(wholesaler, 13)).status, 400, 'total 37 is not a multiple of the pack');
    assert.strictEqual((await add(wholesaler, 12)).status, 200, 'total 36');
    res = await call('PUT', `/cart/items/${packed._id}`, { token: wholesaler.token, body: { quantity: 12 } });
    assert.strictEqual(res.status, 400, 'cannot drop below the minimum');
    res = await call('PUT', `/cart/items/${packed._id}`, { token: wholesaler.token, body: { quantity: 48 } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.items[0].product.quantityStep, 12);
    res = await call('POST', '/orders', { token: wholesaler.token, body: { items: [{ productId: String(packed._id), quantity: 20 }], shippingAddress: address } });
    assert.strictEqual(res.status, 400, 'direct orders follow the same rules');

    assert.strictEqual((await add(buyer, 2)).status, 400, 'below the customer minimum');
    assert.strictEqual((await add(buyer, 3)).status, 200);
    assert.strictEqual((await add(buyer, 1)).status, 200, 'customers can add single pieces above the minimum');

    // Stock is checked against the whole cart, not just the latest addition.
    const scarce = await makeProduct({ stock: 5 });
    await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(scarce._id), quantity: 4 } });
    res = await call('POST', '/cart/items', { token: buyer.token, body: { productId: String(scarce._id), quantity: 4 } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'INSUFFICIENT_STOCK');

    // Cart validation reports products that stopped being orderable.
    await Product.updateOne({ _id: scarce._id }, { $set: { comingSoon: true } });
    res = await call('POST', '/cart/validate', { token: buyer.token });
    assert.ok(res.json.data.issues.some((i) => i.type === 'coming_soon'));

    // Featured/hot filters now actually filter.
    await Product.updateOne({ _id: plain._id }, { $set: { isHot: true } });
    res = await call('GET', '/products?isHot=true&limit=50');
    assert.ok(res.json.data.every((p) => p.isHot === true) && res.json.data.some((p) => String(p.id) === String(plain._id)));

    console.log('phase2 api tests passed');
  } finally {
    await Cart.deleteMany({ userId: { $in: made.users } });
    await Order.deleteMany({ userId: { $in: made.users } });
    await ProductAlert.deleteMany({ userId: { $in: made.users } });
    await Notification.deleteMany({ userId: { $in: made.users } });
    await Product.deleteMany({ _id: { $in: made.products } });
    await Company.deleteMany({ _id: { $in: made.companies } });
    await Category.deleteMany({ _id: { $in: made.categories } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

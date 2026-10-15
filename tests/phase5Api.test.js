const assert = require('assert');

// Phase 5: scheduled price changes, customer notices, the shopper-facing
// "price changing soon" data, cancelling, and the admin Price Changes list.
// Price changes use transactions, so this needs a local single-node replica set:
//
//   PHASE5_TEST_MONGODB_URI='mongodb://127.0.0.1:27232/oxon_phase5_test?replicaSet=rs0' node tests/phase5Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PHASE5_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE5_TEST_MONGODB_URI to a local replica-set MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE5_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Cart, Notification, PriceChangeAudit, Company } = require('../src/models');
  const { processDuePriceChanges, sendPriceChangeReminders } = require('../src/services/priceLifecycleService');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  let keyCounter = 0;
  const call = async (method, path, { token, body, key } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(key && { 'Idempotency-Key': key }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const nextKey = () => `p5-${Date.now()}-${keyCounter += 1}`;

  const suffix = Date.now().toString(36);
  const made = { users: [], products: [], companies: [] };
  const makeUser = async (role, extra = {}) => {
    const user = await User.create({ name: `P5 ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  let skuCounter = 0;
  const makeProduct = async (fields = {}) => {
    skuCounter += 1;
    const product = await Product.create({
      name: `P5 Product ${suffix} ${skuCounter}`, category: 'p5', mrp: 1000, retailPrice: 900, wholesalePrice: 700,
      sku: `P5-${suffix}-${skuCounter}`, stock: 100, status: 'active', ...fields,
    });
    made.products.push(product._id);
    return product;
  };
  const inCart = (user, product) => Cart.updateOne({ userId: user._id }, { $push: { items: { productId: product._id, quantity: 1, priceAtAdd: 900 } } }, { upsert: true });
  const notificationsOf = (user, type) => Notification.find({ userId: user._id, type }).sort({ createdAt: 1 }).lean();
  const waitFor = async (predicate) => { for (let i = 0; i < 40; i += 1) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); } };

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler', { preferredLanguage: 'hi' });
    const bystander = await makeUser('buyer');
    const product = await makeProduct();
    await inCart(buyer.user, product);
    await inCart(wholesaler.user, product);

    // --- Scheduling announces the change to people holding it in their cart ---
    const key = nextKey();
    let res = await call('PUT', `/admin/products/${product._id}/price-change`, { token: admin.token, key, body: { retailPrice: 800, wholesalePrice: 600, priceChangeMode: 'schedule_48h' } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.audit.status, 'scheduled');
    const auditId = res.json.data.audit._id;

    await waitFor(async () => (await notificationsOf(wholesaler.user, 'price_change_scheduled')).length === 1);
    const [buyerNotice] = await notificationsOf(buyer.user, 'price_change_scheduled');
    assert.strictEqual(buyerNotice.title, 'Price changing soon');
    assert.ok(buyerNotice.body.includes('₹800'), buyerNotice.body);
    assert.strictEqual(buyerNotice.data.productId, String(product._id));
    const [wholesalerNotice] = await notificationsOf(wholesaler.user, 'price_change_scheduled');
    assert.strictEqual(wholesalerNotice.title, 'कीमत जल्द बदलेगी', 'in the wholesaler\'s language');
    assert.ok(wholesalerNotice.body.includes('₹600'), 'a wholesaler sees the wholesale price');
    assert.strictEqual((await notificationsOf(bystander.user, 'price_change_scheduled')).length, 0, 'only people with it in their cart');
    assert.ok((await PriceChangeAudit.findById(auditId)).scheduledNoticeSentAt);

    // Retrying the same request does not announce it twice.
    res = await call('PUT', `/admin/products/${product._id}/price-change`, { token: admin.token, key, body: { retailPrice: 800, wholesalePrice: 600, priceChangeMode: 'schedule_48h' } });
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual((await notificationsOf(buyer.user, 'price_change_scheduled')).length, 1);

    // --- What shoppers see ----------------------------------------------------
    const slug = (await Product.findById(product._id)).slug;
    res = await call('GET', `/products/${slug}`);
    assert.strictEqual(res.json.data.price, 900, 'the live price is unchanged until it starts');
    assert.strictEqual(res.json.data.pendingPriceChange.newPrice, 800);
    assert.strictEqual(res.json.data.pendingPriceChange.currentPrice, 900);
    assert.ok(new Date(res.json.data.pendingPriceChange.effectiveAt) > new Date());
    assert.ok(!('pendingRetailPrice' in res.json.data), 'raw pending fields stay private');
    res = await call('GET', `/products/${slug}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.pendingPriceChange.newPrice, 600);
    res = await call('GET', `/products?limit=50`, { token: buyer.token });
    assert.strictEqual(res.json.data.find((p) => String(p.id) === String(product._id)).pendingPriceChange.newPrice, 800, 'lists carry it too');

    res = await call('GET', '/cart', { token: buyer.token });
    assert.strictEqual(res.json.data.items[0].product.pendingPriceChange.newPrice, 800, 'the cart warns too');

    // A brand discount sets the price regardless, so there is nothing to warn about.
    const brand = await Company.create({ name: `P5 Brand ${suffix}`, customerDiscountPercent: 10 });
    made.companies.push(brand._id);
    await Product.updateOne({ _id: product._id }, { $set: { company: brand._id } });
    res = await call('GET', `/products/${slug}`);
    assert.strictEqual(res.json.data.pendingPriceChange, null);
    await Product.updateOne({ _id: product._id }, { $set: { company: null } });

    // --- Reminder the day before (changes scheduled more than a day ahead) ---
    const audit = await PriceChangeAudit.findById(auditId).lean();
    let reminders = await sendPriceChangeReminders(new Date());
    assert.strictEqual(reminders.reminded, 0, 'too early');
    reminders = await sendPriceChangeReminders(new Date(new Date(audit.effectiveAt).getTime() - 23 * 3600000));
    assert.strictEqual(reminders.reminded, 1);
    await waitFor(async () => (await notificationsOf(buyer.user, 'price_change_scheduled')).length === 2);
    const second = (await notificationsOf(buyer.user, 'price_change_scheduled'))[1];
    assert.strictEqual(second.title, 'Price changes tomorrow');
    reminders = await sendPriceChangeReminders(new Date(new Date(audit.effectiveAt).getTime() - 23 * 3600000));
    assert.strictEqual(reminders.reminded, 0, 'sent once');

    // 24-hour changes were announced when made; no extra reminder.
    const quick = await makeProduct();
    await inCart(buyer.user, quick);
    res = await call('PUT', `/admin/products/${quick._id}/price-change`, { token: admin.token, key: nextKey(), body: { retailPrice: 850, priceChangeMode: 'schedule_24h' } });
    assert.strictEqual(res.status, 201);
    const quickAudit = await PriceChangeAudit.findById(res.json.data.audit._id).lean();
    reminders = await sendPriceChangeReminders(new Date(new Date(quickAudit.effectiveAt).getTime() - 3600000));
    assert.strictEqual(reminders.reminded, 0);

    // An MRP-only change tells nobody.
    const mrpOnly = await makeProduct();
    await inCart(buyer.user, mrpOnly);
    res = await call('PUT', `/admin/products/${mrpOnly._id}/price-change`, { token: admin.token, key: nextKey(), body: { mrp: 1100, priceChangeMode: 'schedule_24h' } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual((await Notification.countDocuments({ userId: buyer.user._id, 'data.productId': String(mrpOnly._id) })), 0);

    // --- Admin list ------------------------------------------------------------
    res = await call('GET', '/admin/price-changes?status=scheduled&limit=50', { token: admin.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.scheduledCount >= 3);
    assert.ok(res.json.data.some((row) => String(row._id) === String(auditId)));
    res = await call('GET', `/admin/price-changes?q=${encodeURIComponent(product.sku)}`, { token: admin.token });
    assert.strictEqual(res.json.data.length, 1);
    res = await call('GET', '/admin/price-changes', { token: buyer.token });
    assert.strictEqual(res.status, 403);

    // --- Cancelling ------------------------------------------------------------
    res = await call('POST', `/admin/price-changes/${auditId}/cancel`, { token: buyer.token });
    assert.strictEqual(res.status, 403);
    res = await call('POST', `/admin/price-changes/${auditId}/cancel`, { token: admin.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.status, 'cancelled');
    const cancelled = await Product.findById(product._id).lean();
    assert.strictEqual(cancelled.retailPrice, 900, 'the live price never moved');
    assert.strictEqual(cancelled.pendingRetailPrice, null);
    assert.strictEqual(cancelled.activePendingPriceChangeAudit, null);
    res = await call('GET', `/products/${slug}`);
    assert.strictEqual(res.json.data.pendingPriceChange, null);
    res = await call('POST', `/admin/price-changes/${auditId}/cancel`, { token: admin.token });
    assert.strictEqual(res.status, 409, 'cannot cancel twice');

    // --- A change that has come due is applied by the daily job ---------------
    const due = await makeProduct();
    await inCart(buyer.user, due);
    res = await call('PUT', `/admin/products/${due._id}/price-change`, { token: admin.token, key: nextKey(), body: { retailPrice: 750, priceChangeMode: 'schedule_24h' } });
    const dueAuditId = res.json.data.audit._id;
    const past = new Date(Date.now() - 1000);
    await Product.updateOne({ _id: due._id }, { $set: { priceChangeEffectiveAt: past } });
    const result = await processDuePriceChanges();
    assert.ok(result.applied >= 1);
    assert.strictEqual((await Product.findById(due._id)).retailPrice, 750);
    assert.strictEqual((await PriceChangeAudit.findById(dueAuditId)).status, 'applied');
    await waitFor(async () => (await Notification.countDocuments({ userId: buyer.user._id, type: 'price_change', 'data.productId': String(due._id) })) === 1);
    assert.strictEqual(await Notification.countDocuments({ userId: buyer.user._id, type: 'price_change', 'data.productId': String(due._id) }), 1, 'told when it takes effect');
    res = await call('POST', `/admin/price-changes/${dueAuditId}/cancel`, { token: admin.token });
    assert.strictEqual(res.status, 409, 'an applied change cannot be cancelled');

    console.log('phase5 api tests passed');
  } finally {
    await Cart.deleteMany({ userId: { $in: made.users } });
    await Notification.deleteMany({ userId: { $in: made.users } });
    // Audits are append-only through the model; clean our test rows directly.
    await PriceChangeAudit.collection.deleteMany({ product: { $in: made.products } });
    await Product.deleteMany({ _id: { $in: made.products } });
    await Company.deleteMany({ _id: { $in: made.companies } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

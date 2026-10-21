const assert = require('assert');

// Admin panel fixes (UI review, phase 1): correct customer and dashboard
// figures, no fake numbers, and Demand Insights loading.
//
//   ADMINFIX_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_adminfix_test?replicaSet=rs0' node tests/adminFixes.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.ADMINFIX_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set ADMINFIX_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: ADMINFIX_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Order, Analytics } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [], orders: [] };
  let userCount = 0;
  const makeUser = async (role, extra = {}) => {
    userCount += 1;
    const user = await User.create({ name: `Fix ${role} ${suffix}`, email: `fix-${role}-${userCount}-${suffix}@example.com`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const get = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff', { mustChangePassword: false });
    const buyer = await makeUser('buyer');
    const deleted = await makeUser('buyer', { isActive: false, deletedAt: new Date() });
    const product = await Product.create({
      name: `Fix Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `FIX-${suffix}`, stock: 3, lowStockThreshold: 5, status: 'active', rating: 4.5, purchaseCountMin: 10, purchaseCountMax: 50,
    });
    made.products.push(product._id);
    const order = (status, total) => ({
      userId: buyer.user._id, orderType: 'retail', status, total, subtotal: total,
      customerSnapshot: { name: 'Fix buyer', phone: '9812345670' },
      items: [{ productId: product._id, productSnapshot: { name: product.name, sku: product.sku }, quantity: 1, pricePerUnit: total, totalPrice: total }],
      shippingAddress: { fullName: 'A', phone: '9812345670', addressLine1: 'x', city: 'Raipur', state: 'CG', pincode: '492001' },
    });
    const orders = await Order.create([order('delivered', 1000), order('pending_payment', 5000), order('cancelled', 7000)]);
    made.orders.push(...orders.map((o) => o._id));

    // 1. Customer profile has the person's details; spend counts paid orders only.
    let res = await get(`/admin/customers/${buyer.user._id}`, admin.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.name, buyer.user.name);
    assert.strictEqual(res.json.data.email, buyer.user.email);
    assert.strictEqual(res.json.data.phone, buyer.user.phone);
    assert.strictEqual(res.json.data.stats.orders.totalOrders, 3);
    assert.strictEqual(res.json.data.stats.orders.totalSpent, 1000, 'only the paid order');

    // 2. Deleted accounts are not customers; search text is not a pattern.
    res = await get(`/admin/customers/${deleted.user._id}`, admin.token);
    assert.strictEqual(res.status, 404);
    res = await get(`/admin/customers?search=${encodeURIComponent(suffix)}&limit=50`, admin.token);
    assert.deepStrictEqual(res.json.data.map((c) => c._id).sort(), [String(buyer.user._id)]);
    res = await get(`/admin/customers?search=${encodeURIComponent('(+91')}`, admin.token);
    assert.strictEqual(res.status, 200, 'search with "(" works');

    // 3. Dashboard: paid revenue only; staff get no money figures.
    res = await get('/admin/analytics/dashboard', admin.token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.showRevenue, true);
    assert.ok(res.json.data.today.revenue >= 1000);
    const allPaid = await Order.aggregate([{ $match: { createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }, status: { $in: ['payment_verified', 'processing', 'shipped', 'delivered'] } } }, { $group: { _id: null, t: { $sum: '$total' } } }]);
    assert.strictEqual(res.json.data.today.revenue, allPaid[0].t, 'today = paid orders only');
    const customers = await User.countDocuments({ role: { $in: ['buyer', 'wholesaler'] }, deletedAt: null });
    assert.strictEqual(res.json.data.overview.totalCustomers, customers, 'deleted accounts are not counted');
    res = await get('/admin/analytics/dashboard', staff.token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.showRevenue, false);
    assert.strictEqual(res.json.data.overview.totalRevenue, null);
    assert.strictEqual(res.json.data.today.revenue, null);
    assert.strictEqual(res.json.data.thisMonth.revenue, null);
    assert.strictEqual(typeof res.json.data.overview.totalOrders, 'number', 'counts still shown');

    // 4. Demand Insights loads (low-stock product included).
    res = await get('/admin/analytics/demand', admin.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json).slice(0, 200));
    assert.ok(res.json.data.lowStockAlerts.some((p) => p.name === product.name));

    // 5. Sales: real change and conversion figures (null when they can't be worked out).
    await Analytics.create([1, 2, 3, 4].map(() => ({ productId: product._id, eventType: 'view', timestamp: new Date() })));
    res = await get('/admin/analytics/sales?period=30d&groupBy=day', admin.token);
    assert.strictEqual(res.status, 200);
    const summary = res.json.data.summary;
    assert.ok('revenueChangePercent' in summary && 'conversionRate' in summary);
    assert.ok(summary.productViews >= 4);
    assert.strictEqual(summary.conversionRate, Math.round((summary.totalOrders / summary.productViews) * 1000) / 10);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(res.json.data.timeline[0].date), 'grouped by day');
    res = await get('/admin/analytics/sales?period=all', admin.token);
    assert.strictEqual(res.json.data.summary.revenueChangePercent, null, 'no comparison for all time');

    // 6. Shoppers never get the retired rating or "live purchases" range.
    res = await get(`/products/${product.slug}`);
    assert.strictEqual(res.status, 200);
    for (const key of ['rating', 'purchaseCountMin', 'purchaseCountMax']) {
      assert.ok(!(key in res.json.data), `product page has no ${key}`);
    }
    res = await get(`/products?search=${encodeURIComponent(product.name)}&limit=5`);
    const listed = (res.json.data || []).find((p) => p.name === product.name);
    if (listed) for (const key of ['rating', 'purchaseCountMin', 'purchaseCountMax']) assert.ok(!(key in listed), `list has no ${key}`);
    const fresh = await Product.create({ name: `Fix New ${suffix}`, category: 'pumps', mrp: 10, retailPrice: 9, wholesalePrice: 8, sku: `FIXN-${suffix}`, stock: 1, status: 'active' });
    made.products.push(fresh._id);
    assert.strictEqual(fresh.rating, undefined, 'no 4.5 default');

    console.log('adminFixes.test.js: all checks passed');
  } finally {
    await Promise.all([
      Order.deleteMany({ _id: { $in: made.orders } }),
      Analytics.deleteMany({ productId: { $in: made.products } }),
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

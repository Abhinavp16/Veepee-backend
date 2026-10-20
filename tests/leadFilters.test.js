const assert = require('assert');

// Admin "Potential customers": someone becomes a lead 5 minutes after viewing
// without adding to cart; the list filters by views and last-viewed time and
// sorts by views or by most recent.
//
//   LEADS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_leads_test?replicaSet=rs0' node tests/leadFilters.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.LEADS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set LEADS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: LEADS_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Analytics, LeadContact } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };

  try {
    const admin = await User.create({ name: 'Leads Admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.users.push(admin._id);
    const token = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    let lastCounts = null;
    const get = async (query) => {
      const res = await fetch(`${base}/admin/analytics/potential-customers?limit=100&${query}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(json));
      lastCounts = json.data.counts;
      // Only this test's leads (the database may hold others).
      return json.data.potentialCustomers.filter((lead) => lead.product.name?.endsWith(suffix));
    };
    const send = async (method, path, body, auth = token) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };

    const buyers = [];
    for (const name of ['Asha', 'Bala', 'Chetan', 'Dev']) {
      const user = await User.create({ name: `${name} ${suffix}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'buyer' });
      buyers.push(user);
      made.users.push(user._id);
    }
    const product = await Product.create({
      name: `Lead Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `LEAD-${suffix}`, stock: 10, status: 'active',
    });
    made.products.push(product._id);

    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
    const views = (user, count, lastMinutesAgo) => Array.from({ length: count }, (_, i) => ({
      productId: product._id, userId: user._id, eventType: 'view', timestamp: minutesAgo(lastMinutesAgo + i * 10),
    }));
    const [asha, bala, chetan, dev] = buyers;
    let leads;
    await Analytics.insertMany([
      ...views(asha, 6, 3 * 24 * 60), // 6 views, last 3 days ago
      ...views(bala, 2, 60), // 2 views, last an hour ago
      ...views(chetan, 4, 10), // 4 views, last 10 minutes ago
      ...views(dev, 3, 2), // viewed 2 minutes ago: not a lead yet
    ]);

    // 1. Leads appear 5 minutes after the last view.
    leads = await get('period=7d');
    const names = (list) => list.map((lead) => lead.user.name.replace(` ${suffix}`, ''));
    assert.deepStrictEqual(names(leads), ['Asha', 'Chetan', 'Bala'], 'most views first; Dev is too recent');

    // 2. Most recently viewed first.
    leads = await get('period=7d&sort=recent');
    assert.deepStrictEqual(names(leads), ['Chetan', 'Bala', 'Asha']);

    // 3. At least N views.
    leads = await get('period=7d&minViews=4');
    assert.deepStrictEqual(names(leads), ['Asha', 'Chetan']);

    // 4. Last viewed within a range.
    leads = await get(`period=7d&lastViewedFrom=${encodeURIComponent(minutesAgo(24 * 60).toISOString())}`);
    assert.deepStrictEqual(names(leads), ['Chetan', 'Bala'], 'only the last day');
    leads = await get(`period=3d&lastViewedFrom=${encodeURIComponent(minutesAgo(5 * 24 * 60).toISOString())}&lastViewedTo=${encodeURIComponent(minutesAgo(24 * 60).toISOString())}`);
    assert.deepStrictEqual(names(leads), ['Asha'], 'a range older than the period still works');

    // 5. Each lead has the exact last-viewed time.
    assert.ok(!Number.isNaN(new Date(leads[0].lastViewed).getTime()));

    // 6. Watch time: the app reports seconds on the product page; they add up.
    const ashaToken = jwt.sign({ userId: asha._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    let res = await send('POST', `/products/${product._id}/watch-time`, { seconds: 90 }, ashaToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await send('POST', `/products/${product._id}/watch-time`, { seconds: 99999 }, ashaToken);
    assert.strictEqual(res.status, 200, 'capped, not refused');
    res = await send('POST', `/products/${product._id}/watch-time`, { seconds: 0 }, ashaToken);
    assert.strictEqual(res.status, 400);
    res = await send('POST', `/products/${product._id}/watch-time`, { seconds: 30 }, token);
    assert.strictEqual(res.status, 403, 'only customers report watch time');
    leads = await get('period=7d');
    const ashaLead = leads.find((lead) => lead.user.name.startsWith('Asha'));
    assert.strictEqual(ashaLead.watchSeconds, 90 + 1800, '90s plus one capped 30-minute stay');
    assert.strictEqual(ashaLead.viewCount, 6, 'watch reports are not views');

    // 7. Contacted: messaging moves a lead out of "To contact"; undo brings it back.
    res = await send('POST', '/admin/analytics/potential-customers/contacted', {
      leads: [{ userId: String(bala._id), productId: String(product._id) }],
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    leads = await get('period=7d');
    assert.deepStrictEqual(names(leads), ['Asha', 'Chetan'], 'Bala left To contact');
    const todoCount = lastCounts.todo;
    leads = await get('period=7d&view=contacted');
    assert.deepStrictEqual(names(leads), ['Bala']);
    assert.ok(new Date(leads[0].contact.lastContactAt) <= new Date());
    assert.strictEqual(leads[0].contact.lastContactByName, 'Leads Admin');
    assert.ok(lastCounts.contacted >= 1 && lastCounts.todo === todoCount);
    res = await send('DELETE', '/admin/analytics/potential-customers/contacted', { userId: String(bala._id), productId: String(product._id) });
    assert.strictEqual(res.status, 200);
    leads = await get('period=7d');
    assert.deepStrictEqual(names(leads), ['Asha', 'Chetan', 'Bala']);
    res = await send('POST', '/admin/analytics/potential-customers/contacted', { leads: [] });
    assert.strictEqual(res.status, 400);

    console.log('leadFilters.test.js: all checks passed');
  } finally {
    await Promise.all([
      Analytics.deleteMany({ productId: { $in: made.products } }),
      LeadContact.deleteMany({ productId: { $in: made.products } }),
      User.deleteMany({ _id: { $in: made.users } }),
      Product.deleteMany({ _id: { $in: made.products } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

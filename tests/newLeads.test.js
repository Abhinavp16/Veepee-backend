const assert = require('assert');

// Admin Leads "new" marker: people who became leads (or looked again) in the
// last 2 days and aren't contacted are new (green dot on the page); the menu
// shows how many came in since this administrator last opened Leads.
//
//   NEW_LEADS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_new_leads_test?replicaSet=rs0' node tests/newLeads.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
process.env.NEW_LEADS_CACHE_MS = '0'; // every call reads the data again
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.NEW_LEADS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set NEW_LEADS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
// Its own database: the test clears the analytics events in it.
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/[^/?]*_test(\?|$)/i.test(uri)) {
  console.error('Refusing to run: NEW_LEADS_TEST_MONGODB_URI must be a local database whose name ends in _test');
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
  await Analytics.deleteMany({});
  await LeadContact.deleteMany({});
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

  try {
    const makeUser = async (name, role = 'buyer') => {
      const user = await User.create({ name: `${name} ${suffix}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
      made.users.push(user._id);
      return user;
    };
    const admin = await makeUser('Admin', 'admin');
    const admin2 = await makeUser('Admin2', 'admin');
    const staff = await makeUser('Staff', 'staff');
    const tokenFor = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const call = async (method, path, user = admin) => {
      const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` } });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const newCount = async (user = admin) => {
      const res = await call('GET', '/admin/analytics/potential-customers/new', user);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      return res.json.data;
    };

    const product = await Product.create({
      name: `New Lead Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `NL-${suffix}`, stock: 10, status: 'active',
    });
    const soon = await Product.create({
      name: `Soon ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `NLS-${suffix}`, stock: 10, status: 'active', comingSoon: true,
    });
    made.products.push(product._id, soon._id);

    const fresh = await makeUser('Fresh'); // viewed 1 hour ago: new
    const yesterday = await makeUser('Yesterday'); // 1 day ago: new
    const old = await makeUser('Old'); // 3 days ago: not new
    const justNow = await makeUser('JustNow'); // 2 minutes ago: not a lead yet
    const carted = await makeUser('Carted'); // added to cart after viewing
    const contacted = await makeUser('Contacted'); // the team messaged them
    const soonViewer = await makeUser('SoonViewer'); // coming-soon product only
    const view = (user, minutes, p = product) => ({ productId: p._id, userId: user._id, eventType: 'view', timestamp: minutesAgo(minutes) });
    await Analytics.insertMany([
      view(fresh, 60),
      view(yesterday, 24 * 60),
      view(old, 3 * 24 * 60),
      view(justNow, 2),
      view(carted, 90),
      { productId: product._id, userId: carted._id, eventType: 'cart_add', timestamp: minutesAgo(80) },
      view(contacted, 120),
      view(soonViewer, 60, soon),
    ]);
    await LeadContact.create({ userId: contacted._id, productId: product._id, firstContactAt: minutesAgo(30), lastContactAt: minutesAgo(30), contactCount: 1 });

    // 1. Administrators only.
    assert.strictEqual((await call('GET', '/admin/analytics/potential-customers/new', staff)).status, 403);
    assert.strictEqual((await call('POST', '/admin/analytics/potential-customers/seen', staff)).status, 403);
    console.log('ok - administrators only');

    // 2. New = last 2 days, a lead (5 minutes passed), not in cart, not contacted.
    let data = await newCount();
    assert.deepStrictEqual([data.newLeads, data.unseen, data.seenAt], [2, 2, null], JSON.stringify(data));
    console.log('ok - only leads from the last 2 days count as new');

    // 3. The list marks them (and only them) as new.
    const res = await call('GET', '/admin/analytics/potential-customers?period=7d&groupBy=person&limit=100');
    assert.strictEqual(res.status, 200);
    const byName = Object.fromEntries(res.json.data.people.map((p) => [p.user.name.split(' ')[0], p]));
    assert.strictEqual(byName.Fresh.isNew, true);
    assert.strictEqual(byName.Yesterday.isNew, true);
    assert.strictEqual(byName.Old.isNew, false);
    assert.strictEqual(byName.Fresh.products[0].isNew, true);
    const flat = await call('GET', '/admin/analytics/potential-customers?period=7d&limit=100');
    assert.strictEqual(flat.json.data.potentialCustomers.find((l) => String(l.userId) === String(old._id)).isNew, false);
    console.log('ok - the list marks new leads');

    // 4. Opening Leads: nothing unseen for this administrator; still new; others unaffected.
    assert.strictEqual((await call('POST', '/admin/analytics/potential-customers/seen')).status, 200);
    data = await newCount();
    assert.deepStrictEqual([data.newLeads, data.unseen], [2, 0]);
    assert.ok(data.seenAt);
    assert.strictEqual((await newCount(admin2)).unseen, 2, 'each administrator has their own count');
    console.log('ok - opening Leads clears the menu count for that person only');

    // 5. Someone new after the visit (or looking again) counts again.
    await Analytics.create({ productId: product._id, userId: fresh._id, eventType: 'view', timestamp: new Date(Date.now() - 5 * 60 * 1000 - 1000) });
    await User.updateOne({ _id: admin._id }, { $set: { leadsSeenAt: minutesAgo(10) } });
    const another = await makeUser('Another');
    await Analytics.create(view(another, 6));
    data = await newCount();
    assert.deepStrictEqual([data.newLeads, data.unseen], [3, 2], JSON.stringify(data));
    console.log('ok - leads after the last visit count again');

    // 6. Contacting a lead takes it off.
    await LeadContact.create({ userId: another._id, productId: product._id, firstContactAt: new Date(), lastContactAt: new Date(), contactCount: 1 });
    data = await newCount();
    assert.deepStrictEqual([data.newLeads, data.unseen], [2, 1]);
    console.log('ok - contacted leads are not new');

    // 7. A view just before the visit becomes a lead after it: still unseen.
    const late = await makeUser('Late');
    await Analytics.create(view(late, 6)); // a lead since 1 minute ago
    await User.updateOne({ _id: admin._id }, { $set: { leadsSeenAt: minutesAgo(2) } });
    data = await newCount();
    // Late (viewed 6 minutes ago) and Fresh (looked again just over 5
    // minutes ago, step 5) both became leads after the visit 2 minutes ago.
    assert.strictEqual(data.unseen, 2, 'leads that arrived after the visit count');
    console.log('ok - a lead that arrives after the visit counts as unseen');

    // 8. Looked again 2 minutes ago: still deciding, not counted (as on the page).
    const deciding = await makeUser('Deciding');
    await Analytics.insertMany([view(deciding, 60), view(deciding, 2)]);
    const before = (await newCount()).newLeads;
    await Analytics.deleteMany({ userId: deciding._id });
    assert.strictEqual((await newCount()).newLeads, before, 'someone looking right now is not counted');
    console.log('ok - someone still looking is not counted yet');

    // 9. Contacted about a recent product, an older one not: not new on the page.
    const mixed = await makeUser('Mixed');
    const other = await Product.create({
      name: `Other ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `NLO-${suffix}`, stock: 10, status: 'active',
    });
    made.products.push(other._id);
    await Analytics.insertMany([view(mixed, 60), view(mixed, 5 * 24 * 60, other)]);
    await LeadContact.create({ userId: mixed._id, productId: product._id, firstContactAt: minutesAgo(30), lastContactAt: minutesAgo(30), contactCount: 1 });
    const page = await call('GET', '/admin/analytics/potential-customers?period=7d&groupBy=person&limit=100');
    const row = page.json.data.people.find((p) => String(p.userId) === String(mixed._id));
    assert.ok(row, 'still to contact (one product is not contacted)');
    assert.strictEqual(row.isNew, false, 'not new: the recent product was contacted');
    console.log('ok - a contacted product does not make the person new');

    console.log('newLeads.test.js: all checks passed');
  } finally {
    await Analytics.deleteMany({});
    await LeadContact.deleteMany({});
    await Product.deleteMany({ _id: { $in: made.products } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

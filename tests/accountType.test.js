const assert = require('assert');

// Admin switches a wholesaler back to a customer (and a customer to a
// wholesaler): prices follow at once, open negotiations are left and counted,
// the customer is told, the reason is shared only when admin says so, and
// they can apply again.
//
//   ACCOUNT_TYPE_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_account_type_test?replicaSet=rs0' node tests/accountType.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.ACCOUNT_TYPE_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set ACCOUNT_TYPE_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: ACCOUNT_TYPE_TEST_MONGODB_URI must point at a database on this machine');
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

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const makeUser = async (role, extra = {}) => {
    const user = await M.User.create({ name: `AT ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const dealer = await makeUser('wholesaler', {
      businessInfo: { businessName: `Dealer ${suffix}`, gstNumber: '22AAXFV7313A1Z8', status: 'accepted', verified: true },
    });
    const buyer = await makeUser('buyer');
    const product = await M.Product.create({
      name: `AT Product ${suffix}`, category: 'at', mrp: 1000, retailPrice: 900, wholesalePrice: 700,
      sku: `AT-${suffix}`, stock: 100, status: 'active', minWholesaleQuantity: 1,
    });
    made.products.push(product._id);
    const id = String(product._id);
    const dealerId = String(dealer.user._id);

    // An open negotiation, left as it is by the switch.
    let res = await call('POST', '/negotiations', dealer.token, { productId: id, quantity: 5, pricePerUnit: 680 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    res = await call('GET', `/products/${id}`, dealer.token);
    assert.strictEqual(res.json.data.price, 700, 'wholesale price before');

    // 1. Only admins switch; wrong direction refused.
    res = await call('PUT', `/admin/customers/${dealerId}/account-type`, staff.token, { accountType: 'customer' });
    assert.strictEqual(res.status, 403, JSON.stringify(res.json));
    res = await call('PUT', `/admin/customers/${dealerId}/account-type`, admin.token, { accountType: 'wholesaler' });
    assert.strictEqual(codeOf(res), 'ALREADY_WHOLESALER');
    console.log('ok - only admins, only the other way');

    // 2. Switch to customer with a private reason.
    res = await call('PUT', `/admin/customers/${dealerId}/account-type`, admin.token, { accountType: 'customer', reason: 'GST not valid', showReasonToCustomer: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.role, 'buyer');
    assert.strictEqual(res.json.data.openNegotiations, 1);
    assert.strictEqual(res.json.data.businessInfo.status, 'removed');
    assert.strictEqual(res.json.data.businessInfo.businessName, `Dealer ${suffix}`, 'business details kept');
    assert.strictEqual(res.json.data.accountTypeHistory.length, 1);
    console.log('ok - switched to customer');

    // 3. Prices follow at once; the negotiation stays open.
    res = await call('GET', `/products/${id}`, dealer.token);
    assert.strictEqual(res.json.data.price, 900, 'customer price after');
    assert.strictEqual(res.json.data.negotiationRules, undefined);
    assert.strictEqual(await M.Negotiation.countDocuments({ wholesalerId: dealer.user._id, status: 'pending' }), 1);
    console.log('ok - customer prices at once, negotiation left open');

    // 4. The customer is told; a private reason and admin's history stay hidden.
    const note = await M.Notification.findOne({ userId: dealer.user._id }).sort({ createdAt: -1 }).lean();
    assert.ok(note, 'notification stored');
    assert.strictEqual(note.type, 'account_update');
    assert.ok(!note.body.includes('GST not valid'), 'private reason not in the notification');
    res = await call('GET', '/auth/me', dealer.token);
    assert.strictEqual(res.json.data.role, 'buyer');
    assert.strictEqual(res.json.data.businessInfo.removalReason, null, 'private reason hidden');
    assert.strictEqual(res.json.data.accountTypeHistory, undefined, 'history hidden');
    console.log('ok - customer told; private reason hidden');

    // 5. Admin sees it on the profile.
    res = await call('GET', `/admin/customers/${dealerId}`, admin.token);
    assert.strictEqual(res.json.data.businessInfo.removalReason, 'GST not valid');
    assert.strictEqual(res.json.data.openNegotiations, 1);
    assert.strictEqual(res.json.data.accountTypeHistory[0].byName, 'AT admin');
    console.log('ok - admin sees reason, history and open negotiations');

    // 6. Make them a wholesaler again, then back with a shared reason.
    res = await call('PUT', `/admin/customers/${dealerId}/account-type`, admin.token, { accountType: 'wholesaler' });
    assert.strictEqual(res.json.data.role, 'wholesaler');
    assert.strictEqual(res.json.data.businessInfo.status, 'accepted');
    res = await call('PUT', `/admin/customers/${dealerId}/account-type`, admin.token, { accountType: 'customer', reason: 'No orders in a year', showReasonToCustomer: true });
    assert.strictEqual(res.status, 200);
    res = await call('GET', '/auth/me', dealer.token);
    assert.strictEqual(res.json.data.businessInfo.removalReason, 'No orders in a year', 'shared reason shown');
    const shared = await M.Notification.findOne({ userId: dealer.user._id }).sort({ createdAt: -1 }).lean();
    assert.ok(shared.body.includes('No orders in a year'));
    console.log('ok - shared reason reaches the customer');

    // 7. A customer made a wholesaler directly, without applying.
    res = await call('PUT', `/admin/customers/${buyer.user._id}/account-type`, admin.token, { accountType: 'wholesaler' });
    assert.strictEqual(res.json.data.role, 'wholesaler');
    res = await call('GET', `/products/${id}`, buyer.token);
    assert.strictEqual(res.json.data.price, 700);
    console.log('ok - customer made a wholesaler directly');
  } finally {
    await M.Notification.deleteMany({ userId: { $in: made.users } });
    await M.Negotiation.deleteMany({ productId: { $in: made.products } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS accountType');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');

// Affiliate codes, end to end: a code used at checkout earns a commission
// when the payment is verified; admin marks it paid; cancelling reverses it
// and gives the use back; limits hold even for two checkouts at once; a
// code with orders can't be renamed or deleted; the daily job records a
// commission that was missed; totals cover every code.
//
//   AFFILIATE_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_affiliate_test?replicaSet=rs0' node tests/affiliate.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.AFFILIATE_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set AFFILIATE_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: AFFILIATE_TEST_MONGODB_URI must point at a database on this machine');
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
  const { backfillMissingCommissions } = require('../src/services/affiliateCommissionService');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36).toUpperCase();
  const made = { users: [], products: [], codes: [], offers: [] };
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: res.status, json, text };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const makeUser = async (role) => {
    const user = await M.User.create({ name: `AF ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const buyer2 = await makeUser('buyer');
    const product = await M.Product.create({
      name: `AF Pump ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 1000, wholesalePrice: 800,
      sku: `AF-${suffix}`, stock: 100, status: 'active',
    });
    made.products.push(product._id);
    const order = async (who, code, quantity = 1) => call('POST', '/orders', who.token, {
      items: [{ productId: String(product._id), quantity }], shippingAddress: address, couponCode: code,
    });
    const confirmAndVerify = async (orderId) => {
      let res = await call('PUT', `/admin/orders/${orderId}/confirm`, admin.token, { deliveryCharge: 0 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      const payment = await M.Payment.findOne({ orderId }).lean();
      res = await call('PUT', `/admin/payments/${payment._id}/verify`, admin.token, {});
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    };

    // Code: 10% off, 1 use per customer.
    let res = await call('POST', '/admin/affiliate-codes', admin.token, {
      code: `RAM${suffix}`, personName: 'Ramesh', discountType: 'percentage', discountValue: 10, perCustomerLimit: 1,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const code = res.json.data;
    made.codes.push(code._id);

    // 1. Used at checkout: the order is linked to the code; commission on payment.
    res = await order(buyer, code.code);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const orderId = res.json.data.orderId || res.json.data._id || res.json.data.id;
    let saved = await M.Order.findById(orderId).lean();
    assert.strictEqual(String(saved.affiliateCodeId), String(code._id));
    assert.strictEqual(saved.discount, 100);
    assert.strictEqual((await M.AffiliateCode.findById(code._id)).usageCount, 1);
    await confirmAndVerify(orderId);
    let commission = await M.AffiliateCommission.findOne({ orderId }).lean();
    assert.strictEqual(commission.commissionAmount, 30, '30% of the ₹100 discount');
    assert.strictEqual(commission.status, 'unpaid');
    console.log('ok - order linked to the code; commission recorded on payment');

    // 2. Per-customer limit.
    res = await order(buyer, code.code);
    assert.strictEqual(codeOf(res), 'COUPON_ALREADY_USED', JSON.stringify(res.json));
    console.log('ok - per-customer limit');

    // 3. Summary covers all codes; mark paid; CSV export.
    res = await call('GET', '/admin/affiliate-summary', admin.token);
    assert.ok(res.json.data.pending.amount >= 30, JSON.stringify(res.json));
    res = await call('POST', '/admin/affiliate-commissions/pay', admin.token, { ids: [String(commission._id)], reference: 'UPI-123' });
    assert.strictEqual(res.json.data.paid, 1, JSON.stringify(res.json));
    res = await call('POST', '/admin/affiliate-commissions/pay', admin.token, { ids: [String(commission._id)] });
    assert.strictEqual(res.json.data.paid, 0, 'paid only once');
    commission = await M.AffiliateCommission.findById(commission._id).lean();
    assert.strictEqual(commission.status, 'paid');
    assert.strictEqual(commission.payoutReference, 'UPI-123');
    res = await call('GET', `/admin/affiliate-commissions/export?affiliateCode=${code.code}`, admin.token);
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('"Paid"') && res.text.includes('"UPI-123"'), res.text.slice(0, 300));
    console.log('ok - summary, mark paid, CSV export');

    // 4. Cancelled: commission reversed (was paid: to recover), use given back.
    res = await call('PUT', `/admin/orders/${orderId}/status`, admin.token, { status: 'cancelled', note: 'Customer changed mind' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    commission = await M.AffiliateCommission.findById(commission._id).lean();
    assert.strictEqual(commission.status, 'reversed');
    assert.strictEqual(commission.wasPaidBeforeReversal, true);
    const codeAfter = await M.AffiliateCode.findById(code._id).lean();
    assert.strictEqual(codeAfter.usageCount, 0, 'use given back');
    assert.strictEqual(codeAfter.totalCommissionAccrued, 0);
    res = await call('GET', '/admin/affiliate-summary', admin.token);
    assert.ok(res.json.data.toRecover.amount >= 30);
    // The cancelled order no longer counts toward the customer's limit.
    res = await order(buyer, code.code);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    console.log('ok - cancelling reverses the commission and gives the use back');

    // 5. A code with orders can't be renamed or deleted; offer codes can't clash.
    res = await call('PUT', `/admin/affiliate-codes/${code._id}`, admin.token, { code: `NEW${suffix}` });
    assert.strictEqual(codeOf(res), 'AFFILIATE_CODE_IN_USE');
    res = await call('DELETE', `/admin/affiliate-codes/${code._id}`, admin.token);
    assert.strictEqual(codeOf(res), 'AFFILIATE_CODE_IN_USE');
    res = await call('POST', '/admin/offers', admin.token, { title: 'Clash', code: code.code, discountType: 'percentage', discountValue: 5, targetGroup: 'all' });
    assert.strictEqual(codeOf(res), 'CODE_USED_BY_AFFILIATE', JSON.stringify(res.json));
    console.log('ok - rename/delete blocked once used; no clash with offers');

    // 6. Usage limit holds for two checkouts at once.
    res = await call('POST', '/admin/affiliate-codes', admin.token, { code: `ONE${suffix}`, personName: 'Sita', discountType: 'percentage', discountValue: 5, usageLimit: 1 });
    made.codes.push(res.json.data._id);
    const race = await Promise.all([order(buyer, `ONE${suffix}`), order(buyer2, `ONE${suffix}`)]);
    assert.deepStrictEqual(race.map((r) => r.status).sort(), [201, 400], JSON.stringify(race.map((r) => r.json)));
    assert.strictEqual((await M.AffiliateCode.findById(res.json.data._id)).usageCount, 1);
    console.log('ok - the last use goes to one checkout only');

    // 7. A commission missed at payment is recorded by the daily job.
    const placed = race.find((r) => r.status === 201);
    const missedId = placed.json.data.orderId || placed.json.data._id || placed.json.data.id;
    await confirmAndVerify(missedId);
    await M.AffiliateCommission.deleteOne({ orderId: missedId });
    const job = await backfillMissingCommissions();
    assert.ok(job.credited >= 1, JSON.stringify(job));
    assert.ok(await M.AffiliateCommission.exists({ orderId: missedId }));
    console.log('ok - daily job records a missed commission');
  } finally {
    const orders = await M.Order.find({ userId: { $in: made.users } }).select('_id').lean();
    await M.AffiliateCommission.deleteMany({ orderId: { $in: orders.map((o) => o._id) } });
    await M.Payment.deleteMany({ orderId: { $in: orders.map((o) => o._id) } });
    await M.Order.deleteMany({ userId: { $in: made.users } });
    await M.AffiliateCode.deleteMany({ _id: { $in: made.codes } });
    await M.Offer.deleteMany({ title: 'Clash' });
    await M.Cart.deleteMany({ userId: { $in: made.users } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS affiliate');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

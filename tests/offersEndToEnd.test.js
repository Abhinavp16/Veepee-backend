const assert = require('assert');

// Offers end to end, the way the app uses them: coupons for customers and
// wholesalers (percentage, fixed, cap, minimum, tiers, dates, on/off, who
// it's for), a coupon on a price-request order and on a requirement, the
// shop's extra discount at confirmation, affiliate (referral) codes, and
// brand / category discounts. Affiliate commissions and sales have their
// own tests (affiliate.test.js, sales.test.js).
//
//   OFFERS_E2E_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_offers_e2e_test?replicaSet=rs0' node tests/offersEndToEnd.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.OFFERS_E2E_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set OFFERS_E2E_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: OFFERS_E2E_TEST_MONGODB_URI must point at a database on this machine');
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
  await M.Order.syncIndexes();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36).toUpperCase();
  const made = { users: [], products: [], offers: [], codes: [], companies: [], categories: [], negotiations: [] };
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };
  const hour = 60 * 60 * 1000;

  const makeUser = async (role, extra = {}) => {
    const user = await M.User.create({ name: `Offer ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  let skus = 0;
  const makeProduct = async (name, extra = {}) => {
    skus += 1;
    const product = await M.Product.create({
      name: `${name} ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `OFF-${suffix}-${skus}`, stock: 1000, status: 'active', ...extra,
    });
    made.products.push(product._id);
    return product;
  };
  const makeOffer = async (fields) => {
    const offer = await M.Offer.create({ title: 'Test offer', startDate: new Date(Date.now() - hour), ...fields });
    made.offers.push(offer._id);
    return offer;
  };
  const order = (token, product, quantity, couponCode) => call('POST', '/orders', token, {
    items: [{ productId: String(product._id), quantity }], shippingAddress: address, ...(couponCode && { couponCode }),
  });
  const preview = (token, product, quantity, couponCode) => call('POST', '/orders/preview-coupon', token, {
    couponCode, items: [{ productId: String(product._id), quantity }],
  });
  const codeOf = (res) => res.json.error?.code || res.json.code;

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const buyer2 = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler', { businessInfo: { businessName: 'Test Traders', gstin: '22AAAAA0000A1Z5' } });
    const pump = await makeProduct('Pump'); // customer 900, wholesaler 800, MRP 1000

    // 1. Listing: only live coupons, for the right people.
    const forAll = await makeOffer({ code: `ALL${suffix}`, discountType: 'percentage', discountValue: 10, targetGroup: 'all' });
    const forBuyers = await makeOffer({ code: `BUY${suffix}`, discountType: 'fixed', discountValue: 150, targetGroup: 'buyer', minPurchaseAmount: 1500 });
    const forWholesalers = await makeOffer({ code: `WS${suffix}`, discountType: 'percentage', discountValue: 5, targetGroup: 'wholesaler', maxDiscountAmount: 300 });
    const expired = await makeOffer({ code: `OLD${suffix}`, discountValue: 50, startDate: new Date(Date.now() - 48 * hour), endDate: new Date(Date.now() - hour) });
    const future = await makeOffer({ code: `NEW${suffix}`, discountValue: 50, startDate: new Date(Date.now() + 24 * hour) });
    const off = await makeOffer({ code: `OFF${suffix}`, discountValue: 50, isActive: false });
    const tiers = await makeOffer({
      code: `TIER${suffix}`, discountValue: 0, targetGroup: 'all',
      discountRules: [
        { minPurchaseAmount: 1000, discountType: 'percentage', discountValue: 5 },
        { minPurchaseAmount: 5000, discountType: 'percentage', discountValue: 10, maxDiscountAmount: 700 },
      ],
    });
    const listed = async (group) => {
      const res = await call('GET', `/offers?targetGroup=${group}`);
      assert.strictEqual(res.status, 200);
      return res.json.data.map((o) => o.code).filter((c) => c && c.endsWith(suffix)).sort();
    };
    assert.deepStrictEqual(await listed('buyer'), [forAll.code, forBuyers.code, tiers.code].sort());
    assert.deepStrictEqual(await listed('wholesaler'), [forAll.code, tiers.code, forWholesalers.code].sort());
    console.log('ok 1 - the app lists only live coupons, for customers or wholesalers');

    // 2. Customer coupon (%): preview, order, count, confirmation total.
    let res = await preview(buyer.token, pump, 2, forAll.code.toLowerCase());
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.subtotal, 1800);
    assert.strictEqual(res.json.data.discount, 180);
    assert.strictEqual(res.json.data.payableTotal, 1620);
    res = await order(buyer.token, pump, 2, forAll.code);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    let placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.discount, 180);
    assert.strictEqual(placed.total, 1620);
    assert.strictEqual(placed.offerCode, forAll.code);
    assert.strictEqual(placed.discountSource, 'offer');
    assert.strictEqual((await M.Offer.findById(forAll._id).lean()).usageCount, 1);
    res = await call('PUT', `/admin/orders/${placed._id}/confirm`, admin.token, { deliveryCharge: 200, extraDiscount: 5, extraDiscountType: 'percent' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    placed = await M.Order.findById(placed._id).lean();
    // 1,800 − 180 coupon = 1,620; extra 5% of that = 81; + 200 delivery.
    assert.strictEqual(placed.extraDiscount, 81);
    assert.strictEqual(placed.total, 1800 - 180 - 81 + 200);
    const payment = await M.Payment.findOne({ orderId: placed._id }).lean();
    assert.strictEqual(payment.amount, placed.total, 'the payment asks for the confirmed total');
    console.log('ok 2 - customer % coupon: preview, order, usage count, confirmed total with delivery and extra discount');

    // 3. Fixed coupon with a minimum; tiers pick the best one reached, capped.
    res = await preview(buyer.token, pump, 1, forBuyers.code);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'COUPON_MIN_PURCHASE_NOT_MET');
    assert.match(res.json.message, /1500/);
    res = await preview(buyer.token, pump, 2, forBuyers.code);
    assert.strictEqual(res.json.data.discount, 150);
    res = await preview(buyer.token, pump, 2, tiers.code); // 1,800: 5%
    assert.strictEqual(res.json.data.discount, 90);
    res = await preview(buyer.token, pump, 10, tiers.code); // 9,000: 10% = 900, capped at 700
    assert.strictEqual(res.json.data.discount, 700);
    res = await preview(buyer.token, pump, 1, tiers.code); // 900: below every tier
    assert.strictEqual(codeOf(res), 'COUPON_MIN_PURCHASE_NOT_MET');
    console.log('ok 3 - fixed amount, minimum purchase, tiers and the cap');

    // 4. Who and when: wrong group, expired, not started, switched off.
    for (const [who, code] of [[buyer, forWholesalers.code], [wholesaler, forBuyers.code], [buyer, expired.code], [buyer, future.code], [buyer, off.code], [buyer, 'NOSUCHCODE']]) {
      // Wholesalers buy at least 10.
      res = await order(who.token, pump, who === wholesaler ? 20 : 2, code);
      assert.strictEqual(res.status, 400, `${code}: ${JSON.stringify(res.json)}`);
      assert.strictEqual(codeOf(res), 'INVALID_COUPON', code);
    }
    console.log('ok 4 - refused: the other group\'s coupon, expired, not started, switched off, unknown');

    // 5. Wholesaler coupon on a normal order (capped).
    res = await order(wholesaler.token, pump, 10, forWholesalers.code); // 8,000: 5% = 400, cap 300
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.subtotal, 8000);
    assert.strictEqual(placed.discount, 300);
    console.log('ok 5 - wholesaler coupon on a normal order, capped');

    // 6. Price-request orders take no coupon or affiliate code; without one
    //    they are placed at the agreed price.
    const negotiation = await M.Negotiation.create({
      wholesalerId: wholesaler.user._id, productId: pump._id, productSnapshot: { name: pump.name, price: 800 },
      requestedQuantity: 10, requestedPricePerUnit: 700, requestedTotalPrice: 7000,
      status: 'accepted', finalPricePerUnit: 700, finalTotalPrice: 7000, expiresAt: new Date(Date.now() + 24 * hour),
    });
    made.negotiations.push(negotiation._id);
    const wsUsesBefore = (await M.Offer.findById(forWholesalers._id).lean()).usageCount;
    res = await call('POST', '/orders/from-negotiation', wholesaler.token, { negotiationId: String(negotiation._id), shippingAddress: address, couponCode: forWholesalers.code });
    assert.strictEqual(res.status, 400, JSON.stringify(res.json));
    assert.strictEqual(codeOf(res), 'COUPON_NOT_FOR_PRICE_REQUESTS');
    assert.strictEqual((await M.Negotiation.findById(negotiation._id).lean()).orderId, null, 'still free to order');
    res = await call('POST', '/orders/from-negotiation', wholesaler.token, { negotiationId: String(negotiation._id), shippingAddress: address });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.subtotal, 7000);
    assert.strictEqual(placed.discount, 0);
    assert.strictEqual(placed.total, 7000);
    assert.strictEqual((await M.Offer.findById(forWholesalers._id).lean()).usageCount, wsUsesBefore);

    const pipe = await makeProduct('Pipe');
    const groupId = require('crypto').randomUUID();
    for (const product of [pump, pipe]) {
      const n = await M.Negotiation.create({
        wholesalerId: wholesaler.user._id, productId: product._id, productSnapshot: { name: product.name, price: 800 },
        requestedQuantity: 5, requestedPricePerUnit: 750, requestedTotalPrice: 3750,
        status: 'accepted', finalPricePerUnit: 750, finalTotalPrice: 3750, expiresAt: new Date(Date.now() + 24 * hour),
        requestGroup: { id: groupId, number: `REQ-${suffix}` },
      });
      made.negotiations.push(n._id);
    }
    const refCode = await M.AffiliateCode.create({ code: `REQREF${suffix}`, personName: 'Mohan', discountValue: 5, isActive: true });
    made.codes.push(refCode._id);
    for (const couponCode of [forAll.code, refCode.code]) {
      res = await call('POST', '/orders/from-group', wholesaler.token, { groupId, shippingAddress: address, couponCode });
      assert.strictEqual(res.status, 400, JSON.stringify(res.json));
      assert.strictEqual(codeOf(res), 'COUPON_NOT_FOR_PRICE_REQUESTS');
    }
    res = await call('POST', '/orders/from-group', wholesaler.token, { groupId, shippingAddress: address });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.total, 7500);
    assert.strictEqual(placed.discount, 0);
    console.log('ok 6 - price-request orders refuse coupons and affiliate codes, and go through at the agreed price without one');

    // 7. Limits: once per customer, and a total number of uses.
    const once = await makeOffer({ code: `ONCE${suffix}`, discountValue: 10, targetGroup: 'all', perCustomerLimit: 1, usageLimit: 2 });
    res = await order(buyer.token, pump, 2, once.code);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const firstOnce = res.json.data.orderId;
    res = await preview(buyer.token, pump, 2, once.code);
    assert.strictEqual(codeOf(res), 'COUPON_ALREADY_USED', 'the preview says so too');
    res = await order(buyer.token, pump, 2, once.code);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'COUPON_ALREADY_USED');
    res = await order(buyer2.token, pump, 2, once.code);
    assert.strictEqual(res.status, 201, 'another customer can');
    const third = await makeUser('buyer');
    res = await order(third.token, pump, 2, once.code);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'COUPON_LIMIT_REACHED');
    assert.strictEqual((await M.Offer.findById(once._id).lean()).usageCount, 2);
    // Rejected: the use comes back, to the customer and to the total.
    res = await call('PUT', `/admin/orders/${firstOnce}/reject`, admin.token, { reason: 'test' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual((await M.Offer.findById(once._id).lean()).usageCount, 1);
    res = await order(third.token, pump, 2, once.code);
    assert.strictEqual(res.status, 201, 'the freed use can be taken');
    res = await order(buyer.token, pump, 2, once.code);
    assert.strictEqual(codeOf(res), 'COUPON_LIMIT_REACHED', 'full again');
    // Two checkouts at once for the last use: one gets it.
    const race = await makeOffer({ code: `RACE${suffix}`, discountValue: 10, targetGroup: 'all', usageLimit: 1 });
    const racers = [await makeUser('buyer'), await makeUser('buyer')];
    const both = await Promise.all(racers.map((r) => order(r.token, pump, 2, race.code)));
    assert.strictEqual(both.filter((r) => r.status === 201).length, 1, JSON.stringify(both.map((r) => r.status)));
    assert.strictEqual((await M.Offer.findById(race._id).lean()).usageCount, 1);
    console.log('ok 7 - once per customer, total uses (also when two check out at once), and a rejected order gives its use back');

    // 8. Affiliate (referral) code: discount, then switched off.
    const code = await M.AffiliateCode.create({ code: `REF${suffix}`, personName: 'Ravi', discountType: 'percentage', discountValue: 8, isActive: true });
    made.codes.push(code._id);
    res = await order(buyer2.token, pump, 2, code.code.toLowerCase());
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.discountSource, 'affiliate');
    assert.strictEqual(placed.affiliateCode, code.code);
    assert.strictEqual(placed.discount, 144);
    assert.strictEqual((await M.AffiliateCode.findById(code._id).lean()).usageCount, 1);
    await M.AffiliateCode.updateOne({ _id: code._id }, { $set: { isActive: false } });
    res = await order(buyer2.token, pump, 2, code.code);
    assert.strictEqual(res.status, 400);
    console.log('ok 8 - affiliate / referral code: discount, use counted, refused once switched off');

    // 9. Brand and category discounts (% off MRP), set from admin.
    const brand = await M.Company.create({ name: `Offer Brand ${suffix}` });
    made.companies.push(brand._id);
    const category = await M.Category.create({ name: `Offer Cat ${suffix}` });
    made.categories.push(category._id);
    const branded = await makeProduct('Branded', { company: brand._id, categoryIds: [category._id], primaryCategoryId: category._id, category: category.slug });
    const plain = await makeProduct('Plain', { categoryIds: [category._id], primaryCategoryId: category._id, category: category.slug });
    res = await call('PUT', `/admin/discounts/company/${brand._id}`, admin.token, { customerDiscountPercent: 15, wholesalerDiscountPercent: 25 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('PUT', `/admin/discounts/category/${category._id}`, admin.token, { customerDiscountPercent: 12 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const priceOf = async (product, token) => (await call('GET', `/products/${product._id}`, token)).json.data;
    assert.strictEqual((await priceOf(branded, buyer.token)).price, 850, 'brand 15% off MRP');
    assert.strictEqual((await priceOf(branded, wholesaler.token)).price, 750, 'brand 25% off MRP for wholesalers');
    assert.strictEqual((await priceOf(plain, buyer.token)).price, 880, 'category 12% off MRP');
    assert.strictEqual((await priceOf(plain, wholesaler.token)).price, 800, 'no wholesaler category discount: their normal price');
    res = await order(buyer.token, branded, 2, forAll.code);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    placed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(placed.items[0].pricePerUnit, 850);
    assert.strictEqual(placed.discount, 170, 'coupon on top of the brand price');
    console.log('ok 9 - brand beats category; customers and wholesalers each get theirs; checkout charges it; a coupon stacks on it');

    // 10. A discount never makes a product dearer than its normal price.
    res = await call('PUT', `/admin/discounts/company/${brand._id}`, admin.token, { customerDiscountPercent: 5, wholesalerDiscountPercent: 10 });
    assert.strictEqual(res.status, 200);
    let shown = await priceOf(branded, buyer.token);
    assert.strictEqual(shown.price, 900, '5% off MRP is 950: the normal 900 stays');
    assert.strictEqual(shown.discountPercent || 0, 0);
    shown = await priceOf(branded, wholesaler.token);
    assert.strictEqual(shown.price, 800, '10% off MRP is 900: the normal 800 stays');
    res = await order(buyer.token, branded, 1);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual((await M.Order.findById(res.json.data.orderId).lean()).items[0].pricePerUnit, 900);
    console.log('ok 10 - a small brand discount no longer raises the price (customer ₹900, wholesaler ₹800)');

    // 11. Cancelled by the shop after confirming: the use comes back.
    const before = (await M.Offer.findById(forAll._id).lean()).usageCount;
    res = await order(buyer2.token, pump, 1, forAll.code);
    const cancelId = res.json.data.orderId;
    assert.strictEqual((await M.Offer.findById(forAll._id).lean()).usageCount, before + 1);
    res = await call('PUT', `/admin/orders/${cancelId}/confirm`, admin.token, { deliveryCharge: 0 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('PUT', `/admin/orders/${cancelId}/status`, admin.token, { status: 'cancelled' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual((await M.Offer.findById(forAll._id).lean()).usageCount, before);
    // Cancelling twice gives back only once.
    await call('PUT', `/admin/orders/${cancelId}/status`, admin.token, { status: 'cancelled' });
    assert.strictEqual((await M.Offer.findById(forAll._id).lean()).usageCount, before);
    console.log('ok 11 - a cancelled order gives its coupon use back, once');

    console.log('offers end-to-end: all checks passed');
  } finally {
    await M.Payment.deleteMany({ userId: { $in: made.users } });
    await M.AffiliateCommission.deleteMany({ affiliateCodeId: { $in: made.codes } });
    await M.Order.deleteMany({ userId: { $in: made.users } });
    await M.Negotiation.deleteMany({ _id: { $in: made.negotiations } });
    await M.Cart.deleteMany({ userId: { $in: made.users } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.Offer.deleteMany({ _id: { $in: made.offers } });
    await M.AffiliateCode.deleteMany({ _id: { $in: made.codes } });
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

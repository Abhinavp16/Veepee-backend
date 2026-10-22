const assert = require('assert');

// Sale pages: live sale prices everywhere (only when lower), never in price
// requests; sale quantity and "max per person" taken atomically at checkout
// and given back on cancel / not confirmed / unpaid; "prices changed" stops an
// order the buyer didn't see; coupons cover only what isn't on sale; one sale
// at a time; sale banners only while live; announcement in each language.
//
//   SALES_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_sales_test?replicaSet=rs0' node tests/sales.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.SALES_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set SALES_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: SALES_TEST_MONGODB_URI must point at a database on this machine');
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
  const saleService = require('../src/services/saleService');

  await connectDB();
  await Promise.all([M.Order.syncIndexes(), M.SaleClaim.syncIndexes()]);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [], sales: [], offers: [] };
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };
  const hour = 60 * 60 * 1000;

  const makeUser = async (role, extra = {}) => {
    const user = await M.User.create({ name: `Sale ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
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
  const makeProduct = async (name, extra = {}) => {
    const product = await M.Product.create({
      name: `${name} ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `SALE-${name}-${suffix}`.replace(/\s/g, ''), stock: 100, status: 'active', ...extra,
    });
    made.products.push(product._id);
    return product;
  };
  const buyNow = (product, quantity, extra = {}) => ({ items: [{ productId: String(product._id), quantity }], shippingAddress: address, ...extra });
  const priceOf = async (product, token) => {
    const res = await call('GET', `/products/${product._id}`, token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    return res.json.data;
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer');
    const buyer2 = await makeUser('buyer', { preferredLanguage: 'hi' });
    const wholesaler = await makeUser('wholesaler');

    const pump = await makeProduct('Pump');
    const pipe = await makeProduct('Pipe');
    const nozzle = await makeProduct('Nozzle', { retailPrice: 600 }); // already cheaper than a 20% sale
    const hoe = await makeProduct('Hoe'); // not in the sale

    // 1. A draft changes nothing; staff can't create a sale.
    const saleBody = {
      name: `Diwali ${suffix}`, nameHindi: 'दिवाली सेल', theme: 'diwali', audience: 'both',
      customerPercent: 20, wholesalerPercent: 25,
      startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + 24 * hour).toISOString(),
      status: 'draft',
      products: [
        { productId: String(pump._id), saleQuantity: 3 },
        { productId: String(pipe._id), customerPercent: 30, perPersonLimit: 2 },
        { productId: String(nozzle._id) },
      ],
    };
    let res = await call('POST', '/admin/sales', staff.token, saleBody);
    assert.strictEqual(res.status, 403, 'staff cannot create sales');
    res = await call('POST', '/admin/sales', admin.token, saleBody);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const saleId = String(res.json.data.id);
    made.sales.push(saleId);
    assert.strictEqual(res.json.data.status, 'draft');
    const nozzleRow = res.json.data.products.find((row) => String(row.productId) === String(nozzle._id));
    assert.ok(nozzleRow.warnings.some((w) => w.code === 'no_saving'), 'editor warns the sale is not cheaper');
    assert.strictEqual((await priceOf(pump, buyer.token)).price, 900, 'a draft does nothing');
    res = await call('GET', '/admin/sales', staff.token);
    assert.strictEqual(res.status, 200, 'staff can look');
    console.log('1. drafts change nothing; only admins edit; editor warns "not cheaper"');

    // 2. Published and live: sale prices for each role, never dearer, not in price requests.
    res = await call('PUT', `/admin/sales/${saleId}`, admin.token, { ...saleBody, status: 'published' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.status, 'live');
    let card = await priceOf(pump, buyer.token);
    assert.strictEqual(card.price, 800, 'customer: 20% off MRP 1000');
    assert.strictEqual(card.sale.percent, 20);
    assert.strictEqual(card.sale.name, saleBody.name);
    assert.strictEqual((await priceOf(pipe, buyer.token)).price, 700, 'the product\'s own 30%');
    assert.strictEqual((await priceOf(nozzle, buyer.token)).price, 600, 'never dearer: normal 600 beats 800');
    assert.strictEqual((await priceOf(nozzle, buyer.token)).sale, null);
    card = await priceOf(pump, wholesaler.token);
    assert.strictEqual(card.price, 750, 'wholesaler: 25% off MRP');
    assert.strictEqual(card.negotiationPrice, 800, 'price requests start from the normal price');
    assert.strictEqual((await priceOf(pump)).price, 1000, 'guests see only the MRP (guest prices off)');
    res = await call('GET', `/products?limit=50`, buyer.token);
    const listed = res.json.data.find((p) => String(p.id) === String(pump._id));
    assert.strictEqual(listed.price, 800, 'lists show the sale price too');
    console.log('2. live sale: customer/wholesaler %, own %, never dearer, guests, lists, price requests at normal price');

    // 2b. The website's category products carry the sale (badge and price), only where it's cheaper
    // (with customer prices shown to guests; tests/guestPricing.test.js covers the switch off).
    res = await call('PUT', '/admin/settings', admin.token, { features: { showCustomerPriceToGuests: true } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    await M.WebsiteSettings.updateOne(
      { _id: 'website_settings' },
      { $set: { productCategories: [{ name: `Pumps ${suffix}`, isActive: true, order: 0, products: [], productDetails: [
        { productId: String(pump._id), order: 0 },
        { productId: String(nozzle._id), order: 1 },
        { productId: String(hoe._id), order: 2 },
      ] }] } },
      { upsert: true },
    );
    res = await call('GET', '/settings/website-content');
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const websiteProducts = res.json.data.productCategories[0].productDetails;
    const onWebsite = (product) => websiteProducts.find((p) => p.productId === String(product._id));
    assert.strictEqual(onWebsite(pump).salePrice, 800, 'website: the customer sale price');
    assert.strictEqual(onWebsite(pump).sale.percent, 20);
    assert.strictEqual(onWebsite(pump).sale.name, saleBody.name);
    assert.strictEqual(onWebsite(pump).retailPrice, 900, 'the normal price stays as it was');
    res = await call('PUT', '/admin/settings', admin.token, { features: { showCustomerPriceToGuests: false } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(onWebsite(nozzle).sale, undefined, 'no badge where the sale isn\'t cheaper');
    assert.strictEqual(onWebsite(hoe).sale, undefined, 'no badge outside the sale');
    console.log('2b. website category products: sale price and badge only where the sale applies');

    // 3. Public sale pages.
    res = await call('GET', '/sales/live', buyer.token);
    assert.strictEqual(res.json.data.length, 1);
    assert.strictEqual(String(res.json.data[0].id), saleId);
    assert.strictEqual(res.json.data[0].upToPercent, 30);
    res = await call('GET', `/sales/${saleId}/products`, wholesaler.token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.length, 3);
    assert.strictEqual(res.json.data.find((p) => String(p.id) === String(pipe._id)).salePerPersonLimit, 2);
    console.log('3. sale page and Home strip endpoints');

    // 4. Checkout at the sale price records the sale and takes units.
    res = await call('POST', '/orders', buyer.token, buyNow(pump, 2, { expectedPrices: [{ productId: String(pump._id), price: 800 }] }));
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const order1 = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(order1.items[0].pricePerUnit, 800);
    assert.strictEqual(String(order1.items[0].saleId), saleId);
    let sale = await M.Sale.findById(saleId).lean();
    let pumpEntry = sale.products.find((p) => String(p.productId) === String(pump._id));
    assert.deepStrictEqual([pumpEntry.sold, pumpEntry.remaining], [2, 1]);
    console.log('4. order at the sale price; units taken');

    // 5. Two buyers race for the last unit: one gets it, the other is told.
    const race = await Promise.all([buyer, buyer2].map((b) => call('POST', '/orders', b.token, buyNow(pump, 1, {
      expectedPrices: [{ productId: String(pump._id), price: 800 }],
    }))));
    assert.strictEqual(race.filter((r) => r.status === 201).length, 1, JSON.stringify(race.map((r) => [r.status, r.json.error?.code])));
    const lost = race.find((r) => r.status !== 201);
    assert.strictEqual(lost.status, 409);
    assert.strictEqual(lost.json.error.code, 'PRICE_CHANGED');
    assert.strictEqual(lost.json.error.details.items[0].price, 900, 'the new price is the normal one');
    sale = await M.Sale.findById(saleId).lean();
    pumpEntry = sale.products.find((p) => String(p.productId) === String(pump._id));
    assert.deepStrictEqual([pumpEntry.sold, pumpEntry.remaining], [3, 0], 'never oversold');
    assert.strictEqual((await priceOf(pump, buyer.token)).price, 900, 'sold out: back to the normal price');
    // Without expected prices (older apps) the line just pays the normal price.
    res = await call('POST', '/orders', buyer2.token, buyNow(pump, 1));
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await M.Order.findById(res.json.data.orderId).lean()).items[0].saleId, null);
    console.log('5. last unit: one winner, the other gets PRICE_CHANGED; normal price after');

    // 6. Max per person: a line over the limit pays the normal price.
    res = await call('POST', '/orders', buyer.token, buyNow(pipe, 3, { expectedPrices: [{ productId: String(pipe._id), price: 700 }] }));
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error.details.items[0].reason, 'sale_limit');
    res = await call('POST', '/orders', buyer.token, buyNow(pipe, 2, { expectedPrices: [{ productId: String(pipe._id), price: 700 }] }));
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const pipeOrderId = res.json.data.orderId;
    res = await call('POST', '/orders', buyer.token, buyNow(pipe, 1));
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await M.Order.findById(res.json.data.orderId).lean()).items[0].pricePerUnit, 900, 'over the limit: normal price');
    // The cart says why.
    await M.Cart.create({ userId: buyer.user._id, items: [{ productId: pipe._id, quantity: 1, priceAtAdd: 700 }] });
    res = await call('GET', '/cart', buyer.token);
    assert.strictEqual(res.json.data.items[0].product.saleNote.reason, 'limit');
    assert.strictEqual(res.json.data.items[0].currentPrice, 900);
    await M.Cart.deleteOne({ userId: buyer.user._id });
    console.log('6. max per person; the cart explains the normal price');

    // 7. Not confirmed / cancelled orders give units and the per-person share back.
    res = await call('PUT', `/admin/orders/${pipeOrderId}/reject`, staff.token, { reason: 'Out of area' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const claim = await M.SaleClaim.findOne({ saleId, productId: pipe._id, userId: buyer.user._id }).lean();
    assert.strictEqual(claim.quantity, 0, 'the share is back');
    res = await call('PUT', `/admin/orders/${order1._id}/status`, admin.token, { status: 'cancelled', note: 'test' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    sale = await M.Sale.findById(saleId).lean();
    pumpEntry = sale.products.find((p) => String(p.productId) === String(pump._id));
    assert.deepStrictEqual([pumpEntry.sold, pumpEntry.remaining], [1, 2], 'cancelled units are back');
    console.log('7. reject and cancel give units and per-person shares back');

    // 8. Coupons cover only what isn't on sale.
    const offer = await M.Offer.create({ title: 'Ten', discountType: 'percentage', discountValue: 10, code: `TEN${suffix}`.toUpperCase(), targetGroup: 'all', startDate: new Date(Date.now() - hour) });
    made.offers.push(offer._id);
    res = await call('POST', '/orders/preview-coupon', buyer2.token, { couponCode: offer.code, items: [{ productId: String(pump._id), quantity: 1 }] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error.code, 'COUPON_SALE_ITEMS');
    res = await call('POST', '/orders', buyer2.token, {
      items: [{ productId: String(pump._id), quantity: 1 }, { productId: String(hoe._id), quantity: 1 }],
      shippingAddress: address, couponCode: offer.code,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const mixed = await M.Order.findById(res.json.data.orderId).lean();
    assert.strictEqual(mixed.subtotal, 800 + 900);
    assert.strictEqual(mixed.discount, 90, '10% of the hoe only');
    console.log('8. coupons skip sale lines');

    // 9. One sale at a time.
    res = await call('POST', '/admin/sales', admin.token, { ...saleBody, name: `Flash ${suffix}`, status: 'published' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error.code, 'SALE_OVERLAP');
    console.log('9. only one sale runs at a time');

    // 10. Sale banners show only while live, for the sale's audience.
    const settings = await M.Settings.getSettings();
    const keptBanners = settings.heroBanners;
    settings.heroBanners = [
      { title: 'Plain', imageUrl: 'https://example.com/a.jpg', linkUrl: '/product/x', isActive: true, order: 0 },
      { title: 'Sale', imageUrl: 'https://example.com/b.jpg', linkUrl: `/sale/${saleId}`, isActive: true, order: 1 },
      { title: 'Old sale', imageUrl: 'https://example.com/c.jpg', linkUrl: `/sale/${new mongoose.Types.ObjectId()}`, isActive: true, order: 2 },
    ];
    await settings.save();
    saleService.clearSaleCache();
    res = await call('GET', '/settings/banners', buyer.token);
    assert.deepStrictEqual(res.json.data.heroBanners.map((b) => b.title), ['Plain', 'Sale']);
    settings.heroBanners = keptBanners;
    await settings.save();
    console.log('10. sale banners only while the sale is live');

    // 11. Announce: live only, in each person's language, not twice in a row.
    res = await call('GET', `/admin/sales/${saleId}/announce`, admin.token);
    assert.ok(res.json.data.recipients >= 3);
    res = await call('POST', `/admin/sales/${saleId}/announce`, admin.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const hindi = await M.Notification.findOne({ userId: buyer2.user._id, type: 'sale' }).lean();
    assert.ok(hindi && /दिवाली सेल/.test(hindi.title), 'Hindi for a Hindi speaker');
    assert.strictEqual(hindi.data.saleId, saleId);
    const wholesale = await M.Notification.findOne({ userId: wholesaler.user._id, type: 'sale' }).lean();
    assert.ok(/25%/.test(wholesale.body), 'wholesalers get their own "up to"');
    res = await call('POST', `/admin/sales/${saleId}/announce`, admin.token);
    assert.strictEqual(res.status, 409);
    console.log('11. announcement in each language; no double send');

    // 12. Unpaid sale orders release their units after 48 hours.
    res = await call('POST', '/orders', buyer.token, buyNow(pump, 1));
    const unpaidId = res.json.data.orderId;
    await M.Order.updateOne({ _id: unpaidId }, { $set: { confirmationStatus: 'confirmed', confirmedAt: new Date(Date.now() - 49 * hour) } });
    const before = (await M.Sale.findById(saleId).lean()).products.find((p) => String(p.productId) === String(pump._id));
    const job = await saleService.releaseUnpaidSaleOrders();
    assert.ok(job.cancelled >= 1);
    assert.strictEqual((await M.Order.findById(unpaidId).lean()).status, 'cancelled');
    const after = (await M.Sale.findById(saleId).lean()).products.find((p) => String(p.productId) === String(pump._id));
    assert.strictEqual(after.remaining, before.remaining + 1);
    console.log('12. unpaid sale orders released after 48 hours');

    // 13. End now: prices go back at once; a sale with orders can't be deleted.
    res = await call('POST', `/admin/sales/${saleId}/end`, admin.token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.status, 'ended');
    assert.strictEqual((await priceOf(pipe, buyer.token)).price, 900);
    res = await call('GET', '/sales/live', buyer.token);
    assert.strictEqual(res.json.data.length, 0);
    console.log('13. ending a sale restores prices at once');

    console.log('All sale tests passed');
  } finally {
    await M.Order.deleteMany({ userId: { $in: made.users } });
    await M.Payment.deleteMany({ userId: { $in: made.users } });
    await M.Notification.deleteMany({ userId: { $in: made.users } });
    await M.SaleClaim.deleteMany({ userId: { $in: made.users } });
    await M.Cart.deleteMany({ userId: { $in: made.users } });
    await M.Sale.deleteMany({ _id: { $in: made.sales } });
    await M.Offer.deleteMany({ _id: { $in: made.offers } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');

// Guest prices: visitors who aren't signed in see only the MRP (no customer
// price, discount or sale price) unless the admin's "Show customer prices to
// guests" switch is on. Signed-in customers and wholesalers are unchanged; a
// wholesaler viewing as a customer (X-View-As) sees customer prices; the
// public website data never carries a wholesale price.
//
//   GUEST_PRICING_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_guest_test?replicaSet=rs0' node tests/guestPricing.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.GUEST_PRICING_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set GUEST_PRICING_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: GUEST_PRICING_TEST_MONGODB_URI must point at a database on this machine');
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
  const made = { users: [], products: [], sales: [], companies: [] };
  const hour = 60 * 60 * 1000;

  const makeUser = async (role) => {
    const user = await M.User.create({ name: `Guest test ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const call = async (method, path, token, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const card = async (product, token, headers) => {
    const res = await call('GET', `/products/${product._id}`, token, undefined, headers);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    return res.json.data;
  };
  const setGuestPrices = async (admin, shown) => {
    const res = await call('PUT', '/admin/settings', admin.token, { features: { showCustomerPriceToGuests: shown } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  };

  const settings = await M.Settings.getSettings();
  const before = settings.features?.toObject?.() || {};

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');
    const company = await M.Company.create({ name: `GuestBrand ${suffix}`, slug: `guest-brand-${suffix}` });
    made.companies.push(company._id);
    const pump = await M.Product.create({
      name: `Guest Pump ${suffix}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `GUEST-${suffix}`, stock: 50, status: 'active', company: company._id,
    });
    made.products.push(pump._id);

    // 1. Off (the default): guests see only the MRP.
    await setGuestPrices(admin, false);
    let guest = await card(pump);
    assert.strictEqual(guest.price, 1000, 'guest sees the MRP');
    assert.strictEqual(guest.mrp, 1000);
    assert.strictEqual(guest.discountPercent, 0);
    assert.strictEqual(guest.sale, null);
    assert.strictEqual(guest.guestPriceHidden, true);
    assert.strictEqual(guest.retailPrice, undefined, 'no customer price field for guests');
    assert.strictEqual(guest.wholesalePrice, undefined, 'no wholesale price for guests');
    let res = await call('GET', `/products?limit=50&brand=${encodeURIComponent(company.name)}`);
    const listed = res.json.data.find((p) => String(p.id) === String(pump._id));
    assert.strictEqual(listed.price, 1000, 'lists show the MRP too');
    assert.strictEqual(listed.guestPriceHidden, true);
    console.log('1. switch off: guests see only the MRP (page and lists)');

    // 2. Signed in: unchanged.
    const customer = await card(pump, buyer.token);
    assert.strictEqual(customer.price, 900);
    assert.strictEqual(customer.guestPriceHidden, undefined);
    const trade = await card(pump, wholesaler.token);
    assert.strictEqual(trade.price, 800);
    assert.strictEqual(trade.retailPrice, 900);
    console.log('2. customers and wholesalers see their own prices');

    // 3. A wholesaler viewing the app as a customer sees the customer price.
    const preview = await card(pump, wholesaler.token, { 'X-View-As': 'customer' });
    assert.strictEqual(preview.price, 900, 'customer preview');
    assert.strictEqual(preview.wholesalePrice, undefined, 'no wholesale fields in the preview');
    const notWholesaler = await card(pump, buyer.token, { 'X-View-As': 'customer' });
    assert.strictEqual(notWholesaler.price, 900);
    console.log('3. "view as customer" shows customer prices; nothing else changes');

    // 4. A live sale: guests see its name and countdown, not its prices.
    res = await call('POST', '/admin/sales', admin.token, {
      name: `GuestSale ${suffix}`, theme: 'diwali', audience: 'both', customerPercent: 30, wholesalerPercent: 30,
      startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + 24 * hour).toISOString(),
      status: 'published', products: [{ productId: String(pump._id) }],
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    made.sales.push(res.json.data.id);
    const saleId = String(res.json.data.id);
    res = await call('GET', '/sales/live');
    const live = res.json.data.find((sale) => String(sale.id) === saleId);
    assert.ok(live, 'guests still see the sale');
    assert.strictEqual(live.upToPercent, 30);
    res = await call('GET', `/sales/${saleId}/products`);
    const onSale = res.json.data.find((p) => String(p.id) === String(pump._id));
    assert.strictEqual(onSale.price, 1000, 'sale page shows guests the MRP');
    assert.strictEqual(onSale.sale, null);
    assert.strictEqual((await card(pump, buyer.token)).price, 700, 'customers get the sale price');
    assert.strictEqual((await card(pump, wholesaler.token, { 'X-View-As': 'customer' })).price, 700, 'preview gets the customer sale price');
    console.log('4. sales: guests see the sale, not its prices; preview gets customer sale prices');

    // 5. The website data: never a wholesale price; MRP only while off.
    await M.WebsiteSettings.updateOne(
      { _id: 'website_settings' },
      { $set: { productCategories: [{ name: `Pumps ${suffix}`, isActive: true, order: 0, products: [], productDetails: [
        { productId: String(pump._id), order: 0 },
        { name: 'Typed product', retailPrice: 500, wholesalePrice: 400, mrp: 600, order: 1 },
      ] }] } },
      { upsert: true },
    );
    res = await call('GET', '/settings/website-content');
    let details = res.json.data.productCategories[0].productDetails;
    assert.ok(details.every((p) => !p.wholesalePrice), 'no wholesale price on the website');
    assert.ok(details.every((p) => !p.retailPrice), 'no customer price while off');
    assert.ok(details.every((p) => !p.salePrice), 'no sale price while off');
    assert.strictEqual(details[0].mrp, 1000);
    console.log('5. website data while off: MRP only, never a wholesale price');

    // 6. On: guests see customer prices again (and the switch save keeps the
    // other feature flags).
    await M.Settings.updateOne({ _id: 'app_settings' }, { $set: { 'features.negotiationsEnabled': false } });
    await setGuestPrices(admin, true);
    const after = await M.Settings.getSettings();
    assert.strictEqual(after.features.negotiationsEnabled, false, 'saving one switch keeps the others');
    guest = await card(pump);
    assert.strictEqual(guest.price, 700, 'guest sees the customer (sale) price');
    assert.strictEqual(guest.guestPriceHidden, undefined);
    res = await call('GET', '/settings/website-content');
    details = res.json.data.productCategories[0].productDetails;
    assert.strictEqual(details[0].retailPrice, 900, 'website shows the customer price');
    assert.strictEqual(details[0].salePrice, 700);
    assert.strictEqual(details[1].retailPrice, 500, 'typed customer price shown');
    assert.ok(details.every((p) => !p.wholesalePrice), 'still never a wholesale price');
    console.log('6. switch on: guests and the website see customer prices; never wholesale');

    // 7. The public brand products list carries no prices.
    res = await call('GET', `/companies/${company._id}/products`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.data.products.every((p) => p.retailPrice === undefined && p.wholesalePrice === undefined));
    console.log('7. public brand products list has no prices');

    console.log('All guest pricing tests passed');
  } finally {
    await M.Settings.updateOne({ _id: 'app_settings' }, { $set: { features: before } });
    await M.Sale.deleteMany({ _id: { $in: made.sales } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.Company.deleteMany({ _id: { $in: made.companies } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

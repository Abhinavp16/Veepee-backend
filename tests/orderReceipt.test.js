const assert = require('assert');

// Order receipt PDF: admin/staff and the order's customer can get it once the
// order is confirmed; it shows the shop's GSTIN, the items and every discount.
//
//   RECEIPT_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_receipt_test?replicaSet=rs0' node tests/orderReceipt.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.RECEIPT_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set RECEIPT_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: RECEIPT_TEST_MONGODB_URI must point at a database on this machine');
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
  const fs = require('fs');
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, Product, Cart, Order, Payment, Notification, Settings } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const isPdf = (res.headers.get('content-type') || '').includes('application/pdf');
    return {
      status: res.status,
      headers: res.headers,
      pdf: isPdf ? Buffer.from(await res.arrayBuffer()) : null,
      json: isPdf ? null : await res.json().catch(() => ({})),
    };
  };
  const made = { users: [], products: [], orders: [] };
  const makeUser = async (role, extra = {}) => {
    const user = await User.create({ name: `Rcpt ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const suffix = Date.now().toString(36);
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };

  try {
    const settings = await Settings.getSettings();
    const savedSettings = { businessName: settings.businessName, businessAddress: settings.businessAddress, gstin: settings.gstin };
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer');
    const other = await makeUser('buyer');
    const product = await Product.create({
      name: `Receipt Pump ${suffix}`, category: 'pumps', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `RCPT-${suffix}`, stock: 50, status: 'active',
    });
    made.products.push(product._id);

    let res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 3 }], shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const orderId = res.json.data.orderId;
    made.orders.push(orderId);

    // 1. Not before the order is confirmed.
    res = await call('GET', `/admin/orders/${orderId}/receipt`, { token: staff.token });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error?.code || res.json.code, 'RECEIPT_NOT_AVAILABLE');
    res = await call('GET', `/orders/${orderId}/receipt`, { token: buyer.token });
    assert.strictEqual(res.status, 400);

    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: staff.token, body: { deliveryCharge: 150, extraDiscount: 10, extraDiscountType: 'percent' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.total, 2850, '3000 + 150 - 300');

    // 2. Admin and staff get the PDF with the GSTIN, items and every line.
    for (const who of [admin, staff]) {
      res = await call('GET', `/admin/orders/${orderId}/receipt`, { token: who.token });
      assert.strictEqual(res.status, 200);
      assert.ok(res.pdf.subarray(0, 5).toString() === '%PDF-', 'a PDF');
    }
    const text = res.pdf.toString('latin1');
    const order = await Order.findById(orderId).lean();
    for (const expected of [
      'Order Receipt', 'GSTIN: 22AAXFV7313A1Z8', order.orderNumber, `Receipt Pump ${suffix}`, `SKU: ${order.items[0].productSnapshot.sku}`,
      'Delivery', 'Extra Discount \\(10%\\)', '- Rs. 300.00', 'Grand Total', 'Rs. 2,850.00', 'Awaiting payment', '12 MG Road',
    ]) {
      assert.ok(text.includes(expected), `receipt shows ${expected}`);
    }
    const fileName = decodeURIComponent(res.headers.get('x-receipt-filename'));
    assert.ok(fileName.endsWith(`${order.orderNumber}.pdf`), fileName);
    if (process.env.RECEIPT_SAMPLE_PATH) fs.writeFileSync(process.env.RECEIPT_SAMPLE_PATH, res.pdf);

    // 3. The customer gets their own receipt, not someone else's.
    res = await call('GET', `/orders/${orderId}/receipt`, { token: buyer.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.pdf.toString('latin1').includes(order.orderNumber));
    res = await call('GET', `/orders/${orderId}/receipt`, { token: other.token });
    assert.strictEqual(res.status, 404);
    res = await call('GET', `/admin/orders/${orderId}/receipt`, { token: buyer.token });
    assert.strictEqual(res.status, 403, 'customers use their own route');
    res = await call('GET', `/orders/${orderId}/receipt`);
    assert.strictEqual(res.status, 401);

    // 4. The GSTIN comes from Settings, can be changed and hidden.
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { gstin: 'not-a-gstin' } });
    assert.strictEqual(res.status, 400, 'a wrong GSTIN is refused');
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { gstin: '27aapfu0939f1zv', businessAddress: 'Station Road, Raipur' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('GET', `/admin/orders/${orderId}/receipt`, { token: admin.token });
    assert.ok(res.pdf.toString('latin1').includes('GSTIN: 27AAPFU0939F1ZV'));
    assert.ok(res.pdf.toString('latin1').includes('Station Road, Raipur'));
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { gstin: '' } });
    assert.strictEqual(res.status, 200);
    res = await call('GET', `/admin/orders/${orderId}/receipt`, { token: admin.token });
    assert.ok(!res.pdf.toString('latin1').includes('GSTIN'), 'an empty GSTIN is hidden');

    // 5. Cancelled orders have no receipt.
    const rejected = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 1 }], shippingAddress: address } });
    made.orders.push(rejected.json.data.orderId);
    await call('PUT', `/admin/orders/${rejected.json.data.orderId}/reject`, { token: staff.token, body: { reason: 'No delivery here' } });
    res = await call('GET', `/admin/orders/${rejected.json.data.orderId}/receipt`, { token: admin.token });
    assert.strictEqual(res.status, 400);

    await Settings.updateOne({ _id: 'app_settings' }, { $set: savedSettings });
    console.log('orderReceipt.test.js: all checks passed');
  } finally {
    await Promise.all([
      Order.deleteMany({ _id: { $in: made.orders } }),
      Payment.deleteMany({ orderId: { $in: made.orders } }),
      Notification.deleteMany({ userId: { $in: made.users } }),
      Cart.deleteMany({ userId: { $in: made.users } }),
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

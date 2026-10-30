const assert = require('assert');

// Phase 4 API behaviour: the team notification inbox and browser push tokens.
//
//   PHASE4_TEST_MONGODB_URI=mongodb://127.0.0.1:27231/oxon_phase4_test node tests/phase4Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PHASE4_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE4_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE4_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Order, Payment, AdminNotification, DeviceToken, Negotiation, Cart } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  const makeUser = async (role) => {
    const user = await User.create({ name: `P4 ${role}`, phone: randomPhone(), email: `p4-${role}-${suffix}@example.com`, passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };

  try {
    // Start from a clean inbox so counts are exact.
    await AdminNotification.deleteMany({});
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler');

    const product = await Product.create({ name: `P4 Product ${suffix}`, category: 'p4', mrp: 100, retailPrice: 90, wholesalePrice: 70, sku: `P4-${suffix}`, stock: 100, status: 'active', minWholesaleQuantity: 1 });
    made.products.push(product._id);
    const address = { fullName: 'P4', phone: '9812345670', addressLine1: '1 Road', city: 'Raipur', state: 'CG', pincode: '492001' };

    // A customer order notifies the team.
    let res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 2 }], shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const orderId = res.json.data.orderId;
    const waitFor = async (predicate) => { for (let i = 0; i < 20; i += 1) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); } };
    await waitFor(async () => (await AdminNotification.countDocuments({ type: 'new_order' })) === 1);
    assert.strictEqual(await AdminNotification.countDocuments({ type: 'new_order' }), 1);

    // A payment upload needs a real file service, so record that event directly through the service.
    const { notifyTeam } = require('../src/services/adminNotificationService');
    await notifyTeam({ type: 'payment_uploaded', title: 'Payment to verify', body: 'x', link: '/orders', data: { orderId } });

    // Wholesaler negotiation.
    res = await call('POST', '/negotiations', { token: wholesaler.token, body: { productId: String(product._id), quantity: 5, pricePerUnit: 65 } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    await waitFor(async () => (await AdminNotification.countDocuments({ type: 'new_negotiation' })) === 1);

    // Account deletion request is for administrators only.
    res = await call('POST', '/auth/account-deletion-request', { token: buyer.token, body: {} });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.json));
    await waitFor(async () => (await AdminNotification.countDocuments({ type: 'deletion_request' })) === 1);

    // Admin sees everything; staff only operations.
    res = await call('GET', '/admin/notifications', { token: admin.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.unreadCount, 4);
    assert.deepStrictEqual(new Set(res.json.data.map((n) => n.type)), new Set(['new_order', 'payment_uploaded', 'new_negotiation', 'deletion_request']));
    assert.ok(res.json.data.every((n) => n.isRead === false && !('readBy' in n)));

    res = await call('GET', '/admin/notifications', { token: staff.token });
    assert.strictEqual(res.json.unreadCount, 3);
    assert.ok(!res.json.data.some((n) => n.type === 'deletion_request'), 'staff never see admin-only notifications');

    // Customers cannot read the team inbox.
    res = await call('GET', '/admin/notifications', { token: buyer.token });
    assert.strictEqual(res.status, 403);

    // Reading is per person.
    const orderNotification = await AdminNotification.findOne({ type: 'new_order' });
    res = await call('POST', '/admin/notifications/mark-read', { token: admin.token, body: { ids: [String(orderNotification._id)] } });
    assert.strictEqual(res.json.unreadCount, 3);
    res = await call('GET', '/admin/notifications', { token: staff.token });
    assert.strictEqual(res.json.unreadCount, 3, 'the admin reading it does not mark it read for staff');
    res = await call('POST', '/admin/notifications/mark-read', { token: staff.token, body: {} });
    assert.strictEqual(res.json.unreadCount, 0);
    res = await call('GET', '/admin/notifications', { token: admin.token });
    assert.strictEqual(res.json.unreadCount, 3, 'staff marking all read does not affect the admin');
    assert.strictEqual(res.json.data.find((n) => n.type === 'new_order').isRead, true);

    // Browser push tokens: allowed for staff and admins, one owner per browser.
    const browser = `web-token-${suffix}`;
    res = await call('POST', '/admin/notifications/register-token', { token: staff.token, body: { fcmToken: browser } });
    assert.strictEqual(res.status, 200);
    res = await call('POST', '/admin/notifications/register-token', { token: admin.token, body: { fcmToken: browser } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await DeviceToken.findOne({ userId: staff.user._id, fcmToken: browser })).isActive, false);
    assert.strictEqual((await DeviceToken.findOne({ userId: admin.user._id, fcmToken: browser })).platform, 'web');
    res = await call('POST', '/admin/notifications/unregister-token', { token: admin.token, body: { fcmToken: browser } });
    assert.strictEqual((await DeviceToken.findOne({ userId: admin.user._id, fcmToken: browser })).isActive, false);
    res = await call('POST', '/admin/notifications/register-token', { token: buyer.token, body: { fcmToken: browser } });
    assert.strictEqual(res.status, 403);

    console.log('phase4 api tests passed');
  } finally {
    await AdminNotification.deleteMany({});
    await Negotiation.deleteMany({ wholesalerId: { $in: made.users } });
    await Payment.deleteMany({ userId: { $in: made.users } });
    await Order.deleteMany({ userId: { $in: made.users } });
    await Cart.deleteMany({ userId: { $in: made.users } });
    await DeviceToken.deleteMany({ userId: { $in: made.users } });
    await require('../src/models').AccountDeletionRequest.deleteMany({ userId: { $in: made.users } });
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

const assert = require('assert');

// Delivery is priced by the shop: new orders wait for confirmation, the admin
// adds the delivery charge, and only then can the customer pay.
//
//   DELIVERY_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_delivery_test?replicaSet=rs0' node tests/deliveryConfirmation.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.DELIVERY_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set DELIVERY_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: DELIVERY_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Cart, Order, Payment, Notification } = require('../src/models');

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
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const made = { users: [], products: [], orders: [] };
  const makeUser = async (role) => {
    const user = await User.create({ name: `Del ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const suffix = Date.now().toString(36);
  const product = await Product.create({
    name: `Delivery Pump ${suffix}`, category: 'del', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
    sku: `DEL-${suffix}`, stock: 50, status: 'active', minWholesaleQuantity: 1,
  });
  made.products.push(product._id);
  const address = { fullName: 'Asha', phone: '9812345670', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const buyer = await makeUser('buyer');
    const other = await makeUser('buyer');

    // The cart preview no longer adds a delivery fee.
    await Cart.findOneAndUpdate(
      { userId: buyer.user._id },
      { $set: { items: [{ productId: product._id, quantity: 2, priceAtAdd: 1000 }] } },
      { upsert: true }
    );
    let res = await call('POST', '/orders', { token: buyer.token, body: { shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const orderId = res.json.data.orderId;
    made.orders.push(orderId);
    assert.strictEqual(res.json.data.deliveryFee, 0, 'no delivery fee at checkout');
    assert.strictEqual(res.json.data.total, 2000);
    assert.strictEqual(res.json.data.confirmationStatus, 'pending');
    assert.strictEqual(res.json.data.nextAction, 'await_confirmation');

    // Buy Now orders wait too.
    res = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 1 }], shippingAddress: address } });
    assert.strictEqual(res.status, 201);
    made.orders.push(res.json.data.orderId);
    assert.strictEqual(res.json.data.confirmationStatus, 'pending');
    const secondOrderId = res.json.data.orderId;

    // The customer cannot pay before confirmation.
    res = await call('POST', `/payments/${orderId}/upload`, { token: buyer.token, body: {} });
    assert.strictEqual(res.status, 400, 'no payment before confirmation');
    assert.strictEqual(codeOf(res), 'ORDER_AWAITING_CONFIRMATION');

    // The admin cannot verify a payment for an unconfirmed order either.
    const payment = await Payment.findOne({ orderId });
    res = await call('PUT', `/admin/payments/${payment._id}/verify`, { token: admin.token, body: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'ORDER_AWAITING_CONFIRMATION');

    // The admin list can show just the orders to confirm.
    res = await call('GET', '/admin/orders?confirmation=pending&limit=50', { token: staff.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.data.some((o) => String(o._id) === String(orderId)));
    assert.ok(res.json.data.every((o) => o.confirmationStatus === 'pending'));

    // Status filter: only real statuses; "pending payment" leaves out unconfirmed orders.
    res = await call('GET', '/admin/orders?status=pending_payment&confirmation=notPending&limit=50', { token: staff.token });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.json.data.some((o) => String(o._id) === String(orderId)), 'awaiting confirmation is not "pending payment"');
    assert.ok(res.json.data.every((o) => o.status === 'pending_payment' && o.confirmationStatus !== 'pending'));
    res = await call('GET', '/admin/orders?status[$ne]=x&limit=50', { token: staff.token });
    assert.strictEqual(res.status, 200, 'a query object is ignored, not used');

    // Confirming needs a valid charge and only works once.
    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: staff.token, body: { deliveryCharge: -5 } });
    assert.strictEqual(res.status, 400, 'negative delivery refused');
    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: buyer.token, body: { deliveryCharge: 300 } });
    assert.strictEqual(res.status, 403, 'customers cannot confirm');
    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: staff.token, body: { deliveryCharge: 300 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.deliveryFee, 300);
    assert.strictEqual(res.json.data.total, 2300);
    assert.strictEqual(res.json.data.confirmationStatus, 'confirmed');
    res = await call('PUT', `/admin/orders/${orderId}/confirm`, { token: staff.token, body: { deliveryCharge: 999 } });
    assert.strictEqual(res.status, 400, 'cannot confirm twice');

    const confirmed = await Order.findById(orderId);
    assert.strictEqual(confirmed.deliveryFee, 300);
    assert.strictEqual(confirmed.total, 2300);
    assert.strictEqual(confirmed.status, 'pending_payment');
    assert.ok(confirmed.statusHistory.some((h) => /delivery ₹300/.test(h.note || '')));
    assert.strictEqual((await Payment.findOne({ orderId })).amount, 2300, 'amount due includes delivery');
    const told = await Notification.findOne({ userId: buyer.user._id, 'data.orderId': String(orderId), 'data.action': 'pay' });
    assert.ok(told, 'the customer is told to pay');
    assert.ok(/2300|2,300/.test(told.body), told.body);

    // The customer sees it on their order.
    res = await call('GET', `/orders/${orderId}`, { token: buyer.token });
    assert.strictEqual(res.json.data.confirmationStatus ?? res.json.data.order?.confirmationStatus, 'confirmed');

    // Rejecting cancels the order with a reason.
    res = await call('PUT', `/admin/orders/${secondOrderId}/reject`, { token: staff.token, body: {} });
    assert.strictEqual(res.status, 400, 'a reason is required');
    res = await call('PUT', `/admin/orders/${secondOrderId}/reject`, { token: staff.token, body: { reason: 'We do not deliver to this pincode' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const rejected = await Order.findById(secondOrderId);
    assert.strictEqual(rejected.status, 'cancelled');
    assert.strictEqual(rejected.confirmationStatus, 'rejected');
    assert.strictEqual(rejected.confirmationNote, 'We do not deliver to this pincode');
    assert.ok(await Notification.findOne({ userId: buyer.user._id, 'data.orderId': String(secondOrderId) }));

    // An extra discount can be given at confirmation, in rupees or percent.
    const placeOrder = async () => {
      const placed = await call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: String(product._id), quantity: 2 }], shippingAddress: address } });
      assert.strictEqual(placed.status, 201, JSON.stringify(placed.json));
      made.orders.push(placed.json.data.orderId);
      return placed.json.data.orderId;
    };
    const discounted = await placeOrder(); // 2 x 1000 = 2000
    res = await call('PUT', `/admin/orders/${discounted}/confirm`, { token: staff.token, body: { deliveryCharge: 300, extraDiscount: 101, extraDiscountType: 'percent' } });
    assert.strictEqual(res.status, 400, 'more than 100% refused');
    res = await call('PUT', `/admin/orders/${discounted}/confirm`, { token: staff.token, body: { deliveryCharge: 300, extraDiscount: 2301 } });
    assert.strictEqual(res.status, 400, 'more than the order total refused');
    assert.strictEqual(codeOf(res), 'INVALID_EXTRA_DISCOUNT');
    assert.strictEqual((await Order.findById(discounted)).confirmationStatus, 'pending', 'a refused discount leaves the order waiting');
    res = await call('PUT', `/admin/orders/${discounted}/confirm`, { token: staff.token, body: { deliveryCharge: 300, extraDiscount: 250 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.extraDiscount, 250);
    assert.strictEqual(res.json.data.total, 2050, '2000 + 300 - 250');
    assert.strictEqual((await Payment.findOne({ orderId: discounted })).amount, 2050);
    const toldDiscount = await Notification.findOne({ userId: buyer.user._id, 'data.orderId': String(discounted) });
    assert.ok(/250/.test(toldDiscount.body) && /2,050|2050/.test(toldDiscount.body), toldDiscount.body);
    assert.ok((await Order.findById(discounted)).statusHistory.some((h) => /extra discount ₹250/.test(h.note || '')));
    // Only at confirmation: a confirmed order can't be re-discounted.
    res = await call('PUT', `/admin/orders/${discounted}/confirm`, { token: staff.token, body: { deliveryCharge: 300, extraDiscount: 500 } });
    assert.strictEqual(res.status, 400);

    const percentOff = await placeOrder();
    res = await call('PUT', `/admin/orders/${percentOff}/confirm`, { token: staff.token, body: { deliveryCharge: 0, extraDiscount: 10, extraDiscountType: 'percent' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.extraDiscount, 200, '10% of 2000');
    assert.strictEqual(res.json.data.extraDiscountPercent, 10);
    assert.strictEqual(res.json.data.total, 1800);

    // Orders from before this change need no confirmation.
    const legacy = await Order.create({
      userId: other.user._id,
      customerSnapshot: { name: 'Old', phone: '9812345670' },
      orderType: 'retail',
      items: [{ productId: product._id, productSnapshot: { name: product.name, sku: product.sku }, quantity: 1, pricePerUnit: 1000, totalPrice: 1000 }],
      subtotal: 1000, deliveryFee: 50, total: 1050, shippingAddress: address,
    });
    made.orders.push(legacy._id);
    assert.strictEqual(legacy.confirmationStatus, null);
    res = await call('PUT', `/admin/orders/${legacy._id}/confirm`, { token: staff.token, body: { deliveryCharge: 10 } });
    assert.strictEqual(res.status, 400, 'old orders are not reconfirmed');

    console.log('deliveryConfirmation.test.js: all checks passed');
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

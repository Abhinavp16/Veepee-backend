const assert = require('assert');

// Phase 6: requirements (several products negotiated and paid together).
// Uses transactions, so it needs a local single-node replica set:
//
//   PHASE6_TEST_MONGODB_URI='mongodb://127.0.0.1:27232/oxon_phase6_test?replicaSet=rs0' node tests/phase6Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PHASE6_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE6_TEST_MONGODB_URI to a local replica-set MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE6_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, Product, Cart, Negotiation, Order, Payment, Notification, AdminNotification } = require('../src/models');
  const { summarizeGroup } = require('../src/services/requirementGroupService');

  // Pure roll-up logic.
  const line = (status, extra = {}) => ({ status, orderId: null, currentTotalPrice: 100, ...extra });
  assert.strictEqual(summarizeGroup([line('pending'), line('pending')]).status, 'pending');
  assert.strictEqual(summarizeGroup([line('pending'), line('countered')]).status, 'countered');
  assert.strictEqual(summarizeGroup([line('accepted'), line('accepted')]).canPay, true);
  assert.strictEqual(summarizeGroup([line('accepted'), line('pending')]).canPay, false);
  assert.strictEqual(summarizeGroup([line('accepted'), line('rejected')]).canPay, true, 'a declined line does not block paying for the rest');
  assert.strictEqual(summarizeGroup([line('accepted'), line('rejected')]).totalPrice, 100);
  assert.strictEqual(summarizeGroup([line('rejected'), line('rejected')]).status, 'rejected');
  assert.strictEqual(summarizeGroup([line('converted'), line('converted')]).status, 'converted');
  assert.strictEqual(summarizeGroup([line('accepted', { orderId: 'x' })]).canPay, false);

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

  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  const makeUser = async (role) => {
    const user = await User.create({ name: `P6 ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  let skuCounter = 0;
  const makeProduct = async (fields = {}) => {
    skuCounter += 1;
    const product = await Product.create({
      name: `P6 Product ${suffix} ${skuCounter}`, category: 'p6', mrp: 1000, retailPrice: 900, wholesalePrice: 700,
      sku: `P6-${suffix}-${skuCounter}`, stock: 500, status: 'active', minWholesaleQuantity: 1, ...fields,
    });
    made.products.push(product._id);
    return product;
  };
  const fillCart = (user, lines) => Cart.findOneAndUpdate(
    { userId: user._id },
    { $set: { items: lines.map(([p, quantity]) => ({ productId: p._id, quantity, priceAtAdd: 700 })) } },
    { upsert: true, new: true }
  );
  const address = { fullName: 'P6', phone: '9812345670', addressLine1: '1 Road', city: 'Raipur', state: 'CG', pincode: '492001' };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const wholesaler = await makeUser('wholesaler');
    const buyer = await makeUser('buyer');
    const other = await makeUser('wholesaler');
    const [pump, hose, nozzle] = [await makeProduct(), await makeProduct({ packSize: 12, minWholesaleQuantity: 2 }), await makeProduct()];
    const locked = await makeProduct({ negotiationEnabled: false });

    // --- Sending the cart as a requirement ------------------------------------
    await fillCart(wholesaler.user, [[pump, 10], [hose, 24], [nozzle, 5]]);
    let res = await call('POST', '/negotiations/from-cart', { token: buyer.token, body: {} });
    assert.strictEqual(res.status, 403, 'only wholesalers');

    // One bad line blocks the whole requirement and names the line.
    await fillCart(wholesaler.user, [[pump, 10], [hose, 5], [locked, 1]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'REQUIREMENT_INVALID');
    const bad = res.json.error.details.items;
    assert.deepStrictEqual(bad.map((i) => i.code).sort(), ['INVALID_QUANTITY', 'NEGOTIATION_DISABLED']);
    assert.strictEqual(await Negotiation.countDocuments({ wholesalerId: wholesaler.user._id }), 0, 'nothing was created');
    assert.strictEqual((await Cart.findOne({ userId: wholesaler.user._id })).items.length, 3, 'the cart is untouched');

    await fillCart(wholesaler.user, [[pump, 10], [hose, 24], [nozzle, 5]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: { message: 'Need these for the season', offers: [{ productId: String(nozzle._id), pricePerUnit: 600 }] } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const { id: groupId, number } = res.json.data.requestGroup;
    assert.ok(/^REQ-\d+$/.test(number));
    assert.strictEqual(res.json.data.productCount, 3);
    const lines = await Negotiation.find({ 'requestGroup.id': groupId }).sort({ createdAt: 1 });
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].requestedPricePerUnit, 700, 'asked at the current wholesale price');
    assert.strictEqual(lines[2].requestedPricePerUnit, 600, 'or the wholesaler\'s own price');
    assert.strictEqual((await Cart.findOne({ userId: wholesaler.user._id })).items.length, 0, 'the cart is emptied');
    assert.strictEqual(await AdminNotification.countDocuments({ type: 'new_negotiation', 'data.requirementNumber': number }), 1, 'the team hears about it once');

    // A single product is just a normal negotiation, not a group.
    await fillCart(wholesaler.user, [[pump, 3]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: {} });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.data.requestGroup, null);
    const single = await Negotiation.findById(res.json.data.negotiationIds[0]);
    assert.ok(!single.requestGroup?.id);

    // --- Lists and detail show the group --------------------------------------
    res = await call('GET', '/negotiations?limit=50', { token: wholesaler.token });
    const grouped = res.json.data.filter((n) => n.requestGroup?.id === groupId);
    assert.strictEqual(grouped.length, 3);
    assert.ok(grouped.every((n) => n.canPay === false), 'lines of a requirement are not paid one by one');
    res = await call('GET', `/negotiations/groups/${groupId}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.status, 'pending');
    assert.strictEqual(res.json.data.productCount, 3);
    assert.strictEqual(res.json.data.items.length, 3);
    assert.strictEqual(res.json.data.totalPrice, 10 * 700 + 24 * 700 + 5 * 600);
    res = await call('GET', `/negotiations/groups/${groupId}`, { token: other.token });
    assert.strictEqual(res.status, 404, 'someone else\'s requirement is not visible');

    // --- A wholesaler cannot accept their own offer ----------------------------
    res = await call('POST', `/negotiations/groups/${groupId}/accept`, { token: wholesaler.token });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'NOTHING_TO_ACCEPT');
    res = await call('POST', `/negotiations/${lines[0]._id}/accept`, { token: wholesaler.token });
    assert.strictEqual(res.status, 400, 'the single-negotiation self-accept hole is closed');

    // --- The dealer counters; staff can answer too ------------------------------
    res = await call('PUT', `/admin/negotiations/groups/${groupId}/counter`, { token: buyer.token, body: { counters: [{ negotiationId: String(lines[0]._id), pricePerUnit: 650 }] } });
    assert.strictEqual(res.status, 403);
    res = await call('PUT', `/admin/negotiations/groups/${groupId}/counter`, { token: staff.token, body: { message: 'Best we can do', counters: [
      { negotiationId: String(lines[0]._id), pricePerUnit: 650 },
      { negotiationId: String(lines[1]._id), pricePerUnit: 680 },
    ] } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.status, 'countered');
    assert.strictEqual(res.json.data.waitingOn, 'wholesaler');
    const countered = await Notification.findOne({ userId: wholesaler.user._id, title: 'Counter offer on your requirement' });
    assert.ok(countered, 'the wholesaler is told once for the whole requirement');
    assert.strictEqual(await Notification.countDocuments({ userId: wholesaler.user._id, title: 'Counter offer on your requirement' }), 1);

    // The nozzle line is still waiting, so the requirement cannot be paid yet.
    res = await call('POST', '/orders/from-group', { token: wholesaler.token, body: { groupId, shippingAddress: address } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'REQUIREMENT_NOT_PAYABLE');

    // --- The wholesaler accepts the counters; the dealer accepts the rest -------
    res = await call('POST', `/negotiations/groups/${groupId}/accept`, { token: wholesaler.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const afterAccept = res.json.data.items.map((i) => i.status);
    assert.deepStrictEqual(afterAccept, ['accepted', 'accepted', 'pending']);
    res = await call('PUT', `/admin/negotiations/groups/${groupId}/accept`, { token: admin.token, body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.status, 'accepted');
    assert.strictEqual(res.json.data.canPay, true);
    assert.strictEqual(res.json.data.totalPrice, 10 * 650 + 24 * 680 + 5 * 600);

    // --- ONE order for the whole requirement ------------------------------------
    res = await call('POST', '/orders/from-group', { token: other.token, body: { groupId, shippingAddress: address } });
    assert.strictEqual(res.status, 404, 'only the owner can pay');
    res = await call('POST', '/orders/from-negotiation', { token: wholesaler.token, body: { negotiationId: String(lines[0]._id), shippingAddress: address } });
    assert.strictEqual(res.status, 400, 'a requirement line cannot be paid alone');
    assert.strictEqual(codeOf(res), 'PART_OF_REQUIREMENT');

    res = await call('POST', '/orders/from-group', { token: wholesaler.token, body: { groupId, shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const order = await Order.findById(res.json.data.orderId);
    made.orderIds = [order._id];
    assert.strictEqual(order.items.length, 3);
    assert.strictEqual(order.negotiationIds.length, 3);
    assert.strictEqual(order.negotiationId, null);
    assert.strictEqual(order.orderType, 'wholesale');
    assert.strictEqual(order.subtotal, 10 * 650 + 24 * 680 + 5 * 600);
    assert.deepStrictEqual(order.items.map((i) => i.pricePerUnit), [650, 680, 600]);
    assert.ok(await Payment.findOne({ orderId: order._id }), 'one payment for the order');
    assert.strictEqual(await Payment.countDocuments({ orderId: order._id }), 1);
    const settled = await Negotiation.find({ 'requestGroup.id': groupId });
    assert.ok(settled.every((n) => n.status === 'converted' && String(n.orderId) === String(order._id)));
    // Paying again (a second tap, or Back and pay) returns the same order.
    res = await call('POST', '/orders/from-group', { token: wholesaler.token, body: { groupId, shippingAddress: address } });
    assert.strictEqual(res.status, 200, 'paying again gives the same order');
    assert.strictEqual(String(res.json.data.orderId), String(order._id));
    assert.strictEqual(await Order.countDocuments({ negotiationIds: { $in: settled.map((n) => n._id) } }), 1, 'still one order');
    assert.strictEqual(await Payment.countDocuments({ orderId: order._id }), 1);

    // --- Declining and partial acceptance --------------------------------------
    await fillCart(wholesaler.user, [[pump, 10], [nozzle, 5]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: {} });
    const second = res.json.data.requestGroup.id;
    const secondLines = await Negotiation.find({ 'requestGroup.id': second }).sort({ createdAt: 1 });
    res = await call('PUT', `/admin/negotiations/groups/${second}/reject`, { token: admin.token, body: { message: 'Out of season' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.status, 'rejected');
    assert.ok(await Notification.findOne({ userId: wholesaler.user._id, title: 'Requirement declined' }));
    res = await call('PUT', `/admin/negotiations/groups/${second}/accept`, { token: admin.token, body: {} });
    assert.strictEqual(res.status, 400, 'a declined requirement cannot be accepted');

    // Dealer accepts one line (single endpoint) and declines the other: pay for what was accepted.
    await fillCart(wholesaler.user, [[pump, 10], [nozzle, 5]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: {} });
    const third = res.json.data.requestGroup.id;
    const thirdLines = await Negotiation.find({ 'requestGroup.id': third }).sort({ createdAt: 1 });
    await call('PUT', `/admin/negotiations/${thirdLines[0]._id}/accept`, { token: admin.token, body: {} });
    await call('PUT', `/admin/negotiations/${thirdLines[1]._id}/reject`, { token: admin.token, body: { reason: 'No stock' } });
    res = await call('GET', `/negotiations/groups/${third}`, { token: wholesaler.token });
    assert.strictEqual(res.json.data.canPay, true);
    assert.strictEqual(res.json.data.payableCount, 1);
    res = await call('POST', '/orders/from-group', { token: wholesaler.token, body: { groupId: third, shippingAddress: address } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const partial = await Order.findById(res.json.data.orderId);
    made.orderIds.push(partial._id);
    assert.strictEqual(partial.items.length, 1);

    // Stock is rechecked when paying: nothing is created if a line sold out.
    await fillCart(wholesaler.user, [[pump, 10], [nozzle, 5]]);
    res = await call('POST', '/negotiations/from-cart', { token: wholesaler.token, body: {} });
    const fourth = res.json.data.requestGroup.id;
    await call('PUT', `/admin/negotiations/groups/${fourth}/accept`, { token: admin.token, body: {} });
    await Product.updateOne({ _id: nozzle._id }, { $set: { stock: 1 } });
    const ordersBefore = await Order.countDocuments({ userId: wholesaler.user._id });
    res = await call('POST', '/orders/from-group', { token: wholesaler.token, body: { groupId: fourth, shippingAddress: address } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(codeOf(res), 'INSUFFICIENT_STOCK');
    assert.strictEqual(await Order.countDocuments({ userId: wholesaler.user._id }), ordersBefore, 'no partial order');
    assert.ok((await Negotiation.find({ 'requestGroup.id': fourth })).every((n) => n.status === 'accepted'), 'lines stay accepted');

    // Wholesaler can decline a requirement too.
    res = await call('POST', `/negotiations/groups/${fourth}/reject`, { token: wholesaler.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.status, 'rejected');

    console.log('phase6 api tests passed');
  } finally {
    await Cart.deleteMany({ userId: { $in: made.users } });
    await Payment.deleteMany({ userId: { $in: made.users } });
    await Order.deleteMany({ userId: { $in: made.users } });
    await Negotiation.deleteMany({ wholesalerId: { $in: made.users } });
    await Notification.deleteMany({ userId: { $in: made.users } });
    await AdminNotification.deleteMany({});
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

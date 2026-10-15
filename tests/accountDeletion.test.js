const assert = require('assert');

// Account deletion, end to end: app and website requests, admin review,
// completion, open-order protection, anonymization. Starts the real API and
// writes test data, so it only runs against a database on this machine
// (never the live database):
//
//   ACCOUNT_DELETION_TEST_MONGODB_URI=mongodb://127.0.0.1:27231/oxon_deletion_test node tests/accountDeletion.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '10000';
process.env.NODE_ENV = 'test';
// No Firebase credentials in tests: storage is stubbed below.
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

function isLocalDatabase(uri) {
  return /^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(String(uri || ''));
}

// A valid-looking Indian mobile number (passes the registration validator).
const randomPhone = () => {
  for (;;) {
    const candidate = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(candidate) && new Set(candidate).size > 4) return candidate;
  }
};

async function run(uri) {
  process.env.MONGODB_URI = uri;

  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const storageCleanup = require('../src/utils/storageCleanup');
  const removed = { prefixes: [], files: [] };
  storageCleanup.deleteByPrefix = async (prefix) => { removed.prefixes.push(prefix); return true; };
  storageCleanup.deleteFile = async (file) => { removed.files.push(file); return true; };

  const app = require('../src/app');
  const M = require('../src/models');

  await mongoose.connect(uri);
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = 'Correct-Horse-9';
  const created = { users: [], products: [] };
  const makeUser = async (fields) => {
    const user = await M.User.create({ authProvider: 'email', isActive: true, ...fields });
    created.users.push(user._id);
    return user;
  };
  const token = (user) => jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const admin = await makeUser({ name: 'Del Admin', email: `del-admin-${suffix}@example.com`, role: 'admin', phone: randomPhone(), passwordHash: password });
  const staff = await makeUser({ name: 'Del Staff', email: `del-staff-${suffix}@example.com`, role: 'staff', phone: randomPhone(), passwordHash: password });
  const buyerPhone = randomPhone();
  const buyer = await makeUser({ name: 'Asha Buyer', email: `asha-${suffix}@example.com`, phone: buyerPhone, role: 'buyer', passwordHash: password, address: '1 Test Rd, Raipur', avatar: 'https://example.com/a.webp' });
  const wsPhone = randomPhone();
  const wholesaler = await makeUser({
    name: `Ravi Traders ${suffix}`, email: `ravi-${suffix}@example.com`, phone: wsPhone, role: 'wholesaler', passwordHash: password,
    businessInfo: { businessName: 'Ravi Traders', gstNumber: '22AAAAA0000A1Z5', status: 'accepted', verified: true, proofImages: ['https://example.com/p.webp'] },
  });
  const product = await M.Product.create({
    name: `Del Pump ${suffix}`, sku: `DEL-${suffix}`, category: 'pumps', mrp: 100, retailPrice: 90, wholesalePrice: 80, stock: 50,
    description: 'Test product', status: 'draft',
  });
  created.products.push(product._id);

  const negotiation = await M.Negotiation.collection.insertOne({
    negotiationNumber: `N-${suffix}-1`, wholesalerId: wholesaler._id, productId: product._id, productSnapshot: { name: product.name }, status: 'pending', createdAt: new Date(),
  });
  const orderedNegotiation = await M.Negotiation.collection.insertOne({
    negotiationNumber: `N-${suffix}-2`, wholesalerId: wholesaler._id, productId: product._id, productSnapshot: { name: product.name }, status: 'accepted', createdAt: new Date(),
  });

  const orderDoc = (user, status, extra = {}) => ({
    orderNumber: `T-${suffix}-${Math.floor(Math.random() * 1e6)}`,
    userId: user._id, productId: product._id, productSnapshot: { name: product.name },
    quantity: 1, pricePerUnit: 90, totalPrice: 90, subtotal: 90, total: 90, status, orderType: 'retail',
    customerSnapshot: { name: user.name, email: user.email, phone: user.phone, businessName: 'Ravi Traders' },
    shippingAddress: { fullName: user.name, phone: user.phone, addressLine1: '12 Market Rd', addressLine2: 'Near Temple', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' },
    createdAt: new Date(),
    ...extra,
  });
  const buyerOrder = (await M.Order.collection.insertOne(orderDoc(buyer, 'processing'))).insertedId;
  const wsOrder = (await M.Order.collection.insertOne(orderDoc(wholesaler, 'delivered', { negotiationId: orderedNegotiation.insertedId }))).insertedId;
  const screenshot = `payments/${wsOrder}_abc.png`;
  await M.Payment.collection.insertOne({
    orderId: wsOrder, userId: wholesaler._id, amount: 90, status: 'verified', screenshotUrl: `https://storage.example/${screenshot}`, screenshotPublicId: screenshot,
  });

  for (const user of [buyer, wholesaler]) {
    await M.Cart.create({ userId: user._id, items: [{ productId: product._id, quantity: 1, price: 90 }] }).catch(() => M.Cart.collection.insertOne({ userId: user._id, items: [] }));
    await M.DeviceToken.collection.insertOne({ userId: user._id, fcmToken: `tok-${user._id}`, platform: 'android', isActive: true });
    await M.Notification.collection.insertOne({ userId: user._id, title: 'Hi', body: 'Hello', type: 'general', createdAt: new Date() });
  }

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { auth, body, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  const adminToken = token(admin);

  try {
    let res = await call('POST', '/auth/login', { body: { email: buyer.email, password } });
    assert.strictEqual(res.status, 200, 'buyer can log in');
    const buyerSession = res.body.data;
    res = await call('POST', '/auth/login-phone', { body: { phone: wsPhone, password } });
    assert.strictEqual(res.status, 200, 'wholesaler can log in by phone');
    const wsSession = res.body.data;

    // --- In-app request ---
    res = await call('GET', '/auth/account-deletion-request', { auth: buyerSession.accessToken });
    assert.strictEqual(res.body.data, null);
    res = await call('POST', '/auth/account-deletion-request', { auth: buyerSession.accessToken, body: {} });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.status, 'pending');
    assert.strictEqual(res.body.data.openOrderCount, 1, 'the app can tell the user an order is in progress');
    const days = (new Date(res.body.data.dueAt) - Date.now()) / 864e5;
    assert.ok(days > 29.9 && days <= 30, 'due in 30 days');
    const firstId = res.body.data.id;
    res = await call('POST', '/auth/account-deletion-request', { auth: buyerSession.accessToken, body: {} });
    assert.strictEqual(res.status, 200, 'asking again returns the same request');
    assert.strictEqual(String(res.body.data.id), String(firstId));
    res = await call('POST', '/auth/account-deletion-request/cancel', { auth: buyerSession.accessToken });
    assert.strictEqual(res.body.data.status, 'cancelled');
    res = await call('POST', '/auth/account-deletion-request', { auth: buyerSession.accessToken, body: {} });
    assert.strictEqual(res.status, 201, 'can ask again after cancelling');
    const buyerRequestId = res.body.data.id;

    // Staff and admins are not self-service; only administrators process requests.
    assert.strictEqual((await call('POST', '/auth/account-deletion-request', { auth: token(staff), body: {} })).status, 403);
    assert.strictEqual((await call('POST', '/auth/account-deletion-request', { auth: adminToken, body: {} })).status, 403);
    assert.strictEqual((await call('GET', '/admin/account-deletion-requests', { auth: token(staff) })).status, 403);
    assert.strictEqual((await call('GET', '/admin/account-deletion-requests', { auth: buyerSession.accessToken })).status, 403);
    assert.strictEqual((await call('GET', '/admin/account-deletion-requests')).status, 401);

    res = await call('GET', '/admin/account-deletion-requests?status=pending', { auth: adminToken });
    assert.strictEqual(res.status, 200);
    const listed = res.body.data.find((request) => String(request._id) === String(buyerRequestId));
    assert.strictEqual(listed.openOrderCount, 1, 'admin list shows the open order count');
    assert.ok(res.body.summary.open >= 1);

    res = await call('PUT', `/admin/account-deletion-requests/${buyerRequestId}`, { auth: adminToken, body: { status: 'in_review' } });
    assert.strictEqual(res.status, 200);
    res = await call('POST', '/auth/account-deletion-request/cancel', { auth: buyerSession.accessToken });
    assert.strictEqual(res.status, 404, 'no cancelling once in review');

    // Open order blocks completion; nothing is touched.
    res = await call('POST', `/admin/account-deletion-requests/${buyerRequestId}/complete`, { auth: adminToken, body: {} });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error.code, 'ACCOUNT_HAS_OPEN_ORDERS');
    assert.strictEqual((await M.User.findById(buyer._id).lean()).isActive, true, 'blocked completion changes nothing');
    assert.strictEqual(await M.Cart.countDocuments({ userId: buyer._id }) >= 0, true);

    // Once the order is delivered, completion goes through.
    await M.Order.collection.updateOne({ _id: buyerOrder }, { $set: { status: 'delivered' } });
    res = await call('POST', `/admin/account-deletion-requests/${buyerRequestId}/complete`, { auth: adminToken, body: { staffNote: 'Done' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    res = await call('POST', `/admin/account-deletion-requests/${buyerRequestId}/complete`, { auth: adminToken, body: {} });
    assert.strictEqual(res.status, 409, 'completing twice is refused');

    // The customer is gone.
    res = await call('GET', '/auth/me', { auth: buyerSession.accessToken });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'ACCOUNT_DEACTIVATED');
    assert.strictEqual((await call('POST', '/auth/refresh-token', { body: { refreshToken: buyerSession.refreshToken } })).status, 401);
    assert.strictEqual((await call('POST', '/auth/login', { body: { email: buyer.email, password } })).status, 401);
    assert.strictEqual((await call('POST', '/auth/login-phone', { body: { phone: buyerPhone, password } })).status, 401);
    const goneBuyer = await M.User.findById(buyer._id).select('+passwordHash').lean();
    assert.strictEqual(goneBuyer.name, 'Deleted account');
    assert.ok(goneBuyer.email.endsWith('@deleted.invalid') && goneBuyer.phone.startsWith('deleted-'));
    assert.ok(!goneBuyer.passwordHash && !goneBuyer.address && !goneBuyer.avatar && goneBuyer.isActive === false);
    assert.ok(goneBuyer.deletedAt, 'deletedAt recorded');
    assert.deepStrictEqual(
      [
        await M.Cart.countDocuments({ userId: buyer._id }),
        await M.DeviceToken.countDocuments({ userId: buyer._id }),
        await M.Notification.countDocuments({ userId: buyer._id }),
        await M.RefreshToken.countDocuments({ userId: buyer._id }),
      ],
      [0, 0, 0, 0],
      'cart, device tokens, notifications and sessions are deleted',
    );
    assert.ok(removed.prefixes.includes(`avatars/${buyer._id}`) && removed.prefixes.includes(`proofs/${buyer._id}`), 'avatar and proof folders are cleared from storage');

    // Orders stay for accounting, without name, phone or street address.
    const keptOrder = await M.Order.collection.findOne({ _id: buyerOrder });
    assert.strictEqual(keptOrder.total, 90, 'amounts are kept');
    assert.strictEqual(keptOrder.status, 'delivered');
    assert.strictEqual(keptOrder.shippingAddress.fullName, 'Deleted customer');
    assert.strictEqual(keptOrder.shippingAddress.phone, 'deleted');
    assert.strictEqual(keptOrder.shippingAddress.addressLine1, 'Removed');
    assert.ok(!('addressLine2' in keptOrder.shippingAddress));
    assert.strictEqual(keptOrder.shippingAddress.state, 'Chhattisgarh', 'state is kept for tax records');
    assert.strictEqual(keptOrder.shippingAddress.pincode, '492001');
    assert.strictEqual(keptOrder.customerSnapshot.name, 'Deleted customer');
    assert.strictEqual(keptOrder.customerSnapshot.email, '');
    assert.ok(!('businessName' in keptOrder.customerSnapshot));

    // The phone number can sign up again.
    res = await call('POST', '/auth/register-phone', { body: { name: 'Asha New', phone: buyerPhone, password } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    created.users.push(res.body.data.user._id || res.body.data.user.id);

    // --- Website request ---
    assert.strictEqual((await call('POST', '/account-deletion-request', { body: { name: 'x' } })).status, 400, 'phone is required');
    const before = await M.AccountDeletionRequest.countDocuments({ userId: wholesaler._id });
    res = await call('POST', '/account-deletion-request', { body: { name: 'Wrong Name', phone: wsPhone } });
    assert.strictEqual(res.status, 202);
    const wrongReply = res.body.message;
    assert.strictEqual(await M.AccountDeletionRequest.countDocuments({ userId: wholesaler._id }), before);
    res = await call('POST', '/account-deletion-request', { body: { name: wholesaler.name.toUpperCase(), phone: wsPhone } });
    assert.strictEqual(res.body.message, wrongReply, 'same reply whether or not an account matches');
    const wsRequest = await M.AccountDeletionRequest.findOne({ userId: wholesaler._id, status: 'pending' });
    assert.ok(wsRequest && wsRequest.source === 'website', 'case-insensitive name + phone match creates a website request');
    await call('POST', '/account-deletion-request', { body: { name: 'Del Admin', phone: admin.phone } });
    await call('POST', '/account-deletion-request', { body: { name: 'Del Staff', phone: staff.phone } });
    assert.strictEqual(await M.AccountDeletionRequest.countDocuments({ userId: { $in: [admin._id, staff._id] } }), 0, 'admin and staff cannot be targeted');

    res = await call('POST', `/admin/account-deletion-requests/${wsRequest._id}/complete`, { auth: adminToken, body: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'DELETION_REQUEST_VERIFICATION_REQUIRED');
    res = await call('PUT', `/admin/account-deletion-requests/${wsRequest._id}`, { auth: adminToken, body: { status: 'in_review' } });
    assert.strictEqual(res.status, 400, 'review without the verification tick is refused');
    res = await call('POST', `/admin/account-deletion-requests/${wsRequest._id}/complete`, { auth: adminToken, body: { identityVerified: true } });
    assert.strictEqual(res.status, 200, 'verified website request completes in one step');
    const doneWs = await M.AccountDeletionRequest.findById(wsRequest._id).lean();
    assert.ok(doneWs.identityVerification.verifiedAt, 'verification recorded');
    assert.strictEqual(String(doneWs.identityVerification.verifiedBy), String(admin._id));

    const goneWs = await M.User.findById(wholesaler._id).lean();
    assert.strictEqual(goneWs.businessInfo.gstNumber, null);
    assert.deepStrictEqual(goneWs.businessInfo.proofImages, []);
    assert.strictEqual(goneWs.isActive, false);
    assert.strictEqual(await M.Negotiation.countDocuments({ _id: negotiation.insertedId }), 0, 'open negotiation deleted');
    assert.strictEqual(await M.Negotiation.countDocuments({ _id: orderedNegotiation.insertedId }), 1, 'negotiation that produced an order is kept');
    assert.ok(removed.files.includes(screenshot), 'payment screenshot file removed from storage');
    const keptPayment = await M.Payment.collection.findOne({ orderId: wsOrder });
    assert.strictEqual(keptPayment.screenshotUrl, null);
    assert.strictEqual(keptPayment.amount, 90, 'payment amount is kept');
    assert.strictEqual((await call('GET', '/auth/me', { auth: wsSession.accessToken })).status, 401);

    // --- Rejection: the customer sees the note ---
    const other = await makeUser({ name: 'Keep Me', email: `keep-${suffix}@example.com`, phone: randomPhone(), role: 'buyer', passwordHash: password });
    res = await call('POST', '/auth/login', { body: { email: other.email, password } });
    const otherToken = res.body.data.accessToken;
    res = await call('POST', '/auth/account-deletion-request', { auth: otherToken, body: {} });
    const otherRequest = res.body.data.id;
    await call('PUT', `/admin/account-deletion-requests/${otherRequest}`, { auth: adminToken, body: { status: 'rejected', staffNote: 'Open order must be delivered first' } });
    res = await call('GET', '/auth/account-deletion-request', { auth: otherToken });
    assert.strictEqual(res.body.data.status, 'rejected');
    assert.strictEqual(res.body.data.staffNote, 'Open order must be delivered first');
    assert.strictEqual((await call('POST', `/admin/account-deletion-requests/${otherRequest}/complete`, { auth: adminToken, body: {} })).status, 409);
    assert.strictEqual((await M.User.findById(other._id).lean()).isActive, true, 'a rejected request leaves the account alone');

    // --- Public form limits and CORS ---
    const flood = { 'x-forwarded-for': '203.0.113.77' };
    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      lastStatus = (await call('POST', '/account-deletion-request', { body: { name: 'Nobody', phone: '9000000000' }, headers: flood })).status;
    }
    assert.strictEqual(lastStatus, 429, 'public form is rate limited');
    const preflight = await fetch(`${base}/account-deletion-request`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.veepeeimpex.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'https://www.veepeeimpex.com', 'the website may call the form');
  } finally {
    server.close();
    const ids = created.users;
    await M.AccountDeletionRequest.deleteMany({ userId: { $in: ids } });
    await M.Cart.deleteMany({ userId: { $in: ids } });
    await M.DeviceToken.deleteMany({ userId: { $in: ids } });
    await M.Notification.deleteMany({ userId: { $in: ids } });
    await M.Negotiation.deleteMany({ wholesalerId: { $in: ids } });
    await M.Order.collection.deleteMany({ userId: { $in: ids } });
    await M.Payment.collection.deleteMany({ userId: { $in: ids } });
    await M.RefreshToken.deleteMany({ userId: { $in: ids } });
    await M.User.deleteMany({ _id: { $in: ids } });
    await M.Product.deleteMany({ _id: { $in: created.products } });
    await mongoose.disconnect();
  }
}

async function main() {
  const uri = process.env.ACCOUNT_DELETION_TEST_MONGODB_URI;
  if (!isLocalDatabase(uri)) {
    console.log('Account deletion tests skipped: set ACCOUNT_DELETION_TEST_MONGODB_URI to a local test database');
    return;
  }
  await run(uri);
  console.log('Account deletion tests passed');
}

// The API's database module reconnects after a disconnect, so exit explicitly.
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

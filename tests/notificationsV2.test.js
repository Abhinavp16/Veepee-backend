const assert = require('assert');

// Custom notifications v2: page and sale links, coupons, cart and "saved a
// product" audiences, {name} and Hindi per person, the count endpoint, the
// History rows and saved messages (Settings.notificationTemplates).
//
//   NOTIFY_V2_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_notify_v2_test?replicaSet=rs0' node tests/notificationsV2.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;
process.env.FIREBASE_STORAGE_BUCKET = 'oxon-test';

const uri = process.env.NOTIFY_V2_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set NOTIFY_V2_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: NOTIFY_V2_TEST_MONGODB_URI must point at a database on this machine');
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
  const {
    User, DeviceToken, Notification, NotificationCampaign, Product, Cart, Sale, Offer, Settings,
  } = require('../src/models');
  const notificationService = require('../src/services/notificationService');
  const { DEFAULT_NOTIFICATION_TEMPLATES } = require('../src/utils/customNotificationDefaults');

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
  const made = { users: [], products: [], sales: [], offers: [] };
  const makeUser = async (role, fields = {}) => {
    const user = await User.create({
      name: `V2 ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...fields,
    });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const code = (res) => res.json.error?.code || res.json.code;
  const id0 = (u) => String(u.user._id);

  // A fake Firebase recording what was sent.
  let multicasts = [];
  let eachCalls = [];
  notificationService.messaging = {
    async sendEachForMulticast(message) {
      multicasts.push(message);
      return { responses: message.tokens.map(() => ({ success: true })), successCount: message.tokens.length, failureCount: 0 };
    },
    async sendEach(messages) {
      eachCalls.push(messages);
      const responses = messages.map((m) => (m.token.startsWith('dead-')
        ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : { success: true }));
      return { responses, successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length };
    },
  };
  const reset = () => { multicasts = []; eachCalls = []; };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const ramesh = await makeUser('buyer', { name: 'Ramesh Kumar', preferredLanguage: 'en' });
    const sita = await makeUser('buyer', { name: 'Sita Devi', preferredLanguage: 'hi' });
    // An account with no name (older sign-ups): "there" / "जी".
    const noName = await makeUser('buyer', { name: 'Nameless', preferredLanguage: 'en' });
    await User.updateOne({ _id: noName.user._id }, { $set: { name: '' } });
    const trader = await makeUser('wholesaler', { name: 'Mohan Traders', preferredLanguage: 'hi' });
    await DeviceToken.insertMany([
      { userId: ramesh.user._id, fcmToken: `ok-ramesh-${suffix}`, platform: 'android' },
      { userId: sita.user._id, fcmToken: `ok-sita-${suffix}`, platform: 'android' },
      { userId: trader.user._id, fcmToken: `ok-trader-${suffix}`, platform: 'android' },
      { userId: trader.user._id, fcmToken: `dead-trader-${suffix}`, platform: 'android' },
    ]);
    made.tokens = [`ok-ramesh-${suffix}`, `ok-sita-${suffix}`, `ok-trader-${suffix}`, `dead-trader-${suffix}`];

    const product = await Product.create({
      name: `V2 Sprayer ${suffix}`, category: 'sprayers', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `V2-${suffix}`, stock: 5, status: 'active',
    });
    made.products.push(product._id);

    const send = (body, token = admin.token) => call('POST', '/admin/customers/notifications', { token, body });
    const selected = (users, extra = {}) => ({
      userIds: users.map((u) => String(u.user._id)), title: `T ${Math.random()} ${suffix}`, body: 'Hello', ...extra,
    });
    const inboxFor = (user, title) => Notification.findOne({ userId: user.user._id, title }).lean();

    // 1. Admin only.
    let res = await send(selected([ramesh]), staff.token);
    assert.strictEqual(res.status, 403, 'staff cannot send');
    res = await call('POST', '/admin/customers/notifications/count', { token: staff.token, body: { audience: 'buyers' } });
    assert.strictEqual(res.status, 403, 'staff cannot count');
    res = await call('GET', '/admin/customers/notifications/history', { token: staff.token });
    assert.strictEqual(res.status, 403, 'staff cannot read history');

    // 2. Every page link: { link: 'page', page }, no type; on push and inbox.
    for (const page of ['cart', 'wishlist', 'coupons', 'orders', 'hot-deals', 'popular', 'coming-soon']) {
      reset();
      const body = selected([ramesh], { title: `Page ${page} ${suffix}`, link: { type: 'page', page } });
      res = await send(body);
      assert.strictEqual(res.status, 200, `${page}: ${JSON.stringify(res.json)}`);
      assert.strictEqual(multicasts.length, 1, 'identical message: multicast');
      assert.strictEqual(multicasts[0].data.link, 'page');
      assert.strictEqual(multicasts[0].data.page, page);
      assert.strictEqual(multicasts[0].data.type, undefined);
      const saved = await inboxFor(ramesh, body.title);
      assert.deepStrictEqual(saved.data, { link: 'page', page });
    }
    res = await send(selected([ramesh], { link: { type: 'page', page: 'settings' } }));
    assert.strictEqual(res.status, 400, 'unknown page refused');

    // 3. Customers-only and wholesalers-only pages.
    res = await send({ audience: 'wholesalers', title: 'x', body: 'y', link: { type: 'page', page: 'wholesaler' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(code(res), 'PAGE_NOT_FOR_AUDIENCE');
    res = await send({ audience: 'buyers', title: 'x', body: 'y', link: { type: 'page', page: 'negotiations' } });
    assert.strictEqual(code(res), 'PAGE_NOT_FOR_AUDIENCE');
    res = await send({ audience: 'cart', title: 'x', body: 'y', link: { type: 'page', page: 'wholesaler' } });
    assert.strictEqual(code(res), 'PAGE_NOT_FOR_AUDIENCE', 'cart with everyone is mixed');
    // Chosen people: the other kind are left out and reported.
    reset();
    let body = selected([ramesh, trader], { title: `Apply ${suffix}`, link: { type: 'page', page: 'wholesaler' } });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.saved, 1);
    assert.strictEqual(res.json.data.skipped, 1);
    assert.match(res.json.message, /left out/);
    assert.ok(await inboxFor(ramesh, body.title));
    assert.ok(!(await inboxFor(trader, body.title)), 'the wholesaler did not get Apply for Wholesaler');
    res = await send(selected([ramesh], { link: { type: 'page', page: 'negotiations' } }));
    assert.strictEqual(code(res), 'PAGE_NOT_FOR_AUDIENCE', 'nobody left');
    body = selected([trader], { title: `Ask ${suffix}`, link: { type: 'page', page: 'negotiations' } });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    // The count leaves them out too.
    res = await call('POST', '/admin/customers/notifications/count', {
      token: admin.token,
      body: { userIds: [String(ramesh.user._id), String(trader.user._id)], link: { type: 'page', page: 'wholesaler' } },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual([res.json.data.people, res.json.data.phones], [1, 1]);

    // 4. Sale links: type 'sale' + link 'sale' + saleId; its banner is
    //    the default picture; ended and draft sales refused.
    const day = 24 * 60 * 60 * 1000;
    const banner = 'https://storage.googleapis.com/oxon-test/sales/diwali.webp';
    const liveSale = await Sale.create({
      name: `V2 Diwali ${suffix}`, startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day),
      status: 'published', customerPercent: 10, heroImageUrl: banner,
    });
    const endedSale = await Sale.create({
      name: `V2 Old ${suffix}`, startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day),
      status: 'published', customerPercent: 10,
    });
    const stoppedSale = await Sale.create({
      name: `V2 Stopped ${suffix}`, startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day),
      status: 'published', customerPercent: 10, endedAt: new Date(Date.now() - 1000),
    });
    const draftSale = await Sale.create({
      name: `V2 Draft ${suffix}`, startsAt: new Date(Date.now() + day), endsAt: new Date(Date.now() + 2 * day),
      status: 'draft', customerPercent: 10,
    });
    made.sales.push(liveSale._id, endedSale._id, stoppedSale._id, draftSale._id);
    reset();
    body = selected([ramesh], { title: `Sale ${suffix}`, link: { type: 'sale', id: String(liveSale._id) }, imageUrl: banner });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(
      { type: multicasts[0].data.type, link: multicasts[0].data.link, saleId: multicasts[0].data.saleId },
      { type: 'sale', link: 'sale', saleId: String(liveSale._id) }
    );
    assert.strictEqual(multicasts[0].notification.imageUrl, banner, 'the sale banner is allowed as the picture');
    let saved = await inboxFor(ramesh, body.title);
    assert.deepStrictEqual(saved.data, { type: 'sale', link: 'sale', saleId: String(liveSale._id), imageUrl: banner });
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(endedSale._id) } }));
    assert.strictEqual(code(res), 'SALE_ENDED');
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(stoppedSale._id) } }));
    assert.strictEqual(code(res), 'SALE_ENDED', '"End now" counts as ended');
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(draftSale._id) } }));
    assert.strictEqual(code(res), 'SALE_NOT_PUBLISHED');
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(new mongoose.Types.ObjectId()) } }));
    assert.strictEqual(code(res), 'LINK_NOT_FOUND');
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(endedSale._id) }, imageUrl: 'https://example.com/x.png' }));
    assert.strictEqual(res.status, 400);
    // A sale for one group only: the other group can't open it in the app.
    const wholesaleSale = await Sale.create({
      name: `V2 Trade ${suffix}`, startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day),
      status: 'published', audience: 'wholesalers', wholesalerPercent: 5,
    });
    made.sales.push(wholesaleSale._id);
    res = await send({ audience: 'buyers', title: 'x', body: 'y', link: { type: 'sale', id: String(liveSale._id) } });
    assert.strictEqual(res.status, 200, 'a customers sale to all customers is fine');
    res = await send({ audience: 'wholesalers', title: 'x', body: 'y', link: { type: 'sale', id: String(liveSale._id) } });
    assert.strictEqual(code(res), 'SALE_NOT_FOR_AUDIENCE');
    res = await send({ audience: 'cart', segment: 'all', title: 'x', body: 'y', link: { type: 'sale', id: String(wholesaleSale._id) } });
    assert.strictEqual(code(res), 'SALE_NOT_FOR_AUDIENCE');
    body = selected([ramesh, trader], { title: `Trade sale ${suffix}`, link: { type: 'sale', id: String(wholesaleSale._id) } });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual([res.json.data.saved, res.json.data.skipped], [1, 1]);
    assert.ok(await inboxFor(trader, body.title));
    assert.ok(!(await inboxFor(ramesh, body.title)), 'the customer did not get the wholesalers sale');
    res = await call('POST', '/admin/customers/notifications/count', {
      token: admin.token, body: { userIds: [id0(ramesh), id0(trader)], link: { type: 'sale', id: String(wholesaleSale._id) } },
    });
    assert.deepStrictEqual([res.json.data.people, res.json.data.skipped], [1, 1]);
    res = await send(selected([ramesh], { link: { type: 'sale', id: String(wholesaleSale._id) } }));
    assert.strictEqual(code(res), 'SALE_NOT_FOR_AUDIENCE', 'nobody left');

    // 5. Coupons: active codes only, for the right group; the message gets
    //    " Use code CODE." (Hindi: " कोड CODE इस्तेमाल करें।").
    const mkOffer = async (fields) => {
      const offer = await Offer.create({ title: 'V2 offer', discountValue: 10, ...fields });
      made.offers.push(offer._id);
      return offer;
    };
    await mkOffer({ code: `ALL${suffix}`.toUpperCase(), targetGroup: 'all' });
    await mkOffer({ code: `CUST${suffix}`.toUpperCase(), targetGroup: 'buyer' });
    await mkOffer({ code: `WHOLE${suffix}`.toUpperCase(), targetGroup: 'wholesaler' });
    await mkOffer({ code: `OFF${suffix}`.toUpperCase(), isActive: false });
    await mkOffer({ code: `OLD${suffix}`.toUpperCase(), startDate: new Date(Date.now() - 3 * day), endDate: new Date(Date.now() - day) });
    await mkOffer({ code: `USED${suffix}`.toUpperCase(), usageLimit: 1, usageCount: 1 });
    const ALL = `ALL${suffix}`.toUpperCase();
    reset();
    body = selected([ramesh, sita], { title: `Coupon ${suffix}`, body: 'Big savings.', couponCode: ALL.toLowerCase() });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(multicasts[0].notification.body, `Big savings. Use code ${ALL}.`);
    assert.strictEqual(multicasts[0].data.couponCode, ALL);
    saved = await inboxFor(ramesh, body.title);
    assert.strictEqual(saved.body, `Big savings. Use code ${ALL}.`);
    assert.strictEqual(saved.data.couponCode, ALL);
    assert.strictEqual(saved.data.type, 'custom_admin_notification');
    for (const [bad, expected] of [['NOPE', 'COUPON_NOT_FOUND'], [`OFF${suffix}`, 'COUPON_NOT_FOUND'], [`OLD${suffix}`, 'COUPON_NOT_FOUND'], [`USED${suffix}`, 'COUPON_LIMIT_REACHED']]) {
      res = await send(selected([ramesh], { couponCode: bad }));
      assert.strictEqual(code(res), expected, bad);
    }
    res = await send(selected([ramesh, trader], { couponCode: `CUST${suffix}` }));
    assert.strictEqual(code(res), 'COUPON_NOT_FOR_AUDIENCE', 'a wholesaler among the chosen');
    res = await send({ audience: 'wholesalers', title: 'x', body: 'y', couponCode: `CUST${suffix}` });
    assert.strictEqual(code(res), 'COUPON_NOT_FOR_AUDIENCE');
    res = await send({ audience: 'cart', segment: 'all', title: 'x', body: 'y', couponCode: `WHOLE${suffix}` });
    assert.strictEqual(code(res), 'COUPON_NOT_FOR_AUDIENCE');
    body = selected([trader], { title: `Whole coupon ${suffix}`, couponCode: `WHOLE${suffix}` });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));

    // 6. {name} and Hindi: each person's own text, sent one by one.
    reset();
    body = selected([ramesh, sita, noName, trader], {
      title: `Hi {name} ${suffix}`,
      body: 'Your cart is waiting, {name}.',
      titleHi: `नमस्ते {name} ${suffix}`,
      bodyHi: '{name}, आपका कार्ट इंतज़ार कर रहा है।',
      couponCode: ALL,
      link: { type: 'page', page: 'cart' },
    });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(multicasts.length, 0, 'personal messages are not multicast');
    const sent = eachCalls.flat();
    assert.strictEqual(sent.length, 4, 'one message per phone');
    const byToken = Object.fromEntries(sent.map((m) => [m.token, m]));
    assert.strictEqual(byToken[`ok-ramesh-${suffix}`].notification.title, `Hi Ramesh ${suffix}`);
    assert.strictEqual(byToken[`ok-ramesh-${suffix}`].notification.body, `Your cart is waiting, Ramesh. Use code ${ALL}.`);
    assert.strictEqual(byToken[`ok-sita-${suffix}`].notification.title, `नमस्ते Sita ${suffix}`);
    assert.strictEqual(byToken[`ok-sita-${suffix}`].notification.body, `Sita, आपका कार्ट इंतज़ार कर रहा है। कोड ${ALL} इस्तेमाल करें।`);
    assert.strictEqual(byToken[`ok-trader-${suffix}`].data.page, 'cart');
    assert.strictEqual(res.json.data.delivered, 3);
    assert.strictEqual(res.json.data.failed, 1);
    assert.strictEqual((await DeviceToken.findOne({ fcmToken: `dead-trader-${suffix}` })).isActive, false, 'dead token switched off');
    const rows = await Notification.find({ userId: { $in: made.users }, 'data.page': 'cart', body: /cart|कार्ट/ , createdAt: { $gte: new Date(Date.now() - 60000) } }).lean();
    const rowFor = (u) => rows.find((r) => String(r.userId) === String(u.user._id) && r.title.endsWith(suffix) && /Hi|नमस्ते/.test(r.title));
    assert.strictEqual(rowFor(ramesh).title, `Hi Ramesh ${suffix}`);
    assert.strictEqual(rowFor(sita).title, `नमस्ते Sita ${suffix}`);
    assert.strictEqual(rowFor(trader).body, `Mohan, आपका कार्ट इंतज़ार कर रहा है। कोड ${ALL} इस्तेमाल करें।`);
    assert.strictEqual(rowFor(noName).title, `Hi there ${suffix}`, 'no name: "there"');
    // Hindi without a name: "जी".
    const hindiNoName = await makeUser('buyer', { name: 'Nameless', preferredLanguage: 'hi' });
    await User.updateOne({ _id: hindiNoName.user._id }, { $set: { name: '' } });
    body = selected([hindiNoName], { title: 'x', body: 'y', titleHi: `नमस्ते {name} ${suffix}`, bodyHi: 'संदेश' });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.ok(await Notification.findOne({ userId: hindiNoName.user._id, title: `नमस्ते जी ${suffix}` }), 'no name in Hindi: जी');
    // Only one Hindi field: refused.
    res = await send(selected([ramesh], { titleHi: 'केवल शीर्षक' }));
    assert.strictEqual(code(res), 'HINDI_INCOMPLETE');
    // Same text for everyone: still one multicast.
    reset();
    res = await send(selected([ramesh, sita], { title: `Plain ${suffix}`, body: 'Same for all' }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(multicasts.length, 1);
    assert.strictEqual(eachCalls.length, 0);

    // 7. Items in cart, with the customers / wholesalers filter.
    await Cart.deleteMany({ userId: { $in: made.users } });
    await Cart.create({ userId: ramesh.user._id, items: [{ productId: product._id, quantity: 1, priceAtAdd: 900 }] });
    await Cart.create({ userId: trader.user._id, items: [{ productId: product._id, quantity: 2, priceAtAdd: 800 }] });
    await Cart.create({ userId: sita.user._id, items: [] });
    const inactive = await makeUser('buyer', { isActive: false });
    await Cart.create({ userId: inactive.user._id, items: [{ productId: product._id, quantity: 1, priceAtAdd: 900 }] });
    const recipientsOf = async (title) => new Set((await Notification.find({ title }).select('userId').lean()).map((n) => String(n.userId)));
    const id = (u) => String(u.user._id);
    for (const [segment, inSet, outSet] of [
      ['all', [ramesh, trader], [sita, inactive, admin]],
      ['buyers', [ramesh], [trader, sita, inactive]],
      ['wholesalers', [trader], [ramesh, sita]],
    ]) {
      const title = `Cart ${segment} ${suffix}`;
      res = await send({ audience: 'cart', segment, title, body: 'Come back' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      const got = await recipientsOf(title);
      inSet.forEach((u) => assert.ok(got.has(id(u)), `${segment}: ${u.user.name} got it`));
      outSet.forEach((u) => assert.ok(!got.has(id(u)), `${segment}: ${u.user.name} did not`));
    }
    res = await send({ audience: 'cart', segment: 'buyers', title: `Cart apply ${suffix}`, body: 'x', link: { type: 'page', page: 'wholesaler' } });
    assert.strictEqual(res.status, 200, 'customers in the cart filter may get Apply for Wholesaler');

    // 8. Saved a product, with the filter; the count endpoint.
    await User.updateOne({ _id: ramesh.user._id }, { $set: { wishlist: [product._id] } });
    await User.updateOne({ _id: trader.user._id }, { $set: { wishlist: [product._id] } });
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { audience: 'saved', productId: String(product._id) } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    // Ramesh's phone, and the trader's one working phone (the dead one was switched off).
    assert.deepStrictEqual([res.json.data.people, res.json.data.phones], [2, 2]);
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { audience: 'saved', segment: 'wholesalers', productId: String(product._id) } });
    assert.deepStrictEqual([res.json.data.people, res.json.data.phones], [1, 1]);
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { audience: 'saved' } });
    assert.strictEqual(res.status, 400, 'saved needs a product');
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { userIds: [id(ramesh), id(sita)] } });
    assert.deepStrictEqual([res.json.data.people, res.json.data.phones], [2, 2]);
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { audience: 'cart', segment: 'buyers' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.data.people >= 1);
    const savedTitle = `Saved ${suffix}`;
    res = await send({ audience: 'saved', segment: 'buyers', productId: String(product._id), title: savedTitle, body: 'Price dropped', link: { type: 'page', page: 'wishlist' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const savedGot = await recipientsOf(savedTitle);
    assert.deepStrictEqual([...savedGot], [id(ramesh)]);

    // 9. History: a row per send, newest first, with the typed text.
    res = await call('GET', '/admin/customers/notifications/history?page=1&limit=5', { token: admin.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const latest = res.json.data[0];
    assert.strictEqual(latest.title, savedTitle);
    assert.strictEqual(latest.audience, 'saved');
    assert.strictEqual(latest.segment, 'buyers');
    assert.strictEqual(String(latest.productId), String(product._id));
    assert.strictEqual(latest.productName, product.name);
    assert.deepStrictEqual(latest.link, { type: 'page', page: 'wishlist' });
    assert.strictEqual(latest.recipients, 1);
    assert.strictEqual(latest.sentBy.name, admin.user.name);
    assert.strictEqual(String(latest.sentBy.id), id(admin));
    assert.ok(res.json.pagination.total >= 10);
    const personalRow = await NotificationCampaign.findOne({ title: `Hi {name} ${suffix}` }).lean();
    assert.strictEqual(personalRow.body, 'Your cart is waiting, {name}.', 'kept as typed');
    assert.strictEqual(personalRow.bodyHi, '{name}, आपका कार्ट इंतज़ार कर रहा है।');
    assert.strictEqual(personalRow.couponCode, ALL);
    assert.deepStrictEqual([personalRow.recipients, personalRow.phones, personalRow.delivered, personalRow.failed], [4, 4, 3, 1]);
    const saleRow = await NotificationCampaign.findOne({ title: `Sale ${suffix}` }).lean();
    assert.deepStrictEqual(saleRow.link, { type: 'sale', id: String(liveSale._id), name: liveSale.name });
    assert.strictEqual(saleRow.imageUrl, banner);
    assert.strictEqual(saleRow.status, 'sent');

    // 9b. The same send id twice: the second is refused, nothing doubles.
    const sendId = `send-${suffix}-0001`;
    body = selected([ramesh, sita], { title: `Once ${suffix}`, sendId });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await send(body);
    assert.strictEqual(res.status, 409, JSON.stringify(res.json));
    assert.strictEqual(code(res), 'ALREADY_SENT');
    assert.strictEqual(await Notification.countDocuments({ title: body.title }), 2, 'one inbox row each');
    assert.strictEqual(await NotificationCampaign.countDocuments({ sendId }), 1);
    // Two at once: one goes through.
    const raceId = `race-${suffix}-0001`;
    const both = await Promise.all([0, 1].map(() => send(selected([ramesh], { title: `Race ${suffix}`, sendId: raceId }))));
    assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(await Notification.countDocuments({ title: `Race ${suffix}` }), 1);
    res = await send(selected([ramesh], { sendId: 'bad id!' }));
    assert.strictEqual(res.status, 400, 'send ids are plain');

    // 9c. Firebase throwing for a batch: still 200, saved in the inboxes,
    //     the pushes count as failed and the history row is written.
    const working = notificationService.messaging;
    notificationService.messaging = {
      async sendEachForMulticast() { throw new Error('quota exceeded'); },
      async sendEach() { throw new Error('quota exceeded'); },
    };
    for (const [label, extra] of [['same', {}], ['personal', { title: `Hi {name} boom ${suffix}` }]]) {
      body = selected([ramesh, sita], { title: `Boom ${label} ${suffix}`, ...extra });
      res = await send(body);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.deepStrictEqual([res.json.data.delivered, res.json.data.failed, res.json.data.phones], [0, 2, 2]);
      assert.match(res.json.message, /Don't send it again/);
      const row = await NotificationCampaign.findOne({ title: body.title }).lean();
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual(row.failed, 2);
      assert.ok(row.pushError);
      assert.strictEqual(await Notification.countDocuments({ title: label === 'same' ? body.title : /boom/ }), 2);
    }
    notificationService.messaging = working;

    // 9d. Names: titles like Dr. / Shri / M/s are skipped; "$&" stays as typed.
    const doctor = await makeUser('buyer', { name: 'Dr. Anil Sharma' });
    const shri = await makeUser('buyer', { name: 'shri ramlal' });
    const firm = await makeUser('wholesaler', { name: 'M/s Gupta Traders' });
    const odd = await makeUser('buyer', { name: '$& Dollar' });
    body = selected([doctor, shri, firm, odd], { title: `Name {name} ${suffix}` });
    res = await send(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const nameRows = await Notification.find({ userId: { $in: [doctor, shri, firm, odd].map((u) => u.user._id) }, title: /^Name / }).lean();
    const titleOf = (u) => nameRows.find((r) => String(r.userId) === id0(u)).title;
    assert.strictEqual(titleOf(doctor), `Name Anil ${suffix}`);
    assert.strictEqual(titleOf(shri), `Name ramlal ${suffix}`);
    assert.strictEqual(titleOf(firm), `Name Gupta ${suffix}`);
    assert.strictEqual(titleOf(odd), `Name $& ${suffix}`);

    // 9e. Chosen people are customers and wholesalers only; at most 2000.
    res = await send(selected([admin, staff, ramesh], { title: `Staff ${suffix}` }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.saved, 1);
    assert.ok(!(await inboxFor(admin, `Staff ${suffix}`)));
    res = await send({ userIds: Array.from({ length: 2001 }, () => String(new mongoose.Types.ObjectId())), title: 'x', body: 'y' });
    assert.strictEqual(res.status, 400);
    res = await call('POST', '/admin/customers/notifications/count', { token: admin.token, body: { userIds: [id0(admin), id0(ramesh)] } });
    assert.strictEqual(res.json.data.people, 1);

    // 10. Saved messages: the nine defaults; saved on their own.
    await Settings.deleteOne({ _id: 'app_settings' });
    res = await call('GET', '/admin/settings', { token: admin.token });
    assert.strictEqual(res.status, 200);
    const templates = res.json.data.notificationTemplates;
    assert.strictEqual(templates.length, 9);
    assert.deepStrictEqual(templates.map((t) => t.name), DEFAULT_NOTIFICATION_TEMPLATES.map((t) => t.name));
    assert.deepStrictEqual(templates.find((t) => t.name === 'Your cart is waiting').link, { type: 'page', page: 'cart' });
    assert.strictEqual(templates.find((t) => t.name.startsWith('Sale is live')).link, null);
    const shippingBefore = res.json.data.productTemplates.shippingTerms;
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { businessName: 'V2 Biz', productTemplates: { warranty: 'V2 warranty' } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.notificationTemplates.length, 9, 'other settings leave the saved messages alone');
    const mine = [
      { name: 'Mine', title: 'Hi {name}', body: 'Body', titleHi: '', bodyHi: '', link: { type: 'product', id: String(product._id), name: product.name }, imageUrl: '' },
      { name: 'Page one', title: 'T', body: 'B', link: { type: 'page', page: 'orders' } },
    ];
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { notificationTemplates: mine } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const after = await Settings.findById('app_settings').lean();
    assert.strictEqual(after.notificationTemplates.length, 2);
    assert.deepStrictEqual(after.notificationTemplates[0].link, { type: 'product', id: String(product._id), name: product.name });
    assert.deepStrictEqual(after.notificationTemplates[1].link, { type: 'page', page: 'orders' });
    assert.strictEqual(after.businessName, 'V2 Biz', 'saving templates keeps other settings');
    assert.strictEqual(after.productTemplates.warranty, 'V2 warranty');
    assert.strictEqual(after.productTemplates.shippingTerms, shippingBefore);
    // Limits: 50 at most, a name, a known page.
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { notificationTemplates: Array.from({ length: 51 }, (_, i) => ({ name: `N${i}`, title: 't', body: 'b' })) } });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { notificationTemplates: [{ name: '', title: 't', body: 'b' }] } });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { notificationTemplates: [{ name: 'x', title: 't', body: 'b', link: { type: 'page', page: 'nowhere' } }] } });
    assert.strictEqual(res.status, 400);
    res = await call('PUT', '/admin/settings', { token: admin.token, body: { notificationTemplates: [] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.data.notificationTemplates, [], 'all deleted stays empty');

    console.log('notificationsV2.test.js: all checks passed');
  } finally {
    notificationService.messaging = null;
    await Promise.all([
      DeviceToken.deleteMany({ userId: { $in: made.users } }),
      Notification.deleteMany({ userId: { $in: made.users } }),
      Notification.deleteMany({ title: new RegExp(suffix) }),
      NotificationCampaign.deleteMany({ 'sentBy.id': { $in: made.users } }),
      Cart.deleteMany({ userId: { $in: made.users } }),
      User.deleteMany({ _id: { $in: made.users } }),
      Product.deleteMany({ _id: { $in: made.products } }),
      Sale.deleteMany({ _id: { $in: made.sales } }),
      Offer.deleteMany({ _id: { $in: made.offers } }),
      Settings.deleteOne({ _id: 'app_settings' }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

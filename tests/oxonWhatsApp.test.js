const assert = require('assert');

// After a wholesaler sends a price request or places an order, the app asks
// for OXON's WhatsApp number and the message (with a private PDF link) and
// opens WhatsApp with it.
//
//   WHATSAPP_ALERT_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_whatsapp_test?replicaSet=rs0' node tests/oxonWhatsApp.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.PUBLIC_API_URL;

const uri = process.env.WHATSAPP_ALERT_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set WHATSAPP_ALERT_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: WHATSAPP_ALERT_TEST_MONGODB_URI must point at a database on this machine');
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
  const { normalizeWhatsAppNumber, requestMessage, MAX_LINES } = require('../src/services/oxonWhatsAppService');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const made = { users: [], products: [], orders: [] };

  const call = async (method, path, token, body) => {
    const res = await fetch(path.startsWith('http') ? path : base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const isPdf = (res.headers.get('content-type') || '').includes('application/pdf');
    return {
      status: res.status,
      headers: res.headers,
      pdf: isPdf ? Buffer.from(await res.arrayBuffer()).toString('latin1') : null,
      json: isPdf ? null : await res.clone().json().catch(() => ({})),
      text: isPdf ? null : await res.text().catch(() => ''),
    };
  };
  const makeUser = async (role, extra = {}) => {
    const user = await M.User.create({ name: `WA ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const alertFor = (type, id, token) => call('GET', `/whatsapp-alert?type=${type}&id=${encodeURIComponent(id)}`, token);
  const pdfUrlIn = (text) => (text.match(/PDF: (\S+)/) || [])[1];
  const suffix = Date.now().toString(36);

  const settings = await M.Settings.getSettings();
  const savedAlerts = settings.whatsappAlerts?.toObject?.() || null;

  try {
    const admin = await makeUser('admin');
    const buyer = await makeUser('buyer');
    const wholesaler = await makeUser('wholesaler', { name: 'Wahid Wholesale', businessInfo: { businessName: 'Wahid Agro Traders', gstNumber: '22AAAAA0000A1Z5' } });
    const other = await makeUser('wholesaler');
    const products = await M.Product.create([1, 2].map((n) => ({
      name: `WA Engine ${n} ${suffix}`, category: 'engines', mrp: 1200, retailPrice: 1000, wholesalePrice: 800,
      sku: `WA-${n}-${suffix}`, stock: 500, status: 'active', negotiationEnabled: true,
    })));
    made.products.push(...products.map((p) => p._id));
    const [engine, engine2] = products;

    // 1. Admin sets the number; it is stored as 91XXXXXXXXXX.
    assert.strictEqual(normalizeWhatsAppNumber('+91 78288 32346'), '917828832346');
    assert.strictEqual(normalizeWhatsAppNumber('078288 32346'), '917828832346');
    assert.strictEqual(normalizeWhatsAppNumber('12345'), null);
    let res = await call('PUT', '/admin/settings', admin.token, { whatsappAlerts: { number: '078288 32346', enabled: true, negotiations: true, orders: true } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.whatsappAlerts.number, '917828832346');
    res = await call('PUT', '/admin/settings', admin.token, { whatsappAlerts: { number: '12345' } });
    assert.strictEqual(res.status, 400, 'a wrong number is refused');
    console.log('ok - admin sets the number; it is cleaned up');

    // 2. A price request on one product: the message, only for its wholesaler.
    res = await call('POST', '/negotiations', wholesaler.token, { productId: String(engine._id), quantity: 10, pricePerUnit: 760 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const { id: negotiationId, negotiationNumber } = res.json.data;
    res = await alertFor('negotiation', negotiationId, wholesaler.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const { enabled, number, text } = res.json.data;
    assert.strictEqual(enabled, true);
    assert.strictEqual(number, '917828832346');
    for (const expected of [
      `*New price request ${negotiationNumber}*`,
      'Wahid Wholesale · Wahid Agro Traders',
      `WA Engine 1 ${suffix} (SKU WA-1-${suffix.toUpperCase()}): 10 × ₹760 asked (list ₹800) = ₹7,600`,
      'Total asked: ₹7,600',
      '— sent from the OXON app',
    ]) assert.ok(text.includes(expected), `message has ${expected}\n${text}`);
    assert.strictEqual((await alertFor('negotiation', negotiationId, other.token)).status, 404, 'not another wholesaler\'s');
    assert.strictEqual((await alertFor('negotiation', negotiationId, buyer.token)).status, 403, 'wholesalers only');
    assert.strictEqual((await alertFor('negotiation', negotiationId)).status, 401);
    assert.strictEqual((await call('GET', '/whatsapp-alert?type=nope&id=1', wholesaler.token)).status, 400);
    console.log('ok - price request message, for its own wholesaler only');

    // 3. The PDF link: no sign-in, not indexed, the same link each time.
    const pdfUrl = pdfUrlIn(text);
    assert.ok(pdfUrl && pdfUrl.startsWith('http://127.0.0.1:'), pdfUrl);
    res = await call('GET', pdfUrl);
    assert.strictEqual(res.status, 200);
    assert.ok(res.pdf.startsWith('%PDF-'));
    for (const expected of ['Price Request', negotiationNumber, `WA Engine 1 ${suffix}`, 'Wahid Agro Traders', 'Total Asked', 'this is not a bill']) {
      assert.ok(res.pdf.includes(expected), `PDF has ${expected}`);
    }
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
    assert.strictEqual(pdfUrlIn((await alertFor('negotiation', negotiationId, wholesaler.token)).json.data.text), pdfUrl, 'one link per request');
    console.log('ok - the PDF opens from the link');

    // 4. A requirement (the cart): every line, the note, one REQ number.
    await M.Cart.create({
      userId: wholesaler.user._id,
      items: [
        { productId: engine._id, quantity: 10, priceAtAdd: 800 },
        { productId: engine2._id, quantity: 20, priceAtAdd: 800 },
      ],
    });
    res = await call('POST', '/negotiations/from-cart', wholesaler.token, { message: 'Need before 15 Nov' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const group = res.json.data.requestGroup;
    const requirementText = (await alertFor('requirement', group.id, wholesaler.token)).json.data.text;
    for (const expected of [`*New price request ${group.number}*`, `1. WA Engine 1 ${suffix}`, `2. WA Engine 2 ${suffix}`, 'Note: "Need before 15 Nov"']) {
      assert.ok(requirementText.includes(expected), `requirement message has ${expected}\n${requirementText}`);
    }
    const lineText = (await alertFor('negotiation', res.json.data.negotiationIds[1], wholesaler.token)).json.data.text;
    assert.ok(lineText.startsWith(`*New price request ${group.number}*`), 'a line stands for its requirement');
    assert.strictEqual((await alertFor('requirement', group.id, other.token)).status, 404);
    res = await call('GET', pdfUrlIn(requirementText));
    assert.ok(res.pdf.includes(group.number) && res.pdf.includes(`WA Engine 2 ${suffix}`), 'the requirement PDF has every line');
    console.log('ok - requirement message and PDF');

    // 5. An order: a summary (not a receipt) until OXON confirms it.
    const address = { fullName: 'Wahid', phone: '9812345671', addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };
    res = await call('POST', '/orders', wholesaler.token, { items: [{ productId: String(engine._id), quantity: 10 }], shippingAddress: address });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const { orderId, orderNumber } = res.json.data;
    made.orders.push(orderId);
    const orderText = (await alertFor('order', orderId, wholesaler.token)).json.data.text;
    for (const expected of [`*New order ${orderNumber}*`, 'Payment: Awaiting payment', 'Deliver to: Raipur, Chhattisgarh', 'Total: ₹']) {
      assert.ok(orderText.includes(expected), `order message has ${expected}\n${orderText}`);
    }
    assert.strictEqual((await alertFor('order', orderId, other.token)).status, 404);
    res = await call('GET', pdfUrlIn(orderText));
    assert.ok(res.pdf.includes('Order Summary') && !res.pdf.includes('Order Receipt'), 'a summary until confirmed');
    assert.ok(res.pdf.includes(orderNumber));
    console.log('ok - order message; its PDF is a summary until confirmed');

    // 6. Admin's switches turn it off.
    await call('PUT', '/admin/settings', admin.token, { whatsappAlerts: { orders: false } });
    assert.strictEqual((await alertFor('order', orderId, wholesaler.token)).json.data.enabled, false);
    assert.strictEqual((await alertFor('negotiation', negotiationId, wholesaler.token)).json.data.enabled, true, 'price requests still on');
    await call('PUT', '/admin/settings', admin.token, { whatsappAlerts: { orders: true, enabled: false } });
    assert.strictEqual((await alertFor('negotiation', negotiationId, wholesaler.token)).json.data.enabled, false);
    await call('PUT', '/admin/settings', admin.token, { whatsappAlerts: { enabled: true } });
    console.log('ok - the switches turn it off');

    // 7. A link stops working after 30 days.
    await M.ShareLink.updateMany({ wholesalerId: wholesaler.user._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    res = await call('GET', pdfUrl);
    assert.strictEqual(res.status, 404);
    assert.match(res.text, /expired/);
    assert.strictEqual((await call('GET', `${base}/s/not-a-real-token-123456`)).status, 404);
    console.log('ok - old and made-up links do not work');

    // 8. Long lists stay short in the message.
    const many = Array.from({ length: MAX_LINES + 2 }, (_, i) => ({
      negotiationNumber: 'NEG-1', requestGroup: { number: 'REQ-9' }, productSnapshot: { name: `Item ${i + 1}`, price: 100 },
      requestedQuantity: 1, requestedPricePerUnit: 90, requestedTotalPrice: 90, createdAt: new Date(),
    }));
    const long = requestMessage({ members: many, wholesaler: wholesaler.user, pdfUrl: 'http://x/s/abc' });
    assert.ok(long.includes(`${MAX_LINES}. Item ${MAX_LINES}`) && !long.includes(`Item ${MAX_LINES + 1}:`));
    assert.ok(long.includes('+2 more (see PDF)'));
    assert.ok(long.includes(`Total asked: ₹${(90 * (MAX_LINES + 2)).toLocaleString('en-IN')}`), 'the total counts every line');
    console.log('ok - long lists end with "+N more"');
  } finally {
    await M.Settings.updateOne({ _id: 'app_settings' }, savedAlerts ? { $set: { whatsappAlerts: savedAlerts } } : { $unset: { whatsappAlerts: 1 } });
    await M.ShareLink.deleteMany({ wholesalerId: { $in: made.users } });
    await M.Negotiation.deleteMany({ wholesalerId: { $in: made.users } });
    await M.Cart.deleteMany({ userId: { $in: made.users } });
    await M.Order.deleteMany({ _id: { $in: made.orders } });
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS oxonWhatsApp');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

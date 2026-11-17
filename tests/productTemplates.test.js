const assert = require('assert');

// Settings → Product templates: Shipping & Returns and Warranty typed once
// and shown on every product that uses them (or a product's own text);
// specification sets and text blocks kept for the product form.
//
//   PRODUCT_TEMPLATES_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_product_templates_test?replicaSet=rs0' node tests/productTemplates.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PRODUCT_TEMPLATES_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PRODUCT_TEMPLATES_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PRODUCT_TEMPLATES_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, Product, Settings } = require('../src/models');
  const { LEGACY_SHIPPING_TERMS } = require('../src/services/productTemplates');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const suffix = Date.now().toString(36);
  const made = { users: [], products: [] };
  let skus = 0;
  const makeProduct = async (fields = {}) => {
    skus += 1;
    const product = await Product.create({
      name: `PT Pump ${suffix} ${skus}`, category: 'pumps', mrp: 1000, retailPrice: 900, wholesalePrice: 800,
      sku: `PT-${suffix}-${skus}`, stock: 5, status: 'active', ...fields,
    });
    made.products.push(product._id);
    return product;
  };
  const shown = async (product) => {
    const res = await call('GET', `/products/${product._id}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    return res.json.data;
  };

  try {
    await Settings.deleteOne({ _id: 'app_settings' });
    const admin = await User.create({ name: 'PT admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.users.push(admin._id);
    const token = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    // 1. Settings start with the old shipping text, a warranty, a spec set
    //    and a text block, ready to edit.
    let res = await call('GET', '/admin/settings', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const templates = res.json.data.productTemplates;
    assert.strictEqual(templates.shippingTerms, LEGACY_SHIPPING_TERMS);
    assert.match(templates.warranty, /manufacturing defects/);
    assert.ok(templates.specSets.length >= 1 && templates.specSets[0].items.length >= 1);
    assert.ok(templates.textBlocks.length >= 1);
    console.log('ok - settings start with shipping, warranty, a spec set and a text block');

    // 2. A product using the shared text shows it; editing it in Settings
    //    changes it on the product at once.
    const common = await makeProduct({ useCommonShipping: true, useCommonWarranty: true });
    let data = await shown(common);
    assert.strictEqual(data.shippingTerms, LEGACY_SHIPPING_TERMS);
    assert.match(data.warranty, /manufacturing defects/);
    assert.strictEqual(data.useCommonShipping, undefined, 'the switch is not sent to shoppers');
    res = await call('PUT', '/admin/settings', token, { productTemplates: { shippingTerms: 'Free delivery across Chhattisgarh.' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    data = await shown(common);
    assert.strictEqual(data.shippingTerms, 'Free delivery across Chhattisgarh.');
    console.log('ok - shared text shows on the product and follows Settings');

    // 3. Saving one part keeps the others.
    const saved = await Settings.findById('app_settings').lean();
    assert.match(saved.productTemplates.warranty, /manufacturing defects/);
    assert.ok(saved.productTemplates.specSets.length >= 1);
    res = await call('PUT', '/admin/settings', token, {
      productTemplates: { specSets: [{ name: 'Power tools', items: [{ key: 'Warranty', value: '6 months' }, { key: 'Voltage', value: '220V' }] }] },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const afterSets = (await Settings.findById('app_settings').lean()).productTemplates;
    assert.strictEqual(afterSets.shippingTerms, 'Free delivery across Chhattisgarh.');
    assert.deepStrictEqual(afterSets.specSets, [{ name: 'Power tools', items: [{ key: 'Warranty', value: '6 months' }, { key: 'Voltage', value: '220V' }] }]);
    res = await call('PUT', '/admin/settings', token, { productTemplates: { specSets: [{ name: 'Bad', items: [{ key: 'Warranty' }] }] } });
    assert.strictEqual(res.status, 400, 'a row needs a value');
    console.log('ok - saving one part keeps the rest; bad rows are refused');

    // 4. A product's own text, set from the admin product form.
    res = await call('PUT', `/admin/products/${common._id}`, token, {
      useCommonShipping: false, shippingTerms: 'Ships from Raipur in 2 days.',
      useCommonWarranty: false, warranty: '2 years on the motor.',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    data = await shown(common);
    assert.strictEqual(data.shippingTerms, 'Ships from Raipur in 2 days.');
    assert.strictEqual(data.warranty, '2 years on the motor.');
    res = await call('PUT', `/admin/products/${common._id}`, token, { useCommonWarranty: false, warranty: '' });
    data = await shown(common);
    assert.strictEqual(data.warranty, null, 'own and empty: nothing shown');
    console.log('ok - a product can have its own text, or none');

    // 5. Products from before: the old built-in text or nothing set follow
    //    the shared text; typed text stays; an emptied field stays empty.
    const oldDefault = await makeProduct({ shippingTerms: LEGACY_SHIPPING_TERMS });
    const neverSet = await makeProduct();
    const typed = await makeProduct({ shippingTerms: 'Custom delivery note.' });
    const emptied = await makeProduct({ shippingTerms: null });
    assert.strictEqual((await shown(oldDefault)).shippingTerms, 'Free delivery across Chhattisgarh.');
    assert.strictEqual((await shown(neverSet)).shippingTerms, 'Free delivery across Chhattisgarh.');
    assert.strictEqual((await shown(typed)).shippingTerms, 'Custom delivery note.');
    assert.strictEqual((await shown(emptied)).shippingTerms, null, 'none: null, so older apps keep their fallback');
    assert.match((await shown(typed)).warranty, /manufacturing defects/, 'older products get the shared warranty');
    console.log('ok - older products follow the shared text unless they have their own');

    console.log('productTemplates.test.js: all checks passed');
  } finally {
    await Product.deleteMany({ _id: { $in: made.products } });
    await User.deleteMany({ _id: { $in: made.users } });
    await Settings.deleteOne({ _id: 'app_settings' });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

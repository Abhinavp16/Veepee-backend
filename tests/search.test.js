const assert = require('assert');

// Product search: specifications and brand are searched, units match however
// they're written, best match comes first (spare parts after machines),
// misspellings are corrected, Hindi words work, and filters still apply.
//
//   SEARCH_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_search_test?replicaSet=rs0' node tests/search.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const search = require('../src/services/productSearch');

// Without a database: the pieces.
assert.strictEqual(search.normalizeText('850 Watt').trim(), '850w');
assert.strictEqual(search.normalizeText('850W').trim(), '850w');
assert.strictEqual(search.normalizeText('7 HP petrol').trim(), '7hp petrol');
assert.strictEqual(search.normalizeText('4 Inch (101.6 mm)').trim(), '4inch 101.6mm');
assert.strictEqual(search.normalizeText('Chain Saw').trim(), 'chain saw chainsaw');
assert.strictEqual(search.normalizeText('chainsaw').trim(), 'chain saw chainsaw');
assert.strictEqual(search.editDistance('wedeer', 'weeder', 1), 1, 'a swapped pair is one mistake');
console.log('ok - text is normalized');

const uri = process.env.SEARCH_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set SEARCH_TEST_MONGODB_URI to a local MongoDB to run the API part');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: SEARCH_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

async function run() {
  const http = require('http');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const M = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36);
  const made = { products: [], categories: [], companies: [] };

  const find = async (q, extra = '') => {
    const res = await fetch(`${base}/products/search?limit=50&q=${encodeURIComponent(q)}${extra}`);
    const json = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(json));
    return { names: json.data.map((p) => p.name.replace(` ${suffix}`, '')), total: json.pagination.total, corrected: json.correctedQuery };
  };

  try {
    const tools = await M.Category.create({ name: `Power Tools ${suffix}` });
    const farm = await M.Category.create({ name: `Farm ${suffix}` });
    made.categories.push(tools._id, farm._id);
    const kirlo = await M.Company.create({ name: `Kirlo${suffix}`, slug: `kirlo-${suffix}` });
    made.companies.push(kirlo._id);

    let sku = 0;
    const product = async (name, category, fields = {}) => {
      sku += 1;
      const doc = await M.Product.create({
        name: `${name} ${suffix}`, category: 'x', categoryIds: [category._id], primaryCategoryId: category._id,
        sku: `SR-${suffix}-${sku}`, mrp: 1000, retailPrice: 900, wholesalePrice: 700, stock: 10, status: 'active',
        ...fields,
      });
      made.products.push(doc._id);
      return doc;
    };
    await product('Angle Grinder Back Switch', tools, {
      description: 'Reliable grinder for metal work.',
      specifications: [
        { key: 'feature_1', value: 'Power : 850 w' },
        { key: 'feature_2', value: 'Weight (Approx.) : 1.9 kg' },
        { key: 'feature_3', value: 'Rotor Type : Copper' },
        { key: 'feature_4', value: 'Wheel Size : 4 Inch (101.6 mm)' },
      ],
    });
    await product('Angle Grinder 6-100 - Stator', tools, { description: 'Spare stator for angle grinder.' });
    await product('Gasoline Engine 7HP (P.t.o Shaft)', farm, { specifications: [{ key: 'Power', value: '7 HP' }] });
    await product('Power Weeder 75 Gold', farm, { nameHindi: 'पावर वीडर 75 गोल्ड', description: 'Weeder for small farms.' });
    await product('Chain Saw 67CC', tools, { description: 'Petrol chain saw.' });
    await product('Water Pump 2 inch', farm, { company: kirlo._id, specifications: [{ key: 'Outlet', value: '2 Inch' }] });

    // 1. Specifications are searched.
    assert.deepStrictEqual((await find('copper')).names, ['Angle Grinder Back Switch']);
    assert.deepStrictEqual((await find('1.9 kg')).names, ['Angle Grinder Back Switch']);
    console.log('ok - specifications are searched');

    // 2. Units match however they're written.
    for (const q of ['850w', '850 w', '850 watt', '850 Watts']) {
      assert.deepStrictEqual((await find(q)).names, ['Angle Grinder Back Switch'], q);
    }
    assert.deepStrictEqual((await find('7hp')).names, (await find('7 hp')).names);
    assert.deepStrictEqual((await find('7 hp')).names, ['Gasoline Engine 7HP (P.t.o Shaft)']);
    assert.deepStrictEqual((await find('4inch')).names, ['Angle Grinder Back Switch']);
    assert.deepStrictEqual((await find('chainsaw')).names, (await find('chain saw')).names);
    console.log('ok - units and joined words match either way');

    // 3. Best match first; spare parts after the machine.
    assert.deepStrictEqual((await find('angle grinder')).names, ['Angle Grinder Back Switch', 'Angle Grinder 6-100 - Stator']);
    assert.deepStrictEqual((await find('grinder stator')).names, ['Angle Grinder 6-100 - Stator']);
    console.log('ok - best match first');

    // 4. Brand and every word somewhere (not all in one field).
    assert.deepStrictEqual((await find(`kirlo${suffix}`)).names, ['Water Pump 2 inch']);
    assert.deepStrictEqual((await find('grinder copper')).names, ['Angle Grinder Back Switch']);
    assert.strictEqual((await find('grinder zebra')).total, 0);
    console.log('ok - brand is searched; every word must match');

    // 5. A misspelling is corrected and said so.
    const typo = await find('wedeer');
    assert.deepStrictEqual(typo.names, ['Power Weeder 75 Gold']);
    assert.strictEqual(typo.corrected, 'weeder');
    assert.strictEqual((await find('weeder')).corrected, undefined);
    console.log('ok - misspellings are corrected');

    // 6. Hindi: the Hindi name and common Hindi words.
    assert.deepStrictEqual((await find('वीडर')).names, ['Power Weeder 75 Gold']);
    assert.deepStrictEqual((await find('पंप')).names, ['Water Pump 2 inch']);
    console.log('ok - Hindi words');

    // 7. Filters and paging still apply.
    const inFarm = await find('2 inch', `&categorySlug=${farm.slug}`);
    assert.deepStrictEqual(inFarm.names, ['Water Pump 2 inch']);
    const res = await fetch(`${base}/products/search?limit=1&page=2&q=${encodeURIComponent('angle grinder')}`);
    const paged = await res.json();
    assert.strictEqual(paged.pagination.total, 2);
    assert.strictEqual(paged.data[0].name, `Angle Grinder 6-100 - Stator ${suffix}`);
    console.log('ok - filters and paging');
  } finally {
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.Category.deleteMany({ _id: { $in: made.categories } });
    await M.Company.deleteMany({ _id: { $in: made.companies } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS search');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

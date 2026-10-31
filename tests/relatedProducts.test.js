const assert = require('assert');

// Related products: a machine's are other machines in its category, never
// the spare parts placed in a sub-category (those show under Accessories);
// a spare part's are the others in its own sub-category.
//
//   RELATED_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_related_test?replicaSet=rs0' node tests/relatedProducts.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.RELATED_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set RELATED_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: RELATED_TEST_MONGODB_URI must point at a database on this machine');
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
  const made = { products: [], categories: [], subs: [] };

  try {
    const saws = await M.Category.create({ name: `Chain Saw ${suffix}` });
    made.categories.push(saws._id);
    const spares = await M.SubCategory.create({ name: `Chainsaw Spares ${suffix}`, categories: [{ category: saws._id, order: 1 }] });
    const blades = await M.SubCategory.create({ name: `Chainsaw Blades ${suffix}`, categories: [{ category: saws._id, order: 2 }] });
    made.subs.push(spares._id, blades._id);

    let sku = 0;
    const product = async (name, placements) => {
      sku += 1;
      const doc = await M.Product.create({
        name: `${name} ${suffix}`, category: 'x', categoryIds: [saws._id], primaryCategoryId: saws._id, placements,
        sku: `RL-${suffix}-${sku}`, mrp: 1000, retailPrice: 900, wholesalePrice: 700, stock: 10, status: 'active',
      });
      made.products.push(doc._id);
      return doc;
    };
    const direct = { category: saws._id, subCategory: null };
    const saw72 = await product('Chain Saw 72', [direct]);
    await product('Chain Saw 67CC', [direct]);
    const bar = await product('CS Bar', [{ category: saws._id, subCategory: spares._id }]);
    await product('CS Chain', [{ category: saws._id, subCategory: spares._id }]);
    // In the sub-category and the category list both: still an accessory.
    await product('CS Sprocket', [direct, { category: saws._id, subCategory: spares._id }]);
    await product('CS Blade', [{ category: saws._id, subCategory: blades._id }]);

    const related = async (product) => {
      const res = await fetch(`${base}/products/${product._id}/related?limit=20`);
      const json = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(json));
      return json.data.map((p) => p.name.replace(` ${suffix}`, '')).sort();
    };

    assert.deepStrictEqual(await related(saw72), ['Chain Saw 67CC']);
    console.log('ok - a machine: other machines, no spare parts');
    assert.deepStrictEqual(await related(bar), ['CS Chain', 'CS Sprocket']);
    console.log('ok - a spare part: others in its sub-category');
  } finally {
    await M.Product.deleteMany({ _id: { $in: made.products } });
    await M.SubCategory.deleteMany({ _id: { $in: made.subs } });
    await M.Category.deleteMany({ _id: { $in: made.categories } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS relatedProducts');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

// Keeps every product that is in a sub-category also in that category's own
// list ("both"), as it showed before category lists began following
// placements. After this, admin chooses per product.
//
// Shows what it would do unless --apply is given. Never reads .env:
//   node scripts/migratePlacementsBoth.js --dev            (local dev database)
//   MONGODB_URI=... node scripts/migratePlacementsBoth.js  (any other, explicit)
// Add --apply to write.
const apply = process.argv.includes('--apply');
if (process.argv.includes('--dev')) require('./dev/devEnv');
if (!process.env.MONGODB_URI) {
  console.error('Set MONGODB_URI, or pass --dev for the local dev database.');
  process.exit(1);
}

const mongoose = require('mongoose');
const { Product } = require('../src/models');

const id = (value) => (value == null ? null : String(value?._id || value));

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} on ${mongoose.connection.name}`);

  const products = await Product.find({ 'placements.subCategory': { $ne: null } })
    .select('_id name placements')
    .lean();
  let changed = 0;
  for (const product of products) {
    const placements = (product.placements || []).map((p) => ({ category: id(p.category), subCategory: id(p.subCategory) }));
    const direct = new Set(placements.filter((p) => !p.subCategory).map((p) => p.category));
    const missing = [...new Set(placements.filter((p) => p.subCategory && !direct.has(p.category)).map((p) => p.category))];
    if (missing.length === 0) continue;
    changed += 1;
    console.log(`  "${product.name}": also in the category list again (${missing.length} categor${missing.length === 1 ? 'y' : 'ies'})`);
    if (apply) {
      await Product.updateOne(
        { _id: product._id },
        { $set: { placements: [...placements, ...missing.map((category) => ({ category, subCategory: null }))] } }
      );
    }
  }

  console.log(`${products.length} product(s) in a sub-category; ${changed} put back in the category list too.`);
  if (!apply) console.log('Nothing written. Run again with --apply.');
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});

// Moves the catalogue to Category → Sub-category.
//
//  1. Every child category (one with a parent) becomes a sub-category shown
//     under its parent. Its products are placed as "Parent › Sub-category" and
//     move to the parent category; brands linked to it are linked to the
//     parent; then the child category is deleted.
//  2. Every product without placements gets one per category it is in.
//
// Shows what it would do unless --apply is given. Never reads .env:
//   node scripts/migrateSubCategories.js --dev            (local dev database)
//   MONGODB_URI=... node scripts/migrateSubCategories.js  (any other, explicit)
// Add --apply to write.
const apply = process.argv.includes('--apply');
if (process.argv.includes('--dev')) require('./dev/devEnv');
if (!process.env.MONGODB_URI) {
  console.error('Set MONGODB_URI, or pass --dev for the local dev database.');
  process.exit(1);
}

const mongoose = require('mongoose');
const { Category, SubCategory, Product, Company } = require('../src/models');

const id = (value) => (value == null ? null : String(value?._id || value));

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} on ${mongoose.connection.name}`);

  const categories = await Category.find({}).select('+customerDiscountPercent +wholesalerDiscountPercent').lean();
  const byId = new Map(categories.map((category) => [String(category._id), category]));
  // Children of children are placed under their top-level category.
  const topOf = (category) => {
    let current = category;
    const seen = new Set();
    while (current?.parent && byId.has(id(current.parent)) && !seen.has(id(current))) {
      seen.add(id(current));
      current = byId.get(id(current.parent));
    }
    return current;
  };
  const children = categories.filter((category) => category.parent && byId.has(id(category.parent)));

  // 1. Child categories → sub-categories.
  const subFor = new Map(); // child category id → { sub id, top category id }
  for (const child of children) {
    const top = topOf(child);
    const discount = child.customerDiscountPercent || child.wholesalerDiscountPercent;
    console.log(`  "${child.name}" (under ${top.name}) → sub-category${discount ? '  [its own discount is dropped; the category\'s applies]' : ''}`);
    let sub = await SubCategory.findOne({ slug: child.slug }).lean();
    if (!sub && apply) {
      const order = (await SubCategory.countDocuments({ 'categories.category': top._id })) + 1;
      sub = (await SubCategory.create({
        name: child.name,
        slug: child.slug,
        description: child.description || '',
        image: child.image,
        isActive: child.isActive !== false,
        categories: [{ category: top._id, order }],
      })).toObject();
    } else if (sub && apply && !(sub.categories || []).some((link) => id(link.category) === String(top._id))) {
      await SubCategory.updateOne({ _id: sub._id }, { $push: { categories: { category: top._id, order: 1 } } });
    }
    subFor.set(String(child._id), { sub: sub ? String(sub._id) : `new:${child.slug}`, top: String(top._id), slug: top.slug });
  }

  // Products: move off child categories; everyone gets placements.
  const products = await Product.find({}).select('_id name category categoryIds primaryCategoryId placements').lean();
  let moved = 0;
  let placed = 0;
  for (const product of products) {
    const ids = (product.categoryIds || []).map(String);
    const hasPlacements = (product.placements || []).length > 0;
    const touchesChild = ids.some((categoryId) => subFor.has(categoryId));
    if (hasPlacements && !touchesChild) continue;

    let placements = hasPlacements
      ? product.placements.map((p) => ({ category: id(p.category), subCategory: id(p.subCategory) }))
      : ids.map((categoryId) => ({ category: categoryId, subCategory: null }));
    placements = placements.map((p) => {
      const target = subFor.get(p.category);
      return target ? { category: target.top, subCategory: target.sub } : p;
    });
    const seen = new Set();
    placements = placements.filter((p) => {
      const key = `${p.category}:${p.subCategory || ''}`;
      return !seen.has(key) && seen.add(key);
    });
    const newIds = [...new Set(placements.map((p) => p.category))];
    const oldPrimary = id(product.primaryCategoryId);
    const newPrimary = subFor.get(oldPrimary)?.top || (newIds.includes(oldPrimary) ? oldPrimary : newIds[0] || null);
    placements.sort((a, b) => (a.category === newPrimary ? 0 : 1) - (b.category === newPrimary ? 0 : 1));

    if (touchesChild) {
      moved += 1;
      console.log(`  product "${product.name}": ${placements.map((p) => `${byId.get(p.category)?.name}${p.subCategory ? ' › ' + (children.find((c) => subFor.get(String(c._id))?.sub === p.subCategory)?.name || 'sub') : ''}`).join(', ')}`);
    } else {
      placed += 1;
    }
    if (apply && newIds.length > 0) {
      await Product.updateOne({ _id: product._id }, {
        $set: {
          placements,
          categoryIds: newIds,
          primaryCategoryId: newPrimary,
          category: byId.get(newPrimary)?.slug || product.category,
        },
      });
    }
  }

  // Brands linked to a child category are linked to its top category.
  const companies = await Company.find({ categoryIds: { $in: [...subFor.keys()] } }).select('_id name categoryIds').lean();
  for (const company of companies) {
    const next = [...new Set((company.categoryIds || []).map(String).map((categoryId) => subFor.get(categoryId)?.top || categoryId))];
    console.log(`  brand "${company.name}": linked to the parent categories instead`);
    if (apply) await Company.updateOne({ _id: company._id }, { $set: { categoryIds: next } });
  }

  // The child categories themselves go away.
  if (apply && children.length > 0) {
    await Category.deleteMany({ _id: { $in: children.map((child) => child._id) } });
  }

  console.log(`${children.length} child categor(ies) → sub-categories; ${moved} product(s) moved; ${placed} product(s) given placements; ${companies.length} brand link(s) moved.`);
  if (!apply) console.log('Nothing written. Run again with --apply.');
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});

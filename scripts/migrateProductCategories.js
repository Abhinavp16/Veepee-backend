require('dotenv').config();
const mongoose = require('mongoose');
const { Category, Product } = require('../src/models');

async function migrateProducts(categories) {
  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const byId = new Map(categories.map((category) => [String(category._id), category]));
  const unresolved = [];
  const operations = [];
  const products = await Product.find({}).select('_id category categoryIds primaryCategoryId').lean();

  for (const product of products) {
    const existingIds = (product.categoryIds || []).map(String);
    const existingPrimary = product.primaryCategoryId ? String(product.primaryCategoryId) : null;
    const canonicalPrimary = existingPrimary && existingIds.includes(existingPrimary)
      ? byId.get(existingPrimary)
      : null;
    if (canonicalPrimary) {
      if (product.category !== canonicalPrimary.slug) {
        operations.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $set: { category: canonicalPrimary.slug } },
          },
        });
      }
      continue;
    }

    const legacyCategory = bySlug.get(String(product.category || '').trim().toLowerCase());
    if (!legacyCategory) {
      unresolved.push({ productId: String(product._id), category: product.category || null });
      continue;
    }

    const categoryId = String(legacyCategory._id);
    const categoryIds = [...new Set([...existingIds, categoryId])];
    operations.push({
      updateOne: {
        filter: { _id: product._id },
        update: {
          $set: {
            categoryIds,
            primaryCategoryId: existingPrimary && categoryIds.includes(existingPrimary)
              ? existingPrimary
              : categoryId,
            category: legacyCategory.slug,
          },
        },
      },
    });
  }

  if (operations.length > 0) await Product.bulkWrite(operations, { ordered: false });
  return { inspected: products.length, updated: operations.length, unresolved };
}

async function normalizeCategoryOrders(categories) {
  const groups = new Map();
  for (const category of categories) {
    const parent = category.parent ? String(category.parent) : 'root';
    groups.set(parent, [...(groups.get(parent) || []), category]);
  }

  const operations = [];
  for (const siblings of groups.values()) {
    siblings.sort((left, right) => (
      (Number(left.order) || 0) - (Number(right.order) || 0)
      || left.name.localeCompare(right.name)
      || String(left._id).localeCompare(String(right._id))
    ));
    siblings.forEach((category, index) => {
      const order = index + 1;
      if (category.order !== order) {
        operations.push({
          updateOne: { filter: { _id: category._id }, update: { $set: { order } } },
        });
      }
    });
  }
  if (operations.length > 0) await Category.bulkWrite(operations, { ordered: false });
  return operations.length;
}

async function run() {
  const mongoUri = String(process.env.MONGODB_URI || '').trim().replace(/^['"]|['"]$/g, '');
  if (!mongoUri) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(mongoUri);
  const categories = await Category.find({}).select('_id slug name parent order').lean();
  const productResult = await migrateProducts(categories);
  const normalizedCategories = await normalizeCategoryOrders(categories);

  console.log(JSON.stringify({
    productsInspected: productResult.inspected,
    productsUpdated: productResult.updated,
    unresolvedCount: productResult.unresolved.length,
    unresolvedProducts: productResult.unresolved,
    categoryOrdersNormalized: normalizedCategories,
  }, null, 2));
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

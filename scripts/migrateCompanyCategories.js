require('dotenv').config();
const mongoose = require('mongoose');
const { Company, Category, Product } = require('../src/models');

const normalize = (value) => String(value || '').trim().toLowerCase();
const idString = (value) => value == null ? null : String(value);

function buildCompanyCategoryPlan(companies, categories, products) {
  const categoriesById = new Map(categories.map((category) => [String(category._id), category]));
  const categoriesBySlug = new Map(categories.map((category) => [normalize(category.slug), category]));
  const companiesById = new Map(companies.map((company) => [String(company._id), company]));
  const companiesByBrand = new Map();
  for (const company of companies) {
    for (const key of new Set([normalize(company.name), normalize(company.slug)].filter(Boolean))) {
      companiesByBrand.set(key, [...(companiesByBrand.get(key) || []), company]);
    }
  }

  // Preserve explicit zero-product links while adding every association required by products.
  const categoryIdsByCompany = new Map(companies.map((company) => [String(company._id), new Set(
    (company.categoryIds || []).map(String).filter((id) => categoriesById.has(id))
  )]));
  const report = {
    productsInspected: products.length,
    productsWithoutCompany: [],
    invalidOrMissingCompanies: [],
    unresolvedCategories: [],
    legacyBrandsNotSafelyMapped: [],
  };

  for (const product of products) {
    const productId = String(product._id);
    const companyId = idString(product.company);
    if (!companyId) {
      report.productsWithoutCompany.push(productId);
    }
    const company = companyId && mongoose.Types.ObjectId.isValid(companyId)
      ? companiesById.get(companyId)
      : null;
    if (companyId && !company) {
      report.invalidOrMissingCompanies.push({ productId, companyId });
    }

    if (!company) {
      const brand = String(product.brand || '').trim();
      if (brand && (companiesByBrand.get(normalize(brand)) || []).length !== 1) {
        report.legacyBrandsNotSafelyMapped.push({ productId, brand });
      }
      continue;
    }

    const resolvedIds = [];
    for (const rawCategoryId of product.categoryIds || []) {
      const categoryId = idString(rawCategoryId);
      if (categoryId && mongoose.Types.ObjectId.isValid(categoryId) && categoriesById.has(categoryId)) {
        resolvedIds.push(categoryId);
      } else {
        report.unresolvedCategories.push({ productId, categoryId, category: product.category || null });
      }
    }
    if (resolvedIds.length === 0) {
      const legacyCategory = categoriesBySlug.get(normalize(product.category));
      if (legacyCategory) {
        resolvedIds.push(String(legacyCategory._id));
      } else {
        report.unresolvedCategories.push({ productId, categoryId: null, category: product.category || null });
      }
    }
    for (const categoryId of resolvedIds) categoryIdsByCompany.get(String(company._id)).add(categoryId);
  }

  const updates = [];
  for (const company of companies) {
    const existing = [...new Set((company.categoryIds || []).map(String))].sort();
    const categoryIds = [...categoryIdsByCompany.get(String(company._id))].sort();
    if (existing.length !== categoryIds.length || existing.some((id, index) => id !== categoryIds[index])) {
      updates.push({ companyId: String(company._id), categoryIds });
    }
  }
  return {
    updates,
    report: {
      ...report,
      productsWithoutCompanyCount: report.productsWithoutCompany.length,
      invalidOrMissingCompaniesCount: report.invalidOrMissingCompanies.length,
      unresolvedCategoriesCount: report.unresolvedCategories.length,
      legacyBrandsNotSafelyMappedCount: report.legacyBrandsNotSafelyMapped.length,
      companiesInspected: companies.length,
      companiesChanged: updates.length,
    },
  };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const mongoUri = String(process.env.MONGODB_URI || '').trim().replace(/^['"]|['"]$/g, '');
  if (!mongoUri) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(mongoUri, { autoIndex: false });

  const [companies, categories, products] = await Promise.all([
    Company.find({}).select('_id name slug categoryIds').lean(),
    Category.find({}).select('_id slug').lean(),
    Product.collection.find({}, {
      projection: { _id: 1, company: 1, categoryIds: 1, category: 1, brand: 1 },
    }).toArray(),
  ]);
  const result = buildCompanyCategoryPlan(companies, categories, products);
  if (!dryRun && result.updates.length > 0) {
    await Company.bulkWrite(result.updates.map((update) => ({
      updateOne: {
        filter: { _id: update.companyId },
        update: { $set: { categoryIds: update.categoryIds } },
      },
    })), { ordered: false });
  }
  console.log(JSON.stringify({ dryRun, ...result.report }, null, 2));
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect();
    });
}

module.exports = { buildCompanyCategoryPlan };

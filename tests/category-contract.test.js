const assert = require('assert');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');
const Company = require('../src/models/Company');
const { adminValidation } = require('../src/validations');
const { paginate } = require('../src/utils/helpers');
const {
  categoryProductCondition,
  normalizeObjectIds,
  toIdArray,
} = require('../src/utils/categoryHelpers');
const { getCompanyCategoryCounts, sortCategoriesByTree } = require('../src/utils/companyCategoryHelpers');
const { buildCompanyCategoryPlan } = require('../scripts/migrateCompanyCategories');

const firstId = new mongoose.Types.ObjectId();
const secondId = new mongoose.Types.ObjectId();

assert.deepStrictEqual(toIdArray(`["${firstId}","${secondId}"]`), [String(firstId), String(secondId)]);
assert.deepStrictEqual(normalizeObjectIds([firstId, firstId, secondId]), [String(firstId), String(secondId)]);

const condition = categoryProductCondition({ _id: firstId, slug: 'tractors' });
assert.strictEqual(condition.$or[0].categoryIds.$in[0], firstId);
assert.deepStrictEqual(condition.$or[1].$and[1].category.$in, ['tractors']);

const product = new Product({
  name: 'Multi-category product',
  category: 'tractors',
  categoryIds: [firstId, secondId],
  primaryCategoryId: firstId,
  mrp: 100,
  retailPrice: 90,
  wholesalePrice: 80,
  sku: 'MCP-001',
  stock: 1,
});
assert.strictEqual(product.validateSync(), undefined);
assert.deepStrictEqual(product.categories.map(String), [String(firstId), String(secondId)]);
assert.strictEqual(String(product.primaryCategory), String(firstId));

const company = new Company({ name: 'Deduplicated Co', categoryIds: [firstId, firstId, secondId] });
assert.deepStrictEqual(company.categoryIds.map(String), [String(firstId), String(secondId)]);
assert.ok(Company.schema.indexes().some(([fields]) => fields.categoryIds === 1));
assert.ok(Product.schema.indexes().some(([fields]) => (
  fields.company === 1 && fields.categoryIds === 1 && fields.status === 1
)));

const thirdId = new mongoose.Types.ObjectId();
const categories = [
  { _id: secondId, name: 'Child', parent: firstId, order: 1 },
  { _id: thirdId, name: 'Second root', parent: null, order: 2 },
  { _id: firstId, name: 'First root', parent: null, order: 1 },
];
assert.deepStrictEqual(sortCategoriesByTree(categories).map(({ _id }) => String(_id)), [
  String(firstId), String(secondId), String(thirdId),
]);
const companyCounts = getCompanyCategoryCounts(categories, new Map([
  [String(firstId), new Set(['product-a'])],
  [String(secondId), new Set(['product-a', 'product-b'])],
]));
assert.deepStrictEqual(companyCounts.get(String(firstId)), {
  directProductCount: 1,
  recursiveProductCount: 2,
});

const migrationPlan = buildCompanyCategoryPlan(
  [{ _id: firstId, name: 'Company', slug: 'company', categoryIds: [secondId] }],
  [{ _id: secondId, slug: 'tractors' }, { _id: thirdId, slug: 'tools' }],
  [{ _id: new mongoose.Types.ObjectId(), company: firstId, categoryIds: [thirdId], category: 'tools' }]
);
assert.deepStrictEqual(migrationPlan.updates[0].categoryIds, [String(secondId), String(thirdId)].sort());
assert.strictEqual(migrationPlan.report.companiesChanged, 1);
const migratedCompany = { _id: firstId, name: 'Company', slug: 'company', categoryIds: migrationPlan.updates[0].categoryIds };
assert.strictEqual(buildCompanyCategoryPlan(
  [migratedCompany],
  [{ _id: secondId, slug: 'tractors' }, { _id: thirdId, slug: 'tools' }],
  [{ _id: new mongoose.Types.ObjectId(), company: firstId, categoryIds: [thirdId], category: 'tools' }]
).updates.length, 0);

const invalidCategory = new Category({ name: 'Invalid position', order: 0 });
assert.ok(invalidCategory.validateSync().errors.order);

const commonProduct = {
  name: 'Validated product',
  description: 'Description',
  mrp: 100,
  retailPrice: 90,
  wholesalePrice: 80,
  sku: 'VAL-001',
};
assert.strictEqual(adminValidation.createProduct.validate({
  ...commonProduct,
  categoryIds: [String(firstId), String(secondId)],
  primaryCategoryId: String(firstId),
}).error, undefined);
assert.strictEqual(adminValidation.createProduct.validate({
  ...commonProduct,
  category: 'tractors',
}).error, undefined);
assert.ok(adminValidation.createProduct.validate(commonProduct).error);
assert.deepStrictEqual(paginate('invalid', 'invalid'), { page: 1, limit: 20, skip: 0 });

console.log('Category contract tests passed');

const assert = require('assert');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');
const { adminValidation } = require('../src/validations');
const { paginate } = require('../src/utils/helpers');
const {
  categoryProductCondition,
  normalizeObjectIds,
  toIdArray,
} = require('../src/utils/categoryHelpers');

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

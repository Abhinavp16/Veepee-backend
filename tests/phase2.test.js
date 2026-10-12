const assert = require('assert');

const { quantityRules, assertQuantityAllowed } = require('../src/utils/quantityRules');
const { isComingSoon, assertPurchasable, comingSoonPayload } = require('../src/utils/productAvailability');
const { priceFor, resolveDiscount, pricingForUser } = require('../src/services/productPricingService');

const now = new Date('2026-10-12T00:00:00Z');
const past = new Date('2026-10-01T00:00:00Z');
const future = new Date('2026-11-01T00:00:00Z');

// --- Quantity rules --------------------------------------------------------
const product = { _id: 'p1', name: 'Hose', packSize: 12, minWholesaleQuantity: 2, minCustomerQuantity: 3 };
assert.deepStrictEqual(quantityRules(product, 'wholesaler'), { step: 12, min: 24, packSize: 12 });
assert.deepStrictEqual(quantityRules(product, 'buyer'), { step: 1, min: 3, packSize: 12 });
assert.deepStrictEqual(quantityRules(product, undefined), { step: 1, min: 3, packSize: 12 });
assert.deepStrictEqual(quantityRules({}, 'wholesaler'), { step: 1, min: 1, packSize: 1 });
assert.ok(assertQuantityAllowed(product, 36, 'wholesaler'));
assert.throws(() => assertQuantityAllowed(product, 12, 'wholesaler'), (e) => e.code === 'INVALID_QUANTITY' && e.details.min === 24);
assert.throws(() => assertQuantityAllowed(product, 25, 'wholesaler'), (e) => e.code === 'INVALID_QUANTITY');
assert.throws(() => assertQuantityAllowed(product, 2, 'buyer'), (e) => e.code === 'INVALID_QUANTITY');
assert.ok(assertQuantityAllowed(product, 3, 'buyer'));
assert.throws(() => assertQuantityAllowed(product, 3.5, 'buyer'));

// --- Coming soon -------------------------------------------------------------
const soon = { status: 'active', comingSoon: true, expectedLaunchDate: future, stock: 5 };
assert.strictEqual(isComingSoon(soon, now), true);
assert.strictEqual(isComingSoon({ ...soon, expectedLaunchDate: null }, now), true, 'manual go-live has no date');
assert.strictEqual(isComingSoon({ ...soon, expectedLaunchDate: past }, now), false, 'date passed and stock');
assert.strictEqual(isComingSoon({ ...soon, expectedLaunchDate: past, stock: 0 }, now), true, 'date passed but no stock');
assert.strictEqual(isComingSoon({ ...soon, comingSoon: false }, now), false);
assert.throws(() => assertPurchasable(soon, now), (e) => e.code === 'PRODUCT_COMING_SOON');
assert.throws(() => assertPurchasable({ ...soon, comingSoon: false, status: 'draft' }, now), (e) => e.code === 'PRODUCT_UNAVAILABLE');
assert.throws(() => assertPurchasable({ status: 'archived' }, now), (e) => e.code === 'PRODUCT_UNAVAILABLE');
assert.throws(() => assertPurchasable(null, now), (e) => e.code === 'PRODUCT_UNAVAILABLE');
assert.doesNotThrow(() => assertPurchasable({ ...soon, comingSoon: false }, now));
assert.strictEqual(comingSoonPayload({ ...soon, hidePriceWhileComingSoon: true }, now).priceHidden, true);
assert.strictEqual(comingSoonPayload({ ...soon, comingSoon: false }, now), null);

// --- Pricing -----------------------------------------------------------------
const catalog = { mrp: 1000, retailPrice: 900, wholesalePrice: 700, company: 'brandA', primaryCategoryId: 'child', categoryIds: ['child'] };
const ctx = (overrides = {}) => ({
  companies: new Map(Object.entries(overrides.companies || {})),
  categories: new Map(Object.entries({
    root: { _id: 'root', parent: null },
    child: { _id: 'child', parent: 'root' },
    ...(overrides.categories || {}),
  })),
});

// No discount configured: stored prices are used.
assert.deepStrictEqual(priceFor(catalog, 'buyer', ctx()), { price: 900, mrp: 1000, discountPercent: 0, discountSource: null });
assert.strictEqual(priceFor(catalog, 'wholesaler', ctx()).price, 700);
assert.strictEqual(priceFor(catalog, 'guest', ctx()).price, 900);
assert.strictEqual(priceFor(catalog, 'wholesaler').price, 700, 'works without a context');

// Brand discount applies off MRP, per audience.
const withBrand = ctx({ companies: { brandA: { _id: 'brandA', customerDiscountPercent: 10, wholesalerDiscountPercent: 30 } } });
assert.deepStrictEqual(priceFor(catalog, 'buyer', withBrand), { price: 900, mrp: 1000, discountPercent: 10, discountSource: 'brand' });
assert.strictEqual(priceFor(catalog, 'wholesaler', withBrand).price, 700);
assert.strictEqual(priceFor({ ...catalog, mrp: 999 }, 'buyer', withBrand).price, 899.1);

// A parent category's discount is inherited by its children; nearest wins.
const withParent = ctx({ categories: { root: { _id: 'root', parent: null, customerDiscountPercent: 25 } } });
assert.deepStrictEqual(resolveDiscount(catalog, 'buyer', withParent), { percent: 25, source: 'category' });
const nearest = ctx({ categories: { root: { _id: 'root', parent: null, customerDiscountPercent: 25 }, child: { _id: 'child', parent: 'root', customerDiscountPercent: 5 } } });
assert.strictEqual(resolveDiscount(catalog, 'buyer', nearest).percent, 5);

// Brand beats category.
const both = ctx({ companies: { brandA: { _id: 'brandA', customerDiscountPercent: 10 } }, categories: { root: { _id: 'root', parent: null, customerDiscountPercent: 25 } } });
assert.deepStrictEqual(resolveDiscount(catalog, 'buyer', both), { percent: 10, source: 'brand' });

// Bad data never produces a nonsense price.
const bad = ctx({ companies: { brandA: { _id: 'brandA', customerDiscountPercent: 100 } } });
assert.strictEqual(priceFor(catalog, 'buyer', bad).price, 900);
assert.strictEqual(priceFor({ ...catalog, mrp: 0 }, 'buyer', withBrand).price, 900, 'no MRP, no discount');

// A category cycle cannot hang the resolver.
const cyclic = ctx({ categories: { a: { _id: 'a', parent: 'b' }, b: { _id: 'b', parent: 'a' } } });
assert.strictEqual(resolveDiscount({ ...catalog, company: null, primaryCategoryId: 'a', categoryIds: ['a'] }, 'buyer', cyclic).percent, 0);

// Response block: wholesalers also see the customer price; buyers never see wholesale.
const block = pricingForUser(catalog, 'wholesaler', withBrand);
assert.strictEqual(block.retailPrice, 900);
assert.strictEqual(block.wholesalePrice, 700);
assert.strictEqual(block.canNegotiate, true);
const buyerBlock = pricingForUser(catalog, 'buyer', withBrand);
assert.strictEqual('wholesalePrice' in buyerBlock, false);
assert.strictEqual(buyerBlock.discountPercent, 10);

console.log('phase2 tests passed');

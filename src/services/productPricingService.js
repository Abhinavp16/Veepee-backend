const { Company, Category } = require('../models');

const DISCOUNT_FIELDS = '+customerDiscountPercent +wholesalerDiscountPercent';

const round2 = (value) => Math.round(value * 100) / 100;
const idOf = (value) => (value ? String(value._id || value) : '');
const percentOf = (doc, role) => {
  const raw = role === 'wholesaler' ? doc?.wholesalerDiscountPercent : doc?.customerDiscountPercent;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 100 ? value : 0;
};

/**
 * Loads what is needed to price a set of products: the brand and category
 * discount percentages. Load once per request and reuse for every product.
 */
const loadDiscountContext = async (products) => {
  const companyIds = [...new Set(products.map((p) => idOf(p.company)).filter(Boolean))];
  const [companies, categories] = await Promise.all([
    companyIds.length
      ? Company.find({ _id: { $in: companyIds } }).select(DISCOUNT_FIELDS).lean()
      : [],
    Category.find({}).select(`parent ${DISCOUNT_FIELDS}`).lean(),
  ]);
  return {
    companies: new Map(companies.map((c) => [idOf(c), c])),
    categories: new Map(categories.map((c) => [idOf(c), c])),
  };
};

// The nearest category (own first, then ancestors) that has a discount.
const categoryPercent = (startId, ctx, role) => {
  const seen = new Set();
  let current = ctx.categories.get(startId);
  while (current && !seen.has(idOf(current))) {
    seen.add(idOf(current));
    const percent = percentOf(current, role);
    if (percent > 0) return percent;
    current = ctx.categories.get(idOf(current.parent));
  }
  return 0;
};

/** Which discount applies to a product for a role: brand, else category. */
const resolveDiscount = (product, role, ctx) => {
  const brandPercent = percentOf(ctx.companies.get(idOf(product.company)), role);
  if (brandPercent > 0) return { percent: brandPercent, source: 'brand' };

  const categoryIds = [product.primaryCategoryId, ...(product.categoryIds || [])]
    .map(idOf)
    .filter(Boolean);
  for (const categoryId of [...new Set(categoryIds)]) {
    const percent = categoryPercent(categoryId, ctx, role);
    if (percent > 0) return { percent, source: 'category' };
  }
  return { percent: 0, source: null };
};

/**
 * The one place a shopper's price is decided. A configured discount is a
 * percentage off MRP; otherwise it is the product's retail or wholesale price.
 */
const priceFor = (product, role, ctx) => {
  const audience = role === 'wholesaler' ? 'wholesaler' : 'buyer';
  const base = audience === 'wholesaler' ? product.wholesalePrice : product.retailPrice;
  const { percent, source } = ctx ? resolveDiscount(product, audience, ctx) : { percent: 0, source: null };
  const mrp = Number(product.mrp) || 0;
  if (percent > 0 && mrp > 0) {
    return { price: round2(mrp * (1 - percent / 100)), mrp, discountPercent: percent, discountSource: source };
  }
  return { price: base, mrp, discountPercent: 0, discountSource: null };
};

/**
 * Role-based price block used by every product response. Wholesalers also see
 * the price a customer would pay.
 */
const pricingForUser = (product, role, ctx) => {
  const own = priceFor(product, role, ctx);
  if (role === 'wholesaler') {
    return {
      price: own.price,
      mrp: own.mrp,
      retailPrice: priceFor(product, 'buyer', ctx).price,
      wholesalePrice: own.price,
      minWholesaleQuantity: product.minWholesaleQuantity,
      negotiationEnabled: product.negotiationEnabled,
      canNegotiate: true,
      discountPercent: own.discountPercent,
    };
  }
  return { price: own.price, mrp: own.mrp, canNegotiate: false, discountPercent: own.discountPercent };
};

module.exports = { loadDiscountContext, resolveDiscount, priceFor, pricingForUser, round2 };

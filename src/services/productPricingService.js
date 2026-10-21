const { Company, Category } = require('../models');
const { getCachedCategories } = require('./categoryDiscountCache');
const { getSaleIndex, saleOfferFor, saleSummary, personalSaleLimits } = require('./saleService');

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
 * discount percentages and the live sales. Load once per request and reuse for
 * every product.
 *
 * `sales`: 'cached' (catalogue pages: a copy up to a minute old), 'fresh'
 * (cart and checkout) or false (price requests and requirements, which never
 * use sale prices).
 */
const loadDiscountContext = async (products, { sales = 'cached' } = {}) => {
  const companyIds = [...new Set(products.map((p) => idOf(p.company)).filter(Boolean))];
  const [companies, categories, saleIndex] = await Promise.all([
    companyIds.length
      ? Company.find({ _id: { $in: companyIds } }).select(DISCOUNT_FIELDS).lean()
      : [],
    getCachedCategories(() => Category.find({}).select(`parent ${DISCOUNT_FIELDS}`).lean()),
    sales ? getSaleIndex({ cached: sales === 'cached' }) : null,
  ]);
  return {
    companies: new Map(companies.map((c) => [idOf(c), c])),
    categories: new Map(categories.map((c) => [idOf(c), c])),
    saleIndex,
    now: new Date(),
    // Products that pay the normal price this time (the sale quantity is
    // used up for this line, or the buyer is at the sale's per-person limit).
    withoutSale: new Set(),
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
  const normal = normalPriceFor(product, role, ctx);
  // A live sale: its price, but only when it is lower (a sale never makes
  // anything dearer).
  const audience = role === 'wholesaler' ? 'wholesaler' : 'buyer';
  if (!ctx?.saleIndex || ctx.withoutSale?.has(idOf(product._id)) || !(normal.mrp > 0)) return normal;
  const offer = saleOfferFor(product, audience, ctx.saleIndex, ctx.now);
  if (!offer) return normal;
  const salePrice = round2(normal.mrp * (1 - offer.percent / 100));
  if (!(salePrice > 0) || !(salePrice < Number(normal.price))) return normal;
  return {
    price: salePrice,
    mrp: normal.mrp,
    discountPercent: offer.percent,
    discountSource: 'sale',
    sale: saleSummary(offer),
  };
};

/** The price without any sale: brand, else category % off MRP, else base. */
const normalPriceFor = (product, role, ctx) => {
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
      sale: own.sale || null,
      // Price requests start from the normal price, never the sale's.
      ...(own.sale && { negotiationPrice: normalPriceFor(product, role, ctx).price }),
    };
  }
  return {
    price: own.price,
    mrp: own.mrp,
    canNegotiate: false,
    discountPercent: own.discountPercent,
    sale: own.sale || null,
  };
};

// A scheduled price change the shopper can be warned about: the price they
// would pay, when it starts. Nothing when there is none, when it is not a
// change for them, when a brand/category discount sets their price anyway, or
// when it is already due (the daily job applies it).
const pendingPriceNotice = (product, role, pricing, now = new Date()) => {
  if (!product.priceChangeEffectiveAt || new Date(product.priceChangeEffectiveAt) <= now) return null;
  if ((pricing.discountPercent || 0) > 0) return null;
  const newPrice = role === 'wholesaler' ? product.pendingWholesalePrice : product.pendingRetailPrice;
  if (newPrice == null || pricing.price == null || Number(newPrice) === Number(pricing.price)) return null;
  return {
    currentPrice: pricing.price,
    newPrice: Number(newPrice),
    effectiveAt: product.priceChangeEffectiveAt,
    scheduledAt: product.priceChangeScheduledAt || null,
  };
};


/**
 * For a cart or an order: a sale price only covers a whole line (enough sale
 * units left, and within the buyer's "max per person"). Lines that don't fit
 * pay the normal price; `ctx` is updated so priceFor gives that price.
 * `lines` are { product, quantity }. Returns Map<productId, note> for those
 * lines: { reason: 'limit', limit, left } or { reason: 'sold_out' }.
 */
const applySaleLimits = async (ctx, lines, role, userId) => {
  if (!ctx?.saleIndex) return new Map();
  const quantities = new Map();
  const productById = new Map();
  for (const { product, quantity } of lines) {
    const id = idOf(product?._id);
    if (!id) continue;
    productById.set(id, product);
    quantities.set(id, (quantities.get(id) || 0) + (Number(quantity) || 0));
  }
  const saleLines = [];
  for (const [id, quantity] of quantities) {
    const priced = priceFor(productById.get(id), role, ctx);
    if (priced.sale) saleLines.push({ productId: id, quantity, saleId: priced.sale.id });
  }
  const notes = await personalSaleLimits({ lines: saleLines, user: userId ? { _id: userId } : null });
  for (const id of notes.keys()) ctx.withoutSale.add(id);
  return notes;
};

module.exports = {
  pendingPriceNotice,
  loadDiscountContext,
  resolveDiscount,
  priceFor,
  normalPriceFor,
  pricingForUser,
  applySaleLimits,
  round2,
};

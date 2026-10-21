const mongoose = require('mongoose');
const { Sale, Product, Category } = require('../models');
const { NotFoundError } = require('../utils/errors');
const { USER_ROLES, PRODUCT_STATUS } = require('../utils/constants');
const { formatPaginationResponse } = require('../utils/helpers');
const { productCategoryPopulate } = require('../utils/categoryHelpers');
const { loadDiscountContext } = require('../services/productPricingService');
const { productCard, CARD_SELECT } = require('./productController');
const {
  saleStatus,
  saleIsFor,
  maxPercentFor,
  isSoldOut,
  liveSalesFor,
} = require('../services/saleService');

// Sale pages in the app: the sale itself, its products (priced for this
// viewer, with the sale price while it is live), and the live sale for the
// Home strip. Customers and wholesalers only see sales meant for them.

const HOME_STRIP_PRODUCTS = 10;

const viewerRole = (req) => (req.user?.role === USER_ROLES.WHOLESALER ? USER_ROLES.WHOLESALER : USER_ROLES.BUYER);
const idString = (value) => (value == null ? '' : String(value._id || value));

function salePayload(sale, req, now = new Date(), visibleProducts = null) {
  const endedEarly = sale.endedAt && new Date(sale.endedAt) < new Date(sale.endsAt);
  return {
    id: sale._id,
    name: sale.name,
    nameHindi: sale.nameHindi || '',
    subtitle: sale.subtitle || '',
    subtitleHindi: sale.subtitleHindi || '',
    theme: sale.theme,
    heroImage: sale.heroImageUrl || null,
    startsAt: sale.startsAt,
    endsAt: endedEarly ? sale.endedAt : sale.endsAt,
    status: saleStatus(sale, now),
    // Only products this viewer can see count towards "Up to X% off".
    upToPercent: maxPercentFor(sale, viewerRole(req), visibleProducts?.map((product) => product._id)),
  };
}

async function findSaleFor(req) {
  const { id } = req.params;
  const sale = mongoose.isValidObjectId(id) ? await Sale.findById(id).lean() : null;
  // Drafts and sales meant for others don't exist for this viewer.
  if (!sale || sale.status !== 'published' || !saleIsFor(sale, viewerRole(req))) {
    throw new NotFoundError('This sale is not available', 'SALE_NOT_FOUND');
  }
  return sale;
}

/** Products in the sale this viewer may see (active), in the sale's order. */
async function visibleSaleProducts(sale) {
  const ids = (sale.products || []).map((entry) => entry.productId);
  if (ids.length === 0) return [];
  const products = await Product.find({ _id: { $in: ids }, status: PRODUCT_STATUS.ACTIVE })
    .select(CARD_SELECT)
    .populate('company', 'name')
    .populate(productCategoryPopulate)
    .lean();
  const position = new Map(ids.map((id, index) => [idString(id), index]));
  return products.sort((a, b) => position.get(idString(a._id)) - position.get(idString(b._id)));
}

// The top-level category of a product (sale pages filter by it).
function rootCategoryOf(product, categoryById) {
  let category = categoryById.get(idString(product.primaryCategoryId || product.categoryIds?.[0]));
  const seen = new Set();
  while (category?.parent && !seen.has(idString(category._id))) {
    seen.add(idString(category._id));
    const parent = categoryById.get(idString(category.parent));
    if (!parent) break;
    category = parent;
  }
  return category || null;
}

async function categoryMap() {
  const categories = await Category.find({}).select('name nameHindi slug parent').lean();
  return new Map(categories.map((category) => [idString(category._id), category]));
}

async function saleCards(sale, products, req, now = new Date()) {
  const role = req.user?.role || 'guest';
  const ctx = await loadDiscountContext(products);
  const live = saleStatus(sale, now) === 'live';
  const entryById = new Map((sale.products || []).map((entry) => [idString(entry.productId), entry]));
  return products.map((product) => {
    const entry = entryById.get(idString(product._id));
    return {
      ...productCard(product, role, ctx, now),
      // The sale quantity is used up: "Sold out" at the sale price.
      saleSoldOut: live && isSoldOut(entry),
      // Most one person can buy at the sale price ("Max 2 per person").
      salePerPersonLimit: entry?.perPersonLimit ?? null,
    };
  });
}

// @desc    A sale page: look, texts, dates, status and its category chips
// @route   GET /api/v1/sales/:id
// @access  Public (signed-in viewers see their own audience)
exports.getSale = async (req, res, next) => {
  try {
    const sale = await findSaleFor(req);
    const products = await visibleSaleProducts(sale);
    const categoryById = await categoryMap();
    const categories = [];
    const seen = new Set();
    for (const product of products) {
      const root = rootCategoryOf(product, categoryById);
      if (root && !seen.has(idString(root._id))) {
        seen.add(idString(root._id));
        categories.push({ id: root._id, name: root.name, nameHindi: root.nameHindi || '', slug: root.slug });
      }
    }
    res.json({
      success: true,
      data: { ...salePayload(sale, req, new Date(), products), productCount: products.length, categories },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    A sale's products, a page at a time (optionally one category)
// @route   GET /api/v1/sales/:id/products?page&limit&categoryId
// @access  Public
exports.getSaleProducts = async (req, res, next) => {
  try {
    const sale = await findSaleFor(req);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    let products = await visibleSaleProducts(sale);
    const categoryId = String(req.query.categoryId || '');
    if (mongoose.isValidObjectId(categoryId)) {
      const categoryById = await categoryMap();
      products = products.filter((product) => idString(rootCategoryOf(product, categoryById)?._id) === categoryId);
    }
    const slice = products.slice((page - 1) * limit, page * limit);
    const cards = await saleCards(sale, slice, req);
    res.json({ success: true, ...formatPaginationResponse(cards, products.length, page, limit) });
  } catch (error) {
    next(error);
  }
};

// @desc    The live sale for this viewer with its first products, as a list
//          of one (or none): only one sale runs at a time
// @route   GET /api/v1/sales/live
// @access  Public
exports.getLiveSales = async (req, res, next) => {
  try {
    const now = new Date();
    const sales = await liveSalesFor(viewerRole(req), { now });
    const data = [];
    for (const sale of sales) {
      const products = await visibleSaleProducts(sale);
      if (products.length === 0) continue;
      data.push({
        ...salePayload(sale, req, now, products),
        productCount: products.length,
        products: await saleCards(sale, products.slice(0, HOME_STRIP_PRODUCTS), req, now),
      });
      break;
    }
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

const mongoose = require('mongoose');
const { Sale, Product, Order } = require('../../models');
const { BadRequestError, ConflictError, NotFoundError } = require('../../utils/errors');
const { ORDER_STATUS, PRODUCT_STATUS, USER_ROLES } = require('../../utils/constants');
const { isComingSoon } = require('../../utils/productAvailability');
const { loadDiscountContext, normalPriceFor, round2 } = require('../../services/productPricingService');
const {
  saleStatus,
  saleIsFor,
  salePercentFor,
  announceSale,
  announcementReach,
  clearSaleCache,
} = require('../../services/saleService');

// Admin: create sale pages, pick their products, and announce them.
// (Ported from Laxmi Agro; prices come from OXON's productPricingService.)

const ROW_FIELDS = 'name nameHindi sku mrp retailPrice wholesalePrice stock status comingSoon expectedLaunchDate autoLaunch company categoryIds primaryCategoryId images';
const idString = (value) => (value == null ? '' : String(value._id || value));

const lastAnnouncement = (sale) => (sale.announcements || []).reduce(
  (latest, entry) => (!latest || new Date(entry.at) > new Date(latest.at) ? entry : latest),
  null,
);

// Orders, units and money taken at this sale's prices (cancelled orders don't count).
async function resultsFor(saleIds) {
  const ids = saleIds.map((id) => new mongoose.Types.ObjectId(idString(id)));
  if (ids.length === 0) return new Map();
  const rows = await Order.aggregate([
    { $match: { 'items.saleId': { $in: ids }, status: { $ne: ORDER_STATUS.CANCELLED } } },
    { $unwind: '$items' },
    { $match: { 'items.saleId': { $in: ids } } },
    {
      $group: {
        _id: '$items.saleId',
        orders: { $addToSet: '$_id' },
        units: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.totalPrice' },
      },
    },
  ]);
  return new Map(rows.map((row) => [idString(row._id), {
    orders: row.orders.length,
    units: row.units,
    revenue: round2(row.revenue),
  }]));
}

const EMPTY_RESULTS = { orders: 0, units: 0, revenue: 0 };

function listItem(sale, results) {
  const last = lastAnnouncement(sale);
  return {
    id: sale._id,
    name: sale.name,
    nameHindi: sale.nameHindi || '',
    theme: sale.theme,
    audience: sale.audience,
    status: saleStatus(sale),
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    endedAt: sale.endedAt || null,
    customerPercent: sale.customerPercent,
    wholesalerPercent: sale.wholesalerPercent,
    productCount: (sale.products || []).length,
    lastAnnouncedAt: last?.at || null,
    results: results.get(idString(sale._id)) || EMPTY_RESULTS,
  };
}

// The % the sale itself must have for its audience (a product may have its own).
function checkSaleRules(body) {
  if (['customers', 'both'].includes(body.audience) && !body.customerPercent) {
    throw new BadRequestError('Enter the customer discount %', 'SALE_CUSTOMER_PERCENT_REQUIRED');
  }
  if (['wholesalers', 'both'].includes(body.audience) && !body.wholesalerPercent) {
    throw new BadRequestError('Enter the wholesaler discount %', 'SALE_WHOLESALER_PERCENT_REQUIRED');
  }
  if (body.status === 'published' && body.products.length === 0) {
    throw new BadRequestError('Add at least one product before publishing', 'SALE_NEEDS_PRODUCTS');
  }
}

const shortDate = (date) => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

// Only one sale runs at a time: a published sale's dates can't overlap
// another published sale that hasn't ended. Drafts can overlap anything.
async function checkOneSaleAtATime(body, saleId = null) {
  if (body.status !== 'published') return;
  const clash = await Sale.findOne({
    ...(saleId ? { _id: { $ne: saleId } } : {}),
    status: 'published',
    endedAt: null,
    startsAt: { $lt: new Date(body.endsAt) },
    endsAt: { $gt: new Date(body.startsAt) },
  }).select('name startsAt endsAt').lean();
  if (clash) {
    throw new ConflictError(
      `Only one sale can run at a time. "${clash.name}" runs ${shortDate(clash.startsAt)} to ${shortDate(clash.endsAt)}. Change the dates, or end that sale first.`,
      'SALE_OVERLAP',
    );
  }
}

async function checkProductsExist(products) {
  const ids = [...new Set(products.map((item) => item.productId))];
  if (ids.length === 0) return;
  const found = await Product.find({ _id: { $in: ids }, status: { $ne: PRODUCT_STATUS.ARCHIVED } }).select('_id').lean();
  if (found.length === ids.length) return;
  const foundIds = new Set(found.map((product) => idString(product._id)));
  const gone = ids.filter((id) => !foundIds.has(idString(id)));
  const named = await Product.find({ _id: { $in: gone } }).select('name').lean();
  const names = named.map((product) => product.name).filter(Boolean);
  const error = new BadRequestError(
    names.length > 0
      ? `These products are archived or no longer exist: ${names.join(', ')}. Remove them from the sale.`
      : 'Some products no longer exist. Remove them from the sale.',
    'SALE_PRODUCT_NOT_FOUND',
  );
  error.details = { productIds: gone.map(idString) };
  throw error;
}

// Units sold at this sale's price per product, from its orders (for a product
// added back after it was taken out of the list).
async function unitsSoldFromOrders(saleId, productIds) {
  if (!saleId || productIds.length === 0) return new Map();
  const sale = new mongoose.Types.ObjectId(idString(saleId));
  const rows = await Order.aggregate([
    { $match: { 'items.saleId': sale, status: { $ne: ORDER_STATUS.CANCELLED } } },
    { $unwind: '$items' },
    {
      $match: {
        'items.saleId': sale,
        'items.productId': { $in: productIds.map((id) => new mongoose.Types.ObjectId(idString(id))) },
      },
    },
    { $group: { _id: '$items.productId', units: { $sum: '$items.quantity' } } },
  ]);
  return new Map(rows.map((row) => [idString(row._id), row.units]));
}

// Keeps the units already sold when the admin edits the list or the
// quantities, also for a product taken out and added back later.
async function mergeProducts(saleId, existing = [], incoming = []) {
  const before = new Map(existing.map((entry) => [idString(entry.productId), entry]));
  const added = incoming.map((item) => item.productId).filter((id) => !before.has(idString(id)));
  const soldBefore = await unitsSoldFromOrders(saleId, added);
  return incoming.map((item) => {
    const kept = before.get(idString(item.productId));
    const sold = kept ? Number(kept.sold) || 0 : soldBefore.get(idString(item.productId)) || 0;
    const saleQuantity = item.saleQuantity ?? null;
    return {
      productId: item.productId,
      customerPercent: item.customerPercent ?? null,
      wholesalerPercent: item.wholesalerPercent ?? null,
      saleQuantity,
      sold,
      remaining: saleQuantity == null ? null : Math.max(saleQuantity - sold, 0),
      perPersonLimit: item.perPersonLimit ?? null,
    };
  });
}

const saleFields = (body) => ({
  name: body.name,
  nameHindi: body.nameHindi || '',
  subtitle: body.subtitle || '',
  subtitleHindi: body.subtitleHindi || '',
  theme: body.theme,
  heroImageUrl: body.heroImageUrl || '',
  audience: body.audience,
  customerPercent: body.customerPercent ?? null,
  wholesalerPercent: body.wholesalerPercent ?? null,
  startsAt: body.startsAt,
  endsAt: body.endsAt,
  status: body.status,
});

/** The price this role pays normally and in this sale (as if live). */
function previewSalePrice(product, sale, entry, role, ctx) {
  const normal = normalPriceFor(product, role, ctx);
  const percent = saleIsFor(sale, role) ? salePercentFor(sale, entry, role) : null;
  const mrp = Number(product.mrp) || 0;
  if (!percent || !(mrp > 0)) return { normalPrice: normal.price, salePrice: null, percent: null };
  const price = round2(mrp * (1 - percent / 100));
  return { normalPrice: normal.price, salePrice: price < Number(normal.price) ? price : null, percent };
}

// Each product with its prices in this sale (as if live) and what to watch out for.
async function productRows(sale) {
  const ids = (sale.products || []).map((entry) => entry.productId);
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } }).select(ROW_FIELDS).lean()
    : [];
  const productById = new Map(products.map((product) => [idString(product._id), product]));
  const ctx = await loadDiscountContext(products, { sales: false });
  const others = await Sale.find({
    _id: { $ne: sale._id },
    status: 'published',
    endedAt: null,
    startsAt: { $lt: sale.endsAt },
    endsAt: { $gt: sale.startsAt },
    'products.productId': { $in: ids },
  }).select('name products.productId').lean();

  return (sale.products || []).map((entry) => {
    const product = productById.get(idString(entry.productId));
    if (!product) {
      return { productId: entry.productId, missing: true, warnings: [{ code: 'missing', text: 'Product no longer exists' }] };
    }
    const customer = previewSalePrice(product, sale, entry, USER_ROLES.BUYER, ctx);
    const wholesaler = previewSalePrice(product, sale, entry, USER_ROLES.WHOLESALER, ctx);
    const warnings = [];
    const forCustomers = saleIsFor(sale, USER_ROLES.BUYER);
    const forWholesalers = saleIsFor(sale, USER_ROLES.WHOLESALER);
    if ((forCustomers && !customer.salePrice) || (forWholesalers && !wholesaler.salePrice)) {
      warnings.push({ code: 'no_saving', text: 'The sale % is not lower than the normal price' });
    }
    if (!(Number(product.mrp) > 0)) warnings.push({ code: 'no_mrp', text: 'No MRP: the sale % needs one' });
    if (product.status !== PRODUCT_STATUS.ACTIVE) warnings.push({ code: 'unavailable', text: 'Not active' });
    if (isComingSoon(product)) warnings.push({ code: 'coming_soon', text: 'Coming Soon: can\'t be ordered yet' });
    if (!(Number(product.stock) > 0)) warnings.push({ code: 'out_of_stock', text: 'Out of stock' });
    if (entry.saleQuantity != null && entry.saleQuantity > (Number(product.stock) || 0)) {
      warnings.push({ code: 'quantity_over_stock', text: 'Sale quantity is more than the stock' });
    }
    const overlap = others.find((other) => other.products.some((item) => idString(item.productId) === idString(product._id)));
    if (overlap) warnings.push({ code: 'other_sale', text: `Also in ${overlap.name}` });

    const primary = product.images?.find((image) => image.isPrimary) || product.images?.[0];
    return {
      productId: product._id,
      name: product.name,
      nameHindi: product.nameHindi || '',
      sku: product.sku || '',
      image: primary?.url || null,
      stock: Number(product.stock) || 0,
      mrp: product.mrp || null,
      customer,
      wholesaler,
      customerPercent: entry.customerPercent ?? null,
      wholesalerPercent: entry.wholesalerPercent ?? null,
      saleQuantity: entry.saleQuantity ?? null,
      sold: entry.sold || 0,
      remaining: entry.remaining ?? null,
      perPersonLimit: entry.perPersonLimit ?? null,
      warnings,
    };
  });
}

async function saleDetail(sale) {
  const results = await resultsFor([sale._id]);
  return {
    ...listItem(sale, results),
    subtitle: sale.subtitle || '',
    subtitleHindi: sale.subtitleHindi || '',
    heroImageUrl: sale.heroImageUrl || '',
    savedStatus: sale.status,
    announcements: sale.announcements || [],
    products: await productRows(sale),
  };
}

async function findSale(id) {
  const sale = mongoose.isValidObjectId(id) ? await Sale.findById(id) : null;
  if (!sale) throw new NotFoundError('Sale not found', 'SALE_NOT_FOUND');
  return sale;
}

// @route GET /api/v1/admin/sales
exports.getSales = async (req, res, next) => {
  try {
    const sales = await Sale.find({}).sort({ startsAt: -1 }).lean();
    const results = await resultsFor(sales.map((sale) => sale._id));
    res.json({ success: true, data: sales.map((sale) => listItem(sale, results)) });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/v1/admin/sales/:id
exports.getSale = async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    res.json({ success: true, data: await saleDetail(sale.toObject()) });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/v1/admin/sales
exports.createSale = async (req, res, next) => {
  try {
    checkSaleRules(req.body);
    await checkProductsExist(req.body.products);
    await checkOneSaleAtATime(req.body);
    const sale = await Sale.create({
      ...saleFields(req.body),
      products: await mergeProducts(null, [], req.body.products),
      createdBy: req.user._id,
    });
    clearSaleCache();
    res.status(201).json({ success: true, data: await saleDetail(sale.toObject()) });
  } catch (error) {
    next(error);
  }
};

// @route PUT /api/v1/admin/sales/:id
exports.updateSale = async (req, res, next) => {
  try {
    let sale = await findSale(req.params.id);
    const status = saleStatus(sale);
    if (status === 'ended') {
      throw new BadRequestError('This sale has ended. Create a new one.', 'SALE_ENDED');
    }
    if (status === 'live' && req.body.status !== 'published') {
      throw new BadRequestError('A sale that has started can\'t go back to draft. End it instead.', 'SALE_CANT_UNPUBLISH');
    }
    checkSaleRules(req.body);
    await checkProductsExist(req.body.products);
    await checkOneSaleAtATime(req.body, sale._id);
    // Written only if no checkout or cancellation changed the counts since
    // they were read (countsVersion), so sold units are never written back
    // to older numbers; otherwise read them again.
    let saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt += 1) {
      const latest = await Sale.findById(sale._id).select('products countsVersion').lean();
      if (!latest) throw new NotFoundError('Sale not found', 'SALE_NOT_FOUND');
      const version = latest.countsVersion ?? 0;
      const products = await mergeProducts(sale._id, latest.products, req.body.products);
      const result = await Sale.updateOne(
        { _id: sale._id, countsVersion: latest.countsVersion ?? null },
        { $set: { ...saleFields(req.body), products, countsVersion: version + 1 } },
        { runValidators: true },
      );
      saved = result.matchedCount === 1;
    }
    if (!saved) throw new ConflictError('The sale is busy with orders right now. Save again.', 'SALE_BUSY');
    sale = await Sale.findById(sale._id);
    clearSaleCache();
    res.json({ success: true, data: await saleDetail(sale.toObject()) });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/v1/admin/sales/preview
// Prices and warnings for the editor's unsaved form (nothing is saved).
exports.previewSale = async (req, res, next) => {
  try {
    const { saleId } = req.body;
    const saved = saleId && mongoose.isValidObjectId(saleId) ? await Sale.findById(saleId).lean() : null;
    const draft = {
      _id: saved?._id || new mongoose.Types.ObjectId(),
      ...saleFields(req.body),
      products: await mergeProducts(saved?._id || null, saved?.products || [], req.body.products),
    };
    res.json({ success: true, data: { products: await productRows(draft) } });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/v1/admin/sales/:id/end
exports.endSale = async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (saleStatus(sale) !== 'live' && saleStatus(sale) !== 'upcoming') {
      throw new BadRequestError('Only a scheduled or live sale can be ended', 'SALE_NOT_RUNNING');
    }
    sale.endedAt = new Date();
    await sale.save();
    clearSaleCache();
    res.json({ success: true, data: await saleDetail(sale.toObject()) });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/v1/admin/sales/:id (drafts only)
exports.deleteSale = async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (sale.status !== 'draft') {
      throw new BadRequestError('Only drafts can be deleted. End the sale instead.', 'SALE_NOT_DRAFT');
    }
    // Its orders point at it (results, cancellations giving units back).
    if (await Order.exists({ 'items.saleId': sale._id })) {
      throw new BadRequestError('This sale has orders, so it can\'t be deleted.', 'SALE_HAS_ORDERS');
    }
    await sale.deleteOne();
    clearSaleCache();
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Only a live sale is announced ("Diwali Sale is live!"), at most once in
// ANNOUNCE_GAP_MS (a retried request can't send it twice).
const ANNOUNCE_GAP_MS = 10 * 60 * 1000;
const canAnnounce = (sale) => saleStatus(sale) === 'live';
const minutesAgo = (date) => Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 60000));

// @route GET /api/v1/admin/sales/:id/announce (how many people it would reach)
exports.getAnnouncePreview = async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    const recipients = await announcementReach(sale);
    res.json({ success: true, data: { recipients, canAnnounce: canAnnounce(sale), lastAnnouncement: lastAnnouncement(sale) } });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/v1/admin/sales/:id/announce
exports.announceSale = async (req, res, next) => {
  let locked = null;
  try {
    const sale = await findSale(req.params.id);
    if (!canAnnounce(sale)) {
      throw new BadRequestError('You can announce the sale once it has started', 'SALE_NOT_LIVE');
    }
    const since = new Date(Date.now() - ANNOUNCE_GAP_MS);
    const last = lastAnnouncement(sale);
    if (last && new Date(last.at) > since) {
      throw new ConflictError(`This sale was announced ${minutesAgo(last.at)} min ago. Wait a little before sending it again.`, 'SALE_RECENTLY_ANNOUNCED');
    }
    // One send at a time: the lock is taken in one step.
    const startedAt = new Date();
    locked = await Sale.findOneAndUpdate(
      { _id: sale._id, $or: [{ announcingAt: null }, { announcingAt: { $lt: since } }] },
      { $set: { announcingAt: startedAt } },
    );
    if (!locked) {
      throw new ConflictError('This sale is being announced right now.', 'SALE_RECENTLY_ANNOUNCED');
    }
    const sentTo = await announceSale(sale.toObject());
    await Sale.updateOne(
      { _id: sale._id },
      { $push: { announcements: { at: startedAt, byName: req.user.name || '', sentTo } } },
    );
    res.json({ success: true, data: { sentTo } });
  } catch (error) {
    // A failed send can be tried again at once.
    if (locked) await Sale.updateOne({ _id: locked._id }, { $set: { announcingAt: null } }).catch(() => {});
    next(error);
  }
};

const mongoose = require('mongoose');
const { USER_ROLES, ORDER_STATUS, PRODUCT_STATUS } = require('../utils/constants');
const { ConflictError } = require('../utils/errors');
const { renderTemplate, normalizeLanguage } = require('../utils/notificationTemplates');

// Sale pages (Diwali Sale, Stock Clearance, ...), ported from Laxmi Agro.
//
// A live sale is one more source for a shopper's price, next to brand and
// category discounts: productPricingService.priceFor asks this service for the
// sale price and uses it only when it is lower than what that person pays
// anyway, so product cards, the product page, cart, checkout and orders all
// agree. Price requests and requirements never use sale prices.
//
// Sales go live and end by their dates, worked out on every request (no cron).

const models = () => require('../models');
const CACHE_MS = 60 * 1000;

const idString = (value) => (value == null ? '' : String(value._id || value));
const objectId = (value) => new mongoose.Types.ObjectId(idString(value));
const isWholesalerRole = (role) => role === USER_ROLES.WHOLESALER;

/** draft | upcoming | live | ended (dates are checked on every call). */
function saleStatus(sale, now = new Date()) {
  if (!sale || sale.status !== 'published') return 'draft';
  const time = new Date(now).getTime();
  if (sale.endedAt && new Date(sale.endedAt).getTime() <= time) return 'ended';
  if (time < new Date(sale.startsAt).getTime()) return 'upcoming';
  if (time >= new Date(sale.endsAt).getTime()) return 'ended';
  return 'live';
}

const isLive = (sale, now) => saleStatus(sale, now) === 'live';

/** Whether a sale is meant for this role (buyers and guests are customers). */
function saleIsFor(sale, role) {
  const audience = sale?.audience;
  return isWholesalerRole(role)
    ? audience === 'wholesalers' || audience === 'both'
    : audience === 'customers' || audience === 'both';
}

/** The % off MRP for this product and role: its own, else the sale's. */
function salePercentFor(sale, entry, role) {
  const own = isWholesalerRole(role) ? entry?.wholesalerPercent : entry?.customerPercent;
  const base = isWholesalerRole(role) ? sale?.wholesalerPercent : sale?.customerPercent;
  const percent = Number(own ?? base);
  return Number.isFinite(percent) && percent > 0 && percent < 100 ? percent : null;
}

/** A sale quantity was set and every unit is gone. */
const isSoldOut = (entry) => entry?.saleQuantity != null && !(Number(entry.remaining) > 0);

/**
 * Highest % this role can get ("Up to 30% off"), counting only `productIds`
 * when given (the products this viewer can actually see).
 */
function maxPercentFor(sale, role, productIds = null) {
  const allowed = productIds ? new Set([...productIds].map(idString)) : null;
  const entries = (sale?.products || []).filter((entry) => !allowed || allowed.has(idString(entry.productId)));
  const percents = entries.map((entry) => salePercentFor(sale, entry, role)).filter(Boolean);
  if (percents.length === 0) return allowed && allowed.size === 0 ? null : salePercentFor(sale, null, role);
  return Math.max(...percents);
}

// ---- Published sales that haven't ended, by product ----

async function loadSaleIndex(now = new Date()) {
  const { Sale } = models();
  const sales = await Sale.find({ status: 'published', endedAt: null, endsAt: { $gt: now } }).lean();
  const byProduct = new Map();
  for (const sale of sales) {
    for (const entry of sale.products || []) {
      const key = idString(entry.productId);
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key).push({ sale, entry });
    }
  }
  return { sales, byProduct, at: Date.now() };
}

// Catalogue pages share one copy for a minute per server instance; admin
// changes and checkouts clear it here. Cart and checkout always read fresh.
let cachedIndex = null;
let loading = null;
let generation = 0;

async function cachedSaleIndex() {
  if (cachedIndex && Date.now() - cachedIndex.at < CACHE_MS) return cachedIndex;
  if (!loading) {
    const startedAt = generation;
    const load = (async () => {
      try {
        const index = await loadSaleIndex();
        if (startedAt === generation) cachedIndex = index;
        return index;
      } finally {
        if (loading === load) loading = null;
      }
    })();
    loading = load;
  }
  return loading;
}

function clearSaleCache() {
  cachedIndex = null;
  loading = null;
  generation += 1;
}

const getSaleIndex = ({ cached = false, now } = {}) => (cached ? cachedSaleIndex() : loadSaleIndex(now));

/** Live sales meant for this role, ending soonest first. */
async function liveSalesFor(role, { cached = true, now = new Date() } = {}) {
  const index = await getSaleIndex({ cached, now });
  return index.sales
    .filter((sale) => isLive(sale, now) && saleIsFor(sale, role))
    .sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));
}

// Banner links to a sale look like /sale/<id>.
const SALE_LINK = /^\/sale\/([a-f0-9]{24})(?:[/?#]|$)/i;

/**
 * Banners without sale banners this viewer can't use right now: the sale
 * hasn't started, has ended, or is meant for others. A banner can be set up
 * early and shows by itself when the sale starts.
 */
async function withoutUnavailableSaleBanners(banners, role, now = new Date()) {
  if (!Array.isArray(banners) || banners.length === 0) return banners;
  const links = banners.map((banner) => String(banner?.linkUrl || '').trim().match(SALE_LINK));
  if (!links.some(Boolean)) return banners;
  const index = await getSaleIndex({ cached: true });
  const byId = new Map(index.sales.map((sale) => [String(sale._id).toLowerCase(), sale]));
  return banners.filter((banner, position) => {
    const match = links[position];
    if (!match) return true;
    const sale = byId.get(match[1].toLowerCase());
    return Boolean(sale && isLive(sale, now) && saleIsFor(sale, role));
  });
}

// ---- Prices ----

/**
 * The best live sale offer for a product and role, given the sale index:
 * { percent, sale } or null. Sold-out sale quantities don't count.
 */
function saleOfferFor(product, role, index, now = new Date()) {
  const offers = index?.byProduct?.get(idString(product?._id));
  if (!offers) return null;
  let best = null;
  for (const { sale, entry } of offers) {
    if (!isLive(sale, now) || !saleIsFor(sale, role) || isSoldOut(entry)) continue;
    const percent = salePercentFor(sale, entry, role);
    if (percent && (!best || percent > best.percent)) best = { percent, sale, entry };
  }
  return best;
}

/** What a card needs to show the sale: name, look, %, and when it ends. */
const saleSummary = (offer) => (offer ? {
  id: offer.sale._id,
  name: offer.sale.name,
  nameHindi: offer.sale.nameHindi || '',
  theme: offer.sale.theme,
  percent: offer.percent,
  endsAt: offer.sale.endedAt && new Date(offer.sale.endedAt) < new Date(offer.sale.endsAt)
    ? offer.sale.endedAt
    : offer.sale.endsAt,
  perPersonLimit: offer.entry?.perPersonLimit ?? null,
  remaining: offer.entry?.saleQuantity != null ? Number(offer.entry.remaining) || 0 : null,
} : null);

// ---- Sale quantity (units at the sale price) ----

const SALE_SOLD_OUT = 'SALE_SOLD_OUT';
const SALE_LIMIT_REACHED = 'SALE_LIMIT_REACHED';

// Order lines at a sale's price, one per sale and product (quantities added up).
function saleLinesOf(items = []) {
  const lines = new Map();
  for (const item of items) {
    if (!item?.saleId) continue;
    const key = `${idString(item.saleId)}:${idString(item.productId)}`;
    const line = lines.get(key) || {
      saleId: item.saleId,
      productId: item.productId,
      quantity: 0,
      name: item.productSnapshot?.name || 'This product',
    };
    line.quantity += Number(item.quantity) || 0;
    lines.set(key, line);
  }
  return [...lines.values()].filter((line) => line.quantity > 0);
}

// Units back to a sale product. `remaining` is worked out again from the sale
// quantity, so lowering the quantity below what was sold and then cancelling
// can't free more units than the quantity allows.
const giveBackUpdate = (productId, quantity) => [{
  $set: {
    products: {
      $map: {
        input: '$products',
        as: 'p',
        in: {
          $cond: [
            { $and: [{ $eq: ['$$p.productId', productId] }, { $gte: ['$$p.sold', quantity] }] },
            {
              $mergeObjects: ['$$p', {
                sold: { $subtract: ['$$p.sold', quantity] },
                remaining: {
                  $cond: [
                    { $eq: [{ $ifNull: ['$$p.saleQuantity', null] }, null] },
                    null,
                    { $max: [0, { $subtract: ['$$p.saleQuantity', { $subtract: ['$$p.sold', quantity] }] }] },
                  ],
                },
              }],
            },
            '$$p',
          ],
        },
      },
    },
    countsVersion: { $add: [{ $ifNull: ['$countsVersion', 0] }, 1] },
  },
}];

async function giveBackUnits(lines) {
  const { Sale } = models();
  for (const line of lines) {
    try {
      await Sale.updateOne(
        { _id: line.saleId, products: { $elemMatch: { productId: line.productId, sold: { $gte: line.quantity } } } },
        giveBackUpdate(objectId(line.productId), line.quantity),
      );
    } catch (error) {
      console.warn(`[Sales] could not give back sale units: ${error.message}`);
    }
  }
}

// ---- Per-person limit (units one account can buy at the sale price) ----

/** Units of a product this account bought at a sale's price (cancelled orders don't count). */
async function unitsBoughtAtSale(userId, saleId, productId) {
  const { Order } = models();
  const [user, sale, product] = [userId, saleId, productId].map(objectId);
  const [row] = await Order.aggregate([
    { $match: { userId: user, 'items.saleId': sale, status: { $ne: ORDER_STATUS.CANCELLED } } },
    { $unwind: '$items' },
    { $match: { 'items.saleId': sale, 'items.productId': product } },
    { $group: { _id: null, units: { $sum: '$items.quantity' } } },
  ]);
  return row?.units || 0;
}

const claimKey = (saleId, productId) => `${idString(saleId)}:${idString(productId)}`;

/** Units this account already has at each sale's price: its claim, or its orders. */
async function claimedUnits(userId, lines) {
  const { SaleClaim } = models();
  const claims = await SaleClaim.find({
    userId,
    saleId: { $in: [...new Set(lines.map((line) => idString(line.saleId)))] },
  }).lean();
  const byKey = new Map(claims.map((claim) => [claimKey(claim.saleId, claim.productId), claim.quantity]));
  const result = new Map();
  for (const line of lines) {
    const key = claimKey(line.saleId, line.productId);
    result.set(key, byKey.has(key) ? byKey.get(key) : await unitsBoughtAtSale(userId, line.saleId, line.productId));
  }
  return result;
}

// The sale entries (per-person limit, sale quantity) for these lines.
async function saleEntries(lines) {
  const { Sale } = models();
  const sales = await Sale.find({ _id: { $in: [...new Set(lines.map((line) => idString(line.saleId)))] } })
    .select('products.productId products.saleQuantity products.remaining products.perPersonLimit')
    .lean();
  const entries = new Map();
  for (const sale of sales) {
    for (const entry of sale.products || []) entries.set(claimKey(sale._id, entry.productId), entry);
  }
  return entries;
}

/**
 * The sale price only covers a whole line: enough sale units left, and within
 * this person's "Max per person". A line that needs more pays the normal price
 * (it is never refused or split).
 *
 * `lines` are { productId, quantity, saleId } as priced with the sale.
 * Returns the product ids that must be priced without the sale, and why:
 * Map<productId, { reason: 'limit', limit, left } | { reason: 'sold_out' }>.
 */
async function personalSaleLimits({ lines = [], user = null }) {
  const notes = new Map();
  const saleLines = lines.filter((line) => line.saleId && Number(line.quantity) > 0);
  if (saleLines.length === 0) return notes;
  const entries = await saleEntries(saleLines);
  const limited = saleLines.filter((line) => Number(entries.get(claimKey(line.saleId, line.productId))?.perPersonLimit) > 0);
  const claimed = user?._id && limited.length > 0 ? await claimedUnits(user._id, limited) : new Map();
  for (const line of saleLines) {
    const entry = entries.get(claimKey(line.saleId, line.productId));
    if (!entry) continue;
    if (entry.saleQuantity != null && !(Number(entry.remaining) >= line.quantity)) {
      notes.set(idString(line.productId), { reason: 'sold_out' });
      continue;
    }
    const limit = Number(entry.perPersonLimit) || null;
    if (!limit || !user?._id) continue;
    const already = claimed.get(claimKey(line.saleId, line.productId)) || 0;
    if (already + line.quantity > limit) {
      notes.set(idString(line.productId), { reason: 'limit', limit, left: Math.max(limit - already, 0) });
    }
  }
  return notes;
}

async function releaseClaims(userId, lines) {
  if (!userId) return;
  const { SaleClaim } = models();
  for (const line of lines) {
    try {
      await SaleClaim.updateOne(
        { saleId: line.saleId, productId: line.productId, userId },
        [{ $set: { quantity: { $max: [0, { $subtract: ['$quantity', line.quantity] }] } } }],
      );
    } catch (error) {
      console.warn(`[Sales] could not give back a per-person claim: ${error.message}`);
    }
  }
}

/**
 * Raises this account's claim for each limited line in one atomic step each,
 * all or nothing, so two orders at once can't both go over the limit.
 */
async function claimLimits(userId, lines) {
  const limitedLines = [];
  if (!userId || lines.length === 0) return limitedLines;
  const { SaleClaim } = models();
  const entries = await saleEntries(lines);
  try {
    for (const line of lines) {
      const limit = Number(entries.get(claimKey(line.saleId, line.productId))?.perPersonLimit) || null;
      if (!limit) continue;
      const filter = { saleId: line.saleId, productId: line.productId, userId };
      // First claim for this product: start from what the orders say.
      if (!(await SaleClaim.exists(filter))) {
        const already = await unitsBoughtAtSale(userId, line.saleId, line.productId);
        try {
          await SaleClaim.create({ ...filter, quantity: already });
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
      const claimed = await SaleClaim.findOneAndUpdate(
        { ...filter, quantity: { $lte: limit - line.quantity } },
        { $inc: { quantity: line.quantity } },
      );
      if (!claimed) {
        const current = await SaleClaim.findOne(filter).lean();
        const left = Math.max(limit - (current?.quantity || 0), 0);
        const error = new ConflictError(`${line.name} is at its sale limit of ${limit} per person.`, SALE_LIMIT_REACHED);
        error.details = { productId: idString(line.productId), name: line.name, limit, left };
        throw error;
      }
      limitedLines.push(line);
    }
  } catch (error) {
    await releaseClaims(userId, limitedLines);
    throw error;
  }
  return limitedLines;
}

/**
 * Gives an order's sale units back (cancelled, not confirmed, or the checkout
 * failed), and its per-person claims when `userId` is given. Never throws.
 */
async function giveBackSaleUnits(items = [], { userId = null } = {}) {
  const lines = saleLinesOf(items);
  if (lines.length === 0) return;
  await giveBackUnits(lines);
  await releaseClaims(userId, lines);
  clearSaleCache();
}

/**
 * Takes the per-person claims and the sale units for an order's sale-priced
 * lines, all or nothing. Each step is one atomic update, so two buyers never
 * get the same last units and one person can't go over the limit with two
 * orders at once. Throws SALE_LIMIT_REACHED or SALE_SOLD_OUT.
 */
async function takeSaleUnits(items = [], { userId = null } = {}) {
  const { Sale } = models();
  const lines = saleLinesOf(items);
  if (lines.length === 0) return [];
  const claimed = await claimLimits(userId, lines);
  const taken = [];
  try {
    for (const line of lines) {
      const limited = await Sale.updateOne(
        { _id: line.saleId, products: { $elemMatch: { productId: line.productId, saleQuantity: { $ne: null }, remaining: { $gte: line.quantity } } } },
        { $inc: { 'products.$.remaining': -line.quantity, 'products.$.sold': line.quantity, countsVersion: 1 } },
      );
      if (limited.modifiedCount === 1) {
        taken.push(line);
        continue;
      }
      const open = await Sale.updateOne(
        { _id: line.saleId, products: { $elemMatch: { productId: line.productId, saleQuantity: null } } },
        { $inc: { 'products.$.sold': line.quantity, countsVersion: 1 } },
      );
      if (open.modifiedCount === 1) {
        taken.push(line);
        continue;
      }
      const error = new ConflictError(`Not enough of ${line.name} left at the sale price.`, SALE_SOLD_OUT);
      error.details = { productId: idString(line.productId), name: line.name };
      throw error;
    }
  } catch (error) {
    await giveBackUnits(taken);
    await releaseClaims(userId, claimed);
    throw error;
  } finally {
    clearSaleCache();
  }
  return taken;
}

// ---- Unpaid sale orders ----

const UNPAID_SALE_ORDER_HOURS = 48;

/**
 * Daily job: a confirmed order with sale-priced lines that is still unpaid
 * 48 hours after it was confirmed is cancelled, so its sale units go back for
 * other buyers. The customer is told why. Returns how many were cancelled.
 */
async function releaseUnpaidSaleOrders(now = new Date()) {
  const { Order } = models();
  const { ORDER_CONFIRMATION } = require('../utils/constants');
  const notificationService = require('./notificationService');
  const before = new Date(now.getTime() - UNPAID_SALE_ORDER_HOURS * 60 * 60 * 1000);
  const orders = await Order.find({
    status: ORDER_STATUS.PENDING_PAYMENT,
    confirmationStatus: ORDER_CONFIRMATION.CONFIRMED,
    confirmedAt: { $lte: before },
    'items.saleId': { $type: 'objectId' },
  }).limit(200);
  let cancelled = 0;
  for (const order of orders) {
    // Only if nobody paid or changed it meanwhile.
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: ORDER_STATUS.PENDING_PAYMENT },
      {
        $set: { status: ORDER_STATUS.CANCELLED },
        $push: {
          statusHistory: {
            status: ORDER_STATUS.CANCELLED,
            note: `Not paid within ${UNPAID_SALE_ORDER_HOURS} hours of confirmation: sale units released`,
            timestamp: now,
          },
        },
      },
      { new: true },
    );
    if (!updated) continue;
    cancelled += 1;
    await giveBackSaleUnits(updated.items, { userId: updated.userId });
    await require('./affiliateCommissionService').reverseAffiliateForOrder(updated._id, 'Not paid in time')
      .catch((error) => console.error(`Affiliate reversal failed for ${updated._id}:`, error.message));
    try {
      await notificationService.sendLocalizedToUser(
        updated.userId,
        'saleOrderReleased',
        { orderNumber: updated.orderNumber, hours: UNPAID_SALE_ORDER_HOURS },
        { type: 'order_update', orderId: String(updated._id), orderNumber: updated.orderNumber },
      );
    } catch (error) {
      console.error('Failed to tell the customer about a released sale order:', error);
    }
  }
  return { checked: orders.length, cancelled };
}

// ---- Announcement push ----

const AUDIENCE_ROLES = {
  customers: [USER_ROLES.BUYER],
  wholesalers: [USER_ROLES.WHOLESALER],
  both: [USER_ROLES.BUYER, USER_ROLES.WHOLESALER],
};

async function announcementRecipients(sale) {
  const { User } = models();
  return User.find({
    role: { $in: AUDIENCE_ROLES[sale.audience] || [] },
    isActive: { $ne: false },
    deletedAt: null,
  })
    .select('_id role preferredLanguage')
    .lean();
}

const saleNameIn = (sale, language) => (language === 'hi' && sale.nameHindi ? sale.nameHindi : sale.name);

/** How many people an announcement would reach. */
async function announcementReach(sale) {
  return (await announcementRecipients(sale)).length;
}

/**
 * "Diwali Sale is live": one message per language and role (for "up to X%"),
 * as a push and in each person's notification list. Returns how many people
 * it went to.
 */
async function announceSale(sale) {
  const { DeviceToken, Notification, Product } = models();
  const notificationService = require('./notificationService');
  const users = await announcementRecipients(sale);
  const groups = new Map();
  for (const user of users) {
    const language = normalizeLanguage(user.preferredLanguage);
    const key = `${language}|${user.role}`;
    if (!groups.has(key)) groups.set(key, { language, role: user.role, ids: [] });
    groups.get(key).ids.push(user._id);
  }
  // "Up to X%" counts only products that are on sale (active).
  const active = await Product.find({
    _id: { $in: (sale.products || []).map((entry) => entry.productId) },
    status: PRODUCT_STATUS.ACTIVE,
  }).select('_id').lean();
  const activeIds = active.map((product) => product._id);
  const data = { type: 'sale', saleId: String(sale._id) };
  for (const { language, role, ids } of groups.values()) {
    const percent = maxPercentFor(sale, role, activeIds);
    const message = renderTemplate(percent ? 'saleLive' : 'saleLiveNoPercent', language, {
      saleName: saleNameIn(sale, language),
      percent,
    });
    const tokens = await DeviceToken.find({ userId: { $in: ids }, isActive: true }).select('fcmToken').lean();
    const fcmTokens = [...new Set(tokens.map((token) => token.fcmToken).filter(Boolean))];
    if (fcmTokens.length > 0) {
      try {
        await notificationService.sendToMultipleDevices(fcmTokens, message, { ...data, language });
      } catch (error) {
        console.error('Failed to send sale announcement:', error);
      }
    }
    try {
      await Notification.insertMany(ids.map((userId) => ({
        userId,
        title: message.title,
        body: message.body,
        type: 'sale',
        data: { ...data, language },
      })));
    } catch (error) {
      console.error('Failed to save sale announcements:', error);
    }
  }
  return users.length;
}

module.exports = {
  SALE_LIMIT_REACHED,
  SALE_SOLD_OUT,
  saleStatus,
  saleIsFor,
  salePercentFor,
  isSoldOut,
  maxPercentFor,
  getSaleIndex,
  clearSaleCache,
  liveSalesFor,
  withoutUnavailableSaleBanners,
  saleOfferFor,
  saleSummary,
  saleLinesOf,
  personalSaleLimits,
  takeSaleUnits,
  giveBackSaleUnits,
  unitsBoughtAtSale,
  announcementReach,
  announceSale,
  releaseUnpaidSaleOrders,
  UNPAID_SALE_ORDER_HOURS,
};

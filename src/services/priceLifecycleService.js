const crypto = require('crypto');
const mongoose = require('mongoose');
const { Product, PriceChangeAudit } = require('../models');
const notificationService = require('./notificationService');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { BUSINESS_TIMEZONE } = require('../config/businessTimezone');
const PRICE_FIELDS = ['retailPrice', 'wholesalePrice', 'mrp'];
const HOUR_MS = 60 * 60 * 1000;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function submittedPrices(prices) {
  const result = {};
  for (const field of PRICE_FIELDS) {
    if (!hasOwn(prices, field)) continue;
    const value = Number(prices[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new BadRequestError(`${field} must be a finite non-negative number`, 'INVALID_PRICE');
    }
    result[field] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new BadRequestError('Provide retailPrice, wholesalePrice or mrp', 'PRICE_REQUIRED');
  }
  return result;
}

// Only enforced when an MRP is part of the request, so legacy retail-only changes keep working.
function assertMrpNotBelowRetail(product, prices) {
  if (!hasOwn(prices, 'mrp')) return;
  const retail = hasOwn(prices, 'retailPrice') ? prices.retailPrice : Number(product.retailPrice);
  if (Number.isFinite(retail) && prices.mrp < retail) {
    throw new BadRequestError('MRP cannot be lower than the retail price', 'MRP_BELOW_RETAIL');
  }
}

function assertSubmittedPricesChange(product, prices) {
  if (Object.entries(prices).every(([field, value]) => Number(product[field]) === value)) {
    throw new BadRequestError('At least one supplied price tier must differ from the current live price', 'UNCHANGED_PRICE');
  }
}

function businessDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function customEffectiveAt(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new BadRequestError('effectiveAt must be an ISO-8601 timestamp for custom scheduling', 'INVALID_SCHEDULE');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError('effectiveAt must be an ISO-8601 timestamp for custom scheduling', 'INVALID_SCHEDULE');
  }
  const businessTime = businessDateTimeParts(parsed);
  if (businessTime.hour !== 8 || businessTime.minute !== 0 || businessTime.second !== 0 || parsed.getUTCMilliseconds() !== 0) {
    throw new BadRequestError(`Custom price changes must be exactly 08:00:00 in ${BUSINESS_TIMEZONE}`, 'INVALID_SCHEDULE');
  }
  if (parsed <= now) {
    throw new BadRequestError(`Custom price changes must be a future 08:00:00 time in ${BUSINESS_TIMEZONE}`, 'INVALID_SCHEDULE');
  }
  return parsed;
}

function calculateEffectiveAt(priceChangeMode, effectiveAt, now = new Date()) {
  switch (priceChangeMode) {
    case 'immediate':
      return now;
    case 'schedule_24h':
      return new Date(now.getTime() + (24 * HOUR_MS));
    case 'schedule_48h':
      return new Date(now.getTime() + (48 * HOUR_MS));
    case 'custom':
      return customEffectiveAt(effectiveAt, now);
    default:
      throw new BadRequestError('Invalid priceChangeMode', 'INVALID_SCHEDULE');
  }
}

function requestFingerprint(prices, priceChangeMode, effectiveAt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    retailPrice: hasOwn(prices, 'retailPrice') ? Number(prices.retailPrice) : null,
    wholesalePrice: hasOwn(prices, 'wholesalePrice') ? Number(prices.wholesalePrice) : null,
    mrp: hasOwn(prices, 'mrp') ? Number(prices.mrp) : null,
    priceChangeMode,
    effectiveAt: effectiveAt || null,
  })).digest('hex');
}

function clearPendingPriceChange() {
  return {
    pendingRetailPrice: null,
    pendingWholesalePrice: null,
    pendingMrp: null,
    priceChangeScheduledAt: null,
    priceChangeEffectiveAt: null,
    activePendingPriceChangeAudit: null,
  };
}

function productSnapshot(product) {
  return {
    product: product._id,
    productName: product.name,
    productSku: product.sku,
    productCategory: product.category,
    productCategoryIds: product.categoryIds || [],
    productPrimaryCategoryId: product.primaryCategoryId || null,
    previousRetailPrice: Number(product.retailPrice),
    previousWholesalePrice: Number(product.wholesalePrice),
    previousMrp: Number.isFinite(Number(product.mrp)) ? Number(product.mrp) : null,
  };
}

function priceChangeEvent(product, audit) {
  return {
    productId: product._id.toString(),
    productName: product.name,
    previousRetailPrice: Number(audit.previousRetailPrice),
    retailPrice: Number(product.retailPrice),
    previousWholesalePrice: Number(audit.previousWholesalePrice),
    wholesalePrice: Number(product.wholesalePrice),
    // An MRP-only change doesn't alter what customers pay, so it shouldn't trigger a push.
    priceTiersChanged: audit.newRetailPrice != null || audit.newWholesalePrice != null,
  };
}

async function notifyCartOwnersOfPriceChange(event) {
  if (event.priceTiersChanged === false) return;
  try {
    await notificationService.notifyCartOwnersOfPriceChange(event);
  } catch (error) {
    console.error(`Failed to notify cart owners about price change for product ${event.productId}:`, error);
  }
}

function scheduledChangeEvent(audit) {
  return {
    productId: audit.product,
    productName: audit.productName,
    newRetailPrice: audit.newRetailPrice,
    newWholesalePrice: audit.newWholesalePrice,
    effectiveAt: audit.effectiveAt,
    timeZone: BUSINESS_TIMEZONE,
  };
}

// Sends a customer notice for a scheduled change at most once: `field` is
// claimed atomically first, so overlapping runs cannot both send it.
async function announceScheduledChange(audit, template, field) {
  // An MRP-only change does not alter what customers pay.
  if (audit.newRetailPrice == null && audit.newWholesalePrice == null) return false;
  const claim = await PriceChangeAudit.updateOne(
    { _id: audit._id, status: 'scheduled', [field]: null },
    { $set: { [field]: new Date() } }
  );
  if (claim.modifiedCount !== 1) return false;
  try {
    await notificationService.notifyCartOwnersOfScheduledPriceChange(scheduledChangeEvent(audit), template);
  } catch (error) {
    console.error(`Failed to announce scheduled price change ${audit._id}:`, error);
  }
  return true;
}

async function getIdempotentResult(productId, idempotencyKey, fingerprint) {
  if (!idempotencyKey) return null;
  const audit = await PriceChangeAudit.findOne({ product: productId, idempotencyKey }).lean();
  if (!audit) return null;
  if (audit.requestFingerprint !== fingerprint) {
    throw new ConflictError('Idempotency-Key was already used with a different price change request', 'IDEMPOTENCY_KEY_REUSED');
  }
  const product = await Product.findById(productId).lean();
  if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  return { product, audit, idempotent: true };
}

async function requestPriceChange({ productId, prices, priceChangeMode, effectiveAt, performedBy, adminName, idempotencyKey }) {
  const normalizedKey = String(idempotencyKey || '').trim();
  if (!normalizedKey) {
    throw new BadRequestError('Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const suppliedPrices = submittedPrices(prices);
  const fingerprint = requestFingerprint(prices, priceChangeMode, effectiveAt);
  const existing = await getIdempotentResult(productId, normalizedKey, fingerprint);
  if (existing) return existing;

  const scheduledAt = new Date();
  const normalizedEffectiveAt = calculateEffectiveAt(priceChangeMode, effectiveAt, scheduledAt);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      if (normalizedKey) {
        const duplicate = await PriceChangeAudit.findOne({ product: productId, idempotencyKey: normalizedKey }).session(session);
        if (duplicate) {
          if (duplicate.requestFingerprint !== fingerprint) {
            throw new ConflictError('Idempotency-Key was already used with a different price change request', 'IDEMPOTENCY_KEY_REUSED');
          }
          const product = await Product.findById(productId).session(session).lean();
          if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
          result = { product, audit: duplicate.toObject(), idempotent: true };
          return;
        }
      }

      const product = await Product.findById(productId).session(session);
      if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      assertSubmittedPricesChange(product, suppliedPrices);
      assertMrpNotBelowRetail(product, suppliedPrices);

      const status = priceChangeMode === 'immediate' ? 'applied' : 'scheduled';
      const [audit] = await PriceChangeAudit.create([{
        ...productSnapshot(product),
        admin: performedBy,
        adminName: adminName || 'Admin',
        newRetailPrice: hasOwn(suppliedPrices, 'retailPrice') ? suppliedPrices.retailPrice : null,
        newWholesalePrice: hasOwn(suppliedPrices, 'wholesalePrice') ? suppliedPrices.wholesalePrice : null,
        newMrp: hasOwn(suppliedPrices, 'mrp') ? suppliedPrices.mrp : null,
        scheduleType: priceChangeMode,
        scheduledAt,
        effectiveAt: normalizedEffectiveAt,
        status,
        appliedAt: status === 'applied' ? scheduledAt : null,
        idempotencyKey: normalizedKey,
        requestFingerprint: fingerprint,
      }], { session });

      if (product.activePendingPriceChangeAudit) {
        await PriceChangeAudit.updateOne(
          { _id: product.activePendingPriceChangeAudit, status: 'scheduled' },
          { $set: { status: 'superseded', supersededAt: scheduledAt, supersedingAudit: audit._id } },
          { session }
        );
      }

      const nextProductValues = clearPendingPriceChange();
      if (status === 'applied') {
        for (const [field, value] of Object.entries(suppliedPrices)) nextProductValues[field] = value;
      } else {
        if (hasOwn(suppliedPrices, 'retailPrice')) nextProductValues.pendingRetailPrice = suppliedPrices.retailPrice;
        if (hasOwn(suppliedPrices, 'wholesalePrice')) nextProductValues.pendingWholesalePrice = suppliedPrices.wholesalePrice;
        if (hasOwn(suppliedPrices, 'mrp')) nextProductValues.pendingMrp = suppliedPrices.mrp;
        nextProductValues.priceChangeScheduledAt = scheduledAt;
        nextProductValues.priceChangeEffectiveAt = normalizedEffectiveAt;
        nextProductValues.activePendingPriceChangeAudit = audit._id;
      }

      // The legacy nested field is cleared during every lifecycle transition.
      const updatedProduct = await Product.findByIdAndUpdate(
        productId,
        { $set: nextProductValues, $unset: { pendingPriceChange: 1 } },
        { new: true, runValidators: true, session, strict: false }
      ).lean();
      result = { product: updatedProduct, audit: audit.toObject(), idempotent: false };
    });
    if (!result.idempotent && result.audit.status === 'applied') {
      await notifyCartOwnersOfPriceChange(priceChangeEvent(result.product, result.audit));
    }
    if (!result.idempotent && result.audit.status === 'scheduled') {
      await announceScheduledChange(result.audit, 'priceChangeScheduled', 'scheduledNoticeSentAt');
    }
    return result;
  } catch (error) {
    if (error?.code === 11000 && normalizedKey) {
      const duplicate = await getIdempotentResult(productId, normalizedKey, fingerprint);
      if (duplicate) return duplicate;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function applyDuePriceChange(productId, auditId, now = new Date()) {
  const session = await mongoose.startSession();
  try {
    let priceChange = null;
    await session.withTransaction(async () => {
      const product = await Product.findById(productId).session(session);
      if (!product || !product.activePendingPriceChangeAudit || product.activePendingPriceChangeAudit.toString() !== auditId.toString()) return;
      if (!product.priceChangeEffectiveAt || product.priceChangeEffectiveAt > now) return;

      const audit = await PriceChangeAudit.findOne({ _id: auditId, product: productId, status: 'scheduled' }).session(session);
      if (!audit) return;
      const updates = clearPendingPriceChange();
      if (product.pendingRetailPrice !== null && product.pendingRetailPrice !== undefined) updates.retailPrice = product.pendingRetailPrice;
      if (product.pendingWholesalePrice !== null && product.pendingWholesalePrice !== undefined) updates.wholesalePrice = product.pendingWholesalePrice;
      if (product.pendingMrp !== null && product.pendingMrp !== undefined) updates.mrp = product.pendingMrp;

      const updatedProduct = await Product.findByIdAndUpdate(
        productId,
        { $set: updates, $unset: { pendingPriceChange: 1 } },
        { new: true, runValidators: true, session, strict: false }
      ).lean();
      await PriceChangeAudit.updateOne(
        { _id: auditId, status: 'scheduled' },
        { $set: { status: 'applied', appliedAt: now } },
        { session }
      );
      priceChange = priceChangeEvent(updatedProduct, audit);
    });
    return priceChange;
  } finally {
    await session.endSession();
  }
}

async function processDuePriceChanges() {
  const dueProducts = await Product.find({
    activePendingPriceChangeAudit: { $ne: null },
    priceChangeEffectiveAt: { $lte: new Date() },
  }).select('_id activePendingPriceChangeAudit').lean();
  let applied = 0;
  let failed = 0;
  for (const product of dueProducts) {
    try {
      const event = await applyDuePriceChange(product._id, product.activePendingPriceChangeAudit);
      if (event) {
        applied += 1;
        await notifyCartOwnersOfPriceChange(event);
      }
    } catch (error) {
      failed += 1;
      console.error(`Failed scheduled price change for product ${product._id}:`, error.message);
    }
  }
  return { inspected: dueProducts.length, applied, failed };
}

/**
 * Cancels a change that has not taken effect yet. The live price is never
 * touched; the product just stops showing a pending change.
 */
async function cancelScheduledPriceChange({ auditId, performedBy }) {
  const session = await mongoose.startSession();
  try {
    let audit;
    await session.withTransaction(async () => {
      audit = await PriceChangeAudit.findOne({ _id: auditId, status: 'scheduled' }).session(session);
      if (!audit) {
        throw new ConflictError('Only a scheduled price change can be cancelled', 'PRICE_CHANGE_NOT_CANCELLABLE');
      }
      const product = await Product.findById(audit.product).session(session);
      if (product && String(product.activePendingPriceChangeAudit) === String(audit._id)) {
        await Product.updateOne(
          { _id: product._id },
          { $set: clearPendingPriceChange(), $unset: { pendingPriceChange: 1 } },
          { session, strict: false }
        );
      }
      await PriceChangeAudit.updateOne(
        { _id: audit._id, status: 'scheduled' },
        { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: performedBy } },
        { session }
      );
    });
    return PriceChangeAudit.findById(auditId).lean();
  } finally {
    await session.endSession();
  }
}

/**
 * The "price changes tomorrow" reminder, for changes scheduled more than a
 * day ahead (24-hour changes were already announced when they were made).
 */
async function sendPriceChangeReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + 24 * HOUR_MS);
  const candidates = await PriceChangeAudit.find({
    status: 'scheduled',
    reminderSentAt: null,
    effectiveAt: { $gt: now, $lte: horizon },
  }).lean();

  let reminded = 0;
  for (const audit of candidates) {
    if (new Date(audit.effectiveAt) - new Date(audit.scheduledAt) <= 24 * HOUR_MS) continue;
    if (await announceScheduledChange(audit, 'priceChangeReminder', 'reminderSentAt')) reminded += 1;
  }
  return { reminded };
}

module.exports = {
  // Pure helpers exposed for unit tests only.
  __test: { submittedPrices, assertSubmittedPricesChange, assertMrpNotBelowRetail, requestFingerprint, clearPendingPriceChange },
  TIME_ZONE: BUSINESS_TIMEZONE,
  calculateEffectiveAt,
  requestPriceChange,
  processDuePriceChanges,
  cancelScheduledPriceChange,
  sendPriceChangeReminders,
};

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Product, PriceChangeAudit } = require('../models');
const notificationService = require('./notificationService');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { BUSINESS_TIMEZONE } = require('../config/businessTimezone');
const PRICE_FIELDS = ['retailPrice', 'wholesalePrice'];
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
    throw new BadRequestError('Provide retailPrice or wholesalePrice', 'PRICE_REQUIRED');
  }
  return result;
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
    priceChangeMode,
    effectiveAt: effectiveAt || null,
  })).digest('hex');
}

function clearPendingPriceChange() {
  return {
    pendingRetailPrice: null,
    pendingWholesalePrice: null,
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
  };
}

async function notifyCartOwnersOfPriceChange(event) {
  try {
    await notificationService.notifyCartOwnersOfPriceChange(event);
  } catch (error) {
    console.error(`Failed to notify cart owners about price change for product ${event.productId}:`, error);
  }
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

      const status = priceChangeMode === 'immediate' ? 'applied' : 'scheduled';
      const [audit] = await PriceChangeAudit.create([{
        ...productSnapshot(product),
        admin: performedBy,
        adminName: adminName || 'Admin',
        newRetailPrice: hasOwn(suppliedPrices, 'retailPrice') ? suppliedPrices.retailPrice : null,
        newWholesalePrice: hasOwn(suppliedPrices, 'wholesalePrice') ? suppliedPrices.wholesalePrice : null,
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

module.exports = {
  TIME_ZONE: BUSINESS_TIMEZONE,
  calculateEffectiveAt,
  requestPriceChange,
  processDuePriceChanges,
};

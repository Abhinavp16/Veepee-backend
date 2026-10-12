const { PRODUCT_STATUS } = require('./constants');
const { BadRequestError } = require('./errors');

// A coming-soon product goes live by itself once its launch date has passed
// and it has stock, even before the daily job records the change.
const launchedByDate = (product, now) =>
  Boolean(product.expectedLaunchDate) &&
  new Date(product.expectedLaunchDate) <= now &&
  Number(product.stock) > 0;

const isComingSoon = (product, now = new Date()) =>
  product.comingSoon === true && !launchedByDate(product, now);

// Mongo filters equivalent to `isComingSoon` / `!isComingSoon`.
const comingSoonFilter = (now = new Date()) => ({
  comingSoon: true,
  $nor: [{ expectedLaunchDate: { $lte: now }, stock: { $gt: 0 } }],
});

const notComingSoonFilter = (now = new Date()) => ({
  $or: [
    { comingSoon: { $ne: true } },
    { expectedLaunchDate: { $lte: now }, stock: { $gt: 0 } },
  ],
});

/** Throws unless a shopper may order this product right now. */
const assertPurchasable = (product, now = new Date()) => {
  if (!product || product.status !== PRODUCT_STATUS.ACTIVE) {
    throw new BadRequestError('This product is not available', 'PRODUCT_UNAVAILABLE');
  }
  if (isComingSoon(product, now)) {
    throw new BadRequestError('This product is coming soon', 'PRODUCT_COMING_SOON');
  }
};

/** What a shopper sees about a coming-soon product (null when it is live). */
const comingSoonPayload = (product, now = new Date()) => {
  if (!isComingSoon(product, now)) return null;
  return {
    comingSoon: true,
    expectedLaunchDate: product.expectedLaunchDate || null,
    priceHidden: product.hidePriceWhileComingSoon === true,
  };
};

module.exports = {
  isComingSoon,
  comingSoonFilter,
  notComingSoonFilter,
  assertPurchasable,
  comingSoonPayload,
};

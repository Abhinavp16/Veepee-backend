const { PRODUCT_STATUS } = require('./constants');
const { BadRequestError } = require('./errors');

// A coming-soon product set to go live automatically does so once its launch
// date has passed, even before the daily job records the change. Products
// saved before the setting existed (no `autoLaunch`) count as automatic.
const launchedByDate = (product, now) =>
  Boolean(product.expectedLaunchDate) &&
  new Date(product.expectedLaunchDate) <= now &&
  product.autoLaunch !== false;

const isComingSoon = (product, now = new Date()) =>
  product.comingSoon === true && !launchedByDate(product, now);

// Mongo filters equivalent to `isComingSoon` / `!isComingSoon`.
const launchedByDateFilter = (now) => ({
  expectedLaunchDate: { $lte: now },
  autoLaunch: { $ne: false },
});

const comingSoonFilter = (now = new Date()) => ({
  comingSoon: true,
  $nor: [launchedByDateFilter(now)],
});

const notComingSoonFilter = (now = new Date()) => ({
  $or: [
    { comingSoon: { $ne: true } },
    launchedByDateFilter(now),
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

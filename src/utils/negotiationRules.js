const { BadRequestError } = require('./errors');

// Admin sets these in Settings (Bulk negotiation). The app shows the quick
// picks as "2% off" buttons on the price step; the floor is the most a
// wholesaler may ask off the normal wholesale price.
const DEFAULT_QUICK_PICKS = [2, 1];
const DEFAULT_MAX_DISCOUNT_PERCENT = 10;
const MAX_QUICK_PICKS = 4;

const round2 = (value) => Math.round(value * 100) / 100;

/** Up to 4 distinct picks between 0.5 and 50, largest first. */
function normalizeQuickPicks(list) {
  if (!Array.isArray(list)) return [...DEFAULT_QUICK_PICKS];
  const picks = [...new Set(
    list.map(Number).filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 50).map(round2)
  )];
  return picks.sort((a, b) => b - a).slice(0, MAX_QUICK_PICKS);
}

function maxDiscountPercent(settings) {
  const value = Number(settings?.negotiationMaxDiscountPercent);
  return Number.isFinite(value) && value >= 1 && value <= 90 ? value : DEFAULT_MAX_DISCOUNT_PERCENT;
}

/** What a wholesaler's app needs for the price step. */
function negotiationRulesFor(settings) {
  return {
    quickPicks: normalizeQuickPicks(settings?.negotiationQuickPicks ?? DEFAULT_QUICK_PICKS),
    maxDiscountPercent: maxDiscountPercent(settings),
  };
}

/** The lowest price per unit a wholesaler may ask for. */
function lowestAllowedPrice(standardPrice, settings) {
  const price = Number(standardPrice) || 0;
  return Math.ceil(price * (1 - maxDiscountPercent(settings) / 100));
}

/** Refuses a request further below the normal price than admin allows. */
function assertNegotiablePrice(pricePerUnit, standardPrice, settings, productName = '') {
  const lowest = lowestAllowedPrice(standardPrice, settings);
  if (Number(pricePerUnit) >= lowest) return;
  const percent = maxDiscountPercent(settings);
  const error = new BadRequestError(
    `${productName ? `${productName}: ` : ''}the lowest price you can ask for is ₹${lowest} (${percent}% off)`,
    'NEGOTIATION_PRICE_TOO_LOW'
  );
  error.details = { lowestPrice: lowest, maxDiscountPercent: percent };
  throw error;
}

module.exports = {
  DEFAULT_QUICK_PICKS,
  DEFAULT_MAX_DISCOUNT_PERCENT,
  MAX_QUICK_PICKS,
  normalizeQuickPicks,
  negotiationRulesFor,
  lowestAllowedPrice,
  assertNegotiablePrice,
};

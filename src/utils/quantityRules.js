const { BadRequestError } = require('./errors');

const positiveInt = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

/**
 * How many pieces a person may order of a product.
 * Wholesalers order whole packs (`step`), at least `minWholesaleQuantity`
 * packs. Everyone else orders single pieces, at least `minCustomerQuantity`.
 */
const quantityRules = (product, role) => {
  const packSize = positiveInt(product.packSize, 1);
  if (role === 'wholesaler') {
    return {
      step: packSize,
      min: positiveInt(product.minWholesaleQuantity, 1) * packSize,
      packSize,
    };
  }
  return { step: 1, min: positiveInt(product.minCustomerQuantity, 1), packSize };
};

/** Throws unless `quantity` satisfies the product's minimum and step. */
const assertQuantityAllowed = (product, quantity, role) => {
  const rules = quantityRules(product, role);
  const qty = Number(quantity);
  const unit = rules.step > 1 ? `multiples of ${rules.step}` : 'whole units';
  if (!Number.isInteger(qty) || qty < rules.min || qty % rules.step !== 0) {
    const error = new BadRequestError(
      `${product.name || 'This product'} must be ordered in ${unit}, at least ${rules.min}`,
      'INVALID_QUANTITY'
    );
    error.details = { productId: String(product._id || ''), min: rules.min, step: rules.step };
    throw error;
  }
  return rules;
};

module.exports = { quantityRules, assertQuantityAllowed };

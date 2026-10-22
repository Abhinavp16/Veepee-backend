const { Settings } = require('../models');

// Whether visitors who aren't signed in see customer prices, or only the MRP
// (the admin's "Show customer prices to guests" switch). Read at most every
// 30 seconds; a change in the admin is seen at once on this instance.
const TTL_MS = 30 * 1000;
let cache = null;

const guestPricesShown = async () => {
  if (cache && cache.until > Date.now()) return cache.value;
  const settings = await Settings.getSettings();
  const value = settings?.features?.showCustomerPriceToGuests === true;
  cache = { value, until: Date.now() + TTL_MS };
  return value;
};

const forgetGuestPricing = () => {
  cache = null;
};

/**
 * Who a catalogue request is priced for: the signed-in role, 'guest' for
 * visitors, and 'buyer' for a wholesaler viewing the app as a customer
 * (`X-View-As: customer`).
 */
const shopperRole = (req) => {
  const role = req.user?.role;
  if (!role) return 'guest';
  if (role === 'wholesaler' && String(req.get?.('X-View-As') || '').toLowerCase() === 'customer') {
    return 'buyer';
  }
  return role;
};

module.exports = { guestPricesShown, forgetGuestPricing, shopperRole };

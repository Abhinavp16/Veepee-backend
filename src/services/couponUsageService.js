const { Offer, Order } = require('../models');
const { BadRequestError } = require('../utils/errors');
const { ORDER_STATUS } = require('../utils/constants');

// A coupon's uses: at most usageLimit in all and perCustomerLimit for each
// customer (0 = no limit). A use is taken when the order is placed and given
// back when the order is cancelled or rejected.

/** Uses of [code] by [userId] on orders that still count. */
const customerUses = (code, userId) => Order.countDocuments({
  userId,
  offerCode: code,
  status: { $ne: ORDER_STATUS.CANCELLED },
  offerUsageReleased: { $ne: true },
});

/** Throws when [offer] can't be used (again) by [userId]. */
const assertOfferUsable = async (offer, userId) => {
  if (offer.usageLimit > 0 && offer.usageCount >= offer.usageLimit) {
    throw new BadRequestError('This coupon has been fully used', 'COUPON_LIMIT_REACHED');
  }
  if (userId && offer.perCustomerLimit > 0 && await customerUses(offer.code, userId) >= offer.perCustomerLimit) {
    throw new BadRequestError('You have already used this coupon', 'COUPON_ALREADY_USED');
  }
};

/**
 * Takes one use of the coupon, if any are left: checked and counted in one
 * step, so two checkouts at once can't both take the last use.
 */
const reserveOfferUse = async (code) => {
  const reserved = await Offer.findOneAndUpdate(
    {
      code,
      $or: [
        { usageLimit: { $in: [0, null] } },
        { usageLimit: { $exists: false } },
        { $expr: { $lt: ['$usageCount', '$usageLimit'] } },
      ],
    },
    { $inc: { usageCount: 1 } },
    { new: true }
  );
  if (!reserved) throw new BadRequestError('This coupon has been fully used', 'COUPON_LIMIT_REACHED');
  return reserved;
};

/** Gives a use back (the order wasn't created). */
const releaseOfferUse = (code) =>
  Offer.updateOne({ code, usageCount: { $gt: 0 } }, { $inc: { usageCount: -1 } });

/** A cancelled or rejected order gives its coupon use back, once. */
const releaseOfferForOrder = async (orderId) => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, offerCode: { $ne: null }, offerUsageReleased: { $ne: true } },
    { $set: { offerUsageReleased: true } },
    { new: true }
  ).lean();
  if (!order) return { released: false };
  await releaseOfferUse(order.offerCode);
  return { released: true };
};

module.exports = { assertOfferUsable, reserveOfferUse, releaseOfferUse, releaseOfferForOrder };

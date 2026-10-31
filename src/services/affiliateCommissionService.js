const { Order, AffiliateCode, AffiliateCommission } = require('../models');
const { BadRequestError } = require('../utils/errors');
const { PAID_ORDER_STATUSES } = require('../utils/constants');

// The affiliate earns this share of the discount their code gave.
const COMMISSION_RATE = 0.3;

const round2 = (value) => Number((value || 0).toFixed(2));

/** The order's code: by id (survives a rename), else by its text. */
const codeForOrder = async (order) => {
  if (order.affiliateCodeId) {
    const byId = await AffiliateCode.findById(order.affiliateCodeId);
    if (byId) return byId;
  }
  return order.affiliateCode ? AffiliateCode.findOne({ code: order.affiliateCode }) : null;
};

/**
 * Takes one use of the code, if any are left: checked and counted in one
 * step, so two checkouts at the same moment can't both take the last use.
 */
const reserveAffiliateUse = async (affiliateCodeId) => {
  const reserved = await AffiliateCode.findOneAndUpdate(
    {
      _id: affiliateCodeId,
      $or: [{ usageLimit: 0 }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }],
    },
    { $inc: { usageCount: 1 } },
    { new: true }
  );
  if (!reserved) throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  return reserved;
};

/** Gives a use back (the order wasn't created, or was cancelled). */
const releaseAffiliateUse = (affiliateCodeId) =>
  AffiliateCode.updateOne({ _id: affiliateCodeId, usageCount: { $gt: 0 } }, { $inc: { usageCount: -1 } });

/** Records the commission once the order's payment is verified. */
const creditAffiliateCommissionForOrder = async (orderId) => {
  const order = await Order.findById(orderId).lean();
  if (!order) return { credited: false, reason: 'ORDER_NOT_FOUND' };

  if (order.discountSource !== 'affiliate' || !order.affiliateCode) {
    return { credited: false, reason: 'NOT_AFFILIATE_ORDER' };
  }

  const discountAmount = round2(order.affiliateDiscountAmount || order.discount || 0);
  if (discountAmount <= 0) {
    return { credited: false, reason: 'NO_AFFILIATE_DISCOUNT' };
  }

  const affiliateCode = await codeForOrder(order);
  if (!affiliateCode) {
    return { credited: false, reason: 'AFFILIATE_CODE_NOT_FOUND' };
  }

  const existing = await AffiliateCommission.findOne({ orderId: order._id }).lean();
  if (existing) {
    return { credited: false, reason: 'ALREADY_CREDITED', commission: existing };
  }

  const commissionAmount = round2(discountAmount * COMMISSION_RATE);

  let commission;
  try {
    commission = await AffiliateCommission.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      affiliateCodeId: affiliateCode._id,
      affiliateCode: affiliateCode.code,
      personNameSnapshot: affiliateCode.personName,
      discountAmount,
      commissionRate: COMMISSION_RATE,
      commissionAmount,
      triggerEvent: 'payment_verified',
      status: 'unpaid',
    });
  } catch (error) {
    if (error?.code === 11000) {
      const dup = await AffiliateCommission.findOne({ orderId: order._id }).lean();
      return { credited: false, reason: 'ALREADY_CREDITED', commission: dup };
    }
    throw error;
  }

  await Promise.all([
    Order.updateOne(
      { _id: order._id },
      { $set: { commissionAmount, ...(!order.affiliateCodeId && { affiliateCodeId: affiliateCode._id }) } }
    ),
    AffiliateCode.updateOne(
      { _id: affiliateCode._id },
      {
        $inc: {
          totalDiscountGenerated: discountAmount,
          totalCommissionAccrued: commissionAmount,
        },
      }
    ),
  ]);

  return { credited: true, commission };
};

/**
 * A cancelled or rejected order: its use of the code goes back, and its
 * commission (if any) is reversed and taken off the code's totals. A
 * commission already paid is marked so admin can recover it.
 */
const reverseAffiliateForOrder = async (orderId, reason = 'Order cancelled') => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, affiliateCode: { $ne: null }, affiliateUsageReleased: { $ne: true } },
    { $set: { affiliateUsageReleased: true } },
    { new: true }
  ).lean();
  if (!order) return { reversed: false };

  const code = await codeForOrder(order);
  if (code) await releaseAffiliateUse(code._id);

  const commission = await AffiliateCommission.findOne({ orderId: order._id, status: { $ne: 'reversed' } });
  if (!commission) return { reversed: false, usageReleased: Boolean(code) };

  const wasPaid = commission.status === 'paid';
  commission.status = 'reversed';
  commission.reversedAt = new Date();
  commission.reversalReason = reason;
  commission.wasPaidBeforeReversal = wasPaid;
  await commission.save();
  await Promise.all([
    AffiliateCode.updateOne(
      { _id: commission.affiliateCodeId },
      { $inc: { totalDiscountGenerated: -commission.discountAmount, totalCommissionAccrued: -commission.commissionAmount } }
    ),
    Order.updateOne({ _id: order._id }, { $set: { commissionAmount: 0 } }),
  ]);
  return { reversed: true, usageReleased: Boolean(code), wasPaid };
};

/**
 * Daily: paid affiliate orders whose commission wasn't recorded (the step
 * failed at payment verification) get it now.
 */
const backfillMissingCommissions = async ({ limit = 500 } = {}) => {
  const orders = await Order.find({
    discountSource: 'affiliate',
    affiliateCode: { $ne: null },
    status: { $in: PAID_ORDER_STATUSES },
  }).select('_id').sort({ createdAt: -1 }).limit(limit).lean();
  if (orders.length === 0) return { credited: 0 };
  const done = new Set((await AffiliateCommission.find({ orderId: { $in: orders.map((o) => o._id) } })
    .select('orderId').lean()).map((c) => String(c.orderId)));
  let credited = 0;
  for (const order of orders) {
    if (done.has(String(order._id))) continue;
    try {
      if ((await creditAffiliateCommissionForOrder(order._id)).credited) credited += 1;
    } catch (error) {
      console.error(`Affiliate commission backfill failed for order ${order._id}:`, error.message);
    }
  }
  return { credited };
};

module.exports = {
  COMMISSION_RATE,
  reserveAffiliateUse,
  releaseAffiliateUse,
  creditAffiliateCommissionForOrder,
  reverseAffiliateForOrder,
  backfillMissingCommissions,
};

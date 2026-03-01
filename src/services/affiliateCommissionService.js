const { Order, AffiliateCode, AffiliateCommission } = require('../models');

const COMMISSION_RATE = 0.3;

const round2 = (value) => Number((value || 0).toFixed(2));

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

  const affiliateCode = await AffiliateCode.findOne({ code: order.affiliateCode });
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
      { $set: { commissionAmount } }
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

module.exports = {
  COMMISSION_RATE,
  creditAffiliateCommissionForOrder,
};

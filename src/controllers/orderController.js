const mongoose = require('mongoose');
const { Order, Cart, Product, Negotiation, Payment, Settings, AffiliateCode, Offer } = require('../models');
const { NotFoundError, BadRequestError, ConflictError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { ORDER_CONFIRMATION, ORDER_STATUS, ORDER_TYPES, NEGOTIATION_STATUS, USER_ROLES } = require('../utils/constants');

const { loadDiscountContext, priceFor, applySaleLimits } = require('../services/productPricingService');
const {
  takeSaleUnits,
  giveBackSaleUnits,
  SALE_SOLD_OUT,
  SALE_LIMIT_REACHED,
} = require('../services/saleService');

// Why a line lost its sale price (see productPricingService.applySaleLimits).
const SALE_NOTE_REASONS = { limit: 'sale_limit', sold_out: 'sale_sold_out' };

/**
 * Lines whose price is not what the buyer was looking at (a sale ended or
 * sold out, the buyer reached a sale's limit, a price update came in).
 * Lines the app didn't send are skipped, so older app versions still work.
 */
function changedPrices(orderItems, expectedPrices, saleNotes = new Map()) {
  if (!Array.isArray(expectedPrices) || expectedPrices.length === 0) return [];
  const expected = new Map(expectedPrices.map((entry) => [String(entry.productId), Number(entry.price)]));
  return orderItems.flatMap((item) => {
    const was = expected.get(String(item.productId));
    if (was === undefined || Math.abs(was - item.pricePerUnit) < 0.01) return [];
    const reason = SALE_NOTE_REASONS[saleNotes.get(String(item.productId))?.reason];
    return [{
      productId: String(item.productId),
      name: item.productSnapshot?.name || '',
      expected: was,
      price: item.pricePerUnit,
      ...(reason ? { reason } : {}),
    }];
  });
}

function pricesChangedError(changed) {
  const list = changed.map((line) => `${line.name} is now ₹${line.price}`).join('; ');
  const error = new ConflictError(`Prices changed: ${list}. Check and place the order again.`, 'PRICE_CHANGED');
  error.details = { items: changed };
  return error;
}

// Coupons cover the part of the order not already on sale.
const couponSubtotalOf = (items) => items
  .filter((item) => !item.saleId)
  .reduce((sum, item) => sum + item.totalPrice, 0);

function assertCouponUsable(inputCode, items) {
  if (!inputCode) return;
  if (items.length > 0 && items.every((item) => item.saleId)) {
    throw new BadRequestError(
      'Coupons don\'t apply to sale prices. Remove the coupon, or add items that aren\'t on sale.',
      'COUPON_SALE_ITEMS',
    );
  }
}
const { assertPurchasable } = require('../utils/productAvailability');
const { isReceiptAvailable, sendOrderReceipt } = require('../utils/orderReceiptPdf');
const { assertQuantityAllowed } = require('../utils/quantityRules');
const { notifyTeam } = require('../services/adminNotificationService');
const { loadGroup, summarizeGroup } = require('../services/requirementGroupService');
const { reserveAffiliateUse, releaseAffiliateUse } = require('../services/affiliateCommissionService');

const calculateDiscount = (subtotal, discountType, discountValue, maxDiscountAmount) => {
  let discount = 0;

  if (discountType === 'percentage') {
    discount = (subtotal * discountValue) / 100;
  } else {
    discount = discountValue;
  }

  if (maxDiscountAmount && discount > maxDiscountAmount) {
    discount = maxDiscountAmount;
  }

  if (discount > subtotal) {
    discount = subtotal;
  }

  return Number(discount.toFixed(2));
};

const normalizeDiscountRules = (rules = []) => {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => ({
      minPurchaseAmount: Number(rule?.minPurchaseAmount || 0),
      discountType: rule?.discountType === 'fixed' ? 'fixed' : 'percentage',
      discountValue: Number(rule?.discountValue || 0),
      maxDiscountAmount: rule?.maxDiscountAmount === null || rule?.maxDiscountAmount === undefined || rule?.maxDiscountAmount === ''
        ? undefined
        : Number(rule.maxDiscountAmount),
    }))
    .filter((rule) => rule.discountValue >= 0 && rule.minPurchaseAmount >= 0)
    .sort((a, b) => b.minPurchaseAmount - a.minPurchaseAmount);
};

const pickDiscountRule = (subtotal, rules, fallback) => {
  const normalizedRules = normalizeDiscountRules(rules);
  if (normalizedRules.length > 0) {
    const matchedRule = normalizedRules.find((rule) => subtotal >= rule.minPurchaseAmount);
    if (!matchedRule) {
      const minRequired = Math.min(...normalizedRules.map((rule) => rule.minPurchaseAmount));
      return { matchedRule: null, minRequired };
    }
    return { matchedRule, minRequired: matchedRule.minPurchaseAmount };
  }

  return {
    matchedRule: {
      minPurchaseAmount: Number(fallback?.minPurchaseAmount || 0),
      discountType: fallback?.discountType || 'percentage',
      discountValue: Number(fallback?.discountValue || 0),
      maxDiscountAmount: fallback?.maxDiscountAmount,
    },
    minRequired: Number(fallback?.minPurchaseAmount || 0),
  };
};

const validateAffiliateCandidate = (affiliate) => {
  const now = new Date();

  if (!affiliate.isActive) {
    throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  }

  if (new Date(affiliate.startDate) > now) {
    throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  }

  if (affiliate.endDate && new Date(affiliate.endDate) < now) {
    throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  }

  if (affiliate.usageLimit !== 0 && affiliate.usageCount >= affiliate.usageLimit) {
    throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  }
};

const resolveCouponDiscount = async ({ couponCode, subtotal, userRole, userId = null }) => {
  if (!couponCode || !couponCode.trim()) {
    return {
      discountSource: null,
      discount: 0,
      offerCode: null,
      affiliateCode: null,
      affiliateMeta: null,
    };
  }

  const normalizedCode = couponCode.trim().toUpperCase();
  const now = new Date();

  // Affiliate has precedence on collision.
  const affiliate = await AffiliateCode.findOne({ code: normalizedCode });
  if (affiliate) {
    validateAffiliateCandidate(affiliate);

    // Uses per customer, when admin set a limit (cancelled orders don't count).
    if (userId && affiliate.perCustomerLimit > 0) {
      const used = await Order.countDocuments({
        userId,
        status: { $ne: ORDER_STATUS.CANCELLED },
        $or: [{ affiliateCodeId: affiliate._id }, { affiliateCode: affiliate.code }],
      });
      if (used >= affiliate.perCustomerLimit) {
        throw new BadRequestError('You have already used this code', 'COUPON_ALREADY_USED');
      }
    }

    const { matchedRule, minRequired } = pickDiscountRule(subtotal, affiliate.discountRules, {
      minPurchaseAmount: 0,
      discountType: affiliate.discountType,
      discountValue: affiliate.discountValue,
      maxDiscountAmount: undefined,
    });

    if (!matchedRule) {
      throw new BadRequestError(
        `Minimum purchase amount for this coupon is ₹${minRequired}`,
        'COUPON_MIN_PURCHASE_NOT_MET'
      );
    }

    const discount = calculateDiscount(
      subtotal,
      matchedRule.discountType,
      matchedRule.discountValue,
      matchedRule.maxDiscountAmount
    );

    if (discount <= 0) {
      throw new BadRequestError('Coupon is not applicable for this order', 'COUPON_NOT_APPLICABLE');
    }

    return {
      discountSource: 'affiliate',
      discount,
      offerCode: null,
      affiliateCode: affiliate.code,
      affiliateMeta: {
        id: affiliate._id,
        personName: affiliate.personName,
      },
    };
  }

  const targetGroup = userRole === USER_ROLES.WHOLESALER
    ? USER_ROLES.WHOLESALER
    : USER_ROLES.BUYER;

  const offer = await Offer.findOne({
    code: normalizedCode,
    isActive: true,
    startDate: { $lte: now },
    targetGroup: { $in: [targetGroup, 'all'] },
    $or: [
      { endDate: null },
      { endDate: { $exists: false } },
      { endDate: { $gte: now } },
    ],
  });

  if (!offer) {
    throw new BadRequestError('Invalid or expired coupon code', 'INVALID_COUPON');
  }

  const { matchedRule, minRequired } = pickDiscountRule(subtotal, offer.discountRules, {
    minPurchaseAmount: offer.minPurchaseAmount || 0,
    discountType: offer.discountType,
    discountValue: offer.discountValue,
    maxDiscountAmount: offer.maxDiscountAmount,
  });

  if (!matchedRule || subtotal < (minRequired || 0)) {
    throw new BadRequestError(
      `Minimum purchase amount for this coupon is ₹${minRequired}`,
      'COUPON_MIN_PURCHASE_NOT_MET'
    );
  }

  const discount = calculateDiscount(
    subtotal,
    matchedRule.discountType,
    matchedRule.discountValue,
    matchedRule.maxDiscountAmount
  );

  if (discount <= 0) {
    throw new BadRequestError('Coupon is not applicable for this order', 'COUPON_NOT_APPLICABLE');
  }

  return {
    discountSource: 'offer',
    offerCode: offer.code,
    affiliateCode: null,
    affiliateMeta: null,
    discount,
  };
};

const getCurrentCartPricing = async (userId, userRole) => {
  const cart = await Cart.findOne({ userId });
  if (!cart || cart.items.length === 0) {
    throw new BadRequestError('Cart is empty', 'CART_EMPTY');
  }

  const productIds = cart.items.map(item => item.productId);
  const products = await Product.find({ _id: { $in: productIds } })
    .select('mrp retailPrice wholesalePrice company categoryIds primaryCategoryId');
  const ctx = await loadDiscountContext(products, { sales: 'fresh' });
  const productMap = products.reduce((acc, p) => {
    acc[p._id.toString()] = p;
    return acc;
  }, {});

  const lines = cart.items
    .map((item) => ({ product: productMap[item.productId.toString()], quantity: item.quantity }))
    .filter((line) => line.product);
  await applySaleLimits(ctx, lines, userRole, userId);

  let subtotal = 0;
  let couponSubtotal = 0;
  let itemCount = 0;
  let saleLines = 0;

  for (const { product, quantity } of lines) {
    const priced = priceFor(product, userRole, ctx);
    subtotal += priced.price * quantity;
    if (priced.sale) saleLines += 1;
    else couponSubtotal += priced.price * quantity;
    itemCount += quantity;
  }

  if (subtotal <= 0 || itemCount <= 0) {
    throw new BadRequestError('No valid items in cart', 'CART_EMPTY');
  }

  return { subtotal, couponSubtotal, itemCount, onlySaleItems: saleLines > 0 && saleLines === lines.length };
};

// The same for Buy Now items sent with the coupon preview.
const getItemsPricing = async (items, userRole, userId) => {
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } })
    .select('mrp retailPrice wholesalePrice company categoryIds primaryCategoryId');
  const ctx = await loadDiscountContext(products, { sales: 'fresh' });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const lines = items
    .map((item) => ({ product: byId.get(String(item.productId)), quantity: item.quantity }))
    .filter((line) => line.product);
  await applySaleLimits(ctx, lines, userRole, userId);
  let subtotal = 0;
  let couponSubtotal = 0;
  let saleLines = 0;
  for (const { product, quantity } of lines) {
    const priced = priceFor(product, userRole, ctx);
    subtotal += priced.price * quantity;
    if (priced.sale) saleLines += 1;
    else couponSubtotal += priced.price * quantity;
  }
  return {
    subtotal,
    couponSubtotal,
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    onlySaleItems: saleLines > 0 && saleLines === lines.length,
  };
};

const AWAITING_CONFIRMATION_MESSAGE =
  'Order placed. We will confirm it and add the delivery charge, then you can pay.';

exports.previewCouponForCart = async (req, res, next) => {
  try {
    const { couponCode, subtotal: requestedSubtotal, items } = req.body;

    // Buy Now sends its items (or, from older apps, a subtotal); otherwise
    // the cart is used. The coupon covers only the part not on sale.
    let subtotal = 0;
    let couponSubtotal = 0;
    let itemCount = 0;
    let onlySaleItems = false;

    if (Array.isArray(items) && items.length > 0) {
      ({ subtotal, couponSubtotal, itemCount, onlySaleItems } = await getItemsPricing(items, req.user.role, req.user._id));
    } else if (requestedSubtotal !== undefined && requestedSubtotal !== null) {
      subtotal = parseFloat(requestedSubtotal);
      couponSubtotal = subtotal;
      itemCount = 1;
    } else {
      ({ subtotal, couponSubtotal, itemCount, onlySaleItems } = await getCurrentCartPricing(req.user._id, req.user.role));
    }
    if (onlySaleItems) {
      throw new BadRequestError(
        'Coupons don\'t apply to sale prices. Remove the coupon, or add items that aren\'t on sale.',
        'COUPON_SALE_ITEMS',
      );
    }

    const {
      discountSource,
      offerCode,
      affiliateCode,
      affiliateMeta,
      discount,
    } = await resolveCouponDiscount({
      couponCode,
      subtotal: couponSubtotal,
      userRole: req.user.role,
      userId: req.user._id,
    });

    // Delivery is added by the shop when it confirms the order.
    const deliveryFee = 0;
    const totalBeforeDiscount = subtotal + deliveryFee;
    const payableTotal = Math.max(totalBeforeDiscount - discount, 0);

    res.json({
      success: true,
      message: 'Coupon applied successfully',
      data: {
        couponCode: offerCode || affiliateCode,
        discountSource,
        affiliateCode,
        affiliatePersonName: affiliateMeta?.personName || null,
        itemCount,
        subtotal,
        // The part of the subtotal the coupon applies to (not on sale).
        couponSubtotal,
        deliveryFee,
        totalBeforeDiscount,
        discount,
        payableTotal,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getMyOrders = async (req, res, next) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = { userId: req.user._id };
    if (status) query.status = status;

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    // Fetch payment info for all orders in one query
    const orderIds = orders.map(o => o._id);
    const payments = await Payment.find({ orderId: { $in: orderIds } }).lean();
    const paymentMap = payments.reduce((acc, p) => {
      acc[p.orderId.toString()] = p;
      return acc;
    }, {});

    const formatted = orders.map(o => {
      const payment = paymentMap[o._id.toString()];
      return {
        id: o._id,
        orderNumber: o.orderNumber,
        orderType: o.orderType,
        items: o.items.map(item => ({
          name: item.productSnapshot.name,
          quantity: item.quantity,
          pricePerUnit: item.pricePerUnit,
          totalPrice: item.totalPrice,
          image: item.productSnapshot.image,
        })),
        subtotal: o.subtotal,
        deliveryFee: o.deliveryFee,
        discount: o.discount,
        total: o.total,
        status: o.status,
        confirmationStatus: o.confirmationStatus || null,
        confirmationNote: o.confirmationNote || null,
        trackingNumber: o.trackingNumber,
        createdAt: o.createdAt,
        payment: payment ? {
          status: payment.status,
          screenshotUploaded: !!payment.screenshotUrl,
          uploadedAt: payment.uploadedAt,
          verifiedAt: payment.verifiedAt,
          rejectionReason: payment.rejectionReason,
        } : null,
      };
    });

    res.json({
      success: true,
      ...formatPaginationResponse(formatted, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

// What the app gets back for a placed order (new, or the same one again).
const orderPlacedResponse = ({ order, settings }) => ({
  success: true,
  message: AWAITING_CONFIRMATION_MESSAGE,
  data: {
    orderId: order._id,
    orderNumber: order.orderNumber,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
    status: order.status,
    confirmationStatus: order.confirmationStatus,
    nextAction: 'await_confirmation',
    offerCode: order.offerCode,
    affiliateCode: order.affiliateCode,
    discountSource: order.discountSource,
    upiDetails: {
      upiId: settings.upiId,
      displayName: settings.upiDisplayName,
    },
  },
});

/** The Idempotency-Key the app sent for this checkout, if any. */
const checkoutKey = (req) => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  return key && key.length <= 100 ? key : null;
};

/** Answers with the order already placed for this key, if there is one. */
const respondWithExistingOrder = async (res, userId, key) => {
  if (!key) return false;
  const order = await Order.findOne({ userId, idempotencyKey: key });
  if (!order) return false;
  res.status(200).json(orderPlacedResponse({ order, settings: await Settings.getSettings() }));
  return true;
};

const isDuplicateKeyError = (error) => error?.code === 11000 && /idempotencyKey/.test(String(error.message));

exports.createOrderFromCart = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { items, shippingAddress, customerNote, affiliateCode, couponCode } = req.body;
    const inputCode = (couponCode || affiliateCode || '').trim().toUpperCase();
    const idempotencyKey = checkoutKey(req);
    // Same checkout sent again: the same order, nothing new.
    if (await respondWithExistingOrder(res, req.user._id, idempotencyKey)) return;

    // Check if this is a Buy Now request (items provided directly) or cart-based
    let orderItems = [];
    let subtotal = 0;
    let productIds = [];
    let cart = null;

    if (items && Array.isArray(items) && items.length > 0) {
      // Buy Now flow - use items from request body
      productIds = items.map(item => item.productId);
    } else {
      // Cart flow - get items from cart
      cart = await Cart.findOne({ userId: req.user._id });
      if (!cart || cart.items.length === 0) {
        throw new BadRequestError('Cart is empty', 'CART_EMPTY');
      }
      productIds = cart.items.map(item => item.productId);
    }

    const products = await Product.find({ _id: { $in: productIds } });
    const ctx = await loadDiscountContext(products, { sales: 'fresh' });
    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    // Get items to process (from request or cart)
    const itemsToProcess = (items && Array.isArray(items) && items.length > 0)
      ? items
      : cart.items;

    // A sale price covers a whole line or the line pays the normal price.
    const saleNotes = await applySaleLimits(
      ctx,
      itemsToProcess
        .map((item) => ({ product: productMap[item.productId.toString()], quantity: item.quantity }))
        .filter((line) => line.product),
      userRole,
      req.user._id,
    );

    // Pre-check: collect all stock issues before creating order
    const stockIssues = [];

    for (const item of itemsToProcess) {
      const product = productMap[item.productId.toString()];
      if (!product) continue;

      // Draft, archived and coming-soon products cannot be ordered, and the
      // quantity must follow the product's minimum and pack rules.
      assertPurchasable(product);
      assertQuantityAllowed(product, item.quantity, userRole);

      if (product.stock < item.quantity) {
        stockIssues.push({
          productId: item.productId.toString(),
          name: product.name,
          availableStock: product.stock,
          requestedQty: item.quantity,
          message: product.stock === 0
            ? `${product.name} is out of stock`
            : `Only ${product.stock} units of ${product.name} available (you requested ${item.quantity})`,
        });
        continue;
      }

      // Get role-based pricing (a live sale's price when it is lower)
      const priced = priceFor(product, userRole, ctx);
      const pricePerUnit = priced.price;
      const itemTotal = pricePerUnit * item.quantity;

      orderItems.push({
        productId: product._id,
        productSnapshot: {
          name: product.name,
          sku: product.sku,
          image: product.primaryImage,
        },
        quantity: item.quantity,
        pricePerUnit: pricePerUnit,
        totalPrice: itemTotal,
        saleId: priced.sale?.id || null,
        salePercent: priced.sale?.percent ?? null,
      });
      subtotal += itemTotal;
    }

    if (stockIssues.length > 0) {
      const msg = stockIssues.map(i => i.message).join('; ');
      return res.status(400).json({
        success: false,
        message: msg,
        code: 'INSUFFICIENT_STOCK',
        data: { issues: stockIssues },
      });
    }

    if (orderItems.length === 0) {
      throw new BadRequestError('No valid items in cart', 'CART_EMPTY');
    }

    // Stop if a price is not what the buyer saw, so they can look again.
    const changed = changedPrices(orderItems, req.body.expectedPrices, saleNotes);
    if (changed.length > 0) throw pricesChangedError(changed);

    assertCouponUsable(inputCode, orderItems);
    const {
      discountSource,
      offerCode,
      affiliateCode: resolvedAffiliateCode,
      affiliateMeta,
      discount,
    } = await resolveCouponDiscount({
      couponCode: inputCode,
      subtotal: couponSubtotalOf(orderItems),
      userRole: req.user.role,
      userId: req.user._id,
    });
    // Delivery is added by the shop when it confirms the order.
    const deliveryFee = 0;
    const total = Math.max(subtotal + deliveryFee - discount, 0);

    // Sale-priced lines: claim this buyer's share and the units, all or
    // nothing. If another order got there first, say which price changed.
    try {
      await takeSaleUnits(orderItems, { userId: req.user._id });
    } catch (error) {
      if (![SALE_SOLD_OUT, SALE_LIMIT_REACHED].includes(error.code)) throw error;
      const line = orderItems.find((item) => String(item.productId) === error.details?.productId);
      const normal = line ? priceFor(productMap[String(line.productId)], userRole, {
        ...ctx,
        withoutSale: new Set([...ctx.withoutSale, String(line.productId)]),
      }).price : null;
      if (!line || normal == null) throw error;
      throw pricesChangedError([{
        productId: String(line.productId),
        name: line.productSnapshot?.name || '',
        expected: line.pricePerUnit,
        price: normal,
        reason: error.code === SALE_LIMIT_REACHED ? 'sale_limit' : 'sale_sold_out',
      }]);
    }

    // The code's use is taken before the order is saved (given back if it
    // isn't), so the last use can't go to two orders at once.
    const affiliateCodeId = discountSource === 'affiliate' ? affiliateMeta?.id : null;
    if (affiliateCodeId) await reserveAffiliateUse(affiliateCodeId);

    let order;
    try {
      order = await Order.create({
        userId: req.user._id,
        ...(idempotencyKey && { idempotencyKey }),
        customerSnapshot: {
          name: req.user.name,
          email: req.user.email,
          // Some legacy/social-auth users may not have profile phone set.
          // Fallback to checkout shipping phone to satisfy required snapshot field.
          phone: req.user.phone || shippingAddress?.phone,
        },
        orderType: ORDER_TYPES.RETAIL,
        items: orderItems,
        subtotal,
        deliveryFee,
        discount,
        discountSource,
        affiliateDiscountAmount: discountSource === 'affiliate' ? discount : 0,
        total,
        shippingAddress,
        customerNote,
        confirmationStatus: ORDER_CONFIRMATION.PENDING,
        statusHistory: [{
          status: ORDER_STATUS.PENDING_PAYMENT,
          note: 'Order placed; awaiting confirmation and delivery charge',
        }],
        affiliateCode: resolvedAffiliateCode,
        affiliateCodeId,
        offerCode,
      });
    } catch (error) {
      // Not recorded: the sale units and the code's use go back.
      await giveBackSaleUnits(orderItems, { userId: req.user._id });
      if (affiliateCodeId) await releaseAffiliateUse(affiliateCodeId);
      // The same checkout arrived twice at once and the other one won.
      if (isDuplicateKeyError(error) && await respondWithExistingOrder(res, req.user._id, idempotencyKey)) return;
      throw error;
    }

    if (discountSource === 'offer' && offerCode) {
      await Offer.findOneAndUpdate(
        { code: offerCode },
        { $inc: { usageCount: 1 } }
      );
    }

    // Increment order count (stock deducted when admin confirms/processes)
    for (const item of orderItems) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { orderCount: 1 },
      });
    }

    // Clear cart only for cart-based orders, not for Buy Now
    if (!items || !Array.isArray(items) || items.length === 0) {
      // This was a cart-based order, clear the cart
      if (cart) {
        cart.items = [];
        await cart.save();
      }
    }

    // Create payment record
    const settings = await Settings.getSettings();
    await Payment.create({
      orderId: order._id,
      userId: req.user._id,
      amount: order.total,
      upiId: settings.upiId,
    });

    notifyTeam({
      type: 'new_order',
      title: 'New order',
      body: `${order.customerSnapshot?.name || 'A customer'} placed order ${order.orderNumber} (₹${order.total}).`,
      link: '/orders',
      data: { orderId: order._id, orderNumber: order.orderNumber },
    });

    res.status(201).json(orderPlacedResponse({ order, settings }));
  } catch (error) {
    next(error);
  }
};

// Places ONE order for one or more accepted negotiations (a single deal, or
// every product of a requirement). Nothing is created unless every line is
// still orderable.
const placeNegotiatedOrder = async ({ user, negotiations, shippingAddress, customerNote, inputCode }) => {
  // Claim the negotiations for this order first, in one step: a second tap
  // (or a retry) finds them taken and places nothing.
  const orderId = new mongoose.Types.ObjectId();
  const ids = negotiations.map((n) => n._id);
  const claim = await Negotiation.updateMany(
    { _id: { $in: ids }, status: NEGOTIATION_STATUS.ACCEPTED, orderId: null },
    { $set: { orderId } }
  );
  const release = () => Negotiation.updateMany(
    { _id: { $in: ids }, orderId, status: NEGOTIATION_STATUS.ACCEPTED },
    { $set: { orderId: null } }
  );
  if (claim.modifiedCount !== ids.length) {
    await release();
    throw new ConflictError('This order is already being placed', 'ORDER_ALREADY_PLACED');
  }
  try {
    return await createNegotiatedOrder({ orderId, user, negotiations, shippingAddress, customerNote, inputCode });
  } catch (error) {
    // Free them again unless the order itself was already created.
    if (!(await Order.exists({ _id: orderId }))) await release();
    throw error;
  }
};

const createNegotiatedOrder = async ({ orderId, user, negotiations, shippingAddress, customerNote, inputCode }) => {
  const products = await Product.find({ _id: { $in: negotiations.map((n) => n.productId) } });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  for (const negotiation of negotiations) {
    const product = productById.get(String(negotiation.productId));
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }
    assertPurchasable(product);
    if (product.stock < negotiation.requestedQuantity) {
      const error = new BadRequestError(
        negotiations.length > 1
          ? `Only ${product.stock} of ${product.name} available`
          : 'Insufficient stock',
        'INSUFFICIENT_STOCK'
      );
      throw error;
    }
    items.push({
      productId: product._id,
      productSnapshot: { name: product.name, sku: product.sku, image: product.primaryImage },
      quantity: negotiation.requestedQuantity,
      pricePerUnit: negotiation.finalPricePerUnit,
      totalPrice: negotiation.finalTotalPrice,
    });
  }

  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const {
    discountSource,
    offerCode,
    affiliateCode: resolvedAffiliateCode,
    affiliateMeta,
    discount,
  } = await resolveCouponDiscount({ couponCode: inputCode, subtotal, userRole: user.role, userId: user._id });
  const total = Math.max(subtotal - discount, 0);
  const isGroup = negotiations.length > 1;

  // Taken before the order is saved, given back if it isn't.
  const affiliateCodeId = discountSource === 'affiliate' ? affiliateMeta?.id : null;
  if (affiliateCodeId) await reserveAffiliateUse(affiliateCodeId);

  const order = await Order.create({
    _id: orderId,
    userId: user._id,
    customerSnapshot: {
      name: user.name,
      email: user.email,
      // Keep consistent fallback behavior with cart checkout.
      phone: user.phone || shippingAddress?.phone,
      businessName: user.businessInfo?.businessName,
    },
    orderType: ORDER_TYPES.WHOLESALE,
    negotiationId: isGroup ? null : negotiations[0]._id,
    negotiationIds: negotiations.map((n) => n._id),
    items,
    subtotal,
    discount,
    discountSource,
    affiliateDiscountAmount: discountSource === 'affiliate' ? discount : 0,
    total,
    shippingAddress,
    customerNote,
    confirmationStatus: ORDER_CONFIRMATION.PENDING,
    statusHistory: [{
      status: ORDER_STATUS.PENDING_PAYMENT,
      note: `${isGroup ? 'Order created from a requirement' : 'Order created from negotiation'}; awaiting confirmation and delivery charge`,
    }],
    affiliateCode: resolvedAffiliateCode,
    affiliateCodeId,
    offerCode,
  }).catch(async (error) => {
    if (affiliateCodeId) await releaseAffiliateUse(affiliateCodeId);
    throw error;
  });

  if (discountSource === 'offer' && offerCode) {
    await Offer.findOneAndUpdate({ code: offerCode }, { $inc: { usageCount: 1 } });
  }

  for (const negotiation of negotiations) {
    negotiation.status = NEGOTIATION_STATUS.CONVERTED;
    negotiation.orderId = order._id;
    await negotiation.save();
  }

  // Increment order count (stock deducted when admin confirms/processes)
  await Product.updateMany({ _id: { $in: items.map((i) => i.productId) } }, { $inc: { orderCount: 1 } });

  const settings = await Settings.getSettings();
  await Payment.create({
    orderId: order._id,
    userId: user._id,
    amount: order.total,
    upiId: settings.upiId,
  });

  notifyTeam({
    type: 'new_order',
    title: 'New order',
    body: `${order.customerSnapshot?.name || 'A customer'} placed order ${order.orderNumber} (₹${order.total}).`,
    link: '/orders',
    data: { orderId: order._id, orderNumber: order.orderNumber },
  });

  return { order, settings };
};

exports.createOrderFromNegotiation = async (req, res, next) => {
  try {
    const { negotiationId, shippingAddress, customerNote, affiliateCode, couponCode } = req.body;
    const inputCode = (couponCode || affiliateCode || '').trim().toUpperCase();

    const negotiation = await Negotiation.findOne({
      _id: negotiationId,
      wholesalerId: req.user._id,
      status: { $in: [NEGOTIATION_STATUS.ACCEPTED, NEGOTIATION_STATUS.CONVERTED] },
    });
    // Already ordered (a second tap, or Back and tap again): that order.
    if (negotiation?.status === NEGOTIATION_STATUS.CONVERTED && negotiation.orderId) {
      const existing = await Order.findOne({ _id: negotiation.orderId, userId: req.user._id });
      if (existing) {
        return res.status(200).json(orderPlacedResponse({ order: existing, settings: await Settings.getSettings() }));
      }
    }
    if (!negotiation || negotiation.status !== NEGOTIATION_STATUS.ACCEPTED || negotiation.orderId) {
      throw new NotFoundError('Valid negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }
    if (negotiation.requestGroup?.id) {
      throw new BadRequestError('This product is part of a requirement; pay for the whole requirement', 'PART_OF_REQUIREMENT');
    }

    const placed = await placeNegotiatedOrder({ user: req.user, negotiations: [negotiation], shippingAddress, customerNote, inputCode });
    res.status(201).json(orderPlacedResponse(placed));
  } catch (error) {
    next(error);
  }
};

// One order for a whole requirement, once every line has been answered.
exports.createOrderFromGroup = async (req, res, next) => {
  try {
    const { groupId, shippingAddress, customerNote, affiliateCode, couponCode } = req.body;
    const inputCode = (couponCode || affiliateCode || '').trim().toUpperCase();

    const members = await loadGroup(groupId, { wholesalerId: req.user._id });
    const summary = summarizeGroup(members);
    // Already ordered (a second tap, or Back and tap again): that order.
    if (summary.status === NEGOTIATION_STATUS.CONVERTED) {
      const orderId = members.find((m) => m.status === NEGOTIATION_STATUS.CONVERTED && m.orderId)?.orderId;
      const existing = orderId && await Order.findOne({ _id: orderId, userId: req.user._id });
      if (existing) {
        return res.status(200).json(orderPlacedResponse({ order: existing, settings: await Settings.getSettings() }));
      }
    }
    if (!summary.canPay) {
      throw new BadRequestError('Every product in this requirement must be answered before you can pay', 'REQUIREMENT_NOT_PAYABLE');
    }
    const payable = members.filter((m) => m.status === NEGOTIATION_STATUS.ACCEPTED && !m.orderId);

    const placed = await placeNegotiatedOrder({ user: req.user, negotiations: payable, shippingAddress, customerNote, inputCode });
    res.status(201).json(orderPlacedResponse(placed));
  } catch (error) {
    next(error);
  }
};

// The customer's own order receipt PDF, once the shop has confirmed it.
exports.getOrderReceipt = async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user._id }).lean().catch(() => null);
    if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    if (!isReceiptAvailable(order)) {
      throw new BadRequestError('Your receipt will be ready once we confirm the order', 'RECEIPT_NOT_AVAILABLE');
    }
    await sendOrderReceipt(res, order, await Settings.getSettings());
  } catch (error) {
    next(error);
  }
};

exports.getOrderById = async (req, res, next) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    const payment = await Payment.findOne({ orderId: order._id })
      .select('status uploadedAt verifiedAt');

    res.json({
      success: true,
      data: {
        ...order.toObject(),
        payment: payment ? {
          status: payment.status,
          uploadedAt: payment.uploadedAt,
          verifiedAt: payment.verifiedAt,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

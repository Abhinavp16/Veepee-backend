const { Order, Cart, Product, Negotiation, Payment, Settings, AffiliateCode, Offer } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { ORDER_STATUS, ORDER_TYPES, NEGOTIATION_STATUS, USER_ROLES } = require('../utils/constants');

// Helper to get price based on user role
const getPriceForUser = (product, userRole) => {
  if (userRole === 'wholesaler') {
    return {
      price: product.wholesalePrice,
      retailPrice: product.retailPrice,
      wholesalePrice: product.wholesalePrice,
    };
  }
  // For buyers - show retail price
  return {
    price: product.retailPrice,
    retailPrice: product.retailPrice,
  };
};

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

const resolveCouponDiscount = async ({ couponCode, subtotal, userRole }) => {
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

const getCurrentCartPricing = async (userId) => {
  const cart = await Cart.findOne({ userId });
  if (!cart || cart.items.length === 0) {
    throw new BadRequestError('Cart is empty', 'CART_EMPTY');
  }

  const productIds = cart.items.map(item => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('retailPrice');
  const productMap = products.reduce((acc, p) => {
    acc[p._id.toString()] = p;
    return acc;
  }, {});

  let subtotal = 0;
  let itemCount = 0;

  for (const item of cart.items) {
    const product = productMap[item.productId.toString()];
    if (!product) continue;
    subtotal += product.retailPrice * item.quantity;
    itemCount += item.quantity;
  }

  if (subtotal <= 0 || itemCount <= 0) {
    throw new BadRequestError('No valid items in cart', 'CART_EMPTY');
  }

  return { subtotal, itemCount };
};

exports.previewCouponForCart = async (req, res, next) => {
  try {
    const { couponCode, subtotal: requestedSubtotal } = req.body;

    // If subtotal is provided in request (Buy Now flow), use it; otherwise get from cart
    let subtotal = 0;
    let itemCount = 0;

    if (requestedSubtotal !== undefined && requestedSubtotal !== null) {
      // Buy Now flow - use provided subtotal
      subtotal = parseFloat(requestedSubtotal);
      itemCount = 1;
    } else {
      // Cart flow - get from cart
      const cartPricing = await getCurrentCartPricing(req.user._id);
      subtotal = cartPricing.subtotal;
      itemCount = cartPricing.itemCount;
    }

    const {
      discountSource,
      offerCode,
      affiliateCode,
      affiliateMeta,
      discount,
    } = await resolveCouponDiscount({
      couponCode,
      subtotal,
      userRole: req.user.role,
    });

    const deliveryFee = subtotal > 0 ? 50 : 0;
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
        total: o.total,
        status: o.status,
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

exports.createOrderFromCart = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { items, shippingAddress, customerNote, affiliateCode, couponCode } = req.body;
    const inputCode = (couponCode || affiliateCode || '').trim().toUpperCase();

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
    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    // Get items to process (from request or cart)
    const itemsToProcess = (items && Array.isArray(items) && items.length > 0)
      ? items
      : cart.items;

    // Pre-check: collect all stock issues before creating order
    const stockIssues = [];

    for (const item of itemsToProcess) {
      const product = productMap[item.productId.toString()];
      if (!product) continue;

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

      // Get role-based pricing
      const pricing = getPriceForUser(product, userRole);
      const pricePerUnit = pricing.price;
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

    const {
      discountSource,
      offerCode,
      affiliateCode: resolvedAffiliateCode,
      discount,
    } = await resolveCouponDiscount({
      couponCode: inputCode,
      subtotal,
      userRole: req.user.role,
    });
    const deliveryFee = subtotal > 0 ? 50 : 0;
    const total = Math.max(subtotal + deliveryFee - discount, 0);

    const order = await Order.create({
      userId: req.user._id,
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
      statusHistory: [{
        status: ORDER_STATUS.PENDING_PAYMENT,
        note: 'Order created',
      }],
      affiliateCode: resolvedAffiliateCode,
      offerCode,
    });

    if (discountSource === 'offer' && offerCode) {
      await Offer.findOneAndUpdate(
        { code: offerCode },
        { $inc: { usageCount: 1 } }
      );
    } else if (discountSource === 'affiliate' && resolvedAffiliateCode) {
      await AffiliateCode.findOneAndUpdate(
        { code: resolvedAffiliateCode },
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

    res.status(201).json({
      success: true,
      message: 'Order created. Please complete payment.',
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        discount: order.discount,
        total: order.total,
        status: order.status,
        offerCode: order.offerCode,
        affiliateCode: order.affiliateCode,
        discountSource: order.discountSource,
        upiDetails: {
          upiId: settings.upiId,
          displayName: settings.upiDisplayName,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.createOrderFromNegotiation = async (req, res, next) => {
  try {
    const { negotiationId, shippingAddress, customerNote, affiliateCode, couponCode } = req.body;
    const inputCode = (couponCode || affiliateCode || '').trim().toUpperCase();

    const negotiation = await Negotiation.findOne({
      _id: negotiationId,
      wholesalerId: req.user._id,
      status: NEGOTIATION_STATUS.ACCEPTED,
      orderId: null,
    });

    if (!negotiation) {
      throw new NotFoundError('Valid negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    const product = await Product.findById(negotiation.productId);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    if (product.stock < negotiation.requestedQuantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }

    const subtotal = negotiation.finalTotalPrice;
    const {
      discountSource,
      offerCode,
      affiliateCode: resolvedAffiliateCode,
      discount,
    } = await resolveCouponDiscount({
      couponCode: inputCode,
      subtotal,
      userRole: req.user.role,
    });
    const total = Math.max(subtotal - discount, 0);

    const order = await Order.create({
      userId: req.user._id,
      customerSnapshot: {
        name: req.user.name,
        email: req.user.email,
        // Keep consistent fallback behavior with cart checkout.
        phone: req.user.phone || shippingAddress?.phone,
        businessName: req.user.businessInfo?.businessName,
      },
      orderType: ORDER_TYPES.WHOLESALE,
      negotiationId: negotiation._id,
      items: [{
        productId: product._id,
        productSnapshot: {
          name: product.name,
          sku: product.sku,
          image: product.primaryImage,
        },
        quantity: negotiation.requestedQuantity,
        pricePerUnit: negotiation.finalPricePerUnit,
        totalPrice: negotiation.finalTotalPrice,
      }],
      subtotal,
      discount,
      discountSource,
      affiliateDiscountAmount: discountSource === 'affiliate' ? discount : 0,
      total,
      shippingAddress,
      customerNote,
      statusHistory: [{
        status: ORDER_STATUS.PENDING_PAYMENT,
        note: 'Order created from negotiation',
      }],
      affiliateCode: resolvedAffiliateCode,
      offerCode,
    });

    if (discountSource === 'offer' && offerCode) {
      await Offer.findOneAndUpdate(
        { code: offerCode },
        { $inc: { usageCount: 1 } }
      );
    } else if (discountSource === 'affiliate' && resolvedAffiliateCode) {
      await AffiliateCode.findOneAndUpdate(
        { code: resolvedAffiliateCode },
        { $inc: { usageCount: 1 } }
      );
    }

    // Update negotiation
    negotiation.status = NEGOTIATION_STATUS.CONVERTED;
    negotiation.orderId = order._id;
    await negotiation.save();

    // Increment order count (stock deducted when admin confirms/processes)
    await Product.findByIdAndUpdate(product._id, {
      $inc: { orderCount: 1 },
    });

    // Create payment record
    const settings = await Settings.getSettings();
    await Payment.create({
      orderId: order._id,
      userId: req.user._id,
      amount: order.total,
      upiId: settings.upiId,
    });

    res.status(201).json({
      success: true,
      message: 'Order created. Please complete payment.',
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        discount: order.discount,
        total: order.total,
        status: order.status,
        offerCode: order.offerCode,
        affiliateCode: order.affiliateCode,
        discountSource: order.discountSource,
        upiDetails: {
          upiId: settings.upiId,
          displayName: settings.upiDisplayName,
        },
      },
    });
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

const { Order, Cart, Product, Negotiation, Payment, Settings, AffiliateCode, Offer } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { ORDER_STATUS, ORDER_TYPES, NEGOTIATION_STATUS, USER_ROLES } = require('../utils/constants');

const validateAffiliateCode = async (affiliateCode) => {
  if (!affiliateCode || !affiliateCode.trim()) return null;

  const codeData = await AffiliateCode.findOne({
    code: affiliateCode.trim().toUpperCase(),
    isActive: true,
    startDate: { $lte: new Date() },
  });

  if (!codeData) return null;
  if (codeData.endDate && new Date(codeData.endDate) < new Date()) return null;
  if (codeData.usageLimit !== 0 && codeData.usageCount >= codeData.usageLimit) return null;

  return codeData.code;
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

const resolveOfferDiscount = async ({ couponCode, subtotal, userRole }) => {
  if (!couponCode || !couponCode.trim()) {
    return { offerCode: null, discount: 0 };
  }

  const normalizedCode = couponCode.trim().toUpperCase();
  const now = new Date();
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

  if (subtotal < (offer.minPurchaseAmount || 0)) {
    throw new BadRequestError(
      `Minimum purchase amount for this coupon is ₹${offer.minPurchaseAmount}`,
      'COUPON_MIN_PURCHASE_NOT_MET'
    );
  }

  const discount = calculateDiscount(
    subtotal,
    offer.discountType,
    offer.discountValue,
    offer.maxDiscountAmount
  );

  if (discount <= 0) {
    throw new BadRequestError('Coupon is not applicable for this order', 'COUPON_NOT_APPLICABLE');
  }

  return {
    offerCode: offer.code,
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
    const { couponCode } = req.body;
    const { subtotal, itemCount } = await getCurrentCartPricing(req.user._id);
    const { offerCode, discount } = await resolveOfferDiscount({
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
        couponCode: offerCode,
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
    const { shippingAddress, customerNote, affiliateCode, couponCode } = req.body;

    const validAffiliateCode = await validateAffiliateCode(affiliateCode);

    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestError('Cart is empty', 'CART_EMPTY');
    }

    const productIds = cart.items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    // Pre-check: collect all stock issues before creating order
    const stockIssues = [];
    const orderItems = [];
    let subtotal = 0;

    for (const item of cart.items) {
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

      const itemTotal = product.retailPrice * item.quantity;
      orderItems.push({
        productId: product._id,
        productSnapshot: {
          name: product.name,
          sku: product.sku,
          image: product.primaryImage,
        },
        quantity: item.quantity,
        pricePerUnit: product.retailPrice,
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

    const { offerCode, discount } = await resolveOfferDiscount({
      couponCode,
      subtotal,
      userRole: req.user.role,
    });
    const total = Math.max(subtotal - discount, 0);

    const order = await Order.create({
      userId: req.user._id,
      customerSnapshot: {
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
      },
      orderType: ORDER_TYPES.RETAIL,
      items: orderItems,
      subtotal,
      discount,
      total,
      shippingAddress,
      customerNote,
      statusHistory: [{
        status: ORDER_STATUS.PENDING_PAYMENT,
        note: 'Order created',
      }],
      affiliateCode: validAffiliateCode,
      offerCode,
    });

    if (offerCode) {
      await Offer.findOneAndUpdate(
        { code: offerCode },
        { $inc: { usageCount: 1 } }
      );
    }

    if (validAffiliateCode) {
      await AffiliateCode.findOneAndUpdate(
        { code: validAffiliateCode },
        { $inc: { usageCount: 1 } }
      );
    }

    // Increment order count (stock deducted when admin confirms/processes)
    for (const item of orderItems) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { orderCount: 1 },
      });
    }

    // Clear cart
    cart.items = [];
    await cart.save();

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

    const validAffiliateCode = await validateAffiliateCode(affiliateCode);

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
    const { offerCode, discount } = await resolveOfferDiscount({
      couponCode,
      subtotal,
      userRole: req.user.role,
    });
    const total = Math.max(subtotal - discount, 0);

    const order = await Order.create({
      userId: req.user._id,
      customerSnapshot: {
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
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
      total,
      shippingAddress,
      customerNote,
      statusHistory: [{
        status: ORDER_STATUS.PENDING_PAYMENT,
        note: 'Order created from negotiation',
      }],
      affiliateCode: validAffiliateCode,
      offerCode,
    });

    if (offerCode) {
      await Offer.findOneAndUpdate(
        { code: offerCode },
        { $inc: { usageCount: 1 } }
      );
    }

    if (validAffiliateCode) {
      await AffiliateCode.findOneAndUpdate(
        { code: validAffiliateCode },
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

const { Order, Payment, Product, StockLog, Settings } = require('../../models');
const { isReceiptAvailable, sendOrderReceipt } = require('../../utils/orderReceiptPdf');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { ORDER_STATUS } = require('../../utils/constants');
const notificationService = require('../../services/notificationService');
const orderConfirmationService = require('../../services/orderConfirmationService');

exports.getOrders = async (req, res, next) => {
  try {
    const { status, orderType, dateFrom, dateTo, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};
    // Only real statuses (a query object here could change the search).
    if (Object.values(ORDER_STATUS).includes(status)) query.status = status;
    if (['pending', 'confirmed', 'rejected'].includes(req.query.confirmation)) {
      query.confirmationStatus = req.query.confirmation;
    } else if (req.query.confirmation === 'notPending') {
      // "Pending payment" means confirmed (or older) orders, ready to pay.
      query.confirmationStatus = { $ne: 'pending' };
    }
    if (orderType) query.orderType = orderType;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'customerSnapshot.name': { $regex: search, $options: 'i' } },
        { 'customerSnapshot.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(orders, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getOrderById = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('userId', 'name email phone')
      .populate('negotiationId');

    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    const payment = await Payment.findOne({ orderId: order._id });

    res.json({
      success: true,
      data: {
        ...order.toObject(),
        payment,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    const allowedTransitions = {
      [ORDER_STATUS.PENDING_PAYMENT]: [ORDER_STATUS.CANCELLED],
      [ORDER_STATUS.PAYMENT_UPLOADED]: [ORDER_STATUS.CANCELLED],
      [ORDER_STATUS.PAYMENT_VERIFIED]: [ORDER_STATUS.PROCESSING, ORDER_STATUS.CANCELLED],
      [ORDER_STATUS.PROCESSING]: [ORDER_STATUS.SHIPPED, ORDER_STATUS.CANCELLED],
      [ORDER_STATUS.SHIPPED]: [ORDER_STATUS.DELIVERED],
    };

    const allowed = allowedTransitions[order.status];
    if (!allowed || !allowed.includes(status)) {
      throw new BadRequestError(
        `Cannot transition from ${order.status} to ${status}`,
        'INVALID_STATUS_TRANSITION'
      );
    }

    // ── STOCK DEDUCTION on PROCESSING (owner confirms the order) ──
    if (status === ORDER_STATUS.PROCESSING) {
      for (const item of order.items) {
        const product = await Product.findById(item.productId);
        if (!product) {
          throw new BadRequestError(
            `Product ${item.productSnapshot.name} no longer exists`,
            'PRODUCT_NOT_FOUND'
          );
        }
        if (product.stock < item.quantity) {
          throw new BadRequestError(
            `Insufficient stock for ${product.name}. Available: ${product.stock}, Required: ${item.quantity}`,
            'INSUFFICIENT_STOCK'
          );
        }

        const previousStock = product.stock;
        const result = await Product.findOneAndUpdate(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { new: true }
        );
        if (!result) {
          throw new BadRequestError(
            `Race condition: stock changed for ${item.productSnapshot.name}. Please retry.`,
            'STOCK_RACE_CONDITION'
          );
        }

        await StockLog.create({
          productId: item.productId,
          action: 'order_deduct',
          quantityChange: -item.quantity,
          previousStock,
          newStock: result.stock,
          orderId: order._id,
          reason: `Order ${order.orderNumber} confirmed`,
          performedBy: req.user._id,
        });
      }
    }

    // ── STOCK RESTORATION on CANCEL (only if was already PROCESSING) ──
    if (status === ORDER_STATUS.CANCELLED && order.status === ORDER_STATUS.PROCESSING) {
      for (const item of order.items) {
        const product = await Product.findById(item.productId);
        if (product) {
          const previousStock = product.stock;
          await Product.findByIdAndUpdate(
            item.productId,
            { $inc: { stock: item.quantity } }
          );

          await StockLog.create({
            productId: item.productId,
            action: 'cancel_restore',
            quantityChange: item.quantity,
            previousStock,
            newStock: previousStock + item.quantity,
            orderId: order._id,
            reason: `Order ${order.orderNumber} cancelled – stock restored`,
            performedBy: req.user._id,
          });
        }
      }
    }

    order.addStatusHistory(status, note, req.user._id);

    if (status === ORDER_STATUS.DELIVERED) {
      order.deliveredAt = new Date();
    }

    await order.save();

    try {
      await notificationService.sendOrderStatusUpdate(order.userId, order._id, order.status);
    } catch (notificationError) {
      console.error(`Failed to notify customer about order ${order._id} status update:`, notificationError);
    }

    res.json({
      success: true,
      message: 'Order status updated',
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

const confirmationResponse = (order, message) => ({
  success: true,
  message,
  data: {
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: order.status,
    confirmationStatus: order.confirmationStatus,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    extraDiscount: order.extraDiscount,
    extraDiscountPercent: order.extraDiscountPercent,
    total: order.total,
  },
});

// The order receipt PDF, once the order is confirmed.
exports.getOrderReceipt = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).lean().catch(() => null);
    if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    if (!isReceiptAvailable(order)) {
      throw new BadRequestError('A receipt is available once the order is confirmed', 'RECEIPT_NOT_AVAILABLE');
    }
    await sendOrderReceipt(res, order, await Settings.getSettings());
  } catch (error) {
    next(error);
  }
};

// Adds the delivery charge and lets the customer pay.
exports.confirmOrder = async (req, res, next) => {
  try {
    const order = await orderConfirmationService.confirmOrder({
      orderId: req.params.id,
      deliveryCharge: req.body.deliveryCharge,
      extraDiscount: req.body.extraDiscount,
      extraDiscountType: req.body.extraDiscountType,
      actorId: req.user._id,
    });
    res.json(confirmationResponse(order, 'Order confirmed. The customer has been asked to pay.'));
  } catch (error) {
    next(error);
  }
};

exports.rejectOrder = async (req, res, next) => {
  try {
    const order = await orderConfirmationService.rejectOrder({
      orderId: req.params.id,
      reason: req.body.reason,
      actorId: req.user._id,
    });
    res.json(confirmationResponse(order, 'Order rejected. The customer has been told why.'));
  } catch (error) {
    next(error);
  }
};

exports.shipOrder = async (req, res, next) => {
  try {
    const { trackingNumber, courierName } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    if (![ORDER_STATUS.PAYMENT_VERIFIED, ORDER_STATUS.PROCESSING].includes(order.status)) {
      throw new BadRequestError('Order cannot be shipped in current status', 'INVALID_ORDER_STATUS');
    }

    order.trackingNumber = trackingNumber;
    order.courierName = courierName;
    order.shippedAt = new Date();
    order.addStatusHistory(ORDER_STATUS.SHIPPED, `Shipped via ${courierName}. Tracking: ${trackingNumber}`, req.user._id);

    await order.save();

    try {
      await notificationService.sendOrderStatusUpdate(order.userId, order._id, ORDER_STATUS.SHIPPED);
    } catch (notificationError) {
      console.error(`Failed to notify customer about shipment for order ${order._id}:`, notificationError);
    }

    res.json({
      success: true,
      message: 'Order shipped',
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
        trackingNumber: order.trackingNumber,
        courierName: order.courierName,
      },
    });
  } catch (error) {
    next(error);
  }
};

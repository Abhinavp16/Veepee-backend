const { Payment, Order, Product, StockLog } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { PAYMENT_STATUS, ORDER_STATUS } = require('../../utils/constants');
const notificationService = require('../../services/notificationService');
const { creditAffiliateCommissionForOrder } = require('../../services/affiliateCommissionService');

exports.getPayments = async (req, res, next) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};
    if (status) query.status = status;

    const [payments, total] = await Promise.all([
      Payment.find(query)
        .populate('orderId', 'orderNumber total customerSnapshot')
        .populate('userId', 'name email phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(payments, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      throw new NotFoundError('Payment not found', 'PAYMENT_NOT_FOUND');
    }

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new BadRequestError('Payment already processed', 'PAYMENT_ALREADY_PROCESSED');
    }

    payment.status = PAYMENT_STATUS.VERIFIED;
    payment.verifiedBy = req.user._id;
    payment.verifiedAt = new Date();
    await payment.save();

    const order = await Order.findById(payment.orderId);
    if (order) {
      // Mark payment verified
      order.addStatusHistory(ORDER_STATUS.PAYMENT_VERIFIED, 'Payment verified by admin', req.user._id);

      // Auto-advance to PROCESSING and deduct stock
      for (const item of order.items) {
        const product = await Product.findById(item.productId);
        if (!product) {
          throw new BadRequestError(
            `Product not found: ${item.productSnapshot?.name || item.productId}`,
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
            `Race condition: stock changed for ${item.productSnapshot?.name}. Please retry.`,
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
          reason: `Order ${order.orderNumber} – payment verified, stock deducted`,
          performedBy: req.user._id,
        });
      }

      order.addStatusHistory(ORDER_STATUS.PROCESSING, 'Order auto-confirmed after payment verification', req.user._id);
      await order.save();

      await creditAffiliateCommissionForOrder(order._id);
    }

    // Send push notification to customer
    try {
      await notificationService.sendPaymentVerified(
        payment.userId,
        payment.orderId,
        order?.orderNumber || ''
      );
    } catch (notifErr) {
      console.error('Failed to send payment verified notification:', notifErr.message);
    }

    res.json({
      success: true,
      message: 'Payment verified and order confirmed',
      data: {
        paymentId: payment._id,
        status: payment.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.rejectPayment = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      throw new NotFoundError('Payment not found', 'PAYMENT_NOT_FOUND');
    }

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new BadRequestError('Payment already processed', 'PAYMENT_ALREADY_PROCESSED');
    }

    payment.status = PAYMENT_STATUS.REJECTED;
    payment.rejectionReason = reason;
    payment.verifiedBy = req.user._id;
    payment.verifiedAt = new Date();
    await payment.save();

    const order = await Order.findById(payment.orderId);
    if (order) {
      order.addStatusHistory(ORDER_STATUS.PENDING_PAYMENT, `Payment rejected: ${reason}`, req.user._id);
      await order.save();
    }

    // Send push notification to customer
    try {
      await notificationService.sendPaymentRejected(
        payment.userId,
        payment.orderId,
        order?.orderNumber || '',
        reason
      );
    } catch (notifErr) {
      console.error('Failed to send payment rejected notification:', notifErr.message);
    }

    res.json({
      success: true,
      message: 'Payment rejected',
      data: {
        paymentId: payment._id,
        status: payment.status,
        reason,
      },
    });
  } catch (error) {
    next(error);
  }
};

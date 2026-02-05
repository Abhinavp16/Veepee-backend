const { Payment, Order } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { PAYMENT_STATUS, ORDER_STATUS } = require('../../utils/constants');

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
      order.addStatusHistory(ORDER_STATUS.PAYMENT_VERIFIED, 'Payment verified by admin', req.user._id);
      await order.save();
    }

    // TODO: Send notification to customer

    res.json({
      success: true,
      message: 'Payment verified',
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

    // TODO: Send notification to customer

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

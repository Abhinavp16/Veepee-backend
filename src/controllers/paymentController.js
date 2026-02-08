const { Payment, Order, Settings } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { ORDER_STATUS, PAYMENT_STATUS } = require('../utils/constants');
const { getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

exports.getUpiDetails = async (req, res, next) => {
  try {
    const settings = await Settings.getSettings();

    res.json({
      success: true,
      data: {
        upiId: settings.upiId,
        displayName: settings.upiDisplayName,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.uploadScreenshot = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({
      _id: orderId,
      userId: req.user._id,
    });

    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      throw new BadRequestError('Payment already processed', 'PAYMENT_ALREADY_PROCESSED');
    }

    const payment = await Payment.findOne({ orderId });
    if (!payment) {
      throw new NotFoundError('Payment record not found', 'PAYMENT_NOT_FOUND');
    }

    if (payment.screenshotUrl) {
      throw new BadRequestError('Screenshot already uploaded', 'SCREENSHOT_ALREADY_UPLOADED');
    }

    if (!req.file) {
      throw new BadRequestError('Screenshot is required', 'SCREENSHOT_REQUIRED');
    }

    // Upload to Firebase Storage under payments/ folder
    const bucket = getStorage();
    if (!bucket) {
      throw new BadRequestError('Storage not configured', 'STORAGE_NOT_CONFIGURED');
    }

    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filename = `payments/${orderId}_${uuidv4()}.${ext}`;
    const fileUpload = bucket.file(filename);

    await new Promise((resolve, reject) => {
      const stream = fileUpload.createWriteStream({
        metadata: {
          contentType: req.file.mimetype,
          metadata: {
            orderId,
            uploadedBy: req.user._id.toString(),
            uploadedAt: new Date().toISOString(),
          },
        },
      });
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(req.file.buffer);
    });

    await fileUpload.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

    payment.screenshotUrl = publicUrl;
    payment.screenshotPublicId = filename;
    payment.uploadedAt = new Date();
    payment.status = PAYMENT_STATUS.PENDING;
    await payment.save();

    order.addStatusHistory(ORDER_STATUS.PAYMENT_UPLOADED, 'Payment screenshot uploaded');
    await order.save();

    // TODO: Notify admin

    res.json({
      success: true,
      message: 'Payment screenshot uploaded. Awaiting verification.',
      data: {
        paymentId: payment._id,
        status: payment.status,
        uploadedAt: payment.uploadedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getPaymentStatus = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({
      _id: orderId,
      userId: req.user._id,
    });

    if (!order) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }

    const payment = await Payment.findOne({ orderId });
    if (!payment) {
      throw new NotFoundError('Payment record not found', 'PAYMENT_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        paymentId: payment._id,
        orderId: payment.orderId,
        amount: payment.amount,
        status: payment.status,
        screenshotUrl: payment.screenshotUrl,
        uploadedAt: payment.uploadedAt,
        verifiedAt: payment.verifiedAt,
        rejectionReason: payment.rejectionReason,
      },
    });
  } catch (error) {
    next(error);
  }
};

const mongoose = require('mongoose');
const { PAYMENT_STATUS } = require('../utils/constants');
const { generatePaymentNumber } = require('../utils/helpers');

const paymentSchema = new mongoose.Schema({
  paymentNumber: {
    type: String,
    unique: true,
  },

  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  amount: {
    type: Number,
    required: true,
  },

  method: {
    type: String,
    enum: ['bank_transfer', 'razorpay', 'upi_manual'],
    default: 'bank_transfer',
  },

  upiId: {
    type: String,
    default: null,
  },

  // Razorpay fields
  razorpayOrderId: {
    type: String,
    default: null,
  },
  razorpayPaymentId: {
    type: String,
    default: null,
  },
  razorpaySignature: {
    type: String,
    default: null,
  },

  screenshotUrl: {
    type: String,
    default: null,
  },
  screenshotPublicId: {
    type: String,
    default: null,
  },
  uploadedAt: {
    type: Date,
    default: null,
  },

  status: {
    type: String,
    enum: Object.values(PAYMENT_STATUS),
    default: PAYMENT_STATUS.PENDING,
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  verifiedAt: {
    type: Date,
    default: null,
  },
  rejectionReason: {
    type: String,
    default: null,
  },
  // Screenshots rejected before the current one (newest last), so the team
  // can see what was sent before.
  previousAttempts: {
    type: [
      new mongoose.Schema(
        {
          screenshotUrl: String,
          screenshotPublicId: String,
          uploadedAt: Date,
          rejectionReason: String,
          rejectedAt: Date,
          rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
}, {
  timestamps: true,
});

paymentSchema.index({ paymentNumber: 1 }, { unique: true });
paymentSchema.index({ orderId: 1 });
paymentSchema.index({ userId: 1 });
paymentSchema.index({ status: 1, createdAt: -1 });

paymentSchema.pre('save', function (next) {
  if (!this.paymentNumber) {
    this.paymentNumber = generatePaymentNumber();
  }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);

const mongoose = require('mongoose');

const affiliateCommissionSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    unique: true,
  },
  orderNumber: {
    type: String,
    required: true,
    trim: true,
  },
  affiliateCodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AffiliateCode',
    required: true,
  },
  affiliateCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },
  personNameSnapshot: {
    type: String,
    required: true,
    trim: true,
  },
  discountAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  commissionRate: {
    type: Number,
    required: true,
    default: 0.3,
    min: 0,
  },
  commissionAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  triggerEvent: {
    type: String,
    enum: ['payment_verified'],
    default: 'payment_verified',
  },
  status: {
    type: String,
    enum: ['unpaid'],
    default: 'unpaid',
  },
}, {
  timestamps: true,
});

affiliateCommissionSchema.index({ affiliateCodeId: 1, createdAt: -1 });
affiliateCommissionSchema.index({ affiliateCode: 1, createdAt: -1 });

module.exports = mongoose.model('AffiliateCommission', affiliateCommissionSchema);

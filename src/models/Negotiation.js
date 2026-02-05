const mongoose = require('mongoose');
const { NEGOTIATION_STATUS, NEGOTIATION_ACTIONS } = require('../utils/constants');
const { generateNegotiationNumber } = require('../utils/helpers');

const historyEntrySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: Object.values(NEGOTIATION_ACTIONS),
    required: true,
  },
  by: {
    type: String,
    enum: ['wholesaler', 'admin'],
    required: true,
  },
  pricePerUnit: Number,
  totalPrice: Number,
  message: String,
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const negotiationSchema = new mongoose.Schema({
  negotiationNumber: {
    type: String,
    unique: true,
  },

  wholesalerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productSnapshot: {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    image: String,
    sku: String,
  },

  requestedQuantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1'],
  },
  requestedPricePerUnit: {
    type: Number,
    required: [true, 'Price per unit is required'],
    min: [0, 'Price cannot be negative'],
  },
  requestedTotalPrice: {
    type: Number,
    required: true,
  },
  message: {
    type: String,
    maxlength: [500, 'Message cannot exceed 500 characters'],
  },

  history: [historyEntrySchema],

  status: {
    type: String,
    enum: Object.values(NEGOTIATION_STATUS),
    default: NEGOTIATION_STATUS.PENDING,
  },
  currentOfferBy: {
    type: String,
    enum: ['wholesaler', 'admin'],
  },
  currentPricePerUnit: Number,
  currentTotalPrice: Number,

  finalPricePerUnit: {
    type: Number,
    default: null,
  },
  finalTotalPrice: {
    type: Number,
    default: null,
  },

  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },

  expiresAt: {
    type: Date,
    required: true,
  },
}, {
  timestamps: true,
});

negotiationSchema.index({ negotiationNumber: 1 }, { unique: true });
negotiationSchema.index({ wholesalerId: 1, status: 1 });
negotiationSchema.index({ productId: 1 });
negotiationSchema.index({ status: 1, createdAt: -1 });
negotiationSchema.index({ expiresAt: 1 });

negotiationSchema.pre('save', function (next) {
  if (!this.negotiationNumber) {
    this.negotiationNumber = generateNegotiationNumber();
  }
  
  if (!this.requestedTotalPrice) {
    this.requestedTotalPrice = this.requestedQuantity * this.requestedPricePerUnit;
  }
  
  next();
});

negotiationSchema.virtual('canPay').get(function () {
  return this.status === NEGOTIATION_STATUS.ACCEPTED && !this.orderId;
});

negotiationSchema.virtual('isExpired').get(function () {
  return new Date() > this.expiresAt;
});

negotiationSchema.set('toJSON', { virtuals: true });
negotiationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Negotiation', negotiationSchema);

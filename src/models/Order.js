const mongoose = require('mongoose');
const { ORDER_STATUS, ORDER_TYPES } = require('../utils/constants');
const { generateOrderNumber } = require('../utils/helpers');

const orderItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productSnapshot: {
    name: { type: String, required: true },
    sku: { type: String, required: true },
    image: String,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  pricePerUnit: {
    type: Number,
    required: true,
  },
  totalPrice: {
    type: Number,
    required: true,
  },
}, { _id: false });

const statusHistorySchema = new mongoose.Schema({
  status: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  note: String,
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { _id: false });

const shippingAddressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  addressLine1: { type: String, required: true },
  addressLine2: String,
  city: { type: String, required: true },
  state: { type: String, required: true },
  pincode: { type: String, required: true },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  customerSnapshot: {
    name: { type: String, required: true },
    email: { type: String, default: '' },
    phone: { type: String, required: true },
    businessName: String,
  },

  orderType: {
    type: String,
    enum: Object.values(ORDER_TYPES),
    required: true,
  },
  negotiationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Negotiation',
    default: null,
  },

  items: [orderItemSchema],

  subtotal: {
    type: Number,
    required: true,
  },
  discount: {
    type: Number,
    default: 0,
  },
  total: {
    type: Number,
    required: true,
  },

  shippingAddress: shippingAddressSchema,

  status: {
    type: String,
    enum: Object.values(ORDER_STATUS),
    default: ORDER_STATUS.PENDING_PAYMENT,
  },

  statusHistory: [statusHistorySchema],

  trackingNumber: {
    type: String,
    default: null,
  },
  courierName: {
    type: String,
    default: null,
  },
  shippedAt: {
    type: Date,
    default: null,
  },
  deliveredAt: {
    type: Date,
    default: null,
  },

  customerNote: {
    type: String,
    maxlength: 500,
  },
  adminNote: {
    type: String,
    maxlength: 500,
  },
  affiliateCode: {
    type: String,
    trim: true,
    uppercase: true,
    default: null,
  },
  offerCode: {
    type: String,
    trim: true,
    uppercase: true,
    default: null,
  },
}, {
  timestamps: true,
});

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ orderType: 1 });
orderSchema.index({ negotiationId: 1 }, { sparse: true });
orderSchema.index({ 'items.productId': 1 });

orderSchema.pre('save', function (next) {
  if (!this.orderNumber) {
    this.orderNumber = generateOrderNumber();
  }
  next();
});

orderSchema.methods.addStatusHistory = function (status, note, updatedBy) {
  this.statusHistory.push({
    status,
    note,
    updatedBy,
    timestamp: new Date(),
  });
  this.status = status;
  return this;
};

module.exports = mongoose.model('Order', orderSchema);

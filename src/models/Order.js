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
  // Set when this line was priced by a sale: its units count towards the
  // sale's quantity and the buyer's "max per person", and come back if the
  // order is cancelled or not confirmed.
  saleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null,
  },
  salePercent: {
    type: Number,
    default: null,
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
  // An order paid for a whole requirement lists every negotiation it settles.
  negotiationIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Negotiation',
  }],
  // Sent by the app once per checkout: a repeated request (double tap, Back
  // and tap again, retry) gets the same order instead of a second one.
  idempotencyKey: {
    type: String,
    trim: true,
    maxlength: 100,
    default: undefined,
  },

  items: [orderItemSchema],

  subtotal: {
    type: Number,
    required: true,
  },
  deliveryFee: {
    type: Number,
    default: 0,
  },
  discount: {
    type: Number,
    default: 0,
  },
  discountSource: {
    type: String,
    enum: ['affiliate', 'offer'],
    default: null,
  },
  // Given by the shop when it confirms the order, on top of any coupon.
  extraDiscount: {
    type: Number,
    default: 0,
    min: 0,
  },
  // Set when that discount was entered as a percentage of the products.
  extraDiscountPercent: {
    type: Number,
    default: null,
    min: 0,
    max: 100,
  },
  affiliateDiscountAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  commissionAmount: {
    type: Number,
    default: 0,
    min: 0,
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

  // The shop confirms each new order and adds the delivery charge before the
  // customer pays. Null for orders placed before this step existed.
  confirmationStatus: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected', null],
    default: null,
  },
  confirmedAt: { type: Date, default: null },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Why the shop rejected the order.
  confirmationNote: { type: String, default: null },

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
  // The code itself, so the order stays linked if the code changes.
  affiliateCodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AffiliateCode',
    default: null,
  },
  // Set when a cancelled order gave its use of the code back.
  affiliateUsageReleased: {
    type: Boolean,
    default: false,
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

orderSchema.index(
  { 'items.saleId': 1, userId: 1 },
  { partialFilterExpression: { 'items.saleId': { $type: 'objectId' } } }
);
orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ orderType: 1 });
orderSchema.index({ negotiationId: 1 }, { sparse: true });
orderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
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

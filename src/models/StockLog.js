const mongoose = require('mongoose');

const stockLogSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },
  action: {
    type: String,
    enum: ['order_deduct', 'cancel_restore', 'manual_set', 'manual_adjust'],
    required: true,
  },
  quantityChange: {
    type: Number,
    required: true,
  },
  previousStock: {
    type: Number,
    required: true,
  },
  newStock: {
    type: Number,
    required: true,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },
  reason: {
    type: String,
    maxlength: 500,
    default: null,
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, {
  timestamps: true,
});

stockLogSchema.index({ productId: 1, createdAt: -1 });
stockLogSchema.index({ orderId: 1 });
stockLogSchema.index({ action: 1 });

module.exports = mongoose.model('StockLog', stockLogSchema);

const mongoose = require('mongoose');

// A shopper asking to be told when a coming-soon product becomes available.
const productAlertSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
}, {
  timestamps: true,
});

productAlertSchema.index({ userId: 1, productId: 1 }, { unique: true });
productAlertSchema.index({ productId: 1 });

module.exports = mongoose.model('ProductAlert', productAlertSchema);

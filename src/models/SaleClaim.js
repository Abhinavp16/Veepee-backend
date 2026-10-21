const mongoose = require('mongoose');

// Units of a sale product one account has bought at the sale price, for the
// sale's "Max per person". Checkout raises it in one atomic step, so two
// orders at the same moment can't both go over the limit; cancelling or
// rejecting an order lowers it again (see services/saleService.js).
const saleClaimSchema = new mongoose.Schema({
  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quantity: { type: Number, min: 0, default: 0 },
}, {
  timestamps: true,
});

saleClaimSchema.index({ saleId: 1, productId: 1, userId: 1 }, { unique: true });
saleClaimSchema.index({ userId: 1, saleId: 1 });

module.exports = mongoose.model('SaleClaim', saleClaimSchema);

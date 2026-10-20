const mongoose = require('mongoose');

// The team messaged this person about this product (Leads page "Contacted").
const leadContactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  firstContactAt: { type: Date, required: true },
  lastContactAt: { type: Date, required: true },
  lastContactById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastContactByName: { type: String, default: '' },
  contactCount: { type: Number, default: 0, min: 0 },
}, {
  timestamps: true,
});

leadContactSchema.index({ userId: 1, productId: 1 }, { unique: true });
leadContactSchema.index({ lastContactAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('LeadContact', leadContactSchema);

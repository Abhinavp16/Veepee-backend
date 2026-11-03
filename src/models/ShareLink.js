const mongoose = require('mongoose');

// A private link to a PDF (a wholesaler's price request or order) that OXON
// staff open from WhatsApp without signing in. Random and hard to guess;
// it stops working, and is deleted, after 30 days.
const shareLinkSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  // 'negotiation' (one product), 'requirement' (a REQ- group) or 'order'.
  kind: { type: String, enum: ['negotiation', 'requirement', 'order'], required: true },
  // The negotiation or order id, or the requirement's group id.
  ref: { type: String, required: true },
  wholesalerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
}, {
  timestamps: true,
});

shareLinkSchema.index({ kind: 1, ref: 1 });
shareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ShareLink', shareLinkSchema);

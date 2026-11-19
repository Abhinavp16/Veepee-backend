const mongoose = require('mongoose');

// One admin "Custom notification" send, for the History tab: what was sent,
// to whom, where tapping it went, and how many phones it reached. The text is
// kept as typed ({name} not filled in, no coupon line), so "Send again" can
// load it back into the form.
const notificationCampaignSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  titleHi: { type: String, default: '' },
  bodyHi: { type: String, default: '' },
  // selected | buyers | wholesalers | cart | saved
  audience: { type: String, required: true },
  // cart / saved only: all | buyers | wholesalers
  segment: { type: String, default: null },
  // saved only: the product people saved.
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, default: '' },
  // { type: 'page', page } or { type, id, name }; null when it opens the message.
  link: { type: mongoose.Schema.Types.Mixed, default: null },
  couponCode: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  sentBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
  },
  // People it was saved for, their signed-in phones, and push results.
  recipients: { type: Number, default: 0 },
  phones: { type: Number, default: 0 },
  delivered: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  pushConfigured: { type: Boolean, default: true },
  // Chosen people left out because the page or sale isn't for their account type.
  skipped: { type: Number, default: 0 },
  // The admin form's id for this send: a second request with the same id is
  // refused, so a retry or double click never sends twice.
  sendId: { type: String, default: undefined },
  // sending → sent (pushes may still have failed, see failed / pushError),
  // or failed when saving it to the inboxes went wrong.
  status: { type: String, enum: ['sending', 'sent', 'failed'], default: 'sending' },
  pushError: { type: String, default: '' },
}, {
  timestamps: true,
});

notificationCampaignSchema.index({ createdAt: -1 });
notificationCampaignSchema.index({ sendId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('NotificationCampaign', notificationCampaignSchema);

const mongoose = require('mongoose');

// Something the team should know about (a new order, a payment to verify...).
// Shared by everyone who may see it; `readBy` tracks who has read it.
const adminNotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'new_order',
      'payment_uploaded',
      'new_negotiation',
      'deletion_request',
      'upgrade_request',
    ],
    required: true,
  },
  // 'admin' notifications are for administrators only; 'operations' also
  // reach staff.
  audience: {
    type: String,
    enum: ['admin', 'operations'],
    default: 'operations',
  },
  title: { type: String, required: true },
  body: { type: String, required: true },
  // Where in the admin panel this leads, e.g. "/orders".
  link: { type: String, default: '/' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, {
  timestamps: true,
});

adminNotificationSchema.index({ createdAt: -1 });
// Old notifications clean themselves up after 60 days.
adminNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model('AdminNotification', adminNotificationSchema);

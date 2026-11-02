const mongoose = require('mongoose');

// A customer's "forgot password" request from the app. Admin can reset the
// password only while one is open: pending, and asked within the last 24
// hours (asking again the same day keeps the same request open longer).
const passwordResetRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // As they were when asked, for the list.
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  role: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  lastRequestedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedByName: { type: String, default: '' },
}, {
  timestamps: true,
});

passwordResetRequestSchema.index({ status: 1, lastRequestedAt: -1 });
passwordResetRequestSchema.index({ lastRequestedAt: -1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);

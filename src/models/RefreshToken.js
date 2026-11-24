const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  deviceInfo: String,
  expiresAt: {
    type: Date,
    required: true,
  },
  // Set for staff: the sign-in's hard end. Refreshing never extends past it.
  sessionExpiresAt: {
    type: Date,
    default: null,
  },
  isRevoked: {
    type: Boolean,
    default: false,
  },
  // Renewal: when this token was swapped for a new one, and which. If the
  // phone never got the new one (the reply was lost), this token is
  // presented again while its replacement is still unused; that is accepted
  // once instead of signing the person out (see authController.refreshToken).
  usedAt: {
    type: Date,
    default: null,
  },
  replacedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RefreshToken',
    default: null,
  },
  // Cancelled by a lost-reply recovery (its predecessor came back while it
  // was unused). If it is ever presented, a copy of the session exists, and
  // all of the account's sessions are ended.
  cancelledAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

refreshTokenSchema.index({ token: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);

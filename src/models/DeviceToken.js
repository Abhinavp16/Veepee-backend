const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  fcmToken: {
    type: String,
    required: true,
  },
  platform: {
    type: String,
    enum: ['android', 'ios', 'web'],
    default: 'android',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Compound index: one token per user+device combo
deviceTokenSchema.index({ userId: 1, fcmToken: 1 }, { unique: true });
deviceTokenSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);

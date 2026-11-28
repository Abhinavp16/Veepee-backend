const mongoose = require('mongoose');

// A phone with the app that has not signed in (just downloaded, or signed
// out), with notifications allowed. The admin can send it a custom
// notification ("Not signed in" audience). No account, name or phone number:
// only the push token, the app language, the platform and the app version.
// Signing in removes the row (notificationController.registerFcmToken); a
// phone not seen for 90 days, or one Firebase reports as uninstalled, is
// removed too.
const GUEST_DEVICE_DAYS = 90;

const guestDeviceSchema = new mongoose.Schema({
  fcmToken: { type: String, required: true },
  platform: { type: String, enum: ['android', 'ios'], default: 'android' },
  language: { type: String, enum: ['en', 'hi'], default: 'en' },
  appVersion: { type: String, default: '' },
  lastSeenAt: { type: Date, default: Date.now },
}, {
  timestamps: true, // createdAt: when the phone first joined the list
});

guestDeviceSchema.index({ fcmToken: 1 }, { unique: true });
guestDeviceSchema.index({ createdAt: -1 });
guestDeviceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: GUEST_DEVICE_DAYS * 24 * 60 * 60 });

const GuestDevice = mongoose.model('GuestDevice', guestDeviceSchema);
GuestDevice.GUEST_DEVICE_DAYS = GUEST_DEVICE_DAYS;

module.exports = GuestDevice;

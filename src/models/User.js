const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_ROLES, AUTH_PROVIDERS } = require('../utils/constants');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters'],
  },
  email: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  phone: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
  },
  address: {
    type: String,
    default: null,
    trim: true,
  },
  // Delivery addresses saved in the app (primary and secondary). Kept on the
  // account so they come back after signing in on any phone. Not sent with
  // the profile; read them from GET /auth/addresses.
  savedAddresses: {
    type: [
      new mongoose.Schema(
        {
          id: { type: String, required: true },
          slot: { type: String, enum: ['primary', 'secondary'], required: true },
          fullName: { type: String, required: true, trim: true },
          phone: { type: String, required: true, trim: true },
          addressLine1: { type: String, required: true, trim: true },
          city: { type: String, required: true, trim: true },
          state: { type: String, required: true, trim: true },
          pincode: { type: String, required: true, trim: true },
        },
        { _id: false }
      ),
    ],
    default: [],
    select: false,
  },
  selectedAddressId: { type: String, default: null, select: false },
  avatar: {
    type: String,
    default: null,
  },

  authProvider: {
    type: String,
    enum: Object.values(AUTH_PROVIDERS),
    required: true,
  },
  googleId: {
    type: String,
  },
  passwordHash: {
    type: String,
    select: false,
  },

  role: {
    type: String,
    enum: Object.values(USER_ROLES),
    default: USER_ROLES.BUYER,
  },

  businessInfo: {
    businessName: { type: String, default: null },
    gstNumber: { type: String, default: null },
    businessAddress: { type: String, default: null },
    contactPerson: { type: String, default: null },
    // The business's contact number from the application (10 digits). Not
    // the account's sign-in phone, which applying never changes.
    contactPhone: { type: String, default: null },
    // When they last applied (or applied again) for a wholesaler account.
    appliedAt: { type: Date, default: null },
    // Who accepted or rejected the application, and when (admin only).
    reviewedAt: { type: Date, default: null },
    reviewedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, default: null },
    },
    status: {
      type: String, 
      // removed: admin switched a wholesaler back to a customer.
      enum: ['none', 'pending', 'accepted', 'rejected', 'removed'], 
      default: 'none' 
    },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    // Private proof photos (see services/proofStorage.js); admins see them
    // through short-lived signed links.
    proofImages: [{ type: String }],
    // Set when admin switches a wholesaler back to a customer. The reason
    // reaches the customer only when removalReasonShared is true.
    removedAt: { type: Date, default: null },
    removalReason: { type: String, default: null },
    removalReasonShared: { type: Boolean, default: false },
    // Earlier decisions, kept when they apply again (newest last, at most
    // 10; admin only, see sanitizeUser). The proof photos of an earlier
    // application are deleted when the new one is sent.
    previousApplications: {
      type: [{
        _id: false,
        status: { type: String, enum: ['accepted', 'rejected', 'removed'] },
        businessName: { type: String, default: null },
        gstNumber: { type: String, default: null },
        appliedAt: { type: Date, default: null },
        reviewedAt: { type: Date, default: null },
        reviewedBy: {
          id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          name: { type: String, default: null },
        },
        removedAt: { type: Date, default: null },
        removalReason: { type: String, default: null },
        removalReasonShared: { type: Boolean, default: false },
      }],
      default: undefined,
    },
  },

  // Every admin switch between customer and wholesaler (admin only).
  accountTypeHistory: [{
    _id: false,
    from: { type: String, enum: ['buyer', 'wholesaler'] },
    to: { type: String, enum: ['buyer', 'wholesaler'] },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    reason: { type: String, default: null },
    reasonShared: { type: Boolean, default: false },
    openNegotiations: { type: Number, default: 0 },
  }],

  fcmTokens: [{
    type: String,
  }],

  phoneVerified: {
    type: Boolean,
    default: false,
  },
  marketingConsent: {
    type: Boolean,
    default: false,
  },
  consentTimestamp: {
    type: Date,
    default: null,
  },

  // Set when an admin issues a temporary password; cleared once the person
  // chooses their own.
  mustChangePassword: { type: Boolean, default: false },
  passwordChangedAt: { type: Date, default: null },
  // A customer's one-time password from OXON support stops working after
  // this (staff temporary passwords don't set it).
  tempPasswordExpiresAt: { type: Date, default: null },
  // Wrong tries with that one-time password; it stops working at 5.
  tempPasswordFailures: { type: Number, default: 0 },
  // Every password reset by OXON support (admin only).
  passwordResets: [{
    _id: false,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
  }],

  // Proof of what the person agreed to at signup.
  termsAcceptedAt: { type: Date, default: null },
  termsAcceptedVersion: { type: String, default: null },
  privacyAcceptedAt: { type: Date, default: null },
  privacyAcceptedVersion: { type: String, default: null },

  // Language for server-generated text such as push notifications.
  preferredLanguage: {
    type: String,
    enum: ['en', 'hi'],
    default: 'en',
  },

  // Admin panel "What's new": ids of the new admin features this staff
  // member has already seen, so the highlights clear on every device.
  seenFeatures: { type: [String], default: [] },

  // Admin panel Leads: when this administrator last opened the Leads page.
  // The menu shows how many new leads came in after it.
  leadsSeenAt: { type: Date, default: null },

  // Products saved in the app's wishlist (up to 500), newest last. Kept on
  // the account so it follows them to any phone; read it from
  // GET /wishlist. Admin can notify everyone who saved a product.
  wishlist: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    default: [],
    select: false,
  },

  isActive: {
    type: Boolean,
    default: true,
  },
  lastLoginAt: {
    type: Date,
    default: null,
  },
  // Set when the account is closed through the deletion workflow.
  deletedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

userSchema.index({ role: 1 });
userSchema.index({ googleId: 1 }, { sparse: true });
// "Everyone who saved this product" (admin notifications).
userSchema.index({ wishlist: 1 });
userSchema.index({ 'businessInfo.businessName': 'text' });

userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash') || !this.passwordHash) {
    return next();
  }

  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

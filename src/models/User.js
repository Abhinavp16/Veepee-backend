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
    status: { 
      type: String, 
      // removed: admin switched a wholesaler back to a customer.
      enum: ['none', 'pending', 'accepted', 'rejected', 'removed'], 
      default: 'none' 
    },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    proofImages: [{ type: String }],
    // Set when admin switches a wholesaler back to a customer. The reason
    // reaches the customer only when removalReasonShared is true.
    removedAt: { type: Date, default: null },
    removalReason: { type: String, default: null },
    removalReasonShared: { type: Boolean, default: false },
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

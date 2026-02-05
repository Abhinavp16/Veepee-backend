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
    sparse: true,
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
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
  },

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

  isActive: {
    type: Boolean,
    default: true,
  },
  lastLoginAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ phone: 1 });
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

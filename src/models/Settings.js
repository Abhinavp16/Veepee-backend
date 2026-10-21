const mongoose = require('mongoose');

// Forced-update rule for one platform. The app compares build numbers only;
// `latestVersion` is display text.
const platformUpdateSchema = {
  enabled: { type: Boolean, default: false },
  latestVersion: { type: String, default: '' },
  latestBuildNumber: { type: Number, default: 0, min: 0 },
  storeUrl: { type: String, default: '' },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
};

const settingsSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: 'app_settings',
  },

  businessName: {
    type: String,
    default: 'VeepeeImpex',
  },
  businessPhone: String,
  businessEmail: String,
  businessAddress: String,
  // Printed on order receipts; empty hides it.
  gstin: {
    type: String,
    default: '22AAXFV7313A1Z8',
    trim: true,
    uppercase: true,
  },

  upiId: {
    type: String,
    required: true,
  },
  upiDisplayName: {
    type: String,
    required: true,
  },

  minOrderAmount: {
    type: Number,
    default: 0,
  },
  defaultBulkMinQuantity: {
    type: Number,
    default: 10,
  },
  negotiationExpiryDays: {
    type: Number,
    default: 7,
  },
  lowStockThreshold: {
    type: Number,
    default: 5,
  },

  features: {
    negotiationsEnabled: { type: Boolean, default: true },
    guestCheckout: { type: Boolean, default: false },
    maintenanceMode: { type: Boolean, default: false },
  },

  mobileApp: {
    android: platformUpdateSchema,
    ios: platformUpdateSchema,
  },

  heroBanners: [{
    title: { type: String, required: true },
    subtitle: String,
    tag: String,
    imageUrl: String,
    linkUrl: String,
    buttonText: { type: String, default: 'Shop Now' },
    buttonIcon: { type: String, default: 'ArrowRight' },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],

  promoBanners: [{
    title: { type: String, required: true },
    subtitle: String,
    tag: String,
    imageUrl: String,
    linkUrl: String,
    buttonText: { type: String, default: 'Shop Now' },
    buttonIcon: { type: String, default: 'ArrowRight' },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],

  socialLinks: {
    whatsapp: String,
    instagram: String,
    facebook: String,
  },

  // Bank Transfer Details
  bankName: String,
  bankAccountNumber: String,
  bankIfscCode: String,
  bankAccountHolderName: String,
  bankTransferEnabled: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

settingsSchema.statics.getSettings = async function () {
  let settings = await this.findById('app_settings');
  
  if (!settings) {
    try {
      settings = await this.create({
        _id: 'app_settings',
        upiId: process.env.DEFAULT_UPI_ID || 'veepeeimpex@ybl',
        upiDisplayName: process.env.DEFAULT_UPI_NAME || 'VeepeeImpex Payments',
      });
    } catch (error) {
      // Another request created it at the same moment: use that one.
      if (error?.code !== 11000) throw error;
      settings = await this.findById('app_settings');
    }
  }
  
  return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);

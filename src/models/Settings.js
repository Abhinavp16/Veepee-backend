const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: 'app_settings',
  },

  businessName: {
    type: String,
    default: 'AgriMart',
  },
  businessPhone: String,
  businessEmail: String,
  businessAddress: String,

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

  heroBanners: [{
    title: { type: String, required: true },
    subtitle: String,
    tag: String,
    imageUrl: String,
    linkUrl: String,
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],

  promoBanners: [{
    title: { type: String, required: true },
    subtitle: String,
    tag: String,
    imageUrl: String,
    linkUrl: String,
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  }],

  socialLinks: {
    whatsapp: String,
    instagram: String,
    facebook: String,
  },
}, {
  timestamps: true,
});

settingsSchema.statics.getSettings = async function () {
  let settings = await this.findById('app_settings');
  
  if (!settings) {
    settings = await this.create({
      _id: 'app_settings',
      upiId: process.env.DEFAULT_UPI_ID || 'agrimart@ybl',
      upiDisplayName: process.env.DEFAULT_UPI_NAME || 'AgriMart Payments',
    });
  }
  
  return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);

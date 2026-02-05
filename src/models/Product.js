const mongoose = require('mongoose');
const slugify = require('slugify');
const { PRODUCT_STATUS } = require('../utils/constants');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [200, 'Name cannot exceed 200 characters'],
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
  },
  shortDescription: {
    type: String,
    maxlength: [300, 'Short description cannot exceed 300 characters'],
  },

  category: {
    type: String,
    required: [true, 'Category is required'],
    index: true,
  },
  subCategory: {
    type: String,
    default: null,
  },
  tags: [{
    type: String,
    trim: true,
  }],

  // 3-Tier Pricing System
  mrp: {
    type: Number,
    required: [true, 'MRP is required'],
    min: [0, 'MRP cannot be negative'],
  },
  retailPrice: {
    type: Number,
    required: [true, 'Retail price is required'],
    min: [0, 'Retail price cannot be negative'],
  },
  wholesalePrice: {
    type: Number,
    required: [true, 'Wholesale price is required'],
    min: [0, 'Wholesale price cannot be negative'],
  },
  
  // Bulk/Wholesale settings
  minWholesaleQuantity: {
    type: Number,
    default: 10,
    min: [1, 'Minimum wholesale quantity must be at least 1'],
  },
  negotiationEnabled: {
    type: Boolean,
    default: true,
  },

  sku: {
    type: String,
    required: [true, 'SKU is required'],
    unique: true,
    uppercase: true,
  },
  stock: {
    type: Number,
    required: true,
    min: [0, 'Stock cannot be negative'],
    default: 0,
  },
  lowStockThreshold: {
    type: Number,
    default: 5,
  },
  trackInventory: {
    type: Boolean,
    default: true,
  },

  images: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  }],

  specifications: [{
    key: { type: String, required: true },
    value: { type: String, required: true },
  }],

  metaTitle: {
    type: String,
    maxlength: [70, 'Meta title cannot exceed 70 characters'],
  },
  metaDescription: {
    type: String,
    maxlength: [160, 'Meta description cannot exceed 160 characters'],
  },

  status: {
    type: String,
    enum: Object.values(PRODUCT_STATUS),
    default: PRODUCT_STATUS.DRAFT,
  },
  isFeatured: {
    type: Boolean,
    default: false,
  },
  isHot: {
    type: Boolean,
    default: false,
  },

  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    default: null,
  },

  viewCount: {
    type: Number,
    default: 0,
  },
  orderCount: {
    type: Number,
    default: 0,
  },
  negotiationCount: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ sku: 1 }, { unique: true });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ status: 1, isFeatured: -1 });
productSchema.index({ retailPrice: 1 });
productSchema.index({ wholesalePrice: 1 });
productSchema.index({ stock: 1 });
productSchema.index({ name: 'text', description: 'text', tags: 'text' });

productSchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

productSchema.virtual('inStock').get(function () {
  return this.stock > 0;
});

productSchema.virtual('isLowStock').get(function () {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});

productSchema.virtual('primaryImage').get(function () {
  const primary = this.images.find(img => img.isPrimary);
  return primary ? primary.url : (this.images[0]?.url || null);
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);

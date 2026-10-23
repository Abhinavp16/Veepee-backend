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
  nameHindi: {
    type: String,
    trim: true,
    default: '',
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },
  description: {
    type: String,
    default: '',
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
  // Optional at schema level until legacy records have been migrated. Product
  // write APIs enforce both fields for every new or changed assignment.
  categoryIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
  }],
  primaryCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null,
  },
  // Where it's sold: a category, or a category › sub-category. The first is
  // its main home. categoryIds / primaryCategoryId are kept in step with these.
  placements: [{
    _id: false,
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory', default: null },
  }],
  brand: {
    type: String,
    default: '',
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
  // Pending price changes are deliberately stored as direct fields so reads and
  // worker updates cannot accidentally merge a replacement request.
  pendingRetailPrice: { type: Number, min: [0, 'Pending retail price cannot be negative'], default: null },
  pendingWholesalePrice: { type: Number, min: [0, 'Pending wholesale price cannot be negative'], default: null },
  pendingMrp: { type: Number, min: [0, 'Pending MRP cannot be negative'], default: null },
  priceChangeScheduledAt: { type: Date, default: null },
  priceChangeEffectiveAt: { type: Date, default: null },
  activePendingPriceChangeAudit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PriceChangeAudit',
    default: null,
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

  // Selling units. `minWholesaleQuantity` counts packs; a wholesaler's step is
  // one pack of `packSize` pieces. Customers buy single pieces, at least
  // `minCustomerQuantity`.
  priceUnit: {
    type: String,
    enum: ['piece', 'packet', 'box', 'bundle', 'coil', 'set'],
    default: 'piece',
  },
  packSize: {
    type: Number,
    default: 1,
    min: [1, 'Pack size must be at least 1'],
  },
  minCustomerQuantity: {
    type: Number,
    default: 1,
    min: [1, 'Minimum customer quantity must be at least 1'],
  },

  // Coming soon: visible to shoppers but not orderable. It ends when an admin
  // switches it off, or by itself once `expectedLaunchDate` has passed when
  // `autoLaunch` is on.
  comingSoon: { type: Boolean, default: false },
  expectedLaunchDate: { type: Date, default: null },
  // No default: products saved before this option existed have no value and
  // keep going live by date. New products get false from validation.
  autoLaunch: { type: Boolean },
  hidePriceWhileComingSoon: { type: Boolean, default: false },

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
    blurHash: { type: String, default: null },
    isPrimary: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  }],

  specifications: [{
    key: { type: String, required: true },
    value: { type: String, required: true },
  }],

  videoUrl: {
    type: String,
    default: null,
    trim: true,
  },

  shippingTerms: {
    type: String,
    default: 'Free shipping on orders above ₹5,000. Standard delivery within 5-7 business days. Express delivery available at additional cost.\n\nReturn Policy: Products can be returned within 7 days of delivery if unused and in original packaging. Damaged or defective items will be replaced free of charge. Refunds are processed within 5-7 business days after the returned item is received and inspected.',
  },

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
    default: PRODUCT_STATUS.ACTIVE,
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
  labelIds: [{
    type: String,
    trim: true,
  }],

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
  // Retired: not shown to shoppers (no product reviews yet).
  rating: {
    type: Number,
    min: [0, 'Rating cannot be less than 0'],
    max: [5, 'Rating cannot exceed 5'],
  },
  // Retired: the made-up "live purchases" range is no longer shown.
  purchaseCountMin: {
    type: Number,
    default: 0,
    min: [0, 'Purchase count min cannot be negative'],
  },
  purchaseCountMax: {
    type: Number,
    default: 0,
    min: [0, 'Purchase count max cannot be negative'],
  },
}, {
  timestamps: true,
});

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ sku: 1 }, { unique: true });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ categoryIds: 1, status: 1 });
productSchema.index({ primaryCategoryId: 1, status: 1 });
productSchema.index({ 'placements.category': 1, 'placements.subCategory': 1, status: 1 });
productSchema.index({ company: 1, categoryIds: 1, status: 1 });
productSchema.index({ company: 1, category: 1, status: 1 });
productSchema.index({ status: 1, isFeatured: -1 });
productSchema.index({ comingSoon: 1, expectedLaunchDate: 1 });
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

// Images may not be loaded (a query that selects only some fields).
productSchema.virtual('primaryImage').get(function () {
  const images = this.images || [];
  const primary = images.find(img => img.isPrimary);
  return primary ? primary.url : (images[0]?.url || null);
});

productSchema.virtual('primaryBlurHash').get(function () {
  const images = this.images || [];
  const primary = images.find(img => img.isPrimary);
  return primary ? primary.blurHash : (images[0]?.blurHash || null);
});

productSchema.virtual('categories').get(function () {
  return this.categoryIds || [];
});

productSchema.virtual('primaryCategory').get(function () {
  return this.primaryCategoryId || null;
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);

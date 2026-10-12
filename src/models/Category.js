const mongoose = require('mongoose');
const slugify = require('slugify');

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Category name is required'],
    trim: true,
    unique: true,
    maxlength: [100, 'Name cannot exceed 100 characters'],
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters'],
  },
  image: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
    blurHash: { type: String, default: null },
  },
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null,
  },
  order: {
    type: Number,
    default: 1,
    min: [1, 'Order must be at least 1'],
  },
  // Percent off MRP for each audience. Hidden from normal reads; managed
  // through the admin discounts API and applied by the pricing service.
  customerDiscountPercent: { type: Number, min: 0, max: 99, default: 0, select: false },
  wholesalerDiscountPercent: { type: Number, min: 0, max: 99, default: 0, select: false },
  isActive: {
    type: Boolean,
    default: true,
  },
  productCount: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

categorySchema.index({ parent: 1, order: 1, name: 1, _id: 1 });
categorySchema.index({ isActive: 1, order: 1, name: 1, _id: 1 });

categorySchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

// Virtual to get subcategories
categorySchema.virtual('subcategories', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parent',
});

categorySchema.set('toJSON', { virtuals: true });
categorySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Category', categorySchema);

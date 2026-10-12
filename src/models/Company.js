const mongoose = require('mongoose');
const slugify = require('slugify');

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    unique: true,
    maxlength: [100, 'Company name cannot exceed 100 characters'],
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },
  logo: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters'],
    default: null,
  },
  website: {
    type: String,
    default: null,
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
  categoryIds: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
    }],
    default: [],
    set: (values) => [...new Map((values || []).map((value) => [String(value), value])).values()],
  },
}, {
  timestamps: true,
});

companySchema.index({ slug: 1 }, { unique: true });
companySchema.index({ name: 1 }, { unique: true });
companySchema.index({ isActive: 1 });
companySchema.index({ categoryIds: 1 });

companySchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

companySchema.set('toJSON', { virtuals: true });
companySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Company', companySchema);

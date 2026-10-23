const mongoose = require('mongoose');
const slugify = require('slugify');

// A sub-category ("Blades", "Screws") is made once and shown under one or more
// categories. Products are placed as "Category › Sub-category" (see
// Product.placements), so a shared sub-category only lists the products placed
// under the category being browsed.
const subCategorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Sub-category name is required'],
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
  // The categories it shows under, and its position inside each.
  categories: [{
    _id: false,
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    order: { type: Number, default: 1, min: 1 },
  }],
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

subCategorySchema.index({ 'categories.category': 1, isActive: 1 });

subCategorySchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

module.exports = mongoose.model('SubCategory', subCategorySchema);

const mongoose = require('mongoose');

// A sale page (Diwali Sale, Stock Clearance, ...): chosen products at % off
// MRP between two dates, for customers, wholesalers or both. While live, the
// sale price is used everywhere a shopper's price is worked out
// (productPricingService.priceFor), when it is lower. Only one runs at a time.
const SALE_THEMES = ['diwali', 'clearance', 'flash', 'kisan'];
const SALE_AUDIENCES = ['customers', 'wholesalers', 'both'];
const SALE_STATUSES = ['draft', 'published'];
const MAX_SALE_PRODUCTS = 200;

const percent = { type: Number, min: 1, max: 90, default: null };

const saleProductSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  // This product's own % (else the sale's).
  customerPercent: percent,
  wholesalerPercent: percent,
  // Units at the sale price (null = no limit). sold/remaining change at
  // checkout and when an order is cancelled.
  saleQuantity: { type: Number, min: 1, default: null },
  sold: { type: Number, min: 0, default: 0 },
  remaining: { type: Number, min: 0, default: null },
  // Most units one account can buy at the sale price (null = no limit).
  perPersonLimit: { type: Number, min: 1, default: null },
}, { _id: false });

const saleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  nameHindi: { type: String, trim: true, maxlength: 80, default: '' },
  subtitle: { type: String, trim: true, maxlength: 140, default: '' },
  subtitleHindi: { type: String, trim: true, maxlength: 140, default: '' },
  theme: { type: String, enum: SALE_THEMES, default: 'diwali' },
  heroImageUrl: { type: String, trim: true, default: '' },
  audience: { type: String, enum: SALE_AUDIENCES, default: 'customers' },
  customerPercent: percent,
  wholesalerPercent: percent,
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  status: { type: String, enum: SALE_STATUSES, default: 'draft' },
  // Set by "End now".
  endedAt: { type: Date, default: null },
  products: {
    type: [saleProductSchema],
    default: [],
    validate: [(list) => list.length <= MAX_SALE_PRODUCTS, `A sale can have up to ${MAX_SALE_PRODUCTS} products`],
  },
  announcements: [{
    _id: false,
    at: { type: Date, required: true },
    byName: { type: String, default: '' },
    sentTo: { type: Number, default: 0 },
  }],
  // Set while an announcement is being sent (stops a second one at once).
  announcingAt: { type: Date, default: null },
  // Goes up whenever checkout or a cancellation changes sold/remaining, so an
  // admin save can't write back older counts (see admin saleController).
  countsVersion: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
});

saleSchema.index({ status: 1, startsAt: 1, endsAt: 1 });
saleSchema.index({ 'products.productId': 1 });

module.exports = mongoose.model('Sale', saleSchema);
module.exports.SALE_THEMES = SALE_THEMES;
module.exports.SALE_AUDIENCES = SALE_AUDIENCES;
module.exports.SALE_STATUSES = SALE_STATUSES;
module.exports.MAX_SALE_PRODUCTS = MAX_SALE_PRODUCTS;

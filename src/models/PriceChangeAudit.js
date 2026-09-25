const mongoose = require('mongoose');

const nullablePrice = { type: Number, min: 0, default: null };

const priceChangeAuditSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },
  productName: { type: String, required: true, trim: true },
  productSku: { type: String, required: true, trim: true },
  productCategory: { type: String, required: true, trim: true },
  productCategoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  productPrimaryCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  adminName: { type: String, required: true, trim: true },
  previousRetailPrice: { type: Number, required: true, min: 0 },
  previousWholesalePrice: { type: Number, required: true, min: 0 },
  newRetailPrice: nullablePrice,
  newWholesalePrice: nullablePrice,
  scheduleType: {
    type: String,
    enum: ['immediate', 'schedule_24h', 'schedule_48h', 'custom'],
    required: true,
  },
  scheduledAt: { type: Date, required: true },
  effectiveAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['scheduled', 'applied', 'superseded'],
    required: true,
  },
  appliedAt: { type: Date, default: null },
  supersededAt: { type: Date, default: null },
  supersedingAudit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PriceChangeAudit',
    default: null,
  },
  idempotencyKey: { type: String, trim: true, maxlength: 200, default: null },
  requestFingerprint: { type: String, required: true, maxlength: 128 },
}, { timestamps: true });

priceChangeAuditSchema.index({ product: 1, createdAt: -1 });
priceChangeAuditSchema.index(
  { product: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

const lifecycleFields = new Set(['status', 'appliedAt', 'supersededAt', 'supersedingAudit', 'updatedAt']);

function assertLifecycleOnly(update) {
  const changedFields = Object.keys(update.$set || {});
  if (Object.keys(update).some((operator) => operator !== '$set' && operator !== '$currentDate')) {
    throw new Error('Price change audits only allow lifecycle updates');
  }
  if (changedFields.some((field) => !lifecycleFields.has(field))) {
    throw new Error('Price change audits only allow lifecycle updates');
  }
}

priceChangeAuditSchema.pre('save', function preventNonLifecycleMutation(next) {
  if (!this.isNew && this.isModified()) {
    const changedFields = this.modifiedPaths().filter((path) => path !== 'updatedAt');
    if (changedFields.some((field) => !lifecycleFields.has(field))) {
      return next(new Error('Price change audits only allow lifecycle updates'));
    }
  }
  next();
});

['updateOne', 'updateMany', 'findOneAndUpdate'].forEach((hook) => {
  priceChangeAuditSchema.pre(hook, function preventNonLifecycleMutation(next) {
    try {
      assertLifecycleOnly(this.getUpdate() || {});
      next();
    } catch (error) {
      next(error);
    }
  });
});

['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'replaceOne']
  .forEach((hook) => priceChangeAuditSchema.pre(hook, function preventDeletion(next) {
    next(new Error('Price change audits cannot be deleted or replaced'));
  }));

module.exports = mongoose.model('PriceChangeAudit', priceChangeAuditSchema);

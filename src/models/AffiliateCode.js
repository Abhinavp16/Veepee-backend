const mongoose = require('mongoose');

const discountRuleSchema = new mongoose.Schema({
    minPurchaseAmount: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
    },
    discountType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage',
    },
    discountValue: {
        type: Number,
        required: true,
        min: 0,
    },
    maxDiscountAmount: {
        type: Number,
        min: 0,
    },
}, { _id: false });

const affiliateCodeSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        required: [true, 'Affiliate code is required'],
        trim: true,
        uppercase: true,
    },
    personName: {
        type: String,
        required: [true, 'Person name is required'],
        trim: true,
    },
    discountType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage',
    },
    discountValue: {
        type: Number,
        required: [true, 'Discount value is required'],
        min: 0,
    },
    usageLimit: {
        type: Number,
        default: 0,
    },
    usageCount: {
        type: Number,
        default: 0,
    },
    totalDiscountGenerated: {
        type: Number,
        default: 0,
        min: 0,
    },
    totalCommissionAccrued: {
        type: Number,
        default: 0,
        min: 0,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    startDate: {
        type: Date,
        default: Date.now,
    },
    endDate: {
        type: Date,
    },
    discountRules: {
        type: [discountRuleSchema],
        default: [],
    },
}, {
    timestamps: true,
});

// Index for faster lookups
affiliateCodeSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model('AffiliateCode', affiliateCodeSchema);

const mongoose = require('mongoose');

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
    }
}, {
    timestamps: true,
});

// Index for faster lookups
affiliateCodeSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model('AffiliateCode', affiliateCodeSchema);

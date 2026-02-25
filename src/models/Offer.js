const mongoose = require('mongoose');
const { USER_ROLES } = require('../utils/constants');

const offerSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true,
    },
    description: {
        type: String,
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
    code: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        uppercase: true,
    },
    targetGroup: {
        type: String,
        enum: [USER_ROLES.BUYER, USER_ROLES.WHOLESALER, 'all'],
        default: 'all',
    },
    startDate: {
        type: Date,
        default: Date.now,
    },
    endDate: {
        type: Date,
    },
    imageUrl: {
        type: String,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    minPurchaseAmount: {
        type: Number,
        default: 0,
    },
    maxDiscountAmount: {
        type: Number,
    },
    usageCount: {
        type: Number,
        default: 0,
    }
}, {
    timestamps: true,
});

// Indexes for faster lookups
offerSchema.index({ targetGroup: 1, isActive: 1 });
offerSchema.index({ code: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Offer', offerSchema);

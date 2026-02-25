const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Customer name is required'],
        trim: true,
    },
    role: {
        type: String,
        required: [true, 'Customer role/location is required'],
        trim: true,
    },
    review: {
        type: String,
        required: [true, 'Review content is required'],
        trim: true,
    },
    rating: {
        type: Number,
        required: [true, 'Rating is required'],
        min: 1,
        max: 5,
        default: 5,
    },
    isActive: {
        type: Boolean,
        default: true,
    }
}, {
    timestamps: true,
});

reviewSchema.index({ isActive: 1 });

module.exports = mongoose.model('Review', reviewSchema);

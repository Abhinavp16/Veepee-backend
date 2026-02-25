const { Review } = require('../../models');
const { AppError } = require('../../utils/errors');

// Create Review
exports.createReview = async (req, res, next) => {
    try {
        const review = await Review.create(req.body);

        res.status(201).json({
            success: true,
            data: {
                review,
            },
        });
    } catch (error) {
        next(error);
    }
};

// Get All Reviews (Admin)
exports.getAllReviews = async (req, res, next) => {
    try {
        const reviews = await Review.find().sort('-createdAt');

        res.status(200).json({
            success: true,
            results: reviews.length,
            data: {
                reviews,
            },
        });
    } catch (error) {
        next(error);
    }
};

// Get Single Review
exports.getReview = async (req, res, next) => {
    try {
        const review = await Review.findById(req.params.id);

        if (!review) {
            throw new AppError('No review found with that ID', 404);
        }

        res.status(200).json({
            success: true,
            data: {
                review,
            },
        });
    } catch (error) {
        next(error);
    }
};

// Update Review
exports.updateReview = async (req, res, next) => {
    try {
        const review = await Review.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });

        if (!review) {
            throw new AppError('No review found with that ID', 404);
        }

        res.status(200).json({
            success: true,
            data: {
                review,
            },
        });
    } catch (error) {
        next(error);
    }
};

// Delete Review
exports.deleteReview = async (req, res, next) => {
    try {
        const review = await Review.findByIdAndDelete(req.params.id);

        if (!review) {
            throw new AppError('No review found with that ID', 404);
        }

        res.status(204).json({
            success: true,
            data: null,
        });
    } catch (error) {
        next(error);
    }
};

// Get All Active Reviews (Public)
exports.getActiveReviews = async (req, res, next) => {
    try {
        const reviews = await Review.find({ isActive: true }).sort('-createdAt');

        res.status(200).json({
            success: true,
            results: reviews.length,
            data: {
                reviews,
            },
        });
    } catch (error) {
        next(error);
    }
};

const { Review } = require('../../models');
const { AppError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

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
        const { rating, productId, search } = req.query;
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);

        const query = {};
        if (rating) query.rating = parseInt(rating);
        if (productId) query.productId = productId;
        if (search) {
            query.$or = [
                { comment: { $regex: search, $options: 'i' } },
                { 'userSnapshot.name': { $regex: search, $options: 'i' } },
            ];
        }

        const [reviews, total] = await Promise.all([
            Review.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Review.countDocuments(query),
        ]);

        res.status(200).json({
            success: true,
            ...formatPaginationResponse(reviews, total, page, limit),
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

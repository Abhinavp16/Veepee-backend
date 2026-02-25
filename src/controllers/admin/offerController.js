const { Offer } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

exports.getOffers = async (req, res, next) => {
    try {
        const { targetGroup, isActive, search } = req.query;
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);

        const query = {};
        if (targetGroup) query.targetGroup = targetGroup;
        if (isActive !== undefined) query.isActive = isActive === 'true';
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { code: { $regex: search, $options: 'i' } },
            ];
        }

        const [offers, total] = await Promise.all([
            Offer.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Offer.countDocuments(query),
        ]);

        res.json({
            success: true,
            ...formatPaginationResponse(offers, total, page, limit),
        });
    } catch (error) {
        next(error);
    }
};

exports.getOfferById = async (req, res, next) => {
    try {
        const offer = await Offer.findById(req.params.id);
        if (!offer) {
            throw new NotFoundError('Offer not found', 'OFFER_NOT_FOUND');
        }

        res.json({
            success: true,
            data: offer,
        });
    } catch (error) {
        next(error);
    }
};

exports.createOffer = async (req, res, next) => {
    try {
        const offerData = { ...req.body };

        // Basic validation for dates
        if (offerData.startDate && offerData.endDate) {
            if (new Date(offerData.startDate) > new Date(offerData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        const offer = await Offer.create(offerData);

        res.status(201).json({
            success: true,
            message: 'Offer created successfully',
            data: offer,
        });
    } catch (error) {
        // Handle duplicate code error
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new BadRequestError('Offer code already exists', 'DUPLICATE_CODE'));
        }
        next(error);
    }
};

exports.updateOffer = async (req, res, next) => {
    try {
        const offer = await Offer.findById(req.params.id);
        if (!offer) {
            throw new NotFoundError('Offer not found', 'OFFER_NOT_FOUND');
        }

        const updateData = { ...req.body };

        if (updateData.startDate && updateData.endDate) {
            if (new Date(updateData.startDate) > new Date(updateData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        Object.assign(offer, updateData);
        await offer.save();

        res.json({
            success: true,
            message: 'Offer updated successfully',
            data: offer,
        });
    } catch (error) {
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new BadRequestError('Offer code already exists', 'DUPLICATE_CODE'));
        }
        next(error);
    }
};

exports.deleteOffer = async (req, res, next) => {
    try {
        const offer = await Offer.findById(req.params.id);
        if (!offer) {
            throw new NotFoundError('Offer not found', 'OFFER_NOT_FOUND');
        }

        await Offer.findByIdAndDelete(req.params.id);

        res.json({
            success: true,
            message: 'Offer deleted successfully',
        });
    } catch (error) {
        next(error);
    }
};

exports.toggleOfferStatus = async (req, res, next) => {
    try {
        const offer = await Offer.findById(req.params.id);
        if (!offer) {
            throw new NotFoundError('Offer not found', 'OFFER_NOT_FOUND');
        }

        offer.isActive = !offer.isActive;
        await offer.save();

        res.json({
            success: true,
            message: `Offer ${offer.isActive ? 'activated' : 'deactivated'} successfully`,
            data: offer,
        });
    } catch (error) {
        next(error);
    }
};

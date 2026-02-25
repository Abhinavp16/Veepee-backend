const { AffiliateCode } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

exports.getAffiliateCodes = async (req, res, next) => {
    try {
        const { isActive, search } = req.query;
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);

        const query = {};
        if (isActive !== undefined) query.isActive = isActive === 'true';
        if (search) {
            query.$or = [
                { personName: { $regex: search, $options: 'i' } },
                { code: { $regex: search, $options: 'i' } },
            ];
        }

        const [codes, total] = await Promise.all([
            AffiliateCode.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            AffiliateCode.countDocuments(query),
        ]);

        res.json({
            success: true,
            ...formatPaginationResponse(codes, total, page, limit),
        });
    } catch (error) {
        next(error);
    }
};

exports.getAffiliateCodeById = async (req, res, next) => {
    try {
        const code = await AffiliateCode.findById(req.params.id);
        if (!code) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        res.json({
            success: true,
            data: code,
        });
    } catch (error) {
        next(error);
    }
};

exports.createAffiliateCode = async (req, res, next) => {
    try {
        const codeData = { ...req.body };

        if (codeData.startDate && codeData.endDate) {
            if (new Date(codeData.startDate) > new Date(codeData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        const code = await AffiliateCode.create(codeData);

        res.status(201).json({
            success: true,
            message: 'Affiliate code created successfully',
            data: code,
        });
    } catch (error) {
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new BadRequestError('Affiliate code already exists', 'DUPLICATE_CODE'));
        }
        next(error);
    }
};

exports.updateAffiliateCode = async (req, res, next) => {
    try {
        const code = await AffiliateCode.findById(req.params.id);
        if (!code) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        const updateData = { ...req.body };

        if (updateData.startDate && updateData.endDate) {
            if (new Date(updateData.startDate) > new Date(updateData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        Object.assign(code, updateData);
        await code.save();

        res.json({
            success: true,
            message: 'Affiliate code updated successfully',
            data: code,
        });
    } catch (error) {
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new BadRequestError('Affiliate code already exists', 'DUPLICATE_CODE'));
        }
        next(error);
    }
};

exports.deleteAffiliateCode = async (req, res, next) => {
    try {
        const code = await AffiliateCode.findById(req.params.id);
        if (!code) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        await AffiliateCode.findByIdAndDelete(req.params.id);

        res.json({
            success: true,
            message: 'Affiliate code deleted successfully',
        });
    } catch (error) {
        next(error);
    }
};

exports.toggleAffiliateCodeStatus = async (req, res, next) => {
    try {
        const code = await AffiliateCode.findById(req.params.id);
        if (!code) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        code.isActive = !code.isActive;
        await code.save();

        res.json({
            success: true,
            message: `Affiliate code ${code.isActive ? 'activated' : 'deactivated'} successfully`,
            data: code,
        });
    } catch (error) {
        next(error);
    }
};

exports.getAffiliateCodeUsage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const affiliateCode = await AffiliateCode.findById(id);
        if (!affiliateCode) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        const { Order } = require('../../models');
        const usages = await Order.find({ affiliateCode: affiliateCode.code })
            .select('orderNumber customerSnapshot total createdAt status')
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            success: true,
            data: usages,
        });
    } catch (error) {
        next(error);
    }
};

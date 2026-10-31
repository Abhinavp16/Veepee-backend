const { AffiliateCode, AffiliateCommission, Order, Offer } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

// Typed text is matched as text ("[" or "+" no longer break a search).
const textPattern = (value) => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// Orders placed with this code (by id, or by its text for older orders).
const ordersWithCode = (code) => ({ $or: [{ affiliateCodeId: code._id }, { affiliateCode: code.code }] });

// One code text means one thing at checkout.
const assertNotOfferCode = async (code) => {
    if (code && await Offer.exists({ code: String(code).trim().toUpperCase() })) {
        throw new BadRequestError('An offer already uses this code', 'CODE_USED_BY_OFFER');
    }
};

const normalizeDiscountRules = (rules = []) => {
    if (!Array.isArray(rules)) return [];
    return rules
        .map((rule) => ({
            minPurchaseAmount: Number(rule?.minPurchaseAmount || 0),
            discountType: rule?.discountType === 'fixed' ? 'fixed' : 'percentage',
            discountValue: Number(rule?.discountValue || 0),
            maxDiscountAmount: rule?.maxDiscountAmount === null || rule?.maxDiscountAmount === undefined || rule?.maxDiscountAmount === ''
                ? undefined
                : Number(rule.maxDiscountAmount),
        }))
        .filter((rule) => rule.discountValue >= 0 && rule.minPurchaseAmount >= 0)
        .sort((a, b) => a.minPurchaseAmount - b.minPurchaseAmount);
};

const applyPrimaryDiscountFields = (data) => {
    const rules = normalizeDiscountRules(data.discountRules);
    if (rules.length > 0) {
        const firstRule = rules[0];
        data.discountRules = rules;
        data.discountType = firstRule.discountType;
        data.discountValue = firstRule.discountValue;
        return;
    }

    data.discountRules = [];
};

exports.getAffiliateCodes = async (req, res, next) => {
    try {
        const { isActive, search } = req.query;
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);

        const query = {};
        if (isActive !== undefined) query.isActive = isActive === 'true';
        if (search) {
            query.$or = [{ personName: textPattern(search) }, { code: textPattern(search) }];
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
        applyPrimaryDiscountFields(codeData);

        if (codeData.startDate && codeData.endDate) {
            if (new Date(codeData.startDate) > new Date(codeData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        await assertNotOfferCode(codeData.code);
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
        if (Object.prototype.hasOwnProperty.call(updateData, 'discountRules')) {
            applyPrimaryDiscountFields(updateData);
        }

        if (updateData.startDate && updateData.endDate) {
            if (new Date(updateData.startDate) > new Date(updateData.endDate)) {
                throw new BadRequestError('Start date cannot be after end date', 'INVALID_DATES');
            }
        }

        if (updateData.code && String(updateData.code).toUpperCase() !== code.code) {
            // Orders and commissions refer to it by this text.
            if (await Order.exists(ordersWithCode(code))) {
                throw new BadRequestError('This code has orders, so it can\'t be renamed. Create a new code instead.', 'AFFILIATE_CODE_IN_USE');
            }
            await assertNotOfferCode(updateData.code);
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

        // Its orders and commissions still need it: turn it off instead.
        if (await Order.exists(ordersWithCode(code))) {
            throw new BadRequestError('This code has orders, so it can\'t be deleted. Turn it off instead.', 'AFFILIATE_CODE_IN_USE');
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

        const usages = await Order.find(ordersWithCode(affiliateCode))
            .select('orderNumber customerSnapshot total createdAt status discount commissionAmount')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        const commissions = new Map((await AffiliateCommission.find({ orderId: { $in: usages.map((u) => u._id) } })
            .select('orderId status commissionAmount').lean()).map((c) => [String(c.orderId), c]));

        res.json({
            success: true,
            data: usages.map((usage) => {
                const commission = commissions.get(String(usage._id));
                return {
                    ...usage,
                    discount: usage.discount || 0,
                    commissionAmount: commission?.commissionAmount || 0,
                    commissionStatus: commission?.status || null,
                };
            }),
        });
    } catch (error) {
        next(error);
    }
};

exports.getAffiliateCodeCommissions = async (req, res, next) => {
    try {
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);
        const affiliateCode = await AffiliateCode.findById(req.params.id);
        if (!affiliateCode) {
            throw new NotFoundError('Affiliate code not found', 'AFFILIATE_CODE_NOT_FOUND');
        }

        const query = { affiliateCodeId: affiliateCode._id };
        const [rows, total] = await Promise.all([
            AffiliateCommission.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            AffiliateCommission.countDocuments(query),
        ]);

        res.json({
            success: true,
            ...formatPaginationResponse(rows, total, page, limit),
        });
    } catch (error) {
        next(error);
    }
};

// Filters shared by the commission list and its CSV export.
const commissionQuery = (params) => {
    const { affiliateCode, status, search, from, to } = params;
    const query = {};
    if (affiliateCode) query.affiliateCode = affiliateCode.toString().trim().toUpperCase();
    if (['unpaid', 'paid', 'reversed'].includes(status)) query.status = status;
    if (search) {
        query.$or = [
            { affiliateCode: textPattern(search) },
            { personNameSnapshot: textPattern(search) },
            { orderNumber: textPattern(search) },
        ];
    }
    if (from || to) {
        query.createdAt = {};
        if (from && !Number.isNaN(Date.parse(from))) query.createdAt.$gte = new Date(from);
        if (to && !Number.isNaN(Date.parse(to))) query.createdAt.$lte = new Date(to);
    }
    return query;
};

exports.getAffiliateCommissions = async (req, res, next) => {
    try {
        const { page, limit, skip } = paginate(req.query.page, req.query.limit);
        const query = commissionQuery(req.query);

        const [rows, total] = await Promise.all([
            AffiliateCommission.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            AffiliateCommission.countDocuments(query),
        ]);

        res.json({
            success: true,
            ...formatPaginationResponse(rows, total, page, limit),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /admin/affiliate-summary: totals over every code (the page used to add
 * up only the first page of codes), and commissions by status.
 */
exports.getAffiliateSummary = async (req, res, next) => {
    try {
        const [codes, byStatus] = await Promise.all([
            AffiliateCode.aggregate([{ $group: {
                _id: null,
                codes: { $sum: 1 },
                active: { $sum: { $cond: ['$isActive', 1, 0] } },
                uses: { $sum: '$usageCount' },
                discountGiven: { $sum: '$totalDiscountGenerated' },
            } }]),
            AffiliateCommission.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$commissionAmount' } } }]),
        ]);
        const status = (name) => {
            const row = byStatus.find((r) => r._id === name);
            return { count: row?.count || 0, amount: Number((row?.amount || 0).toFixed(2)) };
        };
        const reversedPaid = await AffiliateCommission.aggregate([
            { $match: { status: 'reversed', wasPaidBeforeReversal: true } },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$commissionAmount' } } },
        ]);
        res.json({
            success: true,
            data: {
                codes: codes[0]?.codes || 0,
                activeCodes: codes[0]?.active || 0,
                uses: codes[0]?.uses || 0,
                discountGiven: Number((codes[0]?.discountGiven || 0).toFixed(2)),
                pending: status('unpaid'),
                paid: status('paid'),
                reversed: status('reversed'),
                // Paid, then the order was cancelled: to recover from the affiliate.
                toRecover: { count: reversedPaid[0]?.count || 0, amount: Number((reversedPaid[0]?.amount || 0).toFixed(2)) },
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /admin/affiliate-commissions/pay { ids, reference, note }: marks
 * pending commissions as paid (the payout itself happens outside, by UPI or
 * bank transfer). Ones already paid or reversed are left as they are.
 */
exports.markCommissionsPaid = async (req, res, next) => {
    try {
        const ids = [...new Set(req.body.ids.map(String))];
        const result = await AffiliateCommission.updateMany(
            { _id: { $in: ids }, status: 'unpaid' },
            {
                $set: {
                    status: 'paid',
                    paidAt: new Date(),
                    paidBy: req.user._id,
                    paidByName: req.user.name || '',
                    payoutReference: String(req.body.reference || '').trim(),
                    payoutNote: String(req.body.note || '').trim(),
                },
            }
        );
        res.json({
            success: true,
            message: `${result.modifiedCount} commission${result.modifiedCount === 1 ? '' : 's'} marked paid`,
            data: { paid: result.modifiedCount, skipped: ids.length - result.modifiedCount },
        });
    } catch (error) {
        next(error);
    }
};

const csvCell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    // Quoted; a leading = + - @ is neutralised so a spreadsheet doesn't run it.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
};
const dateCell = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

/** GET /admin/affiliate-commissions/export (same filters as the list) as CSV. */
exports.exportAffiliateCommissions = async (req, res, next) => {
    try {
        const rows = await AffiliateCommission.find(commissionQuery(req.query)).sort({ createdAt: -1 }).limit(10000).lean();
        const header = ['Date', 'Order', 'Code', 'Affiliate', 'Discount given', 'Commission', 'Status', 'Paid on', 'Payout reference', 'Reversed on', 'Reversal reason'];
        const lines = rows.map((r) => [
            dateCell(r.createdAt), r.orderNumber, r.affiliateCode, r.personNameSnapshot,
            r.discountAmount, r.commissionAmount,
            r.status === 'unpaid' ? 'Pending' : r.status === 'paid' ? 'Paid' : (r.wasPaidBeforeReversal ? 'Reversed (was paid)' : 'Reversed'),
            dateCell(r.paidAt), r.payoutReference, dateCell(r.reversedAt), r.reversalReason,
        ].map(csvCell).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="affiliate-commissions-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(`\uFEFF${[header.map(csvCell).join(','), ...lines].join('\n')}`);
    } catch (error) {
        next(error);
    }
};

const { Negotiation, User } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { NEGOTIATION_STATUS, NEGOTIATION_ACTIONS } = require('../../utils/constants');

exports.getNegotiations = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};
    if (status) query.status = status;

    let negotiations = await Negotiation.find(query)
      .populate('wholesalerId', 'name email phone businessInfo.businessName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Negotiation.countDocuments(query);

    const formatted = negotiations.map(n => ({
      id: n._id,
      negotiationNumber: n.negotiationNumber,
      wholesaler: {
        id: n.wholesalerId._id,
        name: n.wholesalerId.name,
        email: n.wholesalerId.email,
        phone: n.wholesalerId.phone,
        businessName: n.wholesalerId.businessInfo?.businessName,
      },
      product: {
        id: n.productId,
        name: n.productSnapshot.name,
        price: n.productSnapshot.price,
        image: n.productSnapshot.image,
      },
      requestedQuantity: n.requestedQuantity,
      requestedPricePerUnit: n.requestedPricePerUnit,
      requestedTotalPrice: n.requestedTotalPrice,
      currentPricePerUnit: n.currentPricePerUnit,
      currentTotalPrice: n.currentTotalPrice,
      status: n.status,
      currentOfferBy: n.currentOfferBy,
      expiresAt: n.expiresAt,
      createdAt: n.createdAt,
    }));

    res.json({
      success: true,
      ...formatPaginationResponse(formatted, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getNegotiationById = async (req, res, next) => {
  try {
    const negotiation = await Negotiation.findById(req.params.id)
      .populate('wholesalerId', 'name email phone businessInfo');

    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    res.json({
      success: true,
      data: negotiation,
    });
  } catch (error) {
    next(error);
  }
};

exports.acceptNegotiation = async (req, res, next) => {
  try {
    const { message } = req.body;

    const negotiation = await Negotiation.findById(req.params.id);
    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    if (negotiation.status !== NEGOTIATION_STATUS.PENDING) {
      throw new BadRequestError('Cannot accept in current status', 'INVALID_NEGOTIATION_STATUS');
    }

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.ACCEPTED,
      by: 'admin',
      pricePerUnit: negotiation.currentPricePerUnit,
      totalPrice: negotiation.currentTotalPrice,
      message,
    });

    negotiation.status = NEGOTIATION_STATUS.ACCEPTED;
    negotiation.finalPricePerUnit = negotiation.currentPricePerUnit;
    negotiation.finalTotalPrice = negotiation.currentTotalPrice;

    await negotiation.save();

    // TODO: Send notification to wholesaler

    res.json({
      success: true,
      message: 'Negotiation accepted',
      data: {
        status: negotiation.status,
        finalPricePerUnit: negotiation.finalPricePerUnit,
        finalTotalPrice: negotiation.finalTotalPrice,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.rejectNegotiation = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const negotiation = await Negotiation.findById(req.params.id);
    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    if ([NEGOTIATION_STATUS.REJECTED, NEGOTIATION_STATUS.CONVERTED, NEGOTIATION_STATUS.ACCEPTED].includes(negotiation.status)) {
      throw new BadRequestError('Cannot reject in current status', 'INVALID_NEGOTIATION_STATUS');
    }

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.REJECTED,
      by: 'admin',
      message: reason,
    });

    negotiation.status = NEGOTIATION_STATUS.REJECTED;
    await negotiation.save();

    // TODO: Send notification to wholesaler

    res.json({
      success: true,
      message: 'Negotiation rejected',
    });
  } catch (error) {
    next(error);
  }
};

exports.counterNegotiation = async (req, res, next) => {
  try {
    const { pricePerUnit, message } = req.body;

    const negotiation = await Negotiation.findById(req.params.id);
    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    if (![NEGOTIATION_STATUS.PENDING, NEGOTIATION_STATUS.COUNTERED].includes(negotiation.status)) {
      throw new BadRequestError('Cannot counter in current status', 'INVALID_NEGOTIATION_STATUS');
    }

    const totalPrice = negotiation.requestedQuantity * pricePerUnit;

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.COUNTERED,
      by: 'admin',
      pricePerUnit,
      totalPrice,
      message,
    });

    negotiation.status = NEGOTIATION_STATUS.COUNTERED;
    negotiation.currentOfferBy = 'admin';
    negotiation.currentPricePerUnit = pricePerUnit;
    negotiation.currentTotalPrice = totalPrice;

    await negotiation.save();

    // TODO: Send notification to wholesaler

    res.json({
      success: true,
      message: 'Counter offer sent',
      data: {
        status: negotiation.status,
        currentPricePerUnit: negotiation.currentPricePerUnit,
        currentTotalPrice: negotiation.currentTotalPrice,
      },
    });
  } catch (error) {
    next(error);
  }
};

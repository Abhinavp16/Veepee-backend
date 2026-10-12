const { Negotiation, Product, Settings } = require('../models');
const { NotFoundError, BadRequestError, ForbiddenError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { NEGOTIATION_STATUS, NEGOTIATION_ACTIONS, USER_ROLES } = require('../utils/constants');
const { loadDiscountContext, priceFor } = require('../services/productPricingService');
const { assertPurchasable } = require('../utils/productAvailability');
const { assertQuantityAllowed } = require('../utils/quantityRules');
const { notifyTeam } = require('../services/adminNotificationService');
const requirementService = require('../services/requirementGroupService');

exports.getMyNegotiations = async (req, res, next) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = { wholesalerId: req.user._id };
    if (status) query.status = status;

    const [negotiations, total] = await Promise.all([
      Negotiation.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Negotiation.countDocuments(query),
    ]);

    const formatted = negotiations.map(n => ({
      id: n._id,
      negotiationNumber: n.negotiationNumber,
      product: {
        id: n.productId,
        name: n.productSnapshot.name,
        image: n.productSnapshot.image,
        currentPrice: n.productSnapshot.price,
      },
      requestGroup: n.requestGroup?.id ? { id: n.requestGroup.id, number: n.requestGroup.number } : null,
      requestedQuantity: n.requestedQuantity,
      requestedPricePerUnit: n.requestedPricePerUnit,
      requestedTotalPrice: n.requestedTotalPrice,
      currentPricePerUnit: n.currentPricePerUnit,
      currentTotalPrice: n.currentTotalPrice,
      status: n.status,
      currentOfferBy: n.currentOfferBy,
      expiresAt: n.expiresAt,
      // A requirement is paid for as a whole, not line by line.
      canPay: n.status === NEGOTIATION_STATUS.ACCEPTED && !n.orderId && !n.requestGroup?.id,
      orderId: n.orderId || null,
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

exports.createNegotiation = async (req, res, next) => {
  try {
    const { productId, quantity, pricePerUnit, message } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    assertPurchasable(product);
    if (!product.negotiationEnabled) {
      throw new BadRequestError('Negotiation is not enabled for this product', 'NEGOTIATION_DISABLED');
    }
    assertQuantityAllowed(product, quantity, USER_ROLES.WHOLESALER);
    const ctx = await loadDiscountContext([product]);

    const settings = await Settings.getSettings();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + settings.negotiationExpiryDays);

    const totalPrice = quantity * pricePerUnit;

    const negotiation = await Negotiation.create({
      wholesalerId: req.user._id,
      productId,
      productSnapshot: {
        name: product.name,
        price: priceFor(product, USER_ROLES.WHOLESALER, ctx).price,
        image: product.primaryImage,
        sku: product.sku,
      },
      requestedQuantity: quantity,
      requestedPricePerUnit: pricePerUnit,
      requestedTotalPrice: totalPrice,
      message,
      history: [{
        action: NEGOTIATION_ACTIONS.REQUESTED,
        by: 'wholesaler',
        pricePerUnit,
        totalPrice,
        message: message || 'Initial request',
      }],
      currentOfferBy: 'wholesaler',
      currentPricePerUnit: pricePerUnit,
      currentTotalPrice: totalPrice,
      expiresAt,
    });

    await Product.findByIdAndUpdate(productId, { $inc: { negotiationCount: 1 } });

    notifyTeam({
      type: 'new_negotiation',
      title: 'New negotiation request',
      body: `${req.user.name} asked for ${quantity} × ${product.name} at ₹${pricePerUnit} each.`,
      link: '/negotiations',
      data: { negotiationId: negotiation._id },
    });

    res.status(201).json({
      success: true,
      message: 'Negotiation request submitted',
      data: {
        id: negotiation._id,
        negotiationNumber: negotiation.negotiationNumber,
        status: negotiation.status,
        expiresAt: negotiation.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getNegotiationById = async (req, res, next) => {
  try {
    const negotiation = await Negotiation.findOne({
      _id: req.params.id,
      wholesalerId: req.user._id,
    });

    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    const data = negotiation.toObject();
    data.canPay = negotiation.status === NEGOTIATION_STATUS.ACCEPTED && !negotiation.orderId && !negotiation.requestGroup?.id;

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

exports.counterOffer = async (req, res, next) => {
  try {
    const { pricePerUnit, message } = req.body;

    const negotiation = await Negotiation.findOne({
      _id: req.params.id,
      wholesalerId: req.user._id,
    });

    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    if (negotiation.status !== NEGOTIATION_STATUS.COUNTERED) {
      throw new BadRequestError('Cannot counter in current status', 'INVALID_NEGOTIATION_STATUS');
    }

    if (negotiation.currentOfferBy !== 'admin') {
      throw new BadRequestError('Waiting for admin response', 'WAITING_FOR_ADMIN');
    }

    const totalPrice = negotiation.requestedQuantity * pricePerUnit;

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.COUNTERED,
      by: 'wholesaler',
      pricePerUnit,
      totalPrice,
      message,
    });

    negotiation.status = NEGOTIATION_STATUS.PENDING;
    negotiation.currentOfferBy = 'wholesaler';
    negotiation.currentPricePerUnit = pricePerUnit;
    negotiation.currentTotalPrice = totalPrice;

    await negotiation.save();

    // TODO: Notify admin

    res.json({
      success: true,
      message: 'Counter offer submitted',
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

exports.acceptOffer = async (req, res, next) => {
  try {
    const negotiation = await Negotiation.findOne({
      _id: req.params.id,
      wholesalerId: req.user._id,
    });

    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    // Only the dealer's counter can be accepted. Accepting your own pending
    // offer would close the deal at a price the dealer never agreed to.
    if (negotiation.status !== NEGOTIATION_STATUS.COUNTERED || negotiation.currentOfferBy !== 'admin') {
      throw new BadRequestError('There is no dealer offer to accept', 'INVALID_NEGOTIATION_STATUS');
    }

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.ACCEPTED,
      by: 'wholesaler',
      pricePerUnit: negotiation.currentPricePerUnit,
      totalPrice: negotiation.currentTotalPrice,
    });

    negotiation.status = NEGOTIATION_STATUS.ACCEPTED;
    negotiation.finalPricePerUnit = negotiation.currentPricePerUnit;
    negotiation.finalTotalPrice = negotiation.currentTotalPrice;

    await negotiation.save();

    res.json({
      success: true,
      message: 'Offer accepted. You can now proceed to payment.',
      data: {
        negotiationId: negotiation._id,
        finalPricePerUnit: negotiation.finalPricePerUnit,
        finalTotalPrice: negotiation.finalTotalPrice,
        canPay: true,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.rejectNegotiation = async (req, res, next) => {
  try {
    const negotiation = await Negotiation.findOne({
      _id: req.params.id,
      wholesalerId: req.user._id,
    });

    if (!negotiation) {
      throw new NotFoundError('Negotiation not found', 'NEGOTIATION_NOT_FOUND');
    }

    if ([NEGOTIATION_STATUS.REJECTED, NEGOTIATION_STATUS.CONVERTED].includes(negotiation.status)) {
      throw new BadRequestError('Cannot reject in current status', 'INVALID_NEGOTIATION_STATUS');
    }

    negotiation.history.push({
      action: NEGOTIATION_ACTIONS.REJECTED,
      by: 'wholesaler',
    });

    negotiation.status = NEGOTIATION_STATUS.REJECTED;
    await negotiation.save();

    res.json({
      success: true,
      message: 'Negotiation cancelled',
    });
  } catch (error) {
    next(error);
  }
};

// ---- Requirements (several products sent together) -----------------------

const groupPayload = (members, summary) => ({
  requestGroup: { id: members[0].requestGroup.id, number: members[0].requestGroup.number },
  ...summary,
  createdAt: members[0].createdAt,
  expiresAt: members[0].expiresAt,
  items: members.map((n) => ({
    id: n._id,
    negotiationNumber: n.negotiationNumber,
    product: { id: n.productId, name: n.productSnapshot.name, image: n.productSnapshot.image, currentPrice: n.productSnapshot.price },
    quantity: n.requestedQuantity,
    requestedPricePerUnit: n.requestedPricePerUnit,
    currentPricePerUnit: n.currentPricePerUnit,
    currentTotalPrice: n.currentTotalPrice,
    status: n.status,
    currentOfferBy: n.currentOfferBy,
    orderId: n.orderId || null,
  })),
});

exports.createFromCart = async (req, res, next) => {
  try {
    const { requestGroup, negotiations } = await requirementService.createRequirementFromCart({
      user: req.user,
      message: req.body.message,
      offers: req.body.offers,
    });
    res.status(201).json({
      success: true,
      message: requestGroup ? 'Requirement submitted' : 'Negotiation request submitted',
      data: {
        requestGroup,
        negotiationIds: negotiations.map((n) => n._id),
        productCount: negotiations.length,
        expiresAt: negotiations[0].expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getGroup = async (req, res, next) => {
  try {
    const members = await requirementService.loadGroup(req.params.groupId, { wholesalerId: req.user._id });
    res.json({ success: true, data: groupPayload(members, requirementService.summarizeGroup(members)) });
  } catch (error) {
    next(error);
  }
};

exports.respondToGroup = (action) => async (req, res, next) => {
  try {
    const { members, summary } = await requirementService.respondAsWholesaler({
      user: req.user,
      groupId: req.params.groupId,
      action,
    });
    res.json({
      success: true,
      message: action === 'accept' ? 'Offer accepted. You can now pay for the requirement.' : 'Requirement declined',
      data: groupPayload(members, summary),
    });
  } catch (error) {
    next(error);
  }
};

exports.groupPayload = groupPayload;

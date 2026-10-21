const mongoose = require('mongoose');
const { Order, Product, Negotiation, User, Analytics, Payment, LeadContact } = require('../../models');
const { BadRequestError } = require('../../utils/errors');
const { ORDER_STATUS, PAYMENT_STATUS, NEGOTIATION_STATUS, PRODUCT_STATUS, USER_ROLES, ANALYTICS_EVENTS, PAID_ORDER_STATUSES } = require('../../utils/constants');

exports.getDashboardStats = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      totalOrders,
      pendingPayments,
      totalRevenue,
      activeNegotiations,
      todayOrders,
      todayRevenue,
      monthOrders,
      monthRevenue,
      lowStockProducts,
      totalProducts,
      totalCustomers,
    ] = await Promise.all([
      Order.countDocuments(),
      Payment.countDocuments({ status: PAYMENT_STATUS.PENDING }),
      Order.aggregate([
        { $match: { status: { $in: PAID_ORDER_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Negotiation.countDocuments({ status: { $in: [NEGOTIATION_STATUS.PENDING, NEGOTIATION_STATUS.COUNTERED] } }),
      Order.countDocuments({ createdAt: { $gte: today } }),
      // Paid revenue from today's orders (not orders still awaiting payment).
      Order.aggregate([
        { $match: { createdAt: { $gte: today }, status: { $in: PAID_ORDER_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Order.countDocuments({ createdAt: { $gte: thisMonthStart } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: thisMonthStart }, status: { $in: PAID_ORDER_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Product.countDocuments({ status: PRODUCT_STATUS.ACTIVE, $expr: { $lte: ['$stock', '$lowStockThreshold'] }, stock: { $gt: 0 } }),
      Product.countDocuments({ status: PRODUCT_STATUS.ACTIVE }),
      // Same rule as the Customers page: every account that isn't deleted.
      User.countDocuments({ role: { $in: [USER_ROLES.BUYER, USER_ROLES.WHOLESALER] }, deletedAt: null }),
    ]);

    // Staff don't see money figures (Analytics is admin-only too).
    const showRevenue = req.user.role === USER_ROLES.ADMIN;
    const money = (rows) => (showRevenue ? rows[0]?.total || 0 : null);

    res.json({
      success: true,
      data: {
        showRevenue,
        overview: {
          totalOrders,
          pendingPayments,
          totalRevenue: money(totalRevenue),
          activeNegotiations,
          totalProducts,
          totalCustomers,
        },
        today: {
          orders: todayOrders,
          revenue: money(todayRevenue),
        },
        thisMonth: {
          orders: monthOrders,
          revenue: money(monthRevenue),
        },
        alerts: {
          lowStockProducts,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductAnalytics = async (req, res, next) => {
  try {
    const { period = '30d', sortBy = 'views' } = req.query;

    const daysMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = daysMap[period] || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const products = await Product.aggregate([
      { $match: { status: PRODUCT_STATUS.ACTIVE } },
      {
        $lookup: {
          from: 'analytics',
          let: { productId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$productId', '$$productId'] },
                timestamp: { $gte: startDate },
              },
            },
            { $group: { _id: '$eventType', count: { $sum: 1 } } },
          ],
          as: 'analytics',
        },
      },
      {
        $lookup: {
          from: 'orders',
          let: { productId: '$_id' },
          pipeline: [
            { $unwind: '$items' },
            {
              $match: {
                $expr: { $eq: ['$items.productId', '$$productId'] },
                createdAt: { $gte: startDate },
                status: { $in: [ORDER_STATUS.PAYMENT_VERIFIED, ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED] },
              },
            },
            { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$items.totalPrice' } } },
          ],
          as: 'orderStats',
        },
      },
      {
        $project: {
          productId: '$_id',
          name: 1,
          sku: 1,
          stock: 1,
          price: 1,
          views: {
            $ifNull: [
              { $arrayElemAt: [{ $filter: { input: '$analytics', cond: { $eq: ['$$this._id', 'view'] } } }, 0] },
              { count: 0 },
            ],
          },
          cartAdds: {
            $ifNull: [
              { $arrayElemAt: [{ $filter: { input: '$analytics', cond: { $eq: ['$$this._id', 'cart_add'] } } }, 0] },
              { count: 0 },
            ],
          },
          orders: { $ifNull: [{ $arrayElemAt: ['$orderStats.orders', 0] }, 0] },
          revenue: { $ifNull: [{ $arrayElemAt: ['$orderStats.revenue', 0] }, 0] },
        },
      },
      {
        $addFields: {
          views: '$views.count',
          cartAdds: '$cartAdds.count',
          conversionRate: {
            $cond: [
              { $gt: ['$views.count', 0] },
              { $multiply: [{ $divide: ['$orders', '$views.count'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { [sortBy === 'orders' ? 'orders' : sortBy === 'revenue' ? 'revenue' : 'views']: -1 } },
      { $limit: 20 },
    ]);

    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

exports.getSalesAnalytics = async (req, res, next) => {
  try {
    const { period = 'all', groupBy = 'month' } = req.query;

    const daysMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = daysMap[period];
    const startDate = days ? new Date() : null;
    if (startDate) startDate.setDate(startDate.getDate() - days);

    const salesStatuses = PAID_ORDER_STATUSES;
    const salesMatch = {
      status: { $in: salesStatuses },
      ...(startDate ? { createdAt: { $gte: startDate } } : {}),
    };

    const dateFormat = groupBy === 'month' ? '%Y-%m' : groupBy === 'week' ? '%Y-W%V' : '%Y-%m-%d';

    const [summary, timeline, byCategory] = await Promise.all([
      Order.aggregate([
        { $match: salesMatch },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            avgOrderValue: { $avg: '$total' },
          },
        },
      ]),
      Order.aggregate([
        { $match: salesMatch },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
            orders: { $sum: 1 },
            revenue: { $sum: '$total' },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { date: '$_id', orders: 1, revenue: 1, _id: 0 } },
      ]),
      Order.aggregate([
        { $match: salesMatch },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.productId',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: '$product' },
        {
          $group: {
            _id: '$product.category',
            orders: { $sum: 1 },
            revenue: { $sum: '$items.totalPrice' },
          },
        },
        // Show the category's name, not its slug.
        { $lookup: { from: 'categories', localField: '_id', foreignField: 'slug', pipeline: [{ $project: { name: 1 } }], as: 'categoryDoc' } },
        { $project: { category: { $ifNull: [{ $arrayElemAt: ['$categoryDoc.name', 0] }, '$_id'] }, orders: 1, revenue: 1, _id: 0 } },
        { $sort: { revenue: -1 } },
      ]),
    ]);

    const orderTypeCounts = await Order.aggregate([
      { $match: salesMatch },
      { $group: { _id: '$orderType', count: { $sum: 1 } } },
    ]);

    const retailOrders = orderTypeCounts.find(o => o._id === 'retail')?.count || 0;
    const wholesaleOrders = orderTypeCounts.find(o => o._id === 'wholesale')?.count || 0;

    // Change vs the same length of time just before (none for "all time").
    let revenueChangePercent = null;
    if (startDate) {
      const previousStart = new Date(startDate.getTime() - days * 86400000);
      const [previous] = await Order.aggregate([
        { $match: { status: { $in: salesStatuses }, createdAt: { $gte: previousStart, $lt: startDate } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]);
      const previousRevenue = previous?.total || 0;
      const currentRevenue = summary[0]?.totalRevenue || 0;
      if (previousRevenue > 0) {
        revenueChangePercent = Math.round(((currentRevenue - previousRevenue) / previousRevenue) * 1000) / 10;
      }
    }

    // Paid orders per 100 product views in the same period.
    const productViews = await Analytics.countDocuments({
      eventType: ANALYTICS_EVENTS.VIEW,
      ...(startDate ? { timestamp: { $gte: startDate } } : {}),
    });
    const totalOrdersInPeriod = summary[0]?.totalOrders || 0;
    const conversionRate = productViews > 0
      ? Math.round((totalOrdersInPeriod / productViews) * 1000) / 10
      : null;

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: summary[0]?.totalRevenue || 0,
          totalOrders: summary[0]?.totalOrders || 0,
          averageOrderValue: Math.round(summary[0]?.avgOrderValue || 0),
          retailOrders,
          wholesaleOrders,
          revenueChangePercent,
          conversionRate,
          productViews,
        },
        timeline,
        byCategory,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Interest from views and time on the product page: Hot 2, Warm 1, else 0.
const INTEREST_RANK = {
  $switch: {
    branches: [
      { case: { $or: [{ $gte: ['$viewCount', 5] }, { $gte: ['$watchSeconds', 120] }] }, then: 2 },
      { case: { $or: [{ $gte: ['$viewCount', 3] }, { $gte: ['$watchSeconds', 45] }] }, then: 1 },
    ],
    default: 0,
  },
};
const interestName = (rank) => ({
  $switch: { branches: [{ case: { $eq: [rank, 2] }, then: 'Hot' }, { case: { $eq: [rank, 1] }, then: 'Warm' }], default: 'Browsing' },
});
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getPotentialCustomers = async (req, res, next) => {
  try {
    const { period = '7d', page = 1, limit = 30 } = req.query;
    const daysMap = { '3d': 3, '7d': 7, '14d': 14, '30d': 30 };
    const days = daysMap[period] || 7;
    let startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // One row per person + product, or one row per person with their
    // products inside (groupBy=person).
    const byPerson = req.query.groupBy === 'person';

    // Filters: at least this many views, last viewed between two times, and
    // the order (most views first, or most recently viewed first).
    const toDate = (value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');
    const minViews = Math.max(parseInt(req.query.minViews, 10) || 1, 1);
    const minProducts = Math.max(parseInt(req.query.minProducts, 10) || 1, 1);
    const lastViewedFrom = toDate(req.query.lastViewedFrom);
    const lastViewedTo = toDate(req.query.lastViewedTo);
    const search = text(req.query.search);
    const role = [USER_ROLES.BUYER, USER_ROLES.WHOLESALER].includes(req.query.role) ? req.query.role : null;
    const interestMatch = { hot: 2, warm: 1, high: { $gte: 1 } }[req.query.interest];
    // "To contact" (default) or "Contacted": leads the team already messaged.
    // A person is contacted once all their products are.
    const view = req.query.view === 'contacted' ? 'contacted' : 'todo';
    const sortStage = view === 'contacted'
      ? { 'contact.lastContactAt': -1, lastViewed: -1 }
      : {
        recent: { lastViewed: -1, viewCount: -1 },
        views: { viewCount: -1, watchSeconds: -1, lastViewed: -1 },
        watch: { watchSeconds: -1, lastViewed: -1 },
        products: { productCount: -1, lastViewed: -1 },
      }[req.query.sort] || (byPerson ? { lastViewed: -1, viewCount: -1 } : { viewCount: -1, watchSeconds: -1, lastViewed: -1 });
    if (!byPerson) delete sortStage.productCount;
    // A last-viewed date before the period still finds those views.
    if (lastViewedFrom && lastViewedFrom < startDate) startDate = lastViewedFrom;

    // Only some products: by name or SKU, category or brand.
    const productQuery = {};
    const productText = text(req.query.product);
    if (productText) {
      const pattern = new RegExp(escapeRegex(productText), 'i');
      productQuery.$or = [{ name: pattern }, { sku: pattern }];
    }
    if (mongoose.Types.ObjectId.isValid(req.query.categoryId)) productQuery.categoryIds = new mongoose.Types.ObjectId(req.query.categoryId);
    if (mongoose.Types.ObjectId.isValid(req.query.companyId)) productQuery.company = new mongoose.Types.ObjectId(req.query.companyId);
    const productIds = Object.keys(productQuery).length ? await Product.find(productQuery).distinct('_id') : null;

    // Someone becomes a lead 5 minutes after viewing without adding to cart.
    const LEAD_WAIT_MS = 5 * 60 * 1000;
    const latestLeadView = new Date(Date.now() - LEAD_WAIT_MS);
    const lastViewedMatch = {
      $lte: lastViewedTo && lastViewedTo < latestLeadView ? lastViewedTo : latestLeadView,
      ...(lastViewedFrom && { $gte: lastViewedFrom }),
    };
    const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * pageLimit;

    const leadStages = [
      {
        $match: {
          eventType: { $in: [ANALYTICS_EVENTS.VIEW, ANALYTICS_EVENTS.WATCH] },
          userId: { $ne: null },
          timestamp: { $gte: startDate },
          ...(productIds && { productId: { $in: productIds } }),
        },
      },
      // One row per person + product: views, latest view and time spent.
      {
        $group: {
          _id: { userId: '$userId', productId: '$productId' },
          viewCount: { $sum: { $cond: [{ $eq: ['$eventType', ANALYTICS_EVENTS.VIEW] }, 1, 0] } },
          lastViewed: { $max: { $cond: [{ $eq: ['$eventType', ANALYTICS_EVENTS.VIEW] }, '$timestamp', null] } },
          watchSeconds: { $sum: { $ifNull: ['$watchSeconds', 0] } },
        },
      },
      // Views older than the wait (time to add to cart first), within the
      // chosen last-viewed range and with enough views.
      {
        $match: {
          lastViewed: lastViewedMatch,
          viewCount: { $gte: minViews },
        },
      },
      // Leave out people who added it to the cart or bought it since.
      {
        $lookup: {
          from: 'analytics',
          let: { uid: '$_id.userId', pid: '$_id.productId', viewTime: '$lastViewed' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$uid'] },
                    { $eq: ['$productId', '$$pid'] },
                    { $in: ['$eventType', [ANALYTICS_EVENTS.CART_ADD, ANALYTICS_EVENTS.PURCHASE]] },
                    { $gte: ['$timestamp', '$$viewTime'] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'conversions',
        },
      },
      { $match: { conversions: { $size: 0 } } },
      // Messaged by the team within this period: "Contacted".
      {
        $lookup: {
          from: 'leadcontacts',
          let: { uid: '$_id.userId', pid: '$_id.productId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$uid'] },
                    { $eq: ['$productId', '$$pid'] },
                    { $gte: ['$lastContactAt', startDate] },
                  ],
                },
              },
            },
            { $project: { _id: 0, lastContactAt: 1, lastContactByName: 1, contactCount: 1 } },
          ],
          as: 'contacts',
        },
      },
      {
        $addFields: {
          contact: { $arrayElemAt: ['$contacts', 0] },
          isContacted: { $gt: [{ $size: '$contacts' }, 0] },
          interestRank: INTEREST_RANK,
        },
      },
      // The person: search by name, phone or business, and customer type.
      {
        $lookup: {
          from: 'users',
          localField: '_id.userId',
          foreignField: '_id',
          pipeline: [
            {
              $project: {
                _id: 0,
                name: 1,
                email: 1,
                phone: 1,
                role: 1,
                businessName: '$businessInfo.businessName',
                city: { $arrayElemAt: ['$savedAddresses.city', 0] },
              },
            },
          ],
          as: 'user',
        },
      },
      { $unwind: '$user' },
      ...(role ? [{ $match: { 'user.role': role } }] : []),
      ...(search
        ? [{
          $match: {
            $or: ['user.name', 'user.phone', 'user.businessName'].map((field) => ({ [field]: new RegExp(escapeRegex(search), 'i') })),
          },
        }]
        : []),
      {
        $lookup: {
          from: 'products',
          localField: '_id.productId',
          foreignField: '_id',
          pipeline: [
            {
              $project: {
                _id: 0,
                name: 1,
                sku: 1,
                slug: 1,
                price: '$retailPrice',
                image: { $arrayElemAt: ['$images.url', 0] },
              },
            },
          ],
          as: 'product',
        },
      },
      { $unwind: '$product' },
    ];

    const leadFields = {
      viewCount: 1,
      lastViewed: 1,
      watchSeconds: 1,
      contact: 1,
      isContacted: 1,
      interest: interestName('$interestRank'),
      product: 1,
    };

    let pipeline;
    if (byPerson) {
      pipeline = [
        ...leadStages,
        // Their most interesting products first.
        { $sort: { interestRank: -1, viewCount: -1, lastViewed: -1 } },
        {
          $group: {
            _id: '$_id.userId',
            user: { $first: '$user' },
            productCount: { $sum: 1 },
            viewCount: { $sum: '$viewCount' },
            watchSeconds: { $sum: '$watchSeconds' },
            lastViewed: { $max: '$lastViewed' },
            interestRank: { $max: '$interestRank' },
            contactedCount: { $sum: { $cond: ['$isContacted', 1, 0] } },
            lastContactAt: { $max: '$contact.lastContactAt' },
            products: {
              $push: {
                productId: '$_id.productId',
                viewCount: '$viewCount',
                lastViewed: '$lastViewed',
                watchSeconds: '$watchSeconds',
                contact: '$contact',
                isContacted: '$isContacted',
                interest: interestName('$interestRank'),
                product: '$product',
              },
            },
          },
        },
        {
          $addFields: {
            isContacted: { $eq: ['$contactedCount', '$productCount'] },
            contact: { lastContactAt: '$lastContactAt' },
          },
        },
        {
          $match: {
            productCount: { $gte: minProducts },
            ...(interestMatch !== undefined && { interestRank: interestMatch }),
          },
        },
        {
          $facet: {
            counts: [{ $group: { _id: '$isContacted', count: { $sum: 1 } } }],
            summary: [
              { $match: { isContacted: view === 'contacted' } },
              {
                $group: {
                  _id: null,
                  people: { $sum: 1 },
                  hotPeople: { $sum: { $cond: [{ $eq: ['$interestRank', 2] }, 1, 0] } },
                  products: { $push: '$products.productId' },
                },
              },
              {
                $project: {
                  _id: 0,
                  people: 1,
                  hotPeople: 1,
                  products: { $size: { $reduce: { input: '$products', initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } } },
                },
              },
            ],
            data: [
              { $match: { isContacted: view === 'contacted' } },
              { $sort: sortStage },
              { $skip: skip },
              { $limit: pageLimit },
              {
                $project: {
                  _id: 0,
                  userId: '$_id',
                  user: 1,
                  productCount: 1,
                  viewCount: 1,
                  watchSeconds: 1,
                  lastViewed: 1,
                  contactedCount: 1,
                  lastContactAt: 1,
                  interest: interestName('$interestRank'),
                  products: 1,
                },
              },
            ],
          },
        },
      ];
    } else {
      pipeline = [
        ...leadStages,
        ...(interestMatch !== undefined ? [{ $match: { interestRank: interestMatch } }] : []),
        {
          $facet: {
            counts: [{ $group: { _id: '$isContacted', count: { $sum: 1 } } }],
            summary: [
              { $match: { isContacted: view === 'contacted' } },
              {
                $group: {
                  _id: null,
                  people: { $addToSet: '$_id.userId' },
                  hotPeople: { $addToSet: { $cond: [{ $eq: ['$interestRank', 2] }, '$_id.userId', '$$REMOVE'] } },
                  products: { $addToSet: '$_id.productId' },
                },
              },
              { $project: { _id: 0, people: { $size: '$people' }, hotPeople: { $size: '$hotPeople' }, products: { $size: '$products' } } },
            ],
            data: [
              { $match: { isContacted: view === 'contacted' } },
              { $sort: sortStage },
              { $skip: skip },
              { $limit: pageLimit },
              {
                $project: {
                  _id: 0,
                  userId: '$_id.userId',
                  productId: '$_id.productId',
                  user: 1,
                  ...leadFields,
                },
              },
            ],
          },
        },
      ];
    }

    const results = await Analytics.aggregate(pipeline);

    const data = results[0]?.data || [];
    const counts = { todo: 0, contacted: 0 };
    for (const row of results[0]?.counts || []) {
      counts[row._id ? 'contacted' : 'todo'] = row.count;
    }
    const summary = results[0]?.summary?.[0] || { people: 0, hotPeople: 0, products: 0 };
    const total = counts[view];

    res.json({
      success: true,
      data: {
        ...(byPerson ? { people: data } : { potentialCustomers: data }),
        counts,
        summary,
        pagination: {
          page: Math.max(parseInt(page, 10) || 1, 1),
          limit: pageLimit,
          total,
          pages: Math.ceil(total / pageLimit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// The team messaged these leads (person + product): they move to "Contacted".
exports.markLeadsContacted = async (req, res, next) => {
  try {
    const leads = (Array.isArray(req.body?.leads) ? req.body.leads : [])
      .filter((lead) => mongoose.Types.ObjectId.isValid(lead?.userId) && mongoose.Types.ObjectId.isValid(lead?.productId))
      .slice(0, 200);
    if (leads.length === 0) throw new BadRequestError('No leads to mark', 'NO_LEADS');
    const now = new Date();
    await LeadContact.bulkWrite(leads.map((lead) => ({
      updateOne: {
        filter: { userId: lead.userId, productId: lead.productId },
        update: {
          $set: { lastContactAt: now, lastContactById: req.user._id, lastContactByName: req.user.name || '' },
          $setOnInsert: { firstContactAt: now },
          $inc: { contactCount: 1 },
        },
        upsert: true,
      },
    })));
    res.json({ success: true, message: `${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} moved to Contacted`, data: { marked: leads.length } });
  } catch (error) {
    next(error);
  }
};

// Undo: the lead goes back to "To contact".
exports.unmarkLeadContacted = async (req, res, next) => {
  try {
    const { userId, productId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(productId)) {
      throw new BadRequestError('Invalid lead', 'INVALID_LEAD');
    }
    await LeadContact.deleteOne({ userId, productId });
    res.json({ success: true, message: 'Moved back to To contact' });
  } catch (error) {
    next(error);
  }
};

exports.getDemandInsights = async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const highDemandProducts = await Product.aggregate([
      { $match: { stock: 0, status: PRODUCT_STATUS.ACTIVE } },
      {
        $lookup: {
          from: 'analytics',
          let: { productId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$productId', '$$productId'] },
                timestamp: { $gte: sevenDaysAgo },
                eventType: 'view',
              },
            },
            { $count: 'views' },
          ],
          as: 'recentViews',
        },
      },
      {
        $lookup: {
          from: 'negotiations',
          let: { productId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$productId', '$$productId'] },
                createdAt: { $gte: sevenDaysAgo },
              },
            },
            { $count: 'negotiations' },
          ],
          as: 'recentNegotiations',
        },
      },
      {
        $addFields: {
          recentViews: { $ifNull: [{ $arrayElemAt: ['$recentViews.views', 0] }, 0] },
          recentNegotiations: { $ifNull: [{ $arrayElemAt: ['$recentNegotiations.negotiations', 0] }, 0] },
        },
      },
      {
        $match: {
          $or: [
            { recentViews: { $gte: 50 } },
            { recentNegotiations: { $gte: 3 } },
          ],
        },
      },
      {
        $project: {
          productId: '$_id',
          name: 1,
          sku: 1,
          stock: 1,
          recentViews: 1,
          recentNegotiations: 1,
          alert: { $literal: 'High demand detected - restock recommended' },
        },
      },
    ]);

    const lowStockAlerts = await Product.find({
      status: PRODUCT_STATUS.ACTIVE,
      stock: { $gt: 0 },
      $expr: { $lte: ['$stock', '$lowStockThreshold'] },
    })
      .select('name sku stock lowStockThreshold')
      .limit(10)
      .lean();

    const trendingProducts = await Analytics.aggregate([
      { $match: { timestamp: { $gte: sevenDaysAgo }, eventType: 'view' } },
      { $group: { _id: '$productId', views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
      {
        $project: {
          productId: '$_id',
          name: '$product.name',
          views: 1,
          stock: '$product.stock',
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        highDemandProducts,
        lowStockAlerts,
        trendingProducts,
      },
    });
  } catch (error) {
    next(error);
  }
};

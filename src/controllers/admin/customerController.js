const { User, Order, Negotiation } = require('../../models');
const { NotFoundError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

exports.getCustomers = async (req, res, next) => {
  try {
    const { role, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = { role: { $ne: 'admin' } };
    if (role) query.role = role;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { 'businessInfo.businessName': { $regex: search, $options: 'i' } },
      ];
    }

    const [customers, total] = await Promise.all([
      User.find(query)
        .select('-fcmTokens')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(customers, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerById = async (req, res, next) => {
  try {
    const customer = await User.findById(req.params.id).select('-fcmTokens');

    if (!customer || customer.role === 'admin') {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }

    const [orderStats, negotiationStats] = await Promise.all([
      Order.aggregate([
        { $match: { userId: customer._id } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalSpent: { $sum: '$total' },
          },
        },
      ]),
      Negotiation.aggregate([
        { $match: { wholesalerId: customer._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const recentOrders = await Order.find({ userId: customer._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('orderNumber total status createdAt');

    res.json({
      success: true,
      data: {
        ...customer,
        stats: {
          orders: orderStats[0] || { totalOrders: 0, totalSpent: 0 },
          negotiations: negotiationStats.reduce((acc, n) => {
            acc[n._id] = n.count;
            return acc;
          }, {}),
        },
        recentOrders,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.upgradeCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const customer = await User.findById(id);

    if (!customer || customer.role === 'admin') {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }

    if (action === 'accept') {
      customer.role = 'wholesaler';
      if (customer.businessInfo) {
        customer.businessInfo.verified = true;
        customer.businessInfo.verifiedAt = new Date();
      }
    } else if (action === 'reject') {
      if (customer.businessInfo) {
        customer.businessInfo.verified = false;
        // Optionally clear the businessName to mark as rejected and hide from pending list
        customer.businessInfo.businessName = null;
      }
    }

    await customer.save();

    if (customer.fcmTokens && customer.fcmTokens.length > 0) {
      const { getMessaging } = require('../../config/firebase');
      const messaging = getMessaging();
      if (messaging) {
        const payload = {
          notification: {
            title: action === 'accept' ? 'Account Upgraded! 🎉' : 'Application Update',
            body: action === 'accept' 
              ? 'Your wholesaler account has been approved. Enjoy bulk access!' 
              : 'Your wholesaler application has been reviewed.',
          },
          data: {
            type: 'ROLE_UPDATED',
            action: action
          },
          tokens: customer.fcmTokens,
        };
        try {
          await messaging.sendEachForMulticast(payload);
        } catch (fcmErr) {
          console.error('FCM Notification error:', fcmErr);
        }
      }
    }

    res.json({
      success: true,
      message: `Customer application ${action}ed successfully.`
    });
  } catch (error) {
    next(error);
  }
};


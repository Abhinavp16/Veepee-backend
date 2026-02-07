const { Product, Analytics } = require('../models');
const { NotFoundError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { PRODUCT_STATUS, ANALYTICS_EVENTS } = require('../utils/constants');

// Helper to get price based on user role
const getPriceForUser = (product, userRole) => {
  if (userRole === 'wholesaler') {
    return {
      price: product.wholesalePrice,
      mrp: product.mrp,
      retailPrice: product.retailPrice,
      wholesalePrice: product.wholesalePrice,
      minWholesaleQuantity: product.minWholesaleQuantity,
      negotiationEnabled: product.negotiationEnabled,
      canNegotiate: true,
    };
  }
  // For buyers and guests - show retail price
  return {
    price: product.retailPrice,
    mrp: product.mrp,
    canNegotiate: false,
  };
};

exports.getProducts = async (req, res, next) => {
  try {
    const { category, minPrice, maxPrice, inStock, featured, sort } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const userRole = req.user?.role || 'guest';

    const query = { status: PRODUCT_STATUS.ACTIVE };

    // Price filter based on user role
    const priceField = userRole === 'wholesaler' ? 'wholesalePrice' : 'retailPrice';
    if (category) query.category = category;
    if (minPrice) query[priceField] = { ...query[priceField], $gte: Number(minPrice) };
    if (maxPrice) query[priceField] = { ...query[priceField], $lte: Number(maxPrice) };
    if (inStock === 'true') query.stock = { $gt: 0 };
    if (featured === 'true') query.isFeatured = true;

    let sortOption = { createdAt: -1 };
    if (sort) {
      let sortField = sort.startsWith('-') ? sort.slice(1) : sort;
      // Map 'price' to appropriate field based on role
      if (sortField === 'price') sortField = priceField;
      const sortOrder = sort.startsWith('-') ? -1 : 1;
      sortOption = { [sortField]: sortOrder };
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('name slug shortDescription category mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isFeatured')
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const formattedProducts = products.map(p => {
      const pricing = getPriceForUser(p, userRole);
      return {
        id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
        isFeatured: p.isFeatured,
      };
    });

    res.json({
      success: true,
      ...formatPaginationResponse(formattedProducts, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductBySlug = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const param = req.params.slug;
    
    // Try finding by slug first, then by ID if it looks like a MongoDB ObjectId
    let product = await Product.findOne({
      slug: param,
      status: PRODUCT_STATUS.ACTIVE,
    }).lean();

    if (!product && param.match(/^[0-9a-fA-F]{24}$/)) {
      product = await Product.findOne({
        _id: param,
        status: PRODUCT_STATUS.ACTIVE,
      }).lean();
    }

    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    // Build response with role-based pricing
    const pricing = getPriceForUser(product, userRole);
    const responseData = {
      ...product,
      id: product._id,
      ...pricing,
    };

    // Remove raw price fields for non-admin users
    if (userRole !== 'admin') {
      delete responseData.retailPrice;
      delete responseData.wholesalePrice;
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};

exports.getCategories = async (req, res, next) => {
  try {
    const categories = await Product.aggregate([
      { $match: { status: PRODUCT_STATUS.ACTIVE } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          subCategories: { $addToSet: '$subCategory' },
        },
      },
      {
        $project: {
          name: '$_id',
          count: 1,
          subCategories: {
            $filter: {
              input: '$subCategories',
              cond: { $ne: ['$$this', null] },
            },
          },
        },
      },
      { $sort: { name: 1 } },
    ]);

    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    next(error);
  }
};

exports.getFeaturedProducts = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    
    const products = await Product.find({
      status: PRODUCT_STATUS.ACTIVE,
      isFeatured: true,
    })
      .select('name slug shortDescription category mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images')
      .limit(10)
      .lean();

    const formattedProducts = products.map(p => {
      const pricing = getPriceForUser(p, userRole);
      return {
        id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
      };
    });

    res.json({
      success: true,
      data: formattedProducts,
    });
  } catch (error) {
    next(error);
  }
};

exports.searchProducts = async (req, res, next) => {
  try {
    const { q } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const userRole = req.user?.role || 'guest';

    const query = {
      status: PRODUCT_STATUS.ACTIVE,
      $text: { $search: q },
    };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('name slug shortDescription category mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images')
        .sort({ score: { $meta: 'textScore' } })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const formattedProducts = products.map(p => {
      const pricing = getPriceForUser(p, userRole);
      return {
        id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
      };
    });

    res.json({
      success: true,
      ...formatPaginationResponse(formattedProducts, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.trackProductView = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { source, sessionId } = req.body;

    await Product.findByIdAndUpdate(id, { $inc: { viewCount: 1 } });

    await Analytics.create({
      productId: id,
      userId: req.user?._id || null,
      eventType: ANALYTICS_EVENTS.VIEW,
      source: source || 'direct',
      sessionId,
      deviceInfo: {
        platform: req.headers['x-platform'],
        appVersion: req.headers['x-app-version'],
      },
    });

    res.json({
      success: true,
      message: 'View tracked',
    });
  } catch (error) {
    next(error);
  }
};

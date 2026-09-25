const { Product, Analytics, WebsiteSettings, Company, Category } = require('../models');
const { NotFoundError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { PRODUCT_STATUS, ANALYTICS_EVENTS } = require('../utils/constants');
const mongoose = require('mongoose');
const { getRecursiveProductCounts } = require('./categoryController');
const {
  categoryProductCondition,
  escapeRegExp,
  getCategoryAndDescendants,
  productCategoryPopulate,
} = require('../utils/categoryHelpers');

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

const categoryResponse = (product) => ({
  categories: Array.isArray(product.categoryIds) ? product.categoryIds : [],
  primaryCategory: product.primaryCategoryId || null,
});

exports.getProducts = async (req, res, next) => {
  try {
    const {
      category,
      categorySlug,
      brand,
      minPrice,
      maxPrice,
      inStock,
      featured,
      isFeatured,
      isHot,
      sort,
    } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const userRole = req.user?.role || 'guest';

    console.log('getProducts request - category:', category, 'brand:', brand);

    const query = { status: PRODUCT_STATUS.ACTIVE };
    const andConditions = [];

    // Price filter based on user role
    const priceField = userRole === 'wholesaler' ? 'wholesalePrice' : 'retailPrice';
    
    const categorySlugFilter = categorySlug?.trim();
    if (categorySlugFilter) {
      const categories = await getCategoryAndDescendants(categorySlugFilter);
      andConditions.push(categoryProductCondition(categories));
    } else if (category) {
      const normalized = String(category).trim();
      const categoryDocument = await Category.findOne({
        $or: [
          { slug: normalized.toLowerCase() },
          { name: { $regex: `^${escapeRegExp(normalized)}$`, $options: 'i' } },
        ],
        isActive: true,
      }).select('_id slug').lean();
      if (categoryDocument) andConditions.push(categoryProductCondition(categoryDocument));
      else query.category = { $regex: escapeRegExp(normalized), $options: 'i' };
    }
    
    // Filter by brand (checks both product.brand and product.company)
    if (brand) {
      const matchingCompanies = await Company.find({
        name: { $regex: escapeRegExp(brand), $options: 'i' }
      }).select('_id');
      const companyIds = matchingCompanies.map(c => c._id);
      
      andConditions.push({ $or: [
        { brand: { $regex: escapeRegExp(brand), $options: 'i' } },
        { company: { $in: companyIds } }
      ] });
    }
    
    if (minPrice) query[priceField] = { ...query[priceField], $gte: Number(minPrice) };
    if (maxPrice) query[priceField] = { ...query[priceField], $lte: Number(maxPrice) };
    if (inStock === 'true') query.stock = { $gt: 0 };
    if (featured === 'true' || isFeatured === 'true') query.isFeatured = true;
    if (isHot === 'true') query.isHot = true;
    if (andConditions.length > 0) query.$and = andConditions;

    console.log('getProducts final query:', JSON.stringify(query));

    let sortOption = { createdAt: -1, _id: -1 };
    if (sort) {
      let sortField = sort.startsWith('-') ? sort.slice(1) : sort;
      // Map 'price' to appropriate field based on role
      if (sortField === 'price') sortField = priceField;
      const sortOrder = sort.startsWith('-') ? -1 : 1;
      sortOption = { [sortField]: sortOrder, _id: sortOrder };
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isFeatured isHot isNew rating purchaseCountMin purchaseCountMax company')
        .populate('company', 'name')
        .populate(productCategoryPopulate)
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
        nameHindi: p.nameHindi,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...categoryResponse(p),
        brand: p.brand || p.company?.name || '',
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
        isFeatured: p.isFeatured,
        isHot: p.isHot,
        isNew: p.isNew,
        rating: p.rating,
        purchaseCountMin: p.purchaseCountMin,
        purchaseCountMax: p.purchaseCountMax,
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

    // Try public lookup by active slug first.
    let product = await Product.findOne({
      slug: param,
      status: PRODUCT_STATUS.ACTIVE,
    }).populate(productCategoryPopulate).lean();

    // If opened from cart/order history, ID may point to a non-active product.
    // Allow ID lookup regardless of status so users can still view item details.
    if (!product && param.match(/^[0-9a-fA-F]{24}$/)) {
      product = await Product.findById(param).populate(productCategoryPopulate).lean();
    }

    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    // Build response with role-based pricing
    const pricing = getPriceForUser(product, userRole);
    let resolvedLabels = [];
    if (Array.isArray(product.labelIds) && product.labelIds.length > 0) {
      const settings = await WebsiteSettings.getSettings();
      const labelMap = new Map(
        (settings.labels || []).map((label) => [
          String(label?.id || ''),
          {
            id: String(label?.id || ''),
            title: String(label?.title || '').trim(),
            sourceType: label?.sourceType === 'image' ? 'image' : 'icon',
            image: String(label?.image || '').trim(),
            icon: String(label?.icon || '').trim(),
            order: Number.isFinite(label?.order) ? label.order : 0,
          },
        ])
      );

      const labelsByTitle = new Map(
        (settings.labels || []).map((label) => [
          String(label?.title || '').trim(),
          {
            id: String(label?.id || ''),
            title: String(label?.title || '').trim(),
            sourceType: label?.sourceType === 'image' ? 'image' : 'icon',
            image: String(label?.image || '').trim(),
            icon: String(label?.icon || '').trim(),
            order: Number.isFinite(label?.order) ? label.order : 0,
          },
        ])
      );

      resolvedLabels = product.labelIds
        .map((labelId) => {
          const value = String(labelId || '').trim();
          return labelMap.get(value) || labelsByTitle.get(value);
        })
        .filter(Boolean);
    }

    const responseData = {
      ...product,
      id: product._id,
      ...categoryResponse(product),
      ...pricing,
      labels: resolvedLabels,
    };

    // Remove raw price fields for non-admin users, but keep for wholesalers so they can see customer price
    if (userRole !== 'admin' && userRole !== 'wholesaler') {
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
    const categoryDocuments = await Category.find({ isActive: true })
      .select('_id name slug parent order')
      .sort({ order: 1, name: 1, _id: 1 })
      .lean();
    const counts = await getRecursiveProductCounts(categoryDocuments);
    const childrenByParent = new Map();
    categoryDocuments.forEach((category) => {
      const parent = category.parent ? String(category.parent) : null;
      childrenByParent.set(parent, [...(childrenByParent.get(parent) || []), category.slug]);
    });
    const categories = categoryDocuments.map((category) => ({
      _id: category.slug,
      categoryId: category._id,
      name: category.slug,
      displayName: category.name,
      count: counts.get(String(category._id)) || 0,
      subCategories: childrenByParent.get(String(category._id)) || [],
    }));

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
      .select('name slug shortDescription category categoryIds primaryCategoryId mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isHot isNew rating purchaseCountMin purchaseCountMax')
      .populate(productCategoryPopulate)
      .sort({ createdAt: -1, _id: -1 })
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
        ...categoryResponse(p),
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
        isHot: p.isHot,
        isNew: p.isNew,
        rating: p.rating,
        purchaseCountMin: p.purchaseCountMin,
        purchaseCountMax: p.purchaseCountMax,
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
    const { q, category, categorySlug, brand } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const userRole = req.user?.role || 'guest';

    console.log('Search request - q:', q, 'category:', category, 'brand:', brand);

    // Build base query
    const query = { status: PRODUCT_STATUS.ACTIVE };

    // Use $and if we have multiple major conditions (q, category, brand)
    const andConditions = [];

    // Search query condition
    if (q && q.trim().length > 0) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const words = escaped.trim().split(/\s+/).filter(Boolean);
      const regexPattern = words.map(w => `(?=.*${w})`).join('') + '.*';
      const regex = new RegExp(regexPattern, 'i');
      const matchingCategories = await Category.find({
        isActive: true,
        $or: [{ name: regex }, { slug: regex }],
      }).select('_id slug').lean();

      andConditions.push({
        $or: [
          { name: regex },
          { description: regex },
          { shortDescription: regex },
          { category: regex },
          { tags: { $in: [new RegExp(escaped, 'i')] } },
          { sku: regex },
          ...(matchingCategories.length > 0 ? categoryProductCondition(matchingCategories).$or : []),
        ]
      });
    }

    // Category condition
    if (categorySlug) {
      const categories = await getCategoryAndDescendants(categorySlug);
      andConditions.push(categoryProductCondition(categories));
    } else if (category) {
      const normalized = String(category).trim();
      const categoryDocument = await Category.findOne({
        isActive: true,
        $or: [
          { slug: normalized.toLowerCase() },
          { name: { $regex: `^${escapeRegExp(normalized)}$`, $options: 'i' } },
        ],
      }).select('_id slug').lean();
      if (categoryDocument) andConditions.push(categoryProductCondition(categoryDocument));
      else andConditions.push({ category: { $regex: escapeRegExp(normalized), $options: 'i' } });
    }
    
    // Brand condition (checks both product.brand and product.company)
    if (brand) {
      const matchingCompanies = await Company.find({
        name: { $regex: escapeRegExp(brand), $options: 'i' }
      }).select('_id');
      const companyIds = matchingCompanies.map(c => c._id);
      
      andConditions.push({
        $or: [
          { brand: { $regex: escapeRegExp(brand), $options: 'i' } },
          { company: { $in: companyIds } }
        ]
      });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    console.log('Final search query:', JSON.stringify(query));

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isHot isNew rating purchaseCountMin purchaseCountMax company')
        .populate('company', 'name')
        .populate(productCategoryPopulate)
        .sort({ createdAt: -1, _id: -1 })
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
        nameHindi: p.nameHindi,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...categoryResponse(p),
        brand: p.brand || p.company?.name || '',
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
        isHot: p.isHot,
        isNew: p.isNew,
        rating: p.rating,
        purchaseCountMin: p.purchaseCountMin,
        purchaseCountMax: p.purchaseCountMax,
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

exports.trackProductEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { event, source, sessionId } = req.body;

    const allowedEvents = [ANALYTICS_EVENTS.CART_ADD, ANALYTICS_EVENTS.WISHLIST_ADD, ANALYTICS_EVENTS.SHARE];
    if (!allowedEvents.includes(event)) {
      return res.status(400).json({ success: false, message: 'Invalid event type' });
    }

    await Analytics.create({
      productId: id,
      userId: req.user?._id || null,
      eventType: event,
      source: source || 'direct',
      sessionId,
      deviceInfo: {
        platform: req.headers['x-platform'],
        appVersion: req.headers['x-app-version'],
      },
    });

    res.json({ success: true, message: 'Event tracked' });
  } catch (error) {
    next(error);
  }
};

exports.updateProductNameHindi = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { nameHindi } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product id',
        code: 'INVALID_PRODUCT_ID',
      });
    }

    if (!nameHindi) {
      return res.status(400).json({ success: false, message: 'nameHindi is required' });
    }

    const product = await Product.findByIdAndUpdate(
      id,
      { nameHindi },
      { new: true, runValidators: true }
    );

    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        id: product._id,
        name: product.name,
        nameHindi: product.nameHindi,
      },
    });
  } catch (error) {
    next(error);
  }
};


exports.getRelatedProducts = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || 'guest';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);

    const isObjectId = require('mongoose').Types.ObjectId.isValid(id);
    let productQuery = { status: 'active' };
    if (isObjectId && id.length === 24) {
      productQuery._id = id;
    } else {
      productQuery.slug = id;
    }

    const currentProduct = await Product.findOne(productQuery).select('category categoryIds _id').lean();
    if (!currentProduct) return res.json({ success: true, data: [] });

    let relatedCategoryCondition;
    if (currentProduct.categoryIds?.length) {
      const categories = await Category.find({ _id: { $in: currentProduct.categoryIds } })
        .select('_id slug')
        .lean();
      relatedCategoryCondition = categoryProductCondition(categories);
    } else {
      const category = await Category.findOne({ slug: currentProduct.category }).select('_id slug').lean();
      relatedCategoryCondition = category
        ? categoryProductCondition(category)
        : { category: currentProduct.category };
    }

    const relatedProducts = await Product.find({
      status: 'active',
      ...relatedCategoryCondition,
      _id: { $ne: currentProduct._id }
    })
      .select('name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images rating isFeatured isHot isNew purchaseCountMin purchaseCountMax company')
      .populate('company', 'name')
      .populate(productCategoryPopulate)
      .sort({ isFeatured: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const formattedProducts = relatedProducts.map(p => {
      const pricing = userRole === 'wholesaler'
        ? { price: p.wholesalePrice, mrp: p.mrp, retailPrice: p.retailPrice, wholesalePrice: p.wholesalePrice, minWholesaleQuantity: p.minWholesaleQuantity }
        : { price: p.retailPrice, mrp: p.mrp };
      return {
        id: p._id,
        name: p.name,
        nameHindi: p.nameHindi,
        slug: p.slug,
        shortDescription: p.shortDescription,
        category: p.category,
        ...categoryResponse(p),
        brand: p.brand || p.company?.name || '',
        ...pricing,
        stock: p.stock,
        inStock: p.stock > 0,
        primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
        isFeatured: p.isFeatured,
        isHot: p.isHot,
        isNew: p.isNew,
        rating: p.rating,
        purchaseCountMin: p.purchaseCountMin,
        purchaseCountMax: p.purchaseCountMax,
      };
    });

    res.json({ success: true, data: formattedProducts });
  } catch (error) {
    next(error);
  }
};

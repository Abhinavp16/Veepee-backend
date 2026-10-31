const { Product, Analytics, WebsiteSettings, Company, Category, SubCategory, ProductAlert } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { PRODUCT_STATUS, ANALYTICS_EVENTS } = require('../utils/constants');
const mongoose = require('mongoose');
const { getRecursiveProductCounts } = require('./categoryController');
const {
  categoryProductCondition,
  directPlacementCondition,
  escapeRegExp,
  getCategoryAndDescendants,
  productCategoryPopulate,
} = require('../utils/categoryHelpers');
const { loadDiscountContext, pricingForUser, pendingPriceNotice } = require('../services/productPricingService');
const { shopperRole } = require('../services/guestPricing');
const { quantityRules } = require('../utils/quantityRules');
const { negotiationRulesFor } = require('../utils/negotiationRules');
const { rankProducts } = require('../services/productSearch');
const {
  isComingSoon,
  comingSoonFilter,
  notComingSoonFilter,
  comingSoonPayload,
} = require('../utils/productAvailability');

// Fields every product response needs beyond the raw document: the price the
// shopper pays, how many they may order, and any coming-soon state.
const SHOPPER_FIELDS =
  'packSize priceUnit minCustomerQuantity comingSoon expectedLaunchDate autoLaunch hidePriceWhileComingSoon pendingRetailPrice pendingWholesalePrice priceChangeScheduledAt priceChangeEffectiveAt';

const shopperBlock = (product, role, ctx, now) => {
  const pricing = pricingForUser(product, role, ctx);
  const rules = quantityRules(product, role);
  const comingSoon = comingSoonPayload(product, now);
  const block = {
    ...pricing,
    packSize: rules.packSize,
    priceUnit: product.priceUnit || 'piece',
    minQuantity: rules.min,
    quantityStep: rules.step,
    comingSoon: Boolean(comingSoon),
    expectedLaunchDate: comingSoon?.expectedLaunchDate || null,
    priceHidden: Boolean(comingSoon?.priceHidden),
  };
  if (block.priceHidden) {
    for (const key of ['price', 'mrp', 'retailPrice', 'wholesalePrice']) {
      if (key in block) block[key] = null;
    }
    block.discountPercent = 0;
  }
  // No scheduled-change notice when the price is hidden (coming soon, or a
  // visitor seeing only the MRP).
  block.pendingPriceChange = block.priceHidden || block.guestPriceHidden
    ? null
    : pendingPriceNotice(product, role, block, now);
  return block;
};

// Lists hide coming-soon products unless asked: `comingSoon=true` returns only
// those, `includeComingSoon=true` returns both.
const comingSoonListCondition = (query, now) => {
  if (isTrue(query.comingSoon)) return comingSoonFilter(now);
  if (isTrue(query.includeComingSoon)) return null;
  return notComingSoonFilter(now);
};

// Query values arrive already converted to booleans by validation, but accept
// the raw string too.
const isTrue = (value) => value === true || value === 'true';

const categoryResponse = (product) => ({
  categories: Array.isArray(product.categoryIds) ? product.categoryIds : [],
  primaryCategory: product.primaryCategoryId || null,
});

// The product fields and populates a product card needs.
const CARD_SELECT = `name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isFeatured isHot isNew company ${SHOPPER_FIELDS}`;

/** A product as it appears in lists (cards), priced for this shopper. */
const productCard = (p, userRole, ctx, now = new Date()) => ({
  id: p._id,
  name: p.name,
  nameHindi: p.nameHindi,
  slug: p.slug,
  shortDescription: p.shortDescription,
  category: p.category,
  ...categoryResponse(p),
  brand: p.brand || p.company?.name || '',
  ...shopperBlock(p, userRole, ctx, now),
  stock: p.stock,
  inStock: p.stock > 0,
  primaryImage: p.images?.find(img => img.isPrimary)?.url || p.images?.[0]?.url,
  isFeatured: p.isFeatured,
  isHot: p.isHot,
  isNew: p.isNew,
});

exports.productCard = productCard;
exports.CARD_SELECT = CARD_SELECT;

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
    const userRole = shopperRole(req);

    console.log('getProducts request - category:', category, 'brand:', brand);

    const query = { status: PRODUCT_STATUS.ACTIVE };
    const andConditions = [];

    // Price filter based on user role
    const priceField = userRole === 'wholesaler' ? 'wholesalePrice' : 'retailPrice';
    
    const categorySlugFilter = categorySlug?.trim();
    let browsedCategoryIds = null;
    let browsedCategories = null;
    if (categorySlugFilter) {
      const categories = await getCategoryAndDescendants(categorySlugFilter);
      browsedCategories = categories;
      browsedCategoryIds = categories.map((item) => item._id);
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
    
    // A sub-category: only products placed under it, inside the category
    // being browsed when there is one (a shared "Blades" under Brush Cutter
    // lists only Brush Cutter's blades).
    const subCategorySlug = String(req.query.subCategory || '').trim().toLowerCase();
    // The category's own list: products placed straight in it. Those placed
    // only under a sub-category show under its card instead.
    if (browsedCategories && !subCategorySlug) {
      andConditions.push(directPlacementCondition(browsedCategories));
    }
    if (subCategorySlug) {
      const subCategory = await SubCategory.findOne({ slug: subCategorySlug, isActive: true }).select('_id').lean();
      if (!subCategory) throw new NotFoundError('Sub-category not found', 'SUB_CATEGORY_NOT_FOUND');
      andConditions.push({
        placements: {
          $elemMatch: {
            subCategory: subCategory._id,
            ...(browsedCategoryIds ? { category: { $in: browsedCategoryIds } } : {}),
          },
        },
      });
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
    if (isTrue(inStock)) query.stock = { $gt: 0 };
    if (isTrue(featured) || isTrue(isFeatured)) query.isFeatured = true;
    if (isTrue(isHot)) query.isHot = true;
    const visibility = comingSoonListCondition(req.query, new Date());
    if (visibility) andConditions.push(visibility);
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
    // With coming-soon products included, they come after the available ones.
    if (isTrue(req.query.includeComingSoon)) sortOption = { comingSoon: 1, ...sortOption };

    // Names sort as people read them: "6N70" before "6N200", case ignored.
    const nameSort = Object.prototype.hasOwnProperty.call(sortOption, 'name');
    const [products, total] = await Promise.all([
      Product.find(query)
        .select(`name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isFeatured isHot isNew company ${SHOPPER_FIELDS}`)
        .populate('company', 'name')
        .populate(productCategoryPopulate)
        .collation(nameSort ? { locale: 'en', strength: 2, numericOrdering: true } : undefined)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const ctx = await loadDiscountContext(products);
    const now = new Date();
    const formattedProducts = products.map((p) => productCard(p, userRole, ctx, now));

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
    const userRole = shopperRole(req);
    const param = req.params.slug;

    // Try public lookup by active slug first.
    let product = await Product.findOne({
      slug: param,
      status: PRODUCT_STATUS.ACTIVE,
    }).populate(productCategoryPopulate).populate('company', 'name').lean();

    // If opened from cart/order history, ID may point to a non-active product.
    // Allow ID lookup regardless of status so users can still view item details.
    if (!product && param.match(/^[0-9a-fA-F]{24}$/)) {
      product = await Product.findById(param).populate(productCategoryPopulate).populate('company', 'name').lean();
    }

    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    // Build response with role-based pricing
    const ctx = await loadDiscountContext([product]);
    const now = new Date();
    const pricing = shopperBlock(product, userRole, ctx, now);
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

    // Not shown to shoppers: there are no product reviews yet, and the
    // "live purchases" range was made-up social proof.
    const { rating, purchaseCountMin, purchaseCountMax, ...shownProduct } = product;
    const responseData = {
      ...shownProduct,
      id: product._id,
      // Keep `company` as a plain id (unchanged contract) and expose the brand name separately.
      company: product.company?._id || null,
      brand: product.brand || product.company?.name || '',
      ...categoryResponse(product),
      ...pricing,
      labels: resolvedLabels,
    };

    if (pricing.comingSoon && req.user) {
      responseData.notifyMe = Boolean(
        await ProductAlert.exists({ userId: req.user._id, productId: product._id })
      );
    }

    // The quick picks and lowest price for a wholesaler's bulk negotiation.
    if (userRole === 'wholesaler') {
      const { Settings } = require('../models');
      responseData.negotiationRules = negotiationRulesFor(await Settings.getSettings());
    }

    // Remove raw price fields for non-admin users, but keep for wholesalers so they can see customer price
    if (userRole !== 'admin' && userRole !== 'wholesaler') {
      delete responseData.retailPrice;
      delete responseData.wholesalePrice;
    }

    // Scheduled price changes are internal until they go live; never expose them publicly.
    if (userRole !== 'admin') {
      for (const field of [
        'pendingRetailPrice',
        'pendingWholesalePrice',
        'pendingMrp',
        'priceChangeScheduledAt',
        'priceChangeEffectiveAt',
        'activePendingPriceChangeAudit',
      ]) {
        delete responseData[field];
      }
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};

const loadComingSoonProduct = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  }
  const product = await Product.findOne({ _id: id, status: PRODUCT_STATUS.ACTIVE })
    .select('status stock comingSoon expectedLaunchDate autoLaunch')
    .lean();
  if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  return product;
};

// "Notify me when available" for a coming-soon product.
exports.subscribeToLaunch = async (req, res, next) => {
  try {
    const product = await loadComingSoonProduct(req.params.id);
    if (!isComingSoon(product)) {
      throw new BadRequestError('This product is already available', 'PRODUCT_NOT_COMING_SOON');
    }
    await ProductAlert.updateOne(
      { userId: req.user._id, productId: product._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, data: { notifyMe: true } });
  } catch (error) {
    next(error);
  }
};

exports.unsubscribeFromLaunch = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }
    await ProductAlert.deleteOne({ userId: req.user._id, productId: req.params.id });
    res.json({ success: true, data: { notifyMe: false } });
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
    const userRole = shopperRole(req);

    const products = await Product.find({
      status: PRODUCT_STATUS.ACTIVE,
      isFeatured: true,
      ...notComingSoonFilter(new Date()),
    })
      .select(`name slug shortDescription category categoryIds primaryCategoryId mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isHot isNew company ${SHOPPER_FIELDS}`)
      .populate(productCategoryPopulate)
      .sort({ createdAt: -1, _id: -1 })
      .limit(10)
      .lean();

    const ctx = await loadDiscountContext(products);
    const now = new Date();
    const formattedProducts = products.map(p => {
      const pricing = shopperBlock(p, userRole, ctx, now);
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
    const userRole = shopperRole(req);
    const search = String(q || '').trim();

    // Category, brand and coming-soon filters narrow the products first;
    // the search words are then scored in code (services/productSearch).
    const andConditions = [];
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
    if (brand) {
      const companyIds = (await Company.find({
        name: { $regex: escapeRegExp(brand), $options: 'i' },
      }).select('_id').lean()).map((c) => c._id);
      andConditions.push({
        $or: [
          { brand: { $regex: escapeRegExp(brand), $options: 'i' } },
          { company: { $in: companyIds } },
        ],
      });
    }
    const visibility = comingSoonListCondition(req.query, new Date());
    if (visibility) andConditions.push(visibility);
    const query = { status: PRODUCT_STATUS.ACTIVE, ...(andConditions.length > 0 && { $and: andConditions }) };
    const comingSoonLast = isTrue(req.query.includeComingSoon);

    let pageIds;
    let total;
    let correctedQuery = null;
    if (search) {
      const [candidates, categories, subCategories] = await Promise.all([
        Product.find(query)
          .select('name nameHindi sku brand company category categoryIds primaryCategoryId placements specifications tags shortDescription description comingSoon createdAt')
          .populate('company', 'name')
          .lean(),
        Category.find({}).select('name').lean(),
        SubCategory.find({ isActive: true }).select('name').lean(),
      ]);
      const ranked = rankProducts(candidates, search, {
        categoryNames: new Map(categories.map((c) => [String(c._id), c.name])),
        subCategoryNames: new Map(subCategories.map((c) => [String(c._id), c.name])),
      }, { comingSoonLast });
      correctedQuery = ranked.correctedQuery;
      total = ranked.products.length;
      pageIds = ranked.products.slice(skip, skip + limit).map((p) => p._id);
    } else {
      const sort = comingSoonLast ? { comingSoon: 1, createdAt: -1, _id: -1 } : { createdAt: -1, _id: -1 };
      [pageIds, total] = await Promise.all([
        Product.find(query).sort(sort).skip(skip).limit(limit).select('_id').lean().then((rows) => rows.map((r) => r._id)),
        Product.countDocuments(query),
      ]);
    }

    const found = await Product.find({ _id: { $in: pageIds } })
      .select(`name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isHot isNew company ${SHOPPER_FIELDS}`)
      .populate('company', 'name')
      .populate(productCategoryPopulate)
      .lean();
    const byId = new Map(found.map((p) => [String(p._id), p]));
    const products = pageIds.map((id) => byId.get(String(id))).filter(Boolean);

    const ctx = await loadDiscountContext(products);
    const now = new Date();
    const formattedProducts = products.map(p => {
      const pricing = shopperBlock(p, userRole, ctx, now);
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
      };
    });

    res.json({
      success: true,
      ...formatPaginationResponse(formattedProducts, total, page, limit),
      // Nothing matched as typed: these are the results for this spelling.
      ...(correctedQuery && { correctedQuery }),
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

// Time a signed-in customer spent on a product page; shown on the Leads page.
// One report covers one stay, capped at 30 minutes.
const MAX_WATCH_SECONDS_PER_REPORT = 30 * 60;
exports.trackWatchTime = async (req, res, next) => {
  try {
    const seconds = Math.round(Number(req.body?.seconds));
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !Number.isFinite(seconds) || seconds < 1) {
      return res.status(400).json({ success: false, message: 'Invalid watch time' });
    }
    await Analytics.create({
      productId: req.params.id,
      userId: req.user._id,
      eventType: ANALYTICS_EVENTS.WATCH,
      watchSeconds: Math.min(seconds, MAX_WATCH_SECONDS_PER_REPORT),
      source: 'direct',
    });
    res.json({ success: true, message: 'Watch time tracked' });
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
    const userRole = shopperRole(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);

    const isObjectId = require('mongoose').Types.ObjectId.isValid(id);
    let productQuery = { status: 'active' };
    if (isObjectId && id.length === 24) {
      productQuery._id = id;
    } else {
      productQuery.slug = id;
    }

    const currentProduct = await Product.findOne(productQuery).select('category categoryIds placements _id').lean();
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

    // Products placed in a sub-category (spare parts, attachments) show under
    // Accessories, not here. A spare part's related products are the others
    // in its own sub-categories.
    const ownSubCategories = (currentProduct.placements || [])
      .map((placement) => placement.subCategory)
      .filter(Boolean);
    const placementCondition = ownSubCategories.length > 0
      ? { 'placements.subCategory': { $in: ownSubCategories } }
      : { placements: { $not: { $elemMatch: { subCategory: { $ne: null } } } } };

    const relatedProducts = await Product.find({
      status: 'active',
      $and: [
        ...(ownSubCategories.length > 0 ? [] : [relatedCategoryCondition]),
        placementCondition,
        notComingSoonFilter(new Date()),
      ],
      _id: { $ne: currentProduct._id }
    })
      .select(`name nameHindi slug shortDescription category categoryIds primaryCategoryId brand mrp retailPrice wholesalePrice minWholesaleQuantity negotiationEnabled stock images isFeatured isHot isNew company ${SHOPPER_FIELDS}`)
      .populate('company', 'name')
      .populate(productCategoryPopulate)
      .sort({ isFeatured: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const ctx = await loadDiscountContext(relatedProducts);
    const now = new Date();
    const formattedProducts = relatedProducts.map(p => {
      const pricing = shopperBlock(p, userRole, ctx, now);
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
      };
    });

    res.json({ success: true, data: formattedProducts });
  } catch (error) {
    next(error);
  }
};

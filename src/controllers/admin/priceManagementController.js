const XLSX = require('xlsx');
const { Category, Product, PriceChangeAudit } = require('../../models');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { requestPriceChange } = require('../../services/priceLifecycleService');
const { BUSINESS_TIMEZONE } = require('../../config/businessTimezone');
const { getCategoryProductSets } = require('../categoryController');
const { productCategoryPopulate } = require('../../utils/categoryHelpers');

exports.getPriceManagementConfig = (req, res) => {
  res.json({ businessTimezone: BUSINESS_TIMEZONE, customEffectiveHour: 8 });
};

exports.getCategories = async (req, res, next) => {
  try {
    const categories = await Category.find({ isActive: true })
      .sort({ order: 1, name: 1, _id: 1 })
      .lean();
    const productSets = await getCategoryProductSets(categories, { $ne: 'archived' });
    res.json({
      success: true,
      data: categories.map((category) => ({
        ...category,
        productCount: productSets.get(String(category._id))?.size || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
};

exports.createPriceChange = async (req, res, next) => {
  try {
    const result = await requestPriceChange({
      productId: req.params.id,
      prices: {
        ...(req.body.retailPrice !== undefined ? { retailPrice: req.body.retailPrice } : {}),
        ...(req.body.wholesalePrice !== undefined ? { wholesalePrice: req.body.wholesalePrice } : {}),
      },
      priceChangeMode: req.body.priceChangeMode,
      effectiveAt: req.body.effectiveAt,
      performedBy: req.user._id,
      adminName: req.user.name,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.status(result.idempotent ? 200 : 201).json({
      success: true,
      message: result.audit.status === 'applied' ? 'Price change applied' : 'Price change scheduled',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getPriceChangeHistory = async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query.page, req.query.limit || 5, 5);
    const [history, total] = await Promise.all([
      PriceChangeAudit.find({})
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PriceChangeAudit.countDocuments({}),
    ]);
    res.json({ success: true, ...formatPaginationResponse(history, total, page, limit) });
  } catch (error) {
    next(error);
  }
};

exports.exportPriceSnapshot = async (req, res, next) => {
  try {
    const products = await Product.find({ status: { $ne: 'archived' } })
      .select('name sku category categoryIds primaryCategoryId status mrp retailPrice wholesalePrice stock pendingRetailPrice pendingWholesalePrice priceChangeScheduledAt priceChangeEffectiveAt')
      .populate(productCategoryPopulate)
      .sort({ category: 1, name: 1, _id: 1 })
      .lean();
    const rows = products.map((product) => ({
      'Product Name': product.name,
      SKU: product.sku,
      Category: product.category,
      Categories: (product.categoryIds || []).map((category) => category.name || category.slug).join(', '),
      'Primary Category': product.primaryCategoryId?.name || product.category,
      Status: product.status,
      MRP: product.mrp,
      'Retail Price': product.retailPrice,
      'Wholesale Price': product.wholesalePrice,
      Stock: product.stock,
      'Pending Retail Price': product.pendingRetailPrice ?? '',
      'Pending Wholesale Price': product.pendingWholesalePrice ?? '',
      'Scheduled At': product.priceChangeScheduledAt ? new Date(product.priceChangeScheduledAt).toISOString() : '',
      'Effective At': product.priceChangeEffectiveAt ? new Date(product.priceChangeEffectiveAt).toISOString() : '',
    }));
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 32 }, { wch: 18 }, { wch: 20 }, { wch: 35 }, { wch: 22 }, { wch: 12 }, { wch: 14 },
      { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 23 }, { wch: 26 }, { wch: 26 },
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Price Snapshot');
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="price-snapshot.xlsx"');
    res.send(file);
  } catch (error) {
    next(error);
  }
};

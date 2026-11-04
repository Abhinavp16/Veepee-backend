const {
  Product,
  Category,
  SubCategory,
  Company,
  Order,
  Negotiation,
  Sale,
  Cart,
  ProductAlert,
  LeadContact,
  Analytics,
  StockLog,
} = require('../models');
const { deleteImage } = require('../config/cloudinary');
const { getStorage } = require('../config/firebase');
const { ConflictError } = require('../utils/errors');
const { ORDER_STATUS, NEGOTIATION_STATUS, PRODUCT_STATUS } = require('../utils/constants');

// Deleting from admin. A product is archived (hidden, can be restored) or
// deleted for good; categories, sub-categories and brands are deleted for
// good once no live product uses them. Archived products don't stop those:
// they are taken out of what's deleted.

// Orders still being paid for, prepared or delivered.
const OPEN_ORDER_STATUSES = [
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PAYMENT_UPLOADED,
  ORDER_STATUS.PAYMENT_VERIFIED,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.SHIPPED,
];

/** Products that are not archived: these still count as "in use". */
const notArchived = { status: { $ne: PRODUCT_STATUS.ARCHIVED } };

/**
 * Removes a stored image unless something else still shows it (the same
 * file can be picked for more than one product, category or brand).
 */
async function deleteImageIfUnused(publicId) {
  if (!publicId) return false;
  const [product, category, sub, company] = await Promise.all([
    Product.exists({ 'images.publicId': publicId }),
    Category.exists({ 'image.publicId': publicId }),
    SubCategory.exists({ 'image.publicId': publicId }),
    Company.exists({ 'logo.publicId': publicId }),
  ]);
  if (product || category || sub || company) return false;
  return deleteImage(publicId);
}

/** Why [product] can't be deleted for good right now, or null. */
async function productDeleteBlocker(product) {
  const id = product._id;
  const openOrders = await Order.countDocuments({ 'items.productId': id, status: { $in: OPEN_ORDER_STATUSES } });
  if (openOrders > 0) {
    return `It is in ${openOrders} order${openOrders === 1 ? '' : 's'} still in progress. Archive it instead, or delete it once ${openOrders === 1 ? 'that order is' : 'they are'} delivered or cancelled.`;
  }
  const openNegotiations = await Negotiation.countDocuments({
    productId: id,
    $or: [
      { status: { $in: [NEGOTIATION_STATUS.PENDING, NEGOTIATION_STATUS.COUNTERED] } },
      { status: NEGOTIATION_STATUS.ACCEPTED, orderId: null },
    ],
  });
  if (openNegotiations > 0) {
    return `It has ${openNegotiations} open price request${openNegotiations === 1 ? '' : 's'}. Answer or reject ${openNegotiations === 1 ? 'it' : 'them'} first, or archive the product instead.`;
  }
  const now = new Date();
  const sale = await Sale.findOne({
    'products.productId': id,
    endedAt: null,
    $or: [{ status: { $ne: 'published' } }, { endsAt: { $gt: now } }],
  }).select('name').lean();
  if (sale) {
    return `It is in the sale "${sale.name}". Remove it from the sale first, or archive the product instead.`;
  }
  return null;
}

/**
 * Deletes [product] for good: it, its place in carts, launch alerts, views
 * and stock history (its price-change history is kept: that can't be
 * deleted, and has its own copy of the name). Past orders and price
 * requests keep their own copy of
 * its name, price and photo, so its photos stay when it was ever ordered or
 * asked about; otherwise they are removed from storage too.
 */
async function deleteProductPermanently(product) {
  const blocker = await productDeleteBlocker(product);
  if (blocker) throw new ConflictError(`Can't delete "${product.name}" permanently. ${blocker}`, 'PRODUCT_IN_USE');

  const id = product._id;
  const [ordered, negotiated] = await Promise.all([
    Order.exists({ 'items.productId': id }),
    Negotiation.exists({ productId: id }),
  ]);
  const publicIds = (product.images || []).map((image) => image.publicId).filter(Boolean);

  await product.deleteOne();
  await Promise.all([
    Cart.updateMany({ 'items.productId': id }, { $pull: { items: { productId: id } } }),
    ProductAlert.deleteMany({ productId: id }),
    LeadContact.deleteMany({ productId: id }),
    Analytics.deleteMany({ productId: id }),
    StockLog.deleteMany({ productId: id }),
  ]);
  if (!ordered && !negotiated) {
    for (const publicId of publicIds) await deleteImageIfUnused(publicId);
  }
}

/**
 * Archived products in a category that's being deleted: the category comes
 * off them (they need a new one before they can be restored).
 */
async function detachArchivedFromCategory(categoryId) {
  const products = await Product.find({
    status: PRODUCT_STATUS.ARCHIVED,
    $or: [{ categoryIds: categoryId }, { 'placements.category': categoryId }, { primaryCategoryId: categoryId }],
  }).select('categoryIds placements primaryCategoryId');
  const gone = String(categoryId);
  for (const product of products) {
    const categoryIds = (product.categoryIds || []).filter((id) => String(id) !== gone);
    const placements = (product.placements || []).filter((p) => String(p.category) !== gone);
    const primary = product.primaryCategoryId && String(product.primaryCategoryId) !== gone
      ? product.primaryCategoryId
      : (placements[0]?.category || categoryIds[0] || null);
    await Product.updateOne(
      { _id: product._id },
      { $set: { categoryIds, placements, primaryCategoryId: primary } }
    );
  }
  return products.length;
}

/** Archived products in a sub-category being deleted stay in its category. */
function detachArchivedFromSubCategory(subCategoryId) {
  return Product.updateMany(
    { status: PRODUCT_STATUS.ARCHIVED, 'placements.subCategory': subCategoryId },
    { $set: { 'placements.$[p].subCategory': null } },
    { arrayFilters: [{ 'p.subCategory': subCategoryId }] }
  );
}

/** Archived products of a brand being deleted are left without a brand. */
function detachArchivedFromCompany(companyId) {
  return Product.updateMany(
    { status: PRODUCT_STATUS.ARCHIVED, company: companyId },
    { $set: { company: null } }
  );
}

/**
 * Banner pictures and videos (in storage under banners/, used by nothing
 * else) that were in [before] and are no longer in [after] are removed.
 */
async function deleteRemovedBannerFiles(before, after) {
  const bucket = getStorage();
  if (!bucket) return 0;
  const prefix = `https://storage.googleapis.com/${bucket.name}/banners/`;
  const files = (banners) => new Set((banners || [])
    .flatMap((banner) => [banner.imageUrl, banner.videoUrl])
    .filter((url) => typeof url === 'string' && url.startsWith(prefix)));
  const kept = files(after);
  let removed = 0;
  for (const url of files(before)) {
    if (kept.has(url)) continue;
    const path = url.slice(prefix.length - 'banners/'.length);
    if (await deleteImage(path)) removed += 1;
  }
  return removed;
}

module.exports = {
  OPEN_ORDER_STATUSES,
  notArchived,
  deleteImageIfUnused,
  productDeleteBlocker,
  deleteProductPermanently,
  detachArchivedFromCategory,
  detachArchivedFromSubCategory,
  detachArchivedFromCompany,
  deleteRemovedBannerFiles,
};

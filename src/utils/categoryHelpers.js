const mongoose = require('mongoose');
const Category = require('../models/Category');
const Company = require('../models/Company');
const { BadRequestError, NotFoundError } = require('./errors');

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toIdArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value == null ? [] : [value];

  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return trimmed.split(',');
}

function normalizeObjectIds(value, field = 'categoryIds') {
  const ids = toIdArray(value)
    .map((item) => String(item?._id || item?.id || item || '').trim())
    .filter(Boolean);

  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new BadRequestError(`${field} must contain valid category IDs`, 'INVALID_CATEGORY_IDS');
  }
  return [...new Set(ids)];
}

function legacyFallbackCondition(slugs) {
  return {
    $and: [
      { $or: [{ categoryIds: { $exists: false } }, { categoryIds: { $size: 0 } }] },
      { category: { $in: slugs } },
    ],
  };
}

function categoryProductCondition(categories) {
  const list = Array.isArray(categories) ? categories : [categories];
  const ids = list.map((category) => category?._id).filter(Boolean);
  const slugs = list.map((category) => category?.slug).filter(Boolean);
  return {
    $or: [
      { categoryIds: { $in: ids } },
      legacyFallbackCondition(slugs),
    ],
  };
}

async function getCategoryAndDescendants(slug, { activeOnly = true } = {}) {
  const normalizedSlug = String(slug || '').trim().toLowerCase();
  const root = await Category.findOne({
    slug: normalizedSlug,
    ...(activeOnly ? { isActive: true } : {}),
  }).select('_id slug parent name isActive').lean();
  if (!root) throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');

  const categories = [root];
  let parentIds = [root._id];
  while (parentIds.length > 0) {
    const children = await Category.find({
      parent: { $in: parentIds },
      ...(activeOnly ? { isActive: true } : {}),
    }).select('_id slug parent name isActive').lean();
    if (children.length === 0) break;
    categories.push(...children);
    parentIds = children.map((category) => category._id);
  }
  return categories;
}

async function getCategoryAndDescendantsById(categoryId, { activeOnly = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    throw new BadRequestError('categoryId must be a valid ID', 'INVALID_CATEGORY_ID');
  }
  const root = await Category.findOne({
    _id: categoryId,
    ...(activeOnly ? { isActive: true } : {}),
  }).select('_id slug parent name isActive').lean();
  if (!root) throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');

  const categories = [root];
  let parentIds = [root._id];
  while (parentIds.length > 0) {
    const children = await Category.find({
      parent: { $in: parentIds },
      ...(activeOnly ? { isActive: true } : {}),
    }).select('_id slug parent name isActive').lean();
    if (children.length === 0) break;
    categories.push(...children);
    parentIds = children.map((category) => category._id);
  }
  return categories;
}

async function resolveCategoryAssignment(input, existingProduct = null) {
  const categoryFieldsPresent = ['categoryIds', 'primaryCategoryId', 'category']
    .some((field) => hasOwn(input, field));
  if (!categoryFieldsPresent && existingProduct) return null;

  let ids = hasOwn(input, 'categoryIds')
    ? normalizeObjectIds(input.categoryIds)
    : normalizeObjectIds(existingProduct?.categoryIds || []);
  let primaryId = hasOwn(input, 'primaryCategoryId')
    ? String(input.primaryCategoryId || '').trim()
    : String(existingProduct?.primaryCategoryId || '').trim();

  const legacySlug = String(input.category || '').trim().toLowerCase();
  if (legacySlug && (!hasOwn(input, 'categoryIds') || !hasOwn(input, 'primaryCategoryId'))) {
    const legacyCategory = await Category.findOne({ slug: legacySlug, isActive: true })
      .select('_id slug isActive')
      .lean();
    if (!legacyCategory) {
      throw new BadRequestError('Legacy category must match an active category slug', 'INVALID_CATEGORY');
    }
    const legacyId = String(legacyCategory._id);
    if (!hasOwn(input, 'categoryIds')) ids = [legacyId];
    if (!hasOwn(input, 'primaryCategoryId')) primaryId = legacyId;
  }

  if (ids.length === 0) {
    throw new BadRequestError('At least one category is required', 'CATEGORY_REQUIRED');
  }
  if (!mongoose.Types.ObjectId.isValid(primaryId)) {
    throw new BadRequestError('primaryCategoryId is required and must be valid', 'PRIMARY_CATEGORY_REQUIRED');
  }
  if (!ids.includes(primaryId)) {
    throw new BadRequestError('primaryCategoryId must be included in categoryIds', 'PRIMARY_CATEGORY_MISMATCH');
  }

  const categories = await Category.find({ _id: { $in: ids }, isActive: true })
    .select('_id slug name isActive')
    .lean();
  if (categories.length !== ids.length) {
    throw new BadRequestError('All assigned categories must exist and be active', 'INVALID_CATEGORY_ASSIGNMENT');
  }
  const byId = new Map(categories.map((category) => [String(category._id), category]));
  const primaryCategory = byId.get(primaryId);

  return {
    categoryIds: ids,
    primaryCategoryId: primaryId,
    category: primaryCategory.slug,
    categories: ids.map((id) => byId.get(id)),
    primaryCategory,
  };
}

async function validateCompanyCategoryAssignment(input, existingProduct = null, categoryAssignment = null) {
  const suppliedCompany = hasOwn(input, 'company');
  const effectiveCompanyId = suppliedCompany ? input.company : existingProduct?.company;
  if (effectiveCompanyId === undefined || effectiveCompanyId === null || String(effectiveCompanyId).trim() === '') {
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(effectiveCompanyId)) {
    throw new BadRequestError('company must be a valid company ID', 'INVALID_COMPANY_ID');
  }

  const company = await Company.findById(effectiveCompanyId).select('_id isActive categoryIds').lean();
  if (!company) throw new BadRequestError('Assigned company does not exist', 'INVALID_COMPANY_ASSIGNMENT');

  const previousCompanyId = existingProduct?.company ? String(existingProduct.company) : null;
  const isNewAssignment = !existingProduct || (suppliedCompany && String(effectiveCompanyId) !== previousCompanyId);
  if (isNewAssignment && !company.isActive) {
    throw new BadRequestError('Assigned company must be active', 'INACTIVE_COMPANY_ASSIGNMENT');
  }

  let effectiveCategoryIds = categoryAssignment?.categoryIds?.map(String)
    || (existingProduct?.categoryIds || []).map(String);
  if (effectiveCategoryIds.length === 0 && existingProduct?.category) {
    const legacyCategory = await Category.findOne({
      slug: String(existingProduct.category).trim().toLowerCase(),
    }).select('_id').lean();
    if (legacyCategory) effectiveCategoryIds = [String(legacyCategory._id)];
  }
  if (effectiveCategoryIds.length === 0) {
    throw new BadRequestError(
      'Product categories could not be resolved for the assigned company',
      'INVALID_CATEGORY_ASSIGNMENT'
    );
  }

  const linkedIds = new Set((company.categoryIds || []).map(String));
  const unlinkedCategoryIds = effectiveCategoryIds.filter((id) => !linkedIds.has(id));
  if (unlinkedCategoryIds.length > 0) {
    const error = new BadRequestError(
      'All product categories must be linked to the assigned company',
      'COMPANY_CATEGORY_NOT_LINKED'
    );
    error.details = { companyId: String(company._id), categoryIds: unlinkedCategoryIds };
    throw error;
  }
  return company;
}

const productCategoryPopulate = [
  { path: 'categoryIds', select: 'name slug description image parent order isActive' },
  { path: 'primaryCategoryId', select: 'name slug description image parent order isActive' },
];

module.exports = {
  categoryProductCondition,
  escapeRegExp,
  getCategoryAndDescendants,
  getCategoryAndDescendantsById,
  legacyFallbackCondition,
  normalizeObjectIds,
  productCategoryPopulate,
  resolveCategoryAssignment,
  validateCompanyCategoryAssignment,
  toIdArray,
};

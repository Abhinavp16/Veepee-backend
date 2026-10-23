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

// "Where it's sold": [{ category, subCategory? }], as an array or a JSON string
// (multipart forms). Duplicates are dropped; the first entry stays first.
function normalizePlacements(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list.trim() || '[]');
    } catch (_) {
      throw new BadRequestError('placements must be a list', 'INVALID_PLACEMENTS');
    }
  }
  if (!Array.isArray(list)) throw new BadRequestError('placements must be a list', 'INVALID_PLACEMENTS');
  const seen = new Set();
  const placements = [];
  for (const item of list) {
    const category = String(item?.category?._id || item?.category || '').trim();
    const rawSub = item?.subCategory?._id || item?.subCategory;
    const subCategory = rawSub ? String(rawSub).trim() : null;
    if (!mongoose.Types.ObjectId.isValid(category) || (subCategory && !mongoose.Types.ObjectId.isValid(subCategory))) {
      throw new BadRequestError('placements must contain valid category and sub-category IDs', 'INVALID_PLACEMENTS');
    }
    const key = `${category}:${subCategory || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    placements.push({ category, subCategory });
  }
  return placements;
}

// Sub-categories in placements must exist and be shown under that category.
async function validatePlacementSubCategories(placements) {
  const SubCategory = require('../models/SubCategory');
  const subIds = [...new Set(placements.map((p) => p.subCategory).filter(Boolean))];
  if (subIds.length === 0) return;
  const subs = await SubCategory.find({ _id: { $in: subIds } }).select('_id categories').lean();
  const linksBySub = new Map(subs.map((sub) => [
    String(sub._id),
    new Set((sub.categories || []).map((link) => String(link.category))),
  ]));
  for (const placement of placements) {
    if (!placement.subCategory) continue;
    const links = linksBySub.get(placement.subCategory);
    if (!links) throw new BadRequestError('Sub-category not found', 'INVALID_SUB_CATEGORY');
    if (!links.has(placement.category)) {
      throw new BadRequestError('That sub-category is not shown under this category', 'SUB_CATEGORY_NOT_LINKED');
    }
  }
}

// Placements kept in step with a plain category list: sub-category placements
// stay while their category is still assigned; any category without one gets
// a direct placement.
function placementsForCategoryIds(ids, existing = []) {
  const kept = (existing || [])
    .map((p) => ({ category: String(p.category?._id || p.category), subCategory: p.subCategory ? String(p.subCategory?._id || p.subCategory) : null }))
    .filter((p) => ids.includes(p.category));
  const covered = new Set(kept.map((p) => p.category));
  return [...kept, ...ids.filter((id) => !covered.has(id)).map((id) => ({ category: id, subCategory: null }))];
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
  const categoryFieldsPresent = ['placements', 'categoryIds', 'primaryCategoryId', 'category']
    .some((field) => hasOwn(input, field));
  if (!categoryFieldsPresent && existingProduct) return null;

  // "Where it's sold" decides the categories: each distinct category, in
  // order, with the first as the main one unless another is chosen.
  let placements = hasOwn(input, 'placements') ? normalizePlacements(input.placements) : null;
  if (placements && placements.length === 0) {
    throw new BadRequestError('At least one category is required', 'CATEGORY_REQUIRED');
  }
  let ids = placements
    ? [...new Set(placements.map((p) => p.category))]
    : hasOwn(input, 'categoryIds')
      ? normalizeObjectIds(input.categoryIds)
      : normalizeObjectIds(existingProduct?.categoryIds || []);
  let primaryId = hasOwn(input, 'primaryCategoryId')
    ? String(input.primaryCategoryId || '').trim()
    : String(existingProduct?.primaryCategoryId || '').trim();
  // With a new "Where it's sold" list, its first row is the main category
  // (unless one is chosen explicitly).
  if (placements && (!hasOwn(input, 'primaryCategoryId') || !ids.includes(primaryId))) primaryId = ids[0];

  const legacySlug = String(input.category || '').trim().toLowerCase();
  if (legacySlug && (!hasOwn(input, 'categoryIds') || !hasOwn(input, 'primaryCategoryId'))) {
    const legacyCategory = await Category.findOne({ slug: legacySlug, isActive: true })
      .select('_id slug isActive')
      .lean();
    if (!legacyCategory) {
      throw new BadRequestError('Legacy category must match an active category slug', 'INVALID_CATEGORY');
    }
    const legacyId = String(legacyCategory._id);
    if (!placements && !hasOwn(input, 'categoryIds')) ids = [legacyId];
    if (!placements && !hasOwn(input, 'primaryCategoryId')) primaryId = legacyId;
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
  if (placements) await validatePlacementSubCategories(placements);
  else placements = placementsForCategoryIds(ids, existingProduct?.placements);
  // The main placement first.
  placements.sort((a, b) => (a.category === primaryId ? 0 : 1) - (b.category === primaryId ? 0 : 1));

  return {
    placements,
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
  normalizePlacements,
  placementsForCategoryIds,
  productCategoryPopulate,
  resolveCategoryAssignment,
  validateCompanyCategoryAssignment,
  toIdArray,
};

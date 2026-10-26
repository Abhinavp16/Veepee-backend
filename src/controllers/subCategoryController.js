const mongoose = require('mongoose');
const slugify = require('slugify');
const { Category, SubCategory, Product, Company } = require('../models');
const { PRODUCT_STATUS } = require('../utils/constants');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { escapeRegExp, getCategoryAndDescendants } = require('../utils/categoryHelpers');
const { notComingSoonFilter } = require('../utils/productAvailability');

const idOf = (value) => (value == null ? null : String(value?._id || value));

// A product's placements as plain ids.
const plainPlacements = (placements) => (placements || [])
  .map((p) => ({ category: idOf(p.category), subCategory: idOf(p.subCategory) }));

// Whether a product also shows in the category's own list (a direct
// placement), set on or off; its sub-category places stay.
function setDirect(placements, categoryId, keep) {
  const rest = placements.filter((p) => !(p.category === String(categoryId) && !p.subCategory));
  return keep ? [...rest, { category: String(categoryId), subCategory: null }] : rest;
}

// Products of a brand: by its name on the product or its linked company.
async function brandCondition(brand) {
  const name = String(brand || '').trim();
  if (!name) return null;
  const companies = await Company.find({ name: { $regex: escapeRegExp(name), $options: 'i' } }).select('_id').lean();
  return {
    $or: [
      { brand: { $regex: escapeRegExp(name), $options: 'i' } },
      { company: { $in: companies.map((company) => company._id) } },
    ],
  };
}

// How many shoppable products each sub-category has inside the given
// categories (optionally for one brand), and a product photo for cards
// without their own image. Map of subCategoryId → { count, image }.
async function placementCounts(categoryIds, subCategoryIds, brand) {
  if (subCategoryIds.length === 0) return new Map();
  const match = { status: PRODUCT_STATUS.ACTIVE, $and: [notComingSoonFilter(new Date())] };
  const byBrand = await brandCondition(brand);
  if (byBrand) match.$and.push(byBrand);
  const rows = await Product.aggregate([
    { $match: match },
    { $unwind: '$placements' },
    { $match: { 'placements.category': { $in: categoryIds }, 'placements.subCategory': { $in: subCategoryIds } } },
    { $sort: { name: 1 } },
    { $group: { _id: '$placements.subCategory', products: { $addToSet: '$_id' }, images: { $first: '$images' } } },
  ]);
  return new Map(rows.map((row) => {
    const images = row.images || [];
    const image = (images.find((item) => item.isPrimary) || images[0])?.url || null;
    return [String(row._id), { count: row.products.length, image }];
  }));
}

const shopperCard = (sub, categoryId, stats) => {
  const link = (sub.categories || []).find((item) => idOf(item.category) === categoryId);
  return {
    id: String(sub._id),
    name: sub.name,
    slug: sub.slug,
    description: sub.description || '',
    image: sub.image?.url || stats?.image || null,
    order: link?.order || 1,
    productCount: stats?.count || 0,
  };
};

/**
 * GET /sub-categories?category=brush-cutter[&brand=OXON]
 * The sub-category cards on a category page: active ones shown under that
 * category that have products there (for that brand, when given).
 */
exports.getForCategory = async (req, res, next) => {
  try {
    const slug = String(req.query.category || '').trim().toLowerCase();
    if (!slug) throw new BadRequestError('category is required', 'CATEGORY_REQUIRED');
    const categories = await getCategoryAndDescendants(slug);
    const root = categories[0];
    const categoryIds = categories.map((category) => category._id);
    const subs = await SubCategory.find({ isActive: true, 'categories.category': root._id }).lean();
    const counts = await placementCounts(categoryIds, subs.map((sub) => sub._id), req.query.brand);
    const data = subs
      .map((sub) => shopperCard(sub, String(root._id), counts.get(String(sub._id))))
      .filter((card) => card.productCount > 0)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Admin

const adminView = async (subs) => {
  const allCategoryIds = [...new Set(subs.flatMap((sub) => (sub.categories || []).map((link) => idOf(link.category))))];
  const categories = await Category.find({ _id: { $in: allCategoryIds } }).select('_id name slug isActive').lean();
  const categoryById = new Map(categories.map((category) => [String(category._id), category]));
  const rows = await Product.aggregate([
    { $unwind: '$placements' },
    { $match: { 'placements.subCategory': { $in: subs.map((sub) => sub._id) } } },
    { $group: { _id: { sub: '$placements.subCategory', category: '$placements.category' }, count: { $sum: 1 } } },
  ]);
  const countFor = new Map(rows.map((row) => [`${row._id.sub}:${row._id.category}`, row.count]));
  return subs.map((sub) => {
    const links = (sub.categories || [])
      .map((link) => {
        const category = categoryById.get(idOf(link.category));
        return category && {
          categoryId: String(category._id),
          name: category.name,
          slug: category.slug,
          isActive: category.isActive,
          order: link.order || 1,
          productCount: countFor.get(`${sub._id}:${category._id}`) || 0,
        };
      })
      .filter(Boolean);
    return {
      ...sub,
      categories: links,
      productCount: links.reduce((sum, link) => sum + link.productCount, 0),
    };
  });
};

/** GET /sub-categories/admin[?category=<id>][&search=] — every sub-category with its categories and counts. */
exports.adminList = async (req, res, next) => {
  try {
    const query = {};
    if (req.query.category) {
      if (!mongoose.Types.ObjectId.isValid(req.query.category)) throw new BadRequestError('Invalid category', 'INVALID_CATEGORY');
      query['categories.category'] = req.query.category;
    }
    if (req.query.search) query.name = { $regex: escapeRegExp(req.query.search), $options: 'i' };
    const subs = await SubCategory.find(query).sort({ name: 1 }).lean();
    let data = await adminView(subs);
    if (req.query.category) {
      data = data.sort((a, b) => {
        const order = (sub) => sub.categories.find((link) => link.categoryId === String(req.query.category))?.order || 1;
        return order(a) - order(b) || a.name.localeCompare(b.name);
      });
    }
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// The categories a sub-category shows under: valid, existing, no repeats.
// Existing links keep their position; new ones go last in their category.
async function resolveLinks(categoryIds, existing = []) {
  const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map(String))];
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new BadRequestError('categoryIds must be valid category IDs', 'INVALID_CATEGORY_IDS');
  }
  const found = await Category.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw new BadRequestError('Every category must exist', 'INVALID_CATEGORY_IDS');
  const before = new Map(existing.map((link) => [idOf(link.category), link.order || 1]));
  const links = [];
  for (const id of ids) {
    if (before.has(id)) {
      links.push({ category: id, order: before.get(id) });
    } else {
      const last = await SubCategory.find({ 'categories.category': id }).select('categories').lean();
      const max = last.reduce((top, sub) => Math.max(top, ...(sub.categories || [])
        .filter((link) => idOf(link.category) === id).map((link) => link.order || 1)), 0);
      links.push({ category: id, order: max + 1 });
    }
  }
  return links;
}

async function assertUniqueName(name, exceptId = null) {
  const duplicate = await SubCategory.findOne({
    name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('_id').lean();
  if (duplicate) throw new BadRequestError('A sub-category with this name already exists', 'DUPLICATE_SUB_CATEGORY');
  const slug = slugify(name, { lower: true, strict: true });
  if (!slug) throw new BadRequestError('Name must contain letters or numbers', 'INVALID_NAME');
}

/** POST /sub-categories — { name, description?, image?, isActive?, categoryIds[] } */
exports.create = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new BadRequestError('Name is required', 'NAME_REQUIRED');
    await assertUniqueName(name);
    const sub = await SubCategory.create({
      name,
      description: req.body.description || '',
      image: req.body.image || undefined,
      isActive: req.body.isActive !== false,
      categories: await resolveLinks(req.body.categoryIds),
    });
    const [data] = await adminView([sub.toObject()]);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PUT /sub-categories/:id — any of name, description, image, isActive, categoryIds. */
exports.update = async (req, res, next) => {
  try {
    const sub = await SubCategory.findById(req.params.id);
    if (!sub) throw new NotFoundError('Sub-category not found', 'SUB_CATEGORY_NOT_FOUND');
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) throw new BadRequestError('Name is required', 'NAME_REQUIRED');
      if (name !== sub.name) await assertUniqueName(name, sub._id);
      sub.name = name;
    }
    if (req.body.description !== undefined) sub.description = req.body.description;
    if (req.body.image !== undefined) sub.image = req.body.image;
    if (req.body.isActive !== undefined) sub.isActive = req.body.isActive === true;
    if (req.body.categoryIds !== undefined) {
      const links = await resolveLinks(req.body.categoryIds, sub.categories);
      const removed = sub.categories.map((link) => idOf(link.category)).filter((id) => !links.some((link) => idOf(link.category) === id));
      // Taking it away from a category that still has products placed there
      // would leave those products pointing at nothing.
      if (removed.length > 0) {
        const placed = await Product.countDocuments({
          placements: { $elemMatch: { subCategory: sub._id, category: { $in: removed } } },
        });
        if (placed > 0) {
          throw new BadRequestError(
            `${placed} product(s) are placed under this sub-category in a category you removed. Move them first.`,
            'SUB_CATEGORY_IN_USE'
          );
        }
      }
      sub.categories = links;
    }
    await sub.save();
    const [data] = await adminView([sub.toObject()]);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /sub-categories/:id — only when no product is placed under it. */
exports.remove = async (req, res, next) => {
  try {
    const sub = await SubCategory.findById(req.params.id);
    if (!sub) throw new NotFoundError('Sub-category not found', 'SUB_CATEGORY_NOT_FOUND');
    const placed = await Product.countDocuments({ 'placements.subCategory': sub._id });
    if (placed > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete a sub-category with ${placed} product(s). Move them first.`,
        error: { code: 'SUB_CATEGORY_IN_USE', count: placed },
      });
    }
    await sub.deleteOne();
    res.json({ success: true, message: 'Sub-category deleted' });
  } catch (error) {
    next(error);
  }
};

/** PATCH /sub-categories/reorder — { categoryId, subCategoryIds[] } in their new order inside that category. */
exports.reorder = async (req, res, next) => {
  try {
    const { categoryId, subCategoryIds } = req.body;
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw new BadRequestError('Invalid category', 'INVALID_CATEGORY');
    const ids = (Array.isArray(subCategoryIds) ? subCategoryIds : []).map(String);
    const linked = await SubCategory.find({ 'categories.category': categoryId }).select('_id').lean();
    const linkedIds = new Set(linked.map((sub) => String(sub._id)));
    if (ids.length !== linkedIds.size || ids.some((id) => !linkedIds.has(id))) {
      throw new BadRequestError('List every sub-category of this category exactly once', 'INVALID_REORDER');
    }
    await SubCategory.bulkWrite(ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, 'categories.category': categoryId },
        update: { $set: { 'categories.$.order': index + 1 } },
      },
    })));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /sub-categories/:id/products — { categoryId, productIds[], alsoInCategory? }
 * Places products as "Category › Sub-category". A product not yet in that
 * category gets it too, when its brand allows that category. They show only
 * under the sub-category unless `alsoInCategory` keeps them in the
 * category's own list as well.
 */
exports.addProducts = async (req, res, next) => {
  try {
    const { categoryId } = req.body;
    const alsoInCategory = req.body.alsoInCategory === true;
    const sub = await SubCategory.findById(req.params.id).lean();
    if (!sub) throw new NotFoundError('Sub-category not found', 'SUB_CATEGORY_NOT_FOUND');
    if (!(sub.categories || []).some((link) => idOf(link.category) === String(categoryId))) {
      throw new BadRequestError('That sub-category is not shown under this category', 'SUB_CATEGORY_NOT_LINKED');
    }
    const productIds = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : []).map(String))];
    if (productIds.length === 0 || productIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      throw new BadRequestError('productIds must be valid product IDs', 'INVALID_PRODUCT_IDS');
    }
    const products = await Product.find({ _id: { $in: productIds } })
      .select('_id name company categoryIds primaryCategoryId placements')
      .populate('company', 'name categoryIds')
      .lean();
    const added = [];
    const skipped = [];
    for (const product of products) {
      const ids = (product.categoryIds || []).map(String);
      const alreadyPlaced = (product.placements || []).some((p) => idOf(p.category) === String(categoryId) && idOf(p.subCategory) === String(sub._id));
      if (alreadyPlaced) continue;
      const company = product.company;
      if (!ids.includes(String(categoryId)) && company && !(company.categoryIds || []).map(String).includes(String(categoryId))) {
        skipped.push({ id: String(product._id), name: product.name, reason: `${company.name} is not linked to this category` });
        continue;
      }
      let placements = (product.placements || []).length > 0
        ? plainPlacements(product.placements)
        : ids.map((id) => ({ category: id, subCategory: null }));
      placements.push({ category: String(categoryId), subCategory: String(sub._id) });
      placements = setDirect(placements, categoryId, alsoInCategory);
      const update = {
        placements,
        categoryIds: [...new Set([...ids, String(categoryId)])],
      };
      if (!product.primaryCategoryId) update.primaryCategoryId = categoryId;
      await Product.updateOne({ _id: product._id }, { $set: update });
      added.push(String(product._id));
    }
    res.json({ success: true, data: { added: added.length, skipped } });
  } catch (error) {
    next(error);
  }
};

/** GET /sub-categories/:id/products?categoryId= — products placed as "Category › this". */
exports.listProducts = async (req, res, next) => {
  try {
    const { categoryId } = req.query;
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw new BadRequestError('Invalid category', 'INVALID_CATEGORY');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new BadRequestError('Invalid sub-category', 'INVALID_SUB_CATEGORY');
    const products = await Product.find({
      placements: { $elemMatch: { category: categoryId, subCategory: req.params.id } },
    })
      .select('name sku status images brand company placements')
      .populate('company', 'name')
      .sort({ name: 1 })
      .lean();
    res.json({
      success: true,
      data: products.map((product) => ({
        _id: String(product._id),
        // Also in the category's own list, not only under this sub-category.
        alsoInCategory: (product.placements || []).some((p) => idOf(p.category) === String(categoryId) && !p.subCategory),
        name: product.name,
        sku: product.sku,
        status: product.status,
        brand: product.company?.name || product.brand || '',
        image: (product.images?.find((image) => image.isPrimary) || product.images?.[0])?.url || null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /sub-categories/:id/products — { categoryId, productIds[], alsoInCategory }
 * For products placed under this sub-category (in that category): also show
 * them in the category's own list, or only under the sub-category.
 */
exports.setAlsoInCategory = async (req, res, next) => {
  try {
    const { categoryId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw new BadRequestError('Invalid category', 'INVALID_CATEGORY');
    if (typeof req.body.alsoInCategory !== 'boolean') {
      throw new BadRequestError('alsoInCategory must be true or false', 'INVALID_ALSO_IN_CATEGORY');
    }
    const productIds = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : []).map(String))];
    if (productIds.length === 0 || productIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      throw new BadRequestError('productIds must be valid product IDs', 'INVALID_PRODUCT_IDS');
    }
    const products = await Product.find({
      _id: { $in: productIds },
      placements: { $elemMatch: { category: categoryId, subCategory: req.params.id } },
    }).select('_id placements').lean();
    for (const product of products) {
      await Product.updateOne(
        { _id: product._id },
        { $set: { placements: setDirect(plainPlacements(product.placements), categoryId, req.body.alsoInCategory) } }
      );
    }
    res.json({ success: true, data: { updated: products.length } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /sub-categories/:id/products/:productId?categoryId= — takes one placement away (the product stays in the category). */
exports.removeProduct = async (req, res, next) => {
  try {
    const { categoryId } = req.query;
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw new BadRequestError('Invalid category', 'INVALID_CATEGORY');
    const product = await Product.findById(req.params.productId).select('placements categoryIds').lean();
    if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    let placements = (product.placements || []).filter((p) => !(idOf(p.category) === String(categoryId) && idOf(p.subCategory) === String(req.params.id)));
    if (!placements.some((p) => idOf(p.category) === String(categoryId))) {
      placements = [...placements, { category: categoryId, subCategory: null }];
    }
    await Product.updateOne({ _id: product._id }, { $set: { placements } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.brandCondition = brandCondition;

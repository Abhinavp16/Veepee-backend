const mongoose = require('mongoose');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { PRODUCT_STATUS } = require('../utils/constants');
const { categoryProductCondition, escapeRegExp, normalizeObjectIds } = require('../utils/categoryHelpers');

const parentFilter = (parentId) => ({ parent: parentId || null });
const idString = (value) => value == null ? null : String(value);

async function getCategoryProductSets(categories, status = PRODUCT_STATUS.ACTIVE) {
  if (categories.length === 0) return new Map();
  const grouped = await Product.aggregate([
    { $match: { status } },
    {
      $project: {
        category: 1,
        categoryIds: { $ifNull: ['$categoryIds', []] },
      },
    },
    {
      $facet: {
        canonical: [
          { $unwind: '$categoryIds' },
          { $group: { _id: '$categoryIds', productIds: { $addToSet: '$_id' } } },
        ],
        legacy: [
          { $match: { categoryIds: { $size: 0 } } },
          { $group: { _id: '$category', productIds: { $addToSet: '$_id' } } },
        ],
      },
    },
  ]);

  const canonical = new Map((grouped[0]?.canonical || []).map((item) => [String(item._id), item.productIds]));
  const legacy = new Map((grouped[0]?.legacy || []).map((item) => [item._id, item.productIds]));
  return new Map(categories.map((category) => {
    const productIds = new Set([
      ...(canonical.get(String(category._id)) || []),
      ...(legacy.get(category.slug) || []),
    ].map(String));
    return [String(category._id), productIds];
  }));
}

async function getRecursiveProductCounts(categories) {
  const directSets = await getCategoryProductSets(categories);
  const childrenByParent = new Map();
  for (const category of categories) {
    const key = idString(category.parent);
    childrenByParent.set(key, [...(childrenByParent.get(key) || []), String(category._id)]);
  }

  const memo = new Map();
  const collect = (categoryId, visiting = new Set()) => {
    if (memo.has(categoryId)) return memo.get(categoryId);
    if (visiting.has(categoryId)) return new Set(directSets.get(categoryId) || []);
    const nextVisiting = new Set(visiting).add(categoryId);
    const products = new Set(directSets.get(categoryId) || []);
    for (const childId of childrenByParent.get(categoryId) || []) {
      for (const productId of collect(childId, nextVisiting)) products.add(productId);
    }
    memo.set(categoryId, products);
    return products;
  };

  return new Map(categories.map((category) => {
    const categoryId = String(category._id);
    return [categoryId, collect(categoryId).size];
  }));
}

async function normalizeSiblingOrders(parentId) {
  const siblings = await Category.find(parentFilter(parentId))
    .sort({ order: 1, name: 1, _id: 1 })
    .select('_id order')
    .lean();
  const operations = siblings.flatMap((category, index) => {
    const order = index + 1;
    return category.order === order ? [] : [{
      updateOne: { filter: { _id: category._id }, update: { $set: { order } } },
    }];
  });
  if (operations.length > 0) await Category.bulkWrite(operations);
}

async function validateParent(categoryId, parentId) {
  if (!parentId) return true;
  if (!mongoose.Types.ObjectId.isValid(parentId)) return false;
  if (String(parentId) === String(categoryId)) return false;

  let parent = await Category.findById(parentId).select('_id parent').lean();
  if (!parent) return false;
  while (parent?.parent) {
    if (String(parent.parent) === String(categoryId)) return false;
    parent = await Category.findById(parent.parent).select('_id parent').lean();
  }
  return true;
}

function parsePosition(value, fallback) {
  const position = Number(value === undefined || value === null || value === '' ? fallback : value);
  if (!Number.isInteger(position) || position < 1) return null;
  return position;
}

exports.getCategories = async (req, res, next) => {
  try {
    const { parent, active, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const query = {};
    if (parent === 'root') query.parent = null;
    else if (parent) query.parent = parent;
    if (active !== undefined) query.isActive = active === 'true';
    if (search) query.name = { $regex: escapeRegExp(search), $options: 'i' };

    const [categories, total, allCategories] = await Promise.all([
      Category.find(query)
        .populate('parent', 'name slug')
        .sort({ order: 1, name: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Category.countDocuments(query),
      Category.find(active === 'true' ? { isActive: true } : {}).select('_id slug parent').lean(),
    ]);
    const counts = await getRecursiveProductCounts(allCategories);

    res.json({
      success: true,
      ...formatPaginationResponse(categories.map((category) => ({
        ...category,
        productCount: counts.get(String(category._id)) || 0,
      })), total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

async function categoryWithCount(category, { activeOnly = false } = {}) {
  const allCategories = await Category.find(activeOnly ? { isActive: true } : {}).select('_id slug parent').lean();
  const counts = await getRecursiveProductCounts(allCategories);
  const data = category.toObject ? category.toObject() : category;
  return { ...data, productCount: counts.get(String(category._id)) || 0 };
}

exports.getCategoryBySlug = async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const category = await Category.findOne({ slug, isActive: true })
      .populate('parent', 'name slug')
      .populate({ path: 'subcategories', options: { sort: { order: 1, name: 1, _id: 1 } } });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: await categoryWithCount(category, { activeOnly: true }) });
  } catch (error) {
    next(error);
  }
};

exports.getCategory = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id)
      .populate('parent', 'name slug')
      .populate({ path: 'subcategories', options: { sort: { order: 1, name: 1, _id: 1 } } });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: await categoryWithCount(category) });
  } catch (error) {
    next(error);
  }
};

exports.createCategory = async (req, res, next) => {
  try {
    const { name, description, image, parent, order, position: suppliedPosition, isActive } = req.body;
    const existingCategory = await Category.findOne({
      name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' },
    });
    if (existingCategory) return res.status(400).json({ success: false, message: 'Category with this name already exists' });

    if (parent && !await validateParent(null, parent)) {
      return res.status(400).json({ success: false, message: 'Parent category not found' });
    }
    await normalizeSiblingOrders(parent);
    const siblingCount = await Category.countDocuments(parentFilter(parent));
    const requestedPosition = parsePosition(order ?? suppliedPosition, siblingCount + 1);
    if (requestedPosition === null) {
      return res.status(400).json({ success: false, message: 'Order must be an integer of at least 1' });
    }
    const position = Math.min(requestedPosition, siblingCount + 1);
    await Category.updateMany(
      { ...parentFilter(parent), order: { $gte: position } },
      { $inc: { order: 1 } }
    );
    const category = await Category.create({
      name,
      description,
      image,
      parent: parent || null,
      order: position,
      isActive: isActive !== undefined ? isActive : true,
    });
    await normalizeSiblingOrders(parent);
    const createdCategory = await Category.findById(category._id).populate('parent', 'name slug');
    res.status(201).json({ success: true, data: createdCategory });
  } catch (error) {
    next(error);
  }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const { name, description, image, parent, order, position: suppliedPosition, isActive } = req.body;
    let category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    if (name && name !== category.name) {
      const duplicate = await Category.findOne({
        name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' },
        _id: { $ne: category._id },
      });
      if (duplicate) return res.status(400).json({ success: false, message: 'Category with this name already exists' });
    }

    const oldParent = idString(category.parent);
    const newParent = parent !== undefined ? idString(parent || null) : oldParent;
    if (parent !== undefined && !await validateParent(category._id, newParent)) {
      return res.status(400).json({ success: false, message: 'Invalid parent category or category cycle' });
    }
    await Promise.all([...new Set([oldParent, newParent])].map(normalizeSiblingOrders));
    category = await Category.findById(category._id);
    const parentChanged = oldParent !== newParent;
    const siblingCount = await Category.countDocuments({
      ...parentFilter(newParent),
      _id: { $ne: category._id },
    });
    const requestedPosition = parsePosition(order ?? suppliedPosition, parentChanged ? siblingCount + 1 : Math.max(1, category.order || 1));
    if (requestedPosition === null) {
      return res.status(400).json({ success: false, message: 'Order must be an integer of at least 1' });
    }
    const position = Math.min(requestedPosition, siblingCount + 1);

    if (parentChanged) {
      await Category.updateMany(
        { ...parentFilter(oldParent), _id: { $ne: category._id }, order: { $gt: category.order } },
        { $inc: { order: -1 } }
      );
      await Category.updateMany(
        { ...parentFilter(newParent), _id: { $ne: category._id }, order: { $gte: position } },
        { $inc: { order: 1 } }
      );
    } else if (position < category.order) {
      await Category.updateMany(
        { ...parentFilter(newParent), _id: { $ne: category._id }, order: { $gte: position, $lt: category.order } },
        { $inc: { order: 1 } }
      );
    } else if (position > category.order) {
      await Category.updateMany(
        { ...parentFilter(newParent), _id: { $ne: category._id }, order: { $gt: category.order, $lte: position } },
        { $inc: { order: -1 } }
      );
    }

    if (name !== undefined) category.name = name;
    if (description !== undefined) category.description = description;
    if (image !== undefined) category.image = image;
    if (parent !== undefined) category.parent = newParent;
    category.order = position;
    if (isActive !== undefined) category.isActive = isActive;
    await category.save();
    await Promise.all([...new Set([oldParent, newParent])].map(normalizeSiblingOrders));
    const updatedCategory = await Category.findById(category._id).populate('parent', 'name slug');
    res.json({ success: true, data: updatedCategory });
  } catch (error) {
    next(error);
  }
};

exports.reorderCategories = async (req, res, next) => {
  try {
    const parentId = req.body.parentId || null;
    if (parentId && !mongoose.Types.ObjectId.isValid(parentId)) {
      return res.status(400).json({ success: false, message: 'Invalid parentId' });
    }
    if (parentId && !await Category.exists({ _id: parentId })) {
      return res.status(400).json({ success: false, message: 'Parent category not found' });
    }
    const categoryIds = normalizeObjectIds(req.body.categoryIds);
    const siblings = await Category.find(parentFilter(parentId)).select('_id').lean();
    const siblingIds = siblings.map((category) => String(category._id));
    if (categoryIds.length !== siblingIds.length || siblingIds.some((id) => !categoryIds.includes(id))) {
      return res.status(400).json({ success: false, message: 'categoryIds must contain every sibling exactly once' });
    }
    if (categoryIds.length > 0) {
      await Category.bulkWrite(categoryIds.map((categoryId, index) => ({
        updateOne: { filter: { _id: categoryId, ...parentFilter(parentId) }, update: { $set: { order: index + 1 } } },
      })));
    }
    const categories = await Category.find(parentFilter(parentId)).sort({ order: 1, name: 1, _id: 1 }).lean();
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    let category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    if (await Category.exists({ parent: category._id })) {
      return res.status(400).json({ success: false, message: 'Cannot delete category with subcategories. Delete subcategories first.' });
    }
    const products = await Product.countDocuments(categoryProductCondition(category));
    if (products > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete category with ${products} product(s). Reassign products first.` });
    }
    const parent = idString(category.parent);
    await normalizeSiblingOrders(parent);
    category = await Category.findById(category._id);
    const order = category.order;
    await category.deleteOne();
    await Category.updateMany({ ...parentFilter(parent), order: { $gt: order } }, { $inc: { order: -1 } });
    await normalizeSiblingOrders(parent);
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    next(error);
  }
};

exports.updateProductCount = async (identifiers) => {
  try {
    const values = (Array.isArray(identifiers) ? identifiers : [identifiers]).filter(Boolean).map(String);
    if (values.length === 0) return;
    const objectIds = values.filter((value) => mongoose.Types.ObjectId.isValid(value));
    const categories = await Category.find({
      $or: [{ _id: { $in: objectIds } }, { slug: { $in: values } }],
    }).select('_id slug').lean();
    const sets = await getCategoryProductSets(categories);
    if (categories.length > 0) {
      await Category.bulkWrite(categories.map((category) => ({
        updateOne: {
          filter: { _id: category._id },
          update: { $set: { productCount: sets.get(String(category._id))?.size || 0 } },
        },
      })));
    }
  } catch (error) {
    console.error('Error updating category product count:', error);
  }
};

exports.getRecursiveProductCounts = getRecursiveProductCounts;
exports.getCategoryProductSets = getCategoryProductSets;

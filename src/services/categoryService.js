const mongoose = require('mongoose');
const Category = require('../models/Category');
const { BadRequestError } = require('../utils/errors');
const { escapeRegExp } = require('../utils/categoryHelpers');

const parentFilter = (parentId) => ({ parent: parentId || null });
const idString = (value) => value == null ? null : String(value);

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

async function createGlobalCategory(input) {
  const { name, description, image, parent, order, position: suppliedPosition, isActive } = input;
  const existingCategory = await Category.findOne({
    name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' },
  });
  if (existingCategory) throw new BadRequestError('Category with this name already exists', 'CATEGORY_EXISTS');
  if (parent && !await validateParent(null, parent)) {
    throw new BadRequestError('Parent category not found', 'INVALID_CATEGORY_PARENT');
  }

  await normalizeSiblingOrders(parent);
  const siblingCount = await Category.countDocuments(parentFilter(parent));
  const requestedPosition = parsePosition(order ?? suppliedPosition, siblingCount + 1);
  if (requestedPosition === null) {
    throw new BadRequestError('Order must be an integer of at least 1', 'INVALID_CATEGORY_ORDER');
  }
  const position = Math.min(requestedPosition, siblingCount + 1);
  await Category.updateMany(
    { ...parentFilter(parent), order: { $gte: position } },
    { $inc: { order: 1 } }
  );

  try {
    const category = await Category.create({
      name,
      description,
      image,
      parent: parent || null,
      order: position,
      isActive: isActive !== undefined ? isActive : true,
    });
    await normalizeSiblingOrders(parent);
    return Category.findById(category._id).populate('parent', 'name slug');
  } catch (error) {
    await normalizeSiblingOrders(parent);
    throw error;
  }
}

async function removeCreatedCategory(category) {
  if (!category) return;
  const parent = idString(category.parent?._id || category.parent);
  await Category.deleteOne({ _id: category._id });
  await normalizeSiblingOrders(parent);
}

module.exports = {
  createGlobalCategory,
  idString,
  normalizeSiblingOrders,
  parentFilter,
  parsePosition,
  removeCreatedCategory,
  validateParent,
};

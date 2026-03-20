const Category = require('../models/Category');
const Product = require('../models/Product');
const { paginate, formatPaginationResponse } = require('../utils/helpers');

// @desc    Get all categories
// @route   GET /api/v1/categories
// @access  Public
exports.getCategories = async (req, res, next) => {
  try {
    const { parent, active, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};

    // Filter by parent (null for root categories)
    if (parent === 'root') {
      query.parent = null;
    } else if (parent) {
      query.parent = parent;
    }

    // Filter by active status
    if (active !== undefined) {
      query.isActive = active === 'true';
    }

    // Search by name
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const [categories, total] = await Promise.all([
      Category.find(query)
        .populate('parent', 'name slug')
        .sort({ order: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Category.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(categories, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single category
// @route   GET /api/v1/categories/:id
// @access  Public
exports.getCategory = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id)
      .populate('parent', 'name slug')
      .populate('subcategories');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create category
// @route   POST /api/v1/categories
// @access  Private/Admin
exports.createCategory = async (req, res, next) => {
  try {
    const { name, description, image, parent, order, isActive } = req.body;

    // Check if category with same name exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });
    
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists',
      });
    }

    // If parent is specified, verify it exists
    if (parent) {
      const parentCategory = await Category.findById(parent);
      if (!parentCategory) {
        return res.status(400).json({
          success: false,
          message: 'Parent category not found',
        });
      }
    }

    const category = await Category.create({
      name,
      description,
      image,
      parent: parent || null,
      order: order || 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json({
      success: true,
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update category
// @route   PUT /api/v1/categories/:id
// @access  Private/Admin
exports.updateCategory = async (req, res, next) => {
  try {
    const { name, description, image, parent, order, isActive } = req.body;

    let category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    // Check for duplicate name (excluding current category)
    if (name && name !== category.name) {
      const existingCategory = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: req.params.id }
      });
      
      if (existingCategory) {
        return res.status(400).json({
          success: false,
          message: 'Category with this name already exists',
        });
      }
    }

    // Prevent category from being its own parent
    if (parent && parent === req.params.id) {
      return res.status(400).json({
        success: false,
        message: 'Category cannot be its own parent',
      });
    }

    // If parent is specified, verify it exists
    if (parent) {
      const parentCategory = await Category.findById(parent);
      if (!parentCategory) {
        return res.status(400).json({
          success: false,
          message: 'Parent category not found',
        });
      }
    }

    category = await Category.findByIdAndUpdate(
      req.params.id,
      {
        name: name || category.name,
        description: description !== undefined ? description : category.description,
        image: image !== undefined ? image : category.image,
        parent: parent !== undefined ? (parent || null) : category.parent,
        order: order !== undefined ? order : category.order,
        isActive: isActive !== undefined ? isActive : category.isActive,
      },
      { new: true, runValidators: true }
    ).populate('parent', 'name slug');

    res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete category
// @route   DELETE /api/v1/categories/:id
// @access  Private/Admin
exports.deleteCategory = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    // Check if category has subcategories
    const subcategories = await Category.countDocuments({ parent: req.params.id });
    if (subcategories > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete category with subcategories. Delete subcategories first.',
      });
    }

    // Check if category has products
    const products = await Product.countDocuments({ category: category.slug });
    if (products > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category with ${products} product(s). Reassign products first.`,
      });
    }

    await category.deleteOne();

    res.json({
      success: true,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update product count for category
// @route   Internal use
exports.updateProductCount = async (categorySlug) => {
  try {
    const count = await Product.countDocuments({ 
      category: categorySlug,
      status: 'active'
    });
    
    await Category.findOneAndUpdate(
      { slug: categorySlug },
      { productCount: count }
    );
  } catch (error) {
    console.error('Error updating category product count:', error);
  }
};

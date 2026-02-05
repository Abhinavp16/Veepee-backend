const { Product } = require('../../models');
const { NotFoundError } = require('../../utils/errors');
const { paginate, formatPaginationResponse, generateSKU } = require('../../utils/helpers');
const { deleteImage } = require('../../config/cloudinary');
const slugify = require('slugify');

exports.getProducts = async (req, res, next) => {
  try {
    const { status, category, search, sort } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};
    if (status) query.status = status;
    if (category) query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
      ];
    }

    let sortOption = { createdAt: -1 };
    if (sort) {
      const [field, order] = sort.split(':');
      sortOption = { [field]: order === 'asc' ? 1 : -1 };
    }

    const [products, total] = await Promise.all([
      Product.find(query).sort(sortOption).skip(skip).limit(limit).lean(),
      Product.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(products, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductById = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    res.json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.createProduct = async (req, res, next) => {
  try {
    const productData = { ...req.body };

    if (!productData.sku) {
      productData.sku = generateSKU(productData.category, productData.name);
    }

    productData.slug = slugify(productData.name, { lower: true, strict: true });

    if (req.files && req.files.length > 0) {
      productData.images = req.files.map((file, index) => ({
        url: file.path,
        publicId: file.filename,
        isPrimary: index === 0,
        order: index,
      }));
    }

    if (typeof productData.specifications === 'string') {
      productData.specifications = JSON.parse(productData.specifications);
    }
    if (typeof productData.tags === 'string') {
      productData.tags = JSON.parse(productData.tags);
    }

    const product = await Product.create(productData);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    const updateData = { ...req.body };

    if (updateData.name && updateData.name !== product.name) {
      updateData.slug = slugify(updateData.name, { lower: true, strict: true });
    }

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((file, index) => ({
        url: file.path,
        publicId: file.filename,
        isPrimary: false,
        order: product.images.length + index,
      }));
      updateData.images = [...product.images, ...newImages];
    }

    if (typeof updateData.specifications === 'string') {
      updateData.specifications = JSON.parse(updateData.specifications);
    }
    if (typeof updateData.tags === 'string') {
      updateData.tags = JSON.parse(updateData.tags);
    }

    Object.assign(product, updateData);
    await product.save();

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    product.status = 'archived';
    await product.save();

    res.json({
      success: true,
      message: 'Product archived successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.updateStock = async (req, res, next) => {
  try {
    const { stock, adjustment, reason } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    if (stock !== undefined) {
      product.stock = stock;
    } else if (adjustment) {
      const adjustmentValue = parseInt(adjustment);
      product.stock = Math.max(0, product.stock + adjustmentValue);
    }

    await product.save();

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: {
        productId: product._id,
        stock: product.stock,
        reason,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteProductImage = async (req, res, next) => {
  try {
    const { id, imageId } = req.params;

    const product = await Product.findById(id);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    const imageIndex = product.images.findIndex(
      img => img._id.toString() === imageId || img.publicId === imageId
    );

    if (imageIndex === -1) {
      throw new NotFoundError('Image not found', 'IMAGE_NOT_FOUND');
    }

    const image = product.images[imageIndex];
    await deleteImage(image.publicId);

    product.images.splice(imageIndex, 1);

    if (image.isPrimary && product.images.length > 0) {
      product.images[0].isPrimary = true;
    }

    await product.save();

    res.json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

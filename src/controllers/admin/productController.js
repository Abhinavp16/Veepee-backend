const { Product, StockLog } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse, generateSKU } = require('../../utils/helpers');
const { deleteImage } = require('../../config/cloudinary');
const { getStorage } = require('../../config/firebase');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const slugify = require('slugify');

async function uploadFilesToFirebase(files, folder = 'products') {
  const bucket = getStorage();
  if (!bucket) throw new BadRequestError('Firebase Storage not configured', 'STORAGE_NOT_CONFIGURED');

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const webpBuffer = await sharp(file.buffer).webp({ quality: 80 }).toBuffer();
    const filename = `${folder}/${uuidv4()}.webp`;
    const fileUpload = bucket.file(filename);

    await new Promise((resolve, reject) => {
      const stream = fileUpload.createWriteStream({
        metadata: {
          contentType: 'image/webp',
          metadata: { originalName: file.originalname },
        },
      });
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(webpBuffer);
    });

    await fileUpload.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    results.push({ url: publicUrl, publicId: filename });
  }
  return results;
}

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
      const uploaded = await uploadFilesToFirebase(req.files, 'products');
      productData.images = uploaded.map((img, index) => ({
        url: img.url,
        publicId: img.publicId,
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
      const uploaded = await uploadFilesToFirebase(req.files, 'products');
      const newImages = uploaded.map((img, index) => ({
        url: img.url,
        publicId: img.publicId,
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

    const previousStock = product.stock;
    let newStock;
    let action;
    let quantityChange;

    if (stock !== undefined) {
      // Absolute set
      newStock = Math.max(0, parseInt(stock));
      quantityChange = newStock - previousStock;
      action = 'manual_set';
    } else if (adjustment) {
      // Relative adjustment (+N or -N)
      const adjustmentValue = parseInt(adjustment);
      newStock = previousStock + adjustmentValue;
      if (newStock < 0) {
        throw new BadRequestError(
          `Cannot reduce stock below 0. Current: ${previousStock}, Adjustment: ${adjustmentValue}`,
          'STOCK_BELOW_ZERO'
        );
      }
      quantityChange = adjustmentValue;
      action = 'manual_adjust';
    } else {
      throw new BadRequestError('Provide stock or adjustment', 'MISSING_STOCK_PARAM');
    }

    // Atomic update with guard for adjustments
    if (action === 'manual_adjust' && quantityChange < 0) {
      const result = await Product.findOneAndUpdate(
        { _id: req.params.id, stock: { $gte: Math.abs(quantityChange) } },
        { $inc: { stock: quantityChange } },
        { new: true }
      );
      if (!result) {
        throw new BadRequestError(
          'Stock changed concurrently. Please refresh and retry.',
          'STOCK_RACE_CONDITION'
        );
      }
      newStock = result.stock;
    } else {
      if (action === 'manual_set') {
        product.stock = newStock;
      } else {
        product.stock = previousStock + quantityChange;
        newStock = product.stock;
      }
      await product.save();
    }

    await StockLog.create({
      productId: product._id,
      action,
      quantityChange,
      previousStock,
      newStock,
      reason: reason || `Manual ${action === 'manual_set' ? 'set to ' + newStock : 'adjustment ' + (quantityChange > 0 ? '+' : '') + quantityChange}`,
      performedBy: req.user._id,
    });

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: {
        productId: product._id,
        previousStock,
        newStock,
        change: quantityChange,
        reason,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getStockLogs = async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = { productId: req.params.id };

    const [logs, total] = await Promise.all([
      StockLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('performedBy', 'name')
        .populate('orderId', 'orderNumber')
        .lean(),
      StockLog.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(logs, total, page, limit),
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

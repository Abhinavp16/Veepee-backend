const { Cart, Product } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');

// Helper to get price based on user role
const getPriceForUser = (product, userRole) => {
  if (userRole === 'wholesaler') {
    return {
      price: product.wholesalePrice,
      retailPrice: product.retailPrice,
      wholesalePrice: product.wholesalePrice,
    };
  }
  // For buyers - show retail price
  return {
    price: product.retailPrice,
    retailPrice: product.retailPrice,
  };
};

exports.getCart = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    let cart = await Cart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = await Cart.create({ userId: req.user._id, items: [] });
    }

    const productIds = cart.items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('name nameHindi slug retailPrice wholesalePrice stock images')
      .lean();

    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    const items = cart.items.map(item => {
      const product = productMap[item.productId.toString()];
      if (!product) return null;

      const pricing = getPriceForUser(product, userRole);
      const currentPrice = pricing.price;

      return {
        productId: item.productId,
        product: {
          name: product.name,
          nameHindi: product.nameHindi,
          slug: product.slug,
          price: pricing.price,
          retailPrice: pricing.retailPrice,
          wholesalePrice: pricing.wholesalePrice,
          stock: product.stock,
          image: product.images?.find(img => img.isPrimary)?.url || product.images?.[0]?.url,
        },
        quantity: item.quantity,
        priceAtAdd: item.priceAtAdd,
        currentPrice: currentPrice,
        priceChanged: item.priceAtAdd !== currentPrice,
        itemTotal: item.quantity * currentPrice,
      };
    }).filter(Boolean);

    const subtotal = items.reduce((sum, item) => sum + item.itemTotal, 0);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

    res.json({
      success: true,
      data: {
        items,
        subtotal,
        itemCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

const populateCartItems = async (cart, userRole = 'guest') => {
  const productIds = cart.items.map(item => item.productId);
  const products = await Product.find({ _id: { $in: productIds } })
    .select('name nameHindi slug retailPrice wholesalePrice stock images')
    .lean();

  const productMap = products.reduce((acc, p) => {
    acc[p._id.toString()] = p;
    return acc;
  }, {});

  const items = cart.items.map(item => {
    const product = productMap[item.productId.toString()];
    if (!product) return null;

    const pricing = getPriceForUser(product, userRole);
    const currentPrice = pricing.price;

    return {
      productId: item.productId,
      product: {
        name: product.name,
        nameHindi: product.nameHindi,
        slug: product.slug,
        price: pricing.price,
        retailPrice: pricing.retailPrice,
        wholesalePrice: pricing.wholesalePrice,
        stock: product.stock,
        image: product.images?.find(img => img.isPrimary)?.url || product.images?.[0]?.url,
      },
      quantity: item.quantity,
      priceAtAdd: item.priceAtAdd,
      currentPrice: currentPrice,
      priceChanged: item.priceAtAdd !== currentPrice,
      itemTotal: item.quantity * currentPrice,
    };
  }).filter(Boolean);

  const subtotal = items.reduce((sum, item) => sum + item.itemTotal, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  return { items, subtotal, itemCount };
};

exports.addItem = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { productId, quantity } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    if (product.stock < quantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }

    const pricing = getPriceForUser(product, userRole);
    const priceToUse = pricing.price;

    let cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) {
      cart = new Cart({ userId: req.user._id, items: [] });
    }

    cart.addItem(productId, quantity, priceToUse);
    await cart.save();

    const data = await populateCartItems(cart, userRole);
    res.json({
      success: true,
      message: 'Item added to cart',
      data,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateItemQuantity = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { productId } = req.params;
    const { quantity } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    if (product.stock < quantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }

    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) {
      throw new NotFoundError('Cart not found', 'CART_NOT_FOUND');
    }

    cart.updateItemQuantity(productId, quantity);
    await cart.save();

    const data = await populateCartItems(cart, userRole);
    res.json({
      success: true,
      message: 'Cart updated',
      data,
    });
  } catch (error) {
    next(error);
  }
};

exports.removeItem = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { productId } = req.params;

    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) {
      throw new NotFoundError('Cart not found', 'CART_NOT_FOUND');
    }

    cart.removeItem(productId);
    await cart.save();

    const data = await populateCartItems(cart, userRole);
    res.json({
      success: true,
      message: 'Item removed from cart',
      data,
    });
  } catch (error) {
    next(error);
  }
};

exports.validateCart = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart || cart.items.length === 0) {
      return res.json({ success: true, data: { valid: true, issues: [] } });
    }

    const productIds = cart.items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('name stock retailPrice status')
      .lean();

    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    const issues = [];

    for (const item of cart.items) {
      const product = productMap[item.productId.toString()];
      if (!product) {
        issues.push({
          productId: item.productId.toString(),
          type: 'unavailable',
          message: 'This product is no longer available',
          availableStock: 0,
          requestedQty: item.quantity,
        });
        continue;
      }
      if (product.status !== 'active') {
        issues.push({
          productId: item.productId.toString(),
          name: product.name,
          type: 'unavailable',
          message: `${product.name} is currently unavailable`,
          availableStock: 0,
          requestedQty: item.quantity,
        });
        continue;
      }
      if (product.stock === 0) {
        issues.push({
          productId: item.productId.toString(),
          name: product.name,
          type: 'out_of_stock',
          message: `${product.name} is out of stock`,
          availableStock: 0,
          requestedQty: item.quantity,
        });
      } else if (product.stock < item.quantity) {
        issues.push({
          productId: item.productId.toString(),
          name: product.name,
          type: 'insufficient_stock',
          message: `Only ${product.stock} units of ${product.name} available`,
          availableStock: product.stock,
          requestedQty: item.quantity,
        });
      }
    }

    res.json({
      success: true,
      data: {
        valid: issues.length === 0,
        issues,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.clearCart = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ userId: req.user._id });
    if (cart) {
      cart.clearCart();
      await cart.save();
    }

    res.json({
      success: true,
      message: 'Cart cleared',
    });
  } catch (error) {
    next(error);
  }
};

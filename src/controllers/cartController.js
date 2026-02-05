const { Cart, Product } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');

exports.getCart = async (req, res, next) => {
  try {
    let cart = await Cart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = await Cart.create({ userId: req.user._id, items: [] });
    }

    const productIds = cart.items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('name slug price stock images')
      .lean();

    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    const items = cart.items.map(item => {
      const product = productMap[item.productId.toString()];
      if (!product) return null;

      return {
        productId: item.productId,
        product: {
          name: product.name,
          slug: product.slug,
          price: product.price,
          stock: product.stock,
          image: product.images?.find(img => img.isPrimary)?.url || product.images?.[0]?.url,
        },
        quantity: item.quantity,
        priceAtAdd: item.priceAtAdd,
        currentPrice: product.price,
        priceChanged: item.priceAtAdd !== product.price,
        itemTotal: item.quantity * product.price,
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

exports.addItem = async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }

    if (product.stock < quantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }

    let cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) {
      cart = new Cart({ userId: req.user._id, items: [] });
    }

    cart.addItem(productId, quantity, product.price);
    await cart.save();

    res.json({
      success: true,
      message: 'Item added to cart',
    });
  } catch (error) {
    next(error);
  }
};

exports.updateItemQuantity = async (req, res, next) => {
  try {
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

    res.json({
      success: true,
      message: 'Cart updated',
    });
  } catch (error) {
    next(error);
  }
};

exports.removeItem = async (req, res, next) => {
  try {
    const { productId } = req.params;

    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) {
      throw new NotFoundError('Cart not found', 'CART_NOT_FOUND');
    }

    cart.removeItem(productId);
    await cart.save();

    res.json({
      success: true,
      message: 'Item removed from cart',
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

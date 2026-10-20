const { Cart, Product } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');

const { loadDiscountContext, priceFor, pendingPriceNotice } = require('../services/productPricingService');
const { assertPurchasable, isComingSoon } = require('../utils/productAvailability');
const { assertQuantityAllowed, quantityRules } = require('../utils/quantityRules');

const CART_PRODUCT_FIELDS =
  'name nameHindi slug mrp retailPrice wholesalePrice stock images status company categoryIds primaryCategoryId packSize priceUnit minWholesaleQuantity minCustomerQuantity comingSoon expectedLaunchDate autoLaunch pendingRetailPrice pendingWholesalePrice priceChangeScheduledAt priceChangeEffectiveAt';

// `known` are products already loaded in this request (not loaded again);
// `ctx` is a discount context already built for every cart product.
const populateCartItems = async (cart, userRole = 'guest', { known = [], ctx: givenCtx } = {}) => {
  const knownIds = new Set(known.map((p) => String(p._id)));
  const missingIds = cart.items.map(item => item.productId).filter((id) => !knownIds.has(String(id)));
  const fetched = missingIds.length > 0
    ? await Product.find({ _id: { $in: missingIds } }).select(CART_PRODUCT_FIELDS).lean()
    : [];
  const products = [...known, ...fetched];
  const ctx = givenCtx || await loadDiscountContext(products);
  const now = new Date();

  const productMap = products.reduce((acc, p) => {
    acc[p._id.toString()] = p;
    return acc;
  }, {});

  const items = cart.items.map(item => {
    const product = productMap[item.productId.toString()];
    if (!product) return null;

    const own = priceFor(product, userRole, ctx);
    const rules = quantityRules(product, userRole);
    const currentPrice = own.price;

    return {
      productId: item.productId,
      product: {
        name: product.name,
        nameHindi: product.nameHindi,
        slug: product.slug,
        price: own.price,
        mrp: own.mrp,
        retailPrice: priceFor(product, 'buyer', ctx).price,
        wholesalePrice: userRole === 'wholesaler' ? own.price : undefined,
        discountPercent: own.discountPercent,
        stock: product.stock,
        image: product.images?.find(img => img.isPrimary)?.url || product.images?.[0]?.url,
        packSize: rules.packSize,
        priceUnit: product.priceUnit || 'piece',
        minQuantity: rules.min,
        quantityStep: rules.step,
        // Present in the cart but not orderable right now.
        unavailable: product.status !== 'active' || isComingSoon(product, now),
        pendingPriceChange: pendingPriceNotice(product, userRole, own, now),
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

exports.getCart = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    let cart = await Cart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = await Cart.create({ userId: req.user._id, items: [] });
    }

    res.json({
      success: true,
      data: await populateCartItems(cart, userRole),
    });
  } catch (error) {
    next(error);
  }
};

exports.addItem = async (req, res, next) => {
  try {
    const userRole = req.user?.role || 'guest';
    const { productId, quantity } = req.body;

    // Few round trips: the database may be far from the server.
    const [product, existingCart] = await Promise.all([
      Product.findById(productId).select(CART_PRODUCT_FIELDS).lean(),
      Cart.findOne({ userId: req.user._id }),
    ]);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }
    assertPurchasable(product);
    const cart = existingCart || new Cart({ userId: req.user._id, items: [] });

    // Rules apply to what the cart will hold, not just this one addition.
    const existing = cart.items.find(item => item.productId.toString() === String(productId));
    const totalQuantity = (existing?.quantity || 0) + quantity;
    assertQuantityAllowed(product, totalQuantity, userRole);
    if (product.stock < totalQuantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }

    // Price every cart product with one discount lookup.
    const others = cart.items
      .map(item => item.productId)
      .filter((id) => String(id) !== String(productId));
    const otherProducts = others.length > 0
      ? await Product.find({ _id: { $in: others } }).select(CART_PRODUCT_FIELDS).lean()
      : [];
    const known = [product, ...otherProducts];
    const ctx = await loadDiscountContext(known);
    const priceToUse = priceFor(product, userRole, ctx).price;

    cart.addItem(productId, quantity, priceToUse);
    const [, data] = await Promise.all([
      cart.save(),
      populateCartItems(cart, userRole, { known, ctx }),
    ]);
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

    const [product, cart] = await Promise.all([
      Product.findById(productId).select(CART_PRODUCT_FIELDS).lean(),
      Cart.findOne({ userId: req.user._id }),
    ]);
    if (!product) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }
    assertPurchasable(product);
    assertQuantityAllowed(product, quantity, userRole);

    if (product.stock < quantity) {
      throw new BadRequestError('Insufficient stock', 'INSUFFICIENT_STOCK');
    }
    if (!cart) {
      throw new NotFoundError('Cart not found', 'CART_NOT_FOUND');
    }

    cart.updateItemQuantity(productId, quantity);
    const [, data] = await Promise.all([
      cart.save(),
      populateCartItems(cart, userRole, { known: [product] }),
    ]);
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
    const [, data] = await Promise.all([cart.save(), populateCartItems(cart, userRole)]);
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
      .select('name stock retailPrice status comingSoon expectedLaunchDate autoLaunch packSize minWholesaleQuantity minCustomerQuantity')
      .lean();
    const role = req.user?.role;
    const now = new Date();

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
      if (isComingSoon(product, now)) {
        issues.push({
          productId: item.productId.toString(),
          name: product.name,
          type: 'coming_soon',
          message: `${product.name} is coming soon and cannot be ordered yet`,
          availableStock: 0,
          requestedQty: item.quantity,
        });
        continue;
      }
      const rules = quantityRules(product, role);
      if (item.quantity < rules.min || item.quantity % rules.step !== 0) {
        issues.push({
          productId: item.productId.toString(),
          name: product.name,
          type: 'invalid_quantity',
          message: `${product.name} must be ordered ${rules.step > 1 ? `in multiples of ${rules.step}, ` : ''}at least ${rules.min}`,
          availableStock: product.stock,
          requestedQty: item.quantity,
          minQuantity: rules.min,
          quantityStep: rules.step,
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

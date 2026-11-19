const mongoose = require('mongoose');
const { User, Product } = require('../models');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// The app's wishlist, kept on the account (User.wishlist) so it follows the
// person to any phone. Every response: { success, data: { productIds } }.

const MAX_WISHLIST = 500;

async function storedList(userId) {
  const user = await User.findById(userId).select('+wishlist').lean();
  return (user?.wishlist || []).map(String);
}

const reply = async (res, userId) => {
  res.json({ success: true, data: { productIds: await storedList(userId) } });
};

function productIdParam(req) {
  const { productId } = req.params;
  if (!/^[0-9a-fA-F]{24}$/.test(productId)) {
    throw new BadRequestError('Invalid product id', 'INVALID_PRODUCT_ID');
  }
  return new mongoose.Types.ObjectId(productId);
}

// GET /wishlist
exports.getWishlist = async (req, res, next) => {
  try {
    await reply(res, req.user._id);
  } catch (error) {
    next(error);
  }
};

// PUT /wishlist { productIds }: replaces the list (unknown products dropped).
exports.replaceWishlist = async (req, res, next) => {
  try {
    const ids = [...new Set(req.body.productIds.map((id) => id.toLowerCase()))];
    const existing = new Set((await Product.find({ _id: { $in: ids } }).select('_id').lean()).map((p) => String(p._id)));
    const kept = ids.filter((id) => existing.has(id)).map((id) => new mongoose.Types.ObjectId(id));
    await User.updateOne({ _id: req.user._id }, { $set: { wishlist: kept } });
    await reply(res, req.user._id);
  } catch (error) {
    next(error);
  }
};

// POST /wishlist/:productId: adds it (already there is fine).
exports.addToWishlist = async (req, res, next) => {
  try {
    const productId = productIdParam(req);
    if (!await Product.exists({ _id: productId })) {
      throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
    }
    // Added only when it isn't there yet and the list has room, in one step.
    const result = await User.updateOne(
      {
        _id: req.user._id,
        wishlist: { $ne: productId },
        $expr: { $lt: [{ $size: { $ifNull: ['$wishlist', []] } }, MAX_WISHLIST] },
      },
      { $push: { wishlist: productId } }
    );
    if (result.modifiedCount === 0) {
      const list = await storedList(req.user._id);
      if (!list.includes(String(productId))) {
        throw new BadRequestError(`Your wishlist is full (${MAX_WISHLIST} products). Remove some to add more.`, 'WISHLIST_FULL');
      }
    }
    await reply(res, req.user._id);
  } catch (error) {
    next(error);
  }
};

// DELETE /wishlist/:productId: removes it (not there is fine).
exports.removeFromWishlist = async (req, res, next) => {
  try {
    const productId = productIdParam(req);
    await User.updateOne({ _id: req.user._id }, { $pull: { wishlist: productId } });
    await reply(res, req.user._id);
  } catch (error) {
    next(error);
  }
};

exports.MAX_WISHLIST = MAX_WISHLIST;

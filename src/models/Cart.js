const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: [1, 'Quantity must be at least 1'],
  },
  priceAtAdd: {
    type: Number,
    required: true,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const cartSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  items: [cartItemSchema],
}, {
  timestamps: true,
});

cartSchema.index({ userId: 1 }, { unique: true });
cartSchema.index({ 'items.productId': 1 });

cartSchema.methods.addItem = function (productId, quantity, price) {
  const existingItem = this.items.find(
    item => item.productId.toString() === productId.toString()
  );

  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    this.items.push({
      productId,
      quantity,
      priceAtAdd: price,
      addedAt: new Date(),
    });
  }

  return this;
};

cartSchema.methods.updateItemQuantity = function (productId, quantity) {
  const item = this.items.find(
    item => item.productId.toString() === productId.toString()
  );

  if (item) {
    item.quantity = quantity;
  }

  return this;
};

cartSchema.methods.removeItem = function (productId) {
  this.items = this.items.filter(
    item => item.productId.toString() !== productId.toString()
  );

  return this;
};

cartSchema.methods.clearCart = function () {
  this.items = [];
  return this;
};

module.exports = mongoose.model('Cart', cartSchema);

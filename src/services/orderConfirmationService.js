const { Order, Payment } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { ORDER_CONFIRMATION, ORDER_STATUS, PAYMENT_STATUS } = require('../utils/constants');
const notificationService = require('./notificationService');

// New orders wait for the shop: it checks the order, adds the delivery charge
// for that address, and confirms it. Only then can the customer pay.

const CONFIRMATION_PENDING_MESSAGE =
  'Your order is awaiting confirmation. You can pay once we confirm it and add the delivery charge.';

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const rupees = (value) => round2(value).toLocaleString('en-IN');

/** Refuses payment steps while an order is still waiting for confirmation. */
const assertOrderConfirmed = (order) => {
  if (order?.confirmationStatus === ORDER_CONFIRMATION.PENDING) {
    throw new BadRequestError(CONFIRMATION_PENDING_MESSAGE, 'ORDER_AWAITING_CONFIRMATION');
  }
};

const loadPendingOrder = async (orderId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (order.confirmationStatus !== ORDER_CONFIRMATION.PENDING || order.status !== ORDER_STATUS.PENDING_PAYMENT) {
    throw new BadRequestError('Only orders awaiting confirmation can be confirmed or rejected', 'ORDER_NOT_AWAITING_CONFIRMATION');
  }
  return order;
};

const notify = async (order, template, params, extraData = {}) => {
  try {
    await notificationService.sendLocalizedToUser(order.userId, template, params, {
      type: 'order_update',
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      status: order.status,
      ...extraData,
    });
  } catch (error) {
    console.error(`Failed to notify customer about order ${order._id}:`, error.message);
  }
};

/** Adds the delivery charge, settles the total and asks the customer to pay. */
async function confirmOrder({ orderId, deliveryCharge, actorId }) {
  const order = await loadPendingOrder(orderId);
  const deliveryFee = round2(Math.max(0, Number(deliveryCharge) || 0));

  order.deliveryFee = deliveryFee;
  order.total = round2(Math.max(order.subtotal + deliveryFee - (order.discount || 0), 0));
  order.confirmationStatus = ORDER_CONFIRMATION.CONFIRMED;
  order.confirmedAt = new Date();
  order.confirmedBy = actorId;
  order.statusHistory.push({
    status: order.status,
    note: deliveryFee > 0
      ? `Order confirmed · delivery ₹${rupees(deliveryFee)} added`
      : 'Order confirmed · free delivery',
    updatedBy: actorId,
    timestamp: new Date(),
  });
  await order.save();

  // The amount due now includes delivery.
  await Payment.updateMany(
    { orderId: order._id, status: PAYMENT_STATUS.PENDING },
    { $set: { amount: order.total } }
  );

  await notify(
    order,
    deliveryFee > 0 ? 'orderConfirmedPay' : 'orderConfirmedPayFreeDelivery',
    { orderNumber: order.orderNumber, deliveryFee: rupees(deliveryFee), total: rupees(order.total) },
    { action: 'pay' }
  );
  return order;
}

/** Cancels an order the shop cannot fulfil, telling the customer why. */
async function rejectOrder({ orderId, reason, actorId }) {
  const order = await loadPendingOrder(orderId);
  order.confirmationStatus = ORDER_CONFIRMATION.REJECTED;
  order.confirmationNote = reason;
  order.addStatusHistory(ORDER_STATUS.CANCELLED, `Order not confirmed: ${reason}`, actorId);
  await order.save();
  await Payment.updateMany(
    { orderId: order._id, status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.REJECTED, rejectionReason: reason } }
  );
  await notify(order, 'orderRejected', { orderNumber: order.orderNumber, reason });
  return order;
}

module.exports = {
  CONFIRMATION_PENDING_MESSAGE,
  assertOrderConfirmed,
  confirmOrder,
  rejectOrder,
};

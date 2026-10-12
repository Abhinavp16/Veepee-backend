const { Product, ProductAlert } = require('../models');
const notificationService = require('./notificationService');
const { PRODUCT_STATUS } = require('../utils/constants');

const CHUNK_SIZE = 25;

/**
 * Tells everyone who asked to be notified that a product is now available,
 * then forgets their requests so a later launch can be subscribed to again.
 */
const notifyLaunchAlerts = async (product) => {
  const alerts = await ProductAlert.find({ productId: product._id }).select('userId').lean();
  if (alerts.length === 0) return { notified: 0, failed: 0 };
  await ProductAlert.deleteMany({ _id: { $in: alerts.map((alert) => alert._id) } });

  let failed = 0;
  for (let i = 0; i < alerts.length; i += CHUNK_SIZE) {
    const results = await Promise.allSettled(
      alerts.slice(i, i + CHUNK_SIZE).map((alert) =>
        notificationService.sendLocalizedToUser(
          alert.userId,
          'productLaunched',
          { productName: product.name },
          { type: 'product_launched', productId: String(product._id) }
        )
      )
    );
    failed += results.filter((result) => result.status === 'rejected').length;
  }
  return { notified: alerts.length - failed, failed };
};

/**
 * Launches every coming-soon product whose date has passed and that has
 * stock. Flipping `comingSoon` is the claim, so overlapping runs cannot
 * announce the same product twice.
 */
const sweepDueLaunches = async (now = new Date()) => {
  const due = await Product.find({
    status: PRODUCT_STATUS.ACTIVE,
    comingSoon: true,
    expectedLaunchDate: { $lte: now },
    stock: { $gt: 0 },
  }).select('_id').lean();

  let launched = 0;
  let notified = 0;
  for (const { _id } of due) {
    const product = await Product.findOneAndUpdate(
      { _id, comingSoon: true },
      { $set: { comingSoon: false } },
      { new: true }
    ).select('name').lean();
    if (!product) continue;
    launched += 1;
    notified += (await notifyLaunchAlerts({ _id, name: product.name })).notified;
  }
  return { launched, notified };
};

module.exports = { notifyLaunchAlerts, sweepDueLaunches };

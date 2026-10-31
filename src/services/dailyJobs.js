const { processDuePriceChanges, sendPriceChangeReminders } = require('./priceLifecycleService');
const { sweepDueLaunches } = require('./productLaunchService');
const { releaseUnpaidSaleOrders } = require('./saleService');
const { backfillMissingCommissions } = require('./affiliateCommissionService');

// Vercel Hobby allows a single daily cron, so every scheduled job runs from
// this one entry point. Each job is isolated so one failure cannot skip the rest.
const runDailyJobs = async () => {
  const jobs = {
    priceChanges: processDuePriceChanges,
    priceChangeReminders: sendPriceChangeReminders,
    productLaunches: sweepDueLaunches,
    unpaidSaleOrders: () => releaseUnpaidSaleOrders(),
    // Affiliate commissions that failed to record at payment verification.
    affiliateCommissions: () => backfillMissingCommissions(),
  };
  const results = {};
  for (const [name, job] of Object.entries(jobs)) {
    try {
      results[name] = { ok: true, ...(await job()) };
    } catch (error) {
      console.error(`Daily job ${name} failed:`, error);
      results[name] = { ok: false, error: error.message };
    }
  }
  return results;
};

module.exports = { runDailyJobs };

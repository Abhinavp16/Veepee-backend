const { processDuePriceChanges } = require('./priceLifecycleService');
const { sweepDueLaunches } = require('./productLaunchService');

// Vercel Hobby allows a single daily cron, so every scheduled job runs from
// this one entry point. Each job is isolated so one failure cannot skip the rest.
const runDailyJobs = async () => {
  const jobs = {
    priceChanges: processDuePriceChanges,
    productLaunches: sweepDueLaunches,
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

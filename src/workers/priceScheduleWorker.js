const { processDuePriceChanges } = require('../services/priceLifecycleService');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = 60 * 1000;
let timer = null;
let isProcessing = false;

async function runPriceSchedulePoll() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const result = await processDuePriceChanges();
    if (result.inspected > 0 || result.failed > 0) {
      logger.info(`Price schedule worker: inspected ${result.inspected}, applied ${result.applied}, failed ${result.failed}`);
    }
  } catch (error) {
    logger.error('Price schedule worker failed:', error);
  } finally {
    isProcessing = false;
  }
}

function startPriceScheduleWorker() {
  if (timer) return timer;
  runPriceSchedulePoll();
  timer = setInterval(runPriceSchedulePoll, POLL_INTERVAL_MS);
  logger.info('Price schedule worker started (one-minute polling)');
  return timer;
}

function stopPriceScheduleWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startPriceScheduleWorker, stopPriceScheduleWorker, runPriceSchedulePoll };

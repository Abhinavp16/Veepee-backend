require('dotenv').config();
const connectDB = require('./config/database');
const logger = require('./utils/logger');
const { startPriceScheduleWorker, stopPriceScheduleWorker } = require('./workers/priceScheduleWorker');

async function startWorker() {
  try {
    await connectDB();
    startPriceScheduleWorker();
  } catch (error) {
    logger.error('Failed to start price schedule worker:', error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(`Price schedule worker received ${signal}; stopping.`);
  stopPriceScheduleWorker();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
startWorker();

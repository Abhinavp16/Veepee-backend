require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/database');
const { initializeFirebase } = require('./config/firebase');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    // Initialize Firebase (optional - will warn if not configured)
    initializeFirebase();

    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
      logger.info(`📚 API Docs: http://${process.env.HOST || 'localhost'}:${PORT}/api/v1`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

startServer();

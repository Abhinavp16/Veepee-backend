const mongoose = require('mongoose');
const logger = require('../utils/logger');

let connectPromise = null;
let listenersAttached = false;
let reconnectTimer = null;
let shuttingDown = false;

const dbHealth = {
  lastError: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
};

const getStateName = (readyState) => {
  switch (readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'unknown';
  }
};

const attachListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;

  const scheduleReconnect = () => {
    if (shuttingDown || reconnectTimer) return;

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connectDB();
        logger.info('MongoDB reconnected successfully');
      } catch (error) {
        dbHealth.lastError = error.message;
        logger.error('MongoDB reconnect failed:', error.message);
        scheduleReconnect();
      }
    }, 5000);
  };

  mongoose.connection.on('connected', () => {
    dbHealth.lastError = null;
    dbHealth.lastConnectedAt = new Date().toISOString();
  });

  mongoose.connection.on('error', (err) => {
    dbHealth.lastError = err.message;
    logger.error('MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    dbHealth.lastDisconnectedAt = new Date().toISOString();
    logger.warn('MongoDB disconnected');
    scheduleReconnect();
  });
};

const connectDB = async () => {
  attachListeners();

  if (!process.env.MONGODB_URI) {
    const error = new Error('MONGODB_URI is not configured');
    dbHealth.lastError = error.message;
    throw error;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectPromise) {
    return connectPromise;
  }

  try {
    connectPromise = mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15000,
    });

    const conn = await connectPromise;
    logger.info(`MongoDB Connected: ${conn.connection.host}`);

    process.on('SIGINT', async () => {
      shuttingDown = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      await mongoose.connection.close();
      logger.info('MongoDB connection closed due to app termination');
      process.exit(0);
    });

    return conn;
  } catch (error) {
    dbHealth.lastError = error.message;
    logger.error('MongoDB connection failed:', error.message);
    throw error;
  } finally {
    connectPromise = null;
  }
};

const getDatabaseHealth = () => ({
  state: getStateName(mongoose.connection.readyState),
  readyState: mongoose.connection.readyState,
  host: mongoose.connection.host || null,
  database: mongoose.connection.name || null,
  lastError: dbHealth.lastError,
  lastConnectedAt: dbHealth.lastConnectedAt,
  lastDisconnectedAt: dbHealth.lastDisconnectedAt,
});

module.exports = connectDB;
module.exports.getDatabaseHealth = getDatabaseHealth;

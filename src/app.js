const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const routes = require('./routes');
const connectDB = require('./config/database');
const { initializeFirebase } = require('./config/firebase');
const errorHandler = require('./middlewares/errorHandler');
const { NotFoundError } = require('./utils/errors');

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
const normalizeOrigins = (value) =>
  (value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const defaultOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://veepee-admin.vercel.app",
];

const allowedOrigins = [
  ...new Set([
    ...normalizeOrigins(process.env.CORS_ORIGIN),
    ...normalizeOrigins(process.env.ADMIN_PANEL_URL),
    ...normalizeOrigins(process.env.FRONTEND_URL),
    ...defaultOrigins,
  ]),
];

const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const vercelPreviewPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const isAllowedOrigin = (origin) => {
  if (allowedOrigins.includes(origin)) return true;
  if (localhostOriginPattern.test(origin)) return true;
  if (vercelPreviewPattern.test(origin)) return true;
  return false;
};

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server and curl requests without Origin header.
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Rate limiting - account based (with IP fallback for guests)
const keyGenerator = (req) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      // Decode JWT to get user ID (payload is base64 encoded)
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.id || payload.userId || payload.sub) {
          return payload.id || payload.userId || payload.sub;
        }
      }
    }
  } catch (e) {
    // If token parsing fails, fall back to IP
  }
  // Fall back to IP for unauthenticated requests
  return req.ip || req.headers['x-forwarded-for'] || 'unknown';
};

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200,
  skip: (req) => req.originalUrl.startsWith('/api/v1/health'),
  keyGenerator,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
    error: { code: 'RATE_LIMIT_EXCEEDED' }
  }
});
app.use('/api', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AgriMart API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// Root landing route for hosted environments that probe "/"
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AgriMart API is running',
    docs: '/api/v1',
    health: '/health',
    apiHealth: '/api/v1/health',
  });
});

// Ensure dependencies are initialized for API routes in hosted/serverless environments.
app.use('/api/v1', async (req, res, next) => {
  try {
    // Keep health routes lightweight and self-diagnosing.
    if (req.path.startsWith('/health')) {
      return next();
    }

    await connectDB();
    initializeFirebase();
    return next();
  } catch (error) {
    return next(error);
  }
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((req, res, next) => {
  next(new NotFoundError(`Route ${req.originalUrl} not found`));
});

// Global error handler
app.use(errorHandler);

module.exports = app;

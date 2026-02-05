const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      throw new UnauthorizedError('Access token required', 'AUTH_TOKEN_REQUIRED');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.userId).select('-passwordHash');

    if (!user) {
      throw new UnauthorizedError('User not found', 'USER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      next(new UnauthorizedError('Invalid token', 'INVALID_TOKEN'));
    } else if (error.name === 'TokenExpiredError') {
      next(new UnauthorizedError('Token expired', 'TOKEN_EXPIRED'));
    } else {
      next(error);
    }
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-passwordHash');
      if (user && user.isActive) {
        req.user = user;
      }
    }

    next();
  } catch (error) {
    next();
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required', 'AUTH_REQUIRED'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Not authorized for this action', 'INSUFFICIENT_PERMISSIONS'));
    }

    next();
  };
};

const adminOnly = authorize('admin');
const wholesalerOnly = authorize('wholesaler', 'admin');
const buyerOrWholesaler = authorize('buyer', 'wholesaler', 'admin');

module.exports = {
  protect,
  optionalAuth,
  authorize,
  adminOnly,
  wholesalerOnly,
  buyerOrWholesaler,
};

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

const PASSWORD_CHANGE_ALLOWED = ['/auth/change-password', '/auth/me', '/auth/logout'];

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

    // A refresh token is not an access token.
    if (decoded.type === 'refresh') {
      throw new UnauthorizedError('Invalid token', 'INVALID_TOKEN');
    }
    // Sessions with a hard end (admin and staff) stop working at that moment.
    if (decoded.sx && Date.now() / 1000 >= decoded.sx) {
      throw new UnauthorizedError('Session expired, please sign in again', 'SESSION_EXPIRED');
    }

    const user = await User.findById(decoded.userId).select('-passwordHash');

    if (!user) {
      throw new UnauthorizedError('User not found', 'USER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    // After an admin issues a temporary password, only changing it is allowed.
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some((path) => req.originalUrl.split('?')[0].endsWith(path))) {
      throw new ForbiddenError('Please change your temporary password first', 'PASSWORD_CHANGE_REQUIRED');
    }

    req.user = user;
    req.auth = decoded;
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

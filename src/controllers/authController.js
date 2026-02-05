const jwt = require('jsonwebtoken');
const { User, RefreshToken } = require('../models');
const { UnauthorizedError, ConflictError, BadRequestError } = require('../utils/errors');
const { USER_ROLES, AUTH_PROVIDERS } = require('../utils/constants');
const { sanitizeUser } = require('../utils/helpers');

const generateTokens = async (userId, deviceInfo) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
  );

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await RefreshToken.create({
    userId,
    token: refreshToken,
    deviceInfo,
    expiresAt,
  });

  return { accessToken, refreshToken };
};

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, phone, marketingConsent } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new ConflictError('Email already registered', 'USER_ALREADY_EXISTS');
    }

    const user = await User.create({
      name,
      email,
      phone,
      passwordHash: password,
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.BUYER,
      marketingConsent,
      consentTimestamp: marketingConsent ? new Date() : null,
    });

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.status(201).json({
      success: true,
      message: 'Registration successful. Please verify your phone.',
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.registerWholesaler = async (req, res, next) => {
  try {
    const { name, email, password, phone, businessName, gstNumber, marketingConsent } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new ConflictError('Email already registered', 'USER_ALREADY_EXISTS');
    }

    const user = await User.create({
      name,
      email,
      phone,
      passwordHash: password,
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.WHOLESALER,
      businessInfo: {
        businessName,
        gstNumber,
        verified: false,
      },
      marketingConsent,
      consentTimestamp: marketingConsent ? new Date() : null,
    });

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.status(201).json({
      success: true,
      message: 'Wholesaler registration successful.',
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      throw new UnauthorizedError('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    if (user.authProvider !== AUTH_PROVIDERS.EMAIL) {
      throw new BadRequestError(`Please login with ${user.authProvider}`, 'AUTH_WRONG_PROVIDER');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new UnauthorizedError('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.json({
      success: true,
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.loginWithPhone = async (req, res, next) => {
  try {
    const { phone, password, expectedRole } = req.body;

    const user = await User.findOne({ phone }).select('+passwordHash');
    if (!user) {
      throw new UnauthorizedError('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new UnauthorizedError('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    // Validate role if expectedRole is provided
    if (expectedRole) {
      const isWholesaler = user.role === USER_ROLES.WHOLESALER;
      const expectsWholesaler = expectedRole === 'wholesaler';
      
      if (isWholesaler && !expectsWholesaler) {
        throw new UnauthorizedError('This is a wholesaler account. Please use the Wholesaler login.', 'AUTH_ROLE_MISMATCH');
      }
      if (!isWholesaler && expectsWholesaler) {
        throw new UnauthorizedError('This is a customer account. Please use the Customer login.', 'AUTH_ROLE_MISMATCH');
      }
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.json({
      success: true,
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.registerWithPhone = async (req, res, next) => {
  try {
    const { name, phone, password } = req.body;

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      throw new ConflictError('Phone number already registered', 'USER_ALREADY_EXISTS');
    }

    const user = await User.create({
      name,
      phone,
      passwordHash: password,
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.BUYER,
    });

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.registerWholesalerWithPhone = async (req, res, next) => {
  try {
    const { name, phone, password, businessName } = req.body;

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      throw new ConflictError('Phone number already registered', 'USER_ALREADY_EXISTS');
    }

    const user = await User.create({
      name,
      phone,
      passwordHash: password,
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.WHOLESALER,
      businessInfo: {
        businessName: businessName || null,
        verified: false,
      },
    });

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.status(201).json({
      success: true,
      message: 'Wholesaler registration successful',
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.googleAuth = async (req, res, next) => {
  try {
    const { idToken, phone, marketingConsent } = req.body;

    // TODO: Verify Google ID token with Firebase Admin SDK
    // For now, this is a placeholder
    const decodedToken = { uid: 'google_uid', email: 'user@gmail.com', name: 'Google User' };

    let user = await User.findOne({ googleId: decodedToken.uid });

    if (!user) {
      user = await User.findOne({ email: decodedToken.email });
      
      if (user) {
        user.googleId = decodedToken.uid;
        user.authProvider = AUTH_PROVIDERS.GOOGLE;
        await user.save();
      } else {
        user = await User.create({
          name: decodedToken.name,
          email: decodedToken.email,
          phone,
          googleId: decodedToken.uid,
          authProvider: AUTH_PROVIDERS.GOOGLE,
          role: USER_ROLES.BUYER,
          marketingConsent,
          consentTimestamp: marketingConsent ? new Date() : null,
        });
      }
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent']);

    res.json({
      success: true,
      data: {
        user: sanitizeUser(user),
        ...tokens,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;

    // TODO: Integrate actual OTP service (e.g., Twilio, MSG91)
    // For development, OTP is always 123456

    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: { expiresIn: 300 },
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyPhone = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;

    // TODO: Verify OTP from cache/service
    // For development, accept 123456
    if (otp !== '123456') {
      throw new BadRequestError('Invalid OTP', 'INVALID_OTP');
    }

    const user = req.user;
    if (user) {
      user.phoneVerified = true;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Phone verified successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    
    const storedToken = await RefreshToken.findOne({
      token: refreshToken,
      userId: decoded.userId,
      isRevoked: false,
    });

    if (!storedToken) {
      throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }

    storedToken.isRevoked = true;
    await storedToken.save();

    const tokens = await generateTokens(decoded.userId, req.headers['user-agent']);

    res.json({
      success: true,
      data: tokens,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      next(new UnauthorizedError('Refresh token expired', 'REFRESH_TOKEN_EXPIRED'));
    } else {
      next(error);
    }
  }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await RefreshToken.updateOne(
        { token: refreshToken, userId: req.user._id },
        { isRevoked: true }
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: sanitizeUser(req.user),
    });
  } catch (error) {
    next(error);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const { name, avatar } = req.body;
    const user = req.user;

    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: sanitizeUser(user),
    });
  } catch (error) {
    next(error);
  }
};

exports.registerFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    const user = req.user;

    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      await user.save();
    }

    res.json({
      success: true,
      message: 'FCM token registered',
    });
  } catch (error) {
    next(error);
  }
};

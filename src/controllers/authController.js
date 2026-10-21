const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { User, RefreshToken, DeviceToken } = require('../models');
const { getStorage } = require('../config/firebase');
const { UnauthorizedError, ConflictError, BadRequestError, ForbiddenError } = require('../utils/errors');
const { USER_ROLES, AUTH_PROVIDERS } = require('../utils/constants');
const { sanitizeUser } = require('../utils/helpers');
const { requireAcceptance, buildAcceptanceFields } = require('../config/legalAcceptance');
const { notifyTeam } = require('../services/adminNotificationService');

const { ACCESS_SECONDS, REFRESH_SECONDS, DASHBOARD_SESSION_SECONDS, tokenExpiry } = require('../utils/sessionTokens');

// `sessionEndsAt` (a Date) hard-limits the session, as it does for staff.
const generateTokens = async (userId, deviceInfo, { sessionEndsAt = null } = {}) => {
  const sx = sessionEndsAt ? Math.floor(sessionEndsAt.getTime() / 1000) : null;
  const accessExp = tokenExpiry(ACCESS_SECONDS(), sx);
  const refreshExp = tokenExpiry(REFRESH_SECONDS(), sx);

  const accessToken = jwt.sign(
    { userId, ...(sx && { sx }), exp: accessExp },
    process.env.JWT_SECRET
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh', jti: uuidv4(), ...(sx && { sx }), exp: refreshExp },
    process.env.JWT_SECRET
  );

  await RefreshToken.create({
    userId,
    token: refreshToken,
    deviceInfo,
    expiresAt: new Date(refreshExp * 1000),
    sessionExpiresAt: sessionEndsAt,
  });

  return { accessToken, refreshToken, ...(sessionEndsAt && { sessionExpiresAt: sessionEndsAt.toISOString() }) };
};

// Staff sign in only through the staff login, so their sessions are always
// time-limited; the shared logins turn them away.
// Admin and staff sessions end 5 hours after sign-in; customers' don't.
const isDashboardRole = (role) => role === USER_ROLES.ADMIN || role === USER_ROLES.STAFF;
const sessionEndFor = (user) => (isDashboardRole(user.role)
  ? new Date(Date.now() + DASHBOARD_SESSION_SECONDS() * 1000)
  : null);

const rejectStaff = (user) => {
  if (user.role === USER_ROLES.STAFF) {
    throw new ForbiddenError('Staff accounts sign in from the staff area', 'STAFF_LOGIN_REQUIRED');
  }
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
    rejectStaff(user);

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent'], { sessionEndsAt: sessionEndFor(user) });

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

exports.staffLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email, role: USER_ROLES.STAFF }).select('+passwordHash');
    // Same answer for "no such staff" and "wrong password".
    if (!user || !(await user.comparePassword(password))) {
      throw new UnauthorizedError('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }
    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent'], { sessionEndsAt: sessionEndFor(user) });

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

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+passwordHash');

    if (!(await user.comparePassword(currentPassword))) {
      throw new UnauthorizedError('Current password is incorrect', 'AUTH_INVALID_CREDENTIALS');
    }
    if (await user.comparePassword(newPassword)) {
      throw new BadRequestError('Choose a password you have not used just now', 'PASSWORD_UNCHANGED');
    }

    user.passwordHash = newPassword;
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    // Every other sign-in is ended; this one continues with fresh tokens and
    // keeps its original session end.
    await RefreshToken.updateMany({ userId: user._id, isRevoked: false }, { isRevoked: true });
    const sx = req.auth?.sx;
    const tokens = await generateTokens(user._id, req.headers['user-agent'], {
      sessionEndsAt: sx ? new Date(sx * 1000) : null,
    });

    res.json({
      success: true,
      message: 'Password changed',
      data: { user: sanitizeUser(user), ...tokens },
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

    rejectStaff(user);

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

    const tokens = await generateTokens(user._id, req.headers['user-agent'], { sessionEndsAt: sessionEndFor(user) });

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
    if (requireAcceptance() && !(req.body.termsAccepted === true && req.body.privacyPolicyAccepted === true)) {
      throw new BadRequestError(
        'Please accept the Terms and Privacy Policy to continue',
        'TERMS_NOT_ACCEPTED'
      );
    }

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
      ...buildAcceptanceFields(req.body),
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
    if (requireAcceptance() && !(req.body.termsAccepted === true && req.body.privacyPolicyAccepted === true)) {
      throw new BadRequestError(
        'Please accept the Terms and Privacy Policy to continue',
        'TERMS_NOT_ACCEPTED'
      );
    }

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
      ...buildAcceptanceFields(req.body),
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

    if (decoded.type !== 'refresh') {
      throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }

    const [storedToken, user] = await Promise.all([
      RefreshToken.findOne({
        token: refreshToken,
        userId: decoded.userId,
        isRevoked: false,
      }),
      User.findOne({ _id: decoded.userId, isActive: true }).select('_id'),
    ]);

    if (!storedToken || !user) {
      throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }

    // Admin and staff sessions end at a fixed time and cannot be renewed past
    // it. One with no recorded end predates that rule, so it ends now.
    const sessionEndsAt = storedToken.sessionExpiresAt;
    const account = await User.findById(user._id).select('role');
    if (isDashboardRole(account?.role) && !sessionEndsAt) {
      throw new UnauthorizedError('Session expired, please sign in again', 'SESSION_EXPIRED');
    }
    if (sessionEndsAt && sessionEndsAt <= new Date()) {
      throw new UnauthorizedError('Session expired, please sign in again', 'SESSION_EXPIRED');
    }

    storedToken.isRevoked = true;
    await storedToken.save();

    const tokens = await generateTokens(user._id, req.headers['user-agent'], { sessionEndsAt });

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
    const { refreshToken, fcmToken } = req.body;

    if (refreshToken) {
      await RefreshToken.updateOne(
        { token: refreshToken, userId: req.user._id },
        { isRevoked: true }
      );
    }

    // Stop pushes for this user on this device once they sign out.
    if (fcmToken) {
      await DeviceToken.updateMany(
        { userId: req.user._id, fcmToken },
        { $set: { isActive: false } }
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

exports.updatePreferences = async (req, res, next) => {
  try {
    req.user.preferredLanguage = req.body.language;
    await req.user.save();

    res.json({
      success: true,
      message: 'Preferences updated',
      data: { language: req.user.preferredLanguage },
    });
  } catch (error) {
    next(error);
  }
};

const addressesPayload = (user) => ({
  addresses: (user.savedAddresses || []).map((address) => ({
    id: address.id,
    slot: address.slot,
    fullName: address.fullName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  })),
  selectedAddressId: user.selectedAddressId || null,
});

exports.getAddresses = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+savedAddresses +selectedAddressId');
    res.json({ success: true, data: addressesPayload(user) });
  } catch (error) {
    next(error);
  }
};

// Replaces the account's saved addresses with the app's list (at most one
// primary and one secondary).
exports.saveAddresses = async (req, res, next) => {
  try {
    const { addresses, selectedAddressId } = req.body;
    const user = await User.findById(req.user._id).select('+savedAddresses +selectedAddressId');
    user.savedAddresses = addresses;
    user.selectedAddressId = addresses.some((address) => address.id === selectedAddressId)
      ? selectedAddressId
      : addresses[0]?.id || null;
    await user.save();
    res.json({ success: true, message: 'Addresses saved', data: addressesPayload(user) });
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
    const { name, avatar, phone, address } = req.body;
    const user = req.user;

    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (phone) user.phone = phone;
    if (address !== undefined) user.address = address;

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

exports.uploadProfileAvatar = async (req, res, next) => {
  try {
    const bucket = getStorage();
    if (!bucket) {
      return res.status(503).json({
        success: false,
        message: 'Image upload service is unavailable',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file uploaded',
      });
    }

    const webpBuffer = await sharp(req.file.buffer).webp({ quality: 80 }).toBuffer();
    const filename = `avatars/${req.user._id}/${uuidv4()}.webp`;
    const fileUpload = bucket.file(filename);

    await new Promise((resolve, reject) => {
      const blobStream = fileUpload.createWriteStream({
        metadata: {
          contentType: 'image/webp',
          metadata: {
            originalName: req.file.originalname,
            uploadedBy: req.user._id.toString(),
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      blobStream.on('error', reject);
      blobStream.on('finish', resolve);
      blobStream.end(webpBuffer);
    });

    await fileUpload.makePublic();
    const avatarUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

    const user = req.user;
    user.avatar = avatarUrl;
    await user.save();

    res.json({
      success: true,
      message: 'Avatar updated successfully',
      data: {
        avatarUrl,
        user: sanitizeUser(user),
      },
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

exports.convertToWholesaler = async (req, res, next) => {
  try {
    const { businessName, gstNumber, businessAddress, contactPerson, phone } = req.body;
    const user = req.user;

    let proofImageUrls = [];
    if (req.files && req.files.length > 0) {
      const bucket = getStorage();
      if (bucket) {
        proofImageUrls = await Promise.all(
          req.files.map(async (file) => {
            const webpBuffer = await sharp(file.buffer).webp({ quality: 80 }).toBuffer();
            const filename = `proofs/${user._id}/${uuidv4()}.webp`;
            const fileUpload = bucket.file(filename);

            await new Promise((resolve, reject) => {
              const blobStream = fileUpload.createWriteStream({
                metadata: { contentType: 'image/webp' },
              });
              blobStream.on('error', reject);
              blobStream.on('finish', resolve);
              blobStream.end(webpBuffer);
            });

            await fileUpload.makePublic();
            return `https://storage.googleapis.com/${bucket.name}/${filename}`;
          })
        );
      }
    }

    // Update user business info (Admin verifies before role update)
    user.businessInfo = {
      ...user.businessInfo,
      businessName,
      gstNumber,
      businessAddress, // We might need to add this to the model
      contactPerson,
      status: 'pending',
      verified: false,
      proofImages: proofImageUrls.length > 0 ? proofImageUrls : (user.businessInfo?.proofImages || []),
    };

    // Also update phone/name if changed? Usually contact person is just name
    user.name = contactPerson || user.name;
    user.phone = phone || user.phone;

    await user.save();

    notifyTeam({
      type: 'upgrade_request',
      audience: 'admin',
      title: 'Wholesaler upgrade request',
      body: `${user.name} applied for a wholesaler account (${businessName || 'no business name'}).`,
      link: '/account-upgrades',
      data: { userId: user._id },
    });

    res.json({
      success: true,
      message: 'Account converted to wholesaler successfully. Please wait for verification.',
      data: sanitizeUser(user),
    });
  } catch (error) {
    next(error);
  }
};

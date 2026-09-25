const { User, RefreshToken } = require('../../models');
const { USER_ROLES, AUTH_PROVIDERS } = require('../../utils/constants');
const { ConflictError, NotFoundError } = require('../../utils/errors');
const { paginate, formatPaginationResponse, sanitizeUser } = require('../../utils/helpers');

const staffQuery = { role: USER_ROLES.STAFF };

exports.createStaff = async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body;
    const identifiers = [{ email }];
    if (phone) identifiers.push({ phone });

    const existingUser = await User.findOne({ $or: identifiers });
    if (existingUser) {
      throw new ConflictError('A user with this email or phone already exists', 'USER_ALREADY_EXISTS');
    }

    const staff = await User.create({
      name,
      email,
      phone: phone || undefined,
      passwordHash: password,
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.STAFF,
      isActive: true,
    });

    res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      data: sanitizeUser(staff),
    });
  } catch (error) {
    next(error);
  }
};

exports.getStaff = async (req, res, next) => {
  try {
    const { search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const query = { ...staffQuery };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const [staff, total] = await Promise.all([
      User.find(query).select('-fcmTokens').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(staff, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.updateStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password, isActive } = req.body;
    const staff = await User.findOne({ _id: id, ...staffQuery }).select('+passwordHash');

    if (!staff) {
      throw new NotFoundError('Staff account not found', 'STAFF_NOT_FOUND');
    }

    const identifiers = [];
    if (email && email !== staff.email) identifiers.push({ email });
    if (phone && phone !== staff.phone) identifiers.push({ phone });
    if (identifiers.length) {
      const existingUser = await User.findOne({ _id: { $ne: staff._id }, $or: identifiers });
      if (existingUser) {
        throw new ConflictError('A user with this email or phone already exists', 'USER_ALREADY_EXISTS');
      }
    }

    if (name !== undefined) staff.name = name;
    if (email !== undefined) staff.email = email;
    if (phone !== undefined) staff.phone = phone || undefined;
    const passwordChanged = password !== undefined;
    if (passwordChanged) staff.passwordHash = password;

    const deactivated = isActive === false && staff.isActive;
    if (isActive !== undefined) staff.isActive = isActive;
    await staff.save();

    if (deactivated || passwordChanged) {
      await RefreshToken.updateMany({ userId: staff._id, isRevoked: false }, { isRevoked: true });
    }

    let message = 'Staff account updated successfully';
    if (deactivated && passwordChanged) {
      message = 'Staff account deactivated, password changed, and active sessions revoked';
    } else if (deactivated) {
      message = 'Staff account deactivated and active sessions revoked';
    } else if (passwordChanged) {
      message = 'Staff password changed and active sessions revoked';
    }

    res.json({
      success: true,
      message,
      data: sanitizeUser(staff),
    });
  } catch (error) {
    next(error);
  }
};

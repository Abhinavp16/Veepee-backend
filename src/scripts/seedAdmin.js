require('dotenv').config();
const mongoose = require('mongoose');
const { USER_ROLES, AUTH_PROVIDERS } = require('../utils/constants');

const ADMIN_EMAIL = 'admin@agrimart.com';
const ADMIN_PASSWORD = 'Admin@123';
const ADMIN_NAME = 'AgriMart Admin';
const ADMIN_PHONE = '+919999999999';

const seedAdmin = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const User = require('../models/User');

    // Delete existing admin to reset password
    await User.deleteOne({ email: ADMIN_EMAIL });
    console.log('🗑️  Cleared existing admin (if any)');

    // Create new admin - model's pre-save hook will hash the password
    const admin = await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      phone: ADMIN_PHONE,
      passwordHash: ADMIN_PASSWORD, // Model will hash this automatically
      authProvider: AUTH_PROVIDERS.EMAIL,
      role: USER_ROLES.ADMIN,
      phoneVerified: true,
      isActive: true,
    });

    console.log('✅ Admin user created successfully!');
    console.log('');
    console.log('📧 Admin Credentials:');
    console.log(`   Email: ${ADMIN_EMAIL}`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log('');
    console.log('⚠️  Please change the password after first login!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding admin:', error.message);
    process.exit(1);
  }
};

seedAdmin();

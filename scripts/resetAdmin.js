require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const resetAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const adminEmail = 'admin@agrimart.com';
        await User.deleteOne({ email: adminEmail });
        console.log('Deleted existing admin user');

        const adminUser = await User.create({
            name: 'AgriMart Admin',
            email: adminEmail,
            phone: '9999999999',
            passwordHash: 'admin123',
            authProvider: 'email',
            role: 'admin',
            isActive: true,
            businessInfo: { verified: true } // Good measure
        });

        console.log('Admin user recreated successfully:', adminUser.email);
        process.exit(0);
    } catch (error) {
        console.error('Error resetting admin:', error);
        process.exit(1);
    }
};

resetAdmin();

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const seedAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const adminEmail = 'admin@agrimart.com';
        const existingAdmin = await User.findOne({ email: adminEmail });

        if (existingAdmin) {
            console.log('Admin user already exists');
            process.exit(0);
        }

        const adminUser = await User.create({
            name: 'AgriMart Admin',
            email: adminEmail,
            phone: '9999999999',
            passwordHash: 'admin123', // Will be hashed by pre-save hook
            authProvider: 'email',
            role: 'admin',
            isActive: true,
        });

        console.log('Admin user created successfully:', adminUser.email);
        process.exit(0);
    } catch (error) {
        console.error('Error seeding admin:', error);
        process.exit(1);
    }
};

seedAdmin();

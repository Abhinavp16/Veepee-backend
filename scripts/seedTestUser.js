require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const seedTestUser = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const testEmail = 'test@agrimart.com';
        const existingUser = await User.findOne({ email: testEmail });

        if (existingUser) {
            console.log('Test user already exists:', testEmail);
            console.log('Password: Test@123');
            process.exit(0);
        }

        const testUser = await User.create({
            name: 'Test Farmer',
            email: testEmail,
            phone: '9876543210',
            passwordHash: 'Test@123',
            authProvider: 'email',
            role: 'buyer',
            isActive: true,
        });

        console.log('Test user created successfully!');
        console.log('Email:', testUser.email);
        console.log('Password: Test@123');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding test user:', error);
        process.exit(1);
    }
};

seedTestUser();

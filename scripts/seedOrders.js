require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const User = require('../src/models/User');

const seedOrders = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        const admin = await User.findOne({ email: 'admin@agrimart.com' });

        // Create dummy customer
        let customer = await User.findOne({ email: 'customer@test.com' });
        if (!customer) {
            customer = await User.create({
                name: 'Ramesh Farmer',
                email: 'customer@test.com',
                phone: '9876543210',
                passwordHash: '123456',
                authProvider: 'email',
                role: 'buyer'
            });
        }

        // Create a pending order
        const order1 = await Order.create({
            userId: customer._id,
            customerSnapshot: {
                name: customer.name,
                email: customer.email,
                phone: customer.phone
            },
            orderType: 'retail',
            items: [{
                productId: new mongoose.Types.ObjectId(), // Fake product ID
                productSnapshot: { name: 'Power Tiller', sku: 'PT-123', image: 'https://placehold.co/100' },
                quantity: 1,
                pricePerUnit: 45000,
                totalPrice: 45000
            }],
            subtotal: 45000,
            total: 45000,
            shippingAddress: {
                fullName: 'Ramesh Farmer',
                phone: '9876543210',
                addressLine1: 'Village Khatraj',
                city: 'Kalol',
                state: 'Gujarat',
                pincode: '382721'
            },
            status: 'payment_uploaded' // Simulate that user uploaded payment
        });

        // Create associated payment
        await Payment.create({
            orderId: order1._id,
            userId: customer._id,
            amount: 45000,
            upiId: 'ramesh@upi',
            screenshotUrl: 'https://placehold.co/400x800/png?text=UPI+Screenshot',
            status: 'pending',
            uploadedAt: new Date()
        });

        console.log('Dummy order and payment created');
        process.exit(0);

    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

seedOrders();

require('dotenv').config();
const mongoose = require('mongoose');
const Negotiation = require('../src/models/Negotiation');
const User = require('../src/models/User');
const Product = require('../src/models/Product');

const seedNegotiations = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        // Get a wholesaler and product
        const wholesaler = await User.findOne({ role: 'wholesaler' }) || await User.findOne({ email: 'customer@test.com' });
        const product = await Product.findOne();

        if (!wholesaler || !product) {
            console.log('Wholesaler or Product not found. Run previous seeds first.');
            process.exit(1);
        }

        // Create a negotiation
        const negotiation = await Negotiation.create({
            wholesalerId: wholesaler._id,
            productId: product._id,
            productSnapshot: {
                name: product.name,
                price: product.wholesalePrice || 50000,
                sku: product.sku,
                image: product.images[0]?.url
            },
            requestedQuantity: 50,
            requestedPricePerUnit: 40000,
            requestedTotalPrice: 2000000,
            message: "I need 50 units, can you give me a better price?",
            status: 'pending',
            currentOfferBy: 'wholesaler',
            currentPricePerUnit: 40000,
            currentTotalPrice: 2000000,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            history: [{
                action: 'requested',
                by: 'wholesaler',
                pricePerUnit: 40000,
                message: "I need 50 units, can you give me a better price?",
                timestamp: new Date()
            }]
        });

        console.log('Dummy negotiation created:', negotiation.negotiationNumber);
        process.exit(0);

    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

seedNegotiations();

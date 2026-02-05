const axios = require('axios');
const mongoose = require('mongoose');
const Payment = require('../src/models/Payment');
const Order = require('../src/models/Order');
const User = require('../src/models/User'); // Import User model to find admin
require('dotenv').config();

async function testPaymentVerify() {
    try {
        // 1. Login
        console.log('Logging in...');
        const loginRes = await axios.post('http://localhost:5000/api/v1/auth/login', {
            email: 'admin@agrimart.com',
            password: 'admin123'
        });
        const token = loginRes.data.data.accessToken;
        console.log('Logged in. Token acquired.');

        // 2. Find a pending payment
        await mongoose.connect(process.env.MONGODB_URI);
        const payment = await Payment.findOne({ status: 'pending' });

        if (!payment) {
            console.log('No pending payment found to verify.');
            return;
        }
        console.log('Found pending payment:', payment._id.toString());

        // 3. Verify Payment
        console.log(`Verifying payment ${payment._id}...`);
        try {
            const verifyRes = await axios.put(
                `http://localhost:5000/api/v1/admin/payments/${payment._id}/verify`,
                {},
                {
                    headers: { 'Authorization': `Bearer ${token}` }
                }
            );
            console.log('Verification Success:', verifyRes.data);
        } catch (err) {
            console.error('Verification Failed:', err.response ? err.response.data : err.message);
            console.error('Status:', err.response ? err.response.status : 'Unknown');
        }

    } catch (error) {
        console.error('Script Error:', error.message);
        if (error.response) console.error('Response:', error.response.data);
    } finally {
        await mongoose.disconnect();
    }
}

testPaymentVerify();

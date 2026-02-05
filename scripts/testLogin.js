const axios = require('axios');

async function testLogin() {
    try {
        console.log('Attempting login with admin@agrimart.com / admin123');
        const res = await axios.post('http://localhost:5000/api/v1/auth/login', {
            email: 'admin@agrimart.com',
            password: 'admin123'
        });
        console.log('Login successful:', res.data);
    } catch (error) {
        if (error.response) {
            console.error('Login failed:', error.response.status, error.response.data);
        } else {
            console.error('Login error:', error.message);
        }
    }
}

testLogin();

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('blurhash');
const Product = require('../src/models/Product');

async function getBlurHashFromUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        
        const { data: pixels, info: { width, height } } = await sharp(buffer)
            .raw()
            .ensureAlpha()
            .resize(32, 32, { fit: 'inside' })
            .toBuffer({ resolveWithObject: true });
            
        return encode(new Uint8ClampedArray(pixels), width, height, 4, 4);
    } catch (err) {
        console.error(`Error generating blurhash for ${url}:`, err.message);
        return null;
    }
}

const migrateBlurHash = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const products = await Product.find({
            'images.blurHash': { $in: [null, ""] }
        });

        console.log(`Found ${products.length} products to migrate.`);

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            let updated = false;

            console.log(`[${i + 1}/${products.length}] Migrating: ${product.name}`);

            for (let j = 0; j < product.images.length; j++) {
                const image = product.images[j];
                
                if (!image.blurHash) {
                    console.log(`  - Generating blurhash for image ${j + 1}...`);
                    const hash = await getBlurHashFromUrl(image.url);
                    if (hash) {
                        image.blurHash = hash;
                        updated = true;
                    }
                }
            }

            if (updated) {
                await product.save();
                console.log(`  ✓ Successfully updated blurhashes for: ${product.name}`);
            } else {
                console.log(`  - No updates needed for: ${product.name}`);
            }
        }

        console.log('\nMigration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('\nError during migration:', error);
        process.exit(1);
    }
};

migrateBlurHash();

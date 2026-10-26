const assert = require('assert');
const sharp = require('sharp');
const { toStoredWebp, MAX_SIDE } = require('../src/utils/imageProcessing');

// Uploads: stored as WebP, upright, at most 1600px on the longest side.
async function run() {
  // A 4000 × 3000 camera shot shrinks to 1600 × 1200.
  const camera = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#e07b39' } }).jpeg().toBuffer();
  let out = await sharp(await toStoredWebp(camera)).metadata();
  assert.strictEqual(out.format, 'webp');
  assert.deepStrictEqual([out.width, out.height], [MAX_SIDE, 1200]);
  console.log('1. camera photo: WebP, 1600 × 1200');

  // Small images are not enlarged.
  const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#2563eb' } }).png().toBuffer();
  out = await sharp(await toStoredWebp(small)).metadata();
  assert.deepStrictEqual([out.width, out.height], [640, 480]);
  console.log('2. small image kept at its size');

  // A portrait photo saved sideways with an EXIF rotation comes out upright.
  const sideways = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#16a34a' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  out = await sharp(await toStoredWebp(sideways)).metadata();
  assert.deepStrictEqual([out.width, out.height], [1067, MAX_SIDE], 'rotated upright, then capped');
  console.log('3. rotated phone photo: upright');

  // Not an image: refused (the payment upload keeps the original instead).
  await assert.rejects(() => toStoredWebp(Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
  console.log('4. a broken file is refused');

  console.log('imageProcessing.test.js: all checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

const sharp = require('sharp');

// Uploaded photos are stored as WebP no larger than this on their longest
// side: plenty for phone screens, and camera shots (4000 × 3000) shrink a lot.
const MAX_SIDE = 1600;

/**
 * An uploaded image ready to store: turned the right way up (phones save the
 * rotation separately, and converting would drop it), no larger than
 * [maxSide] on its longest side (never enlarged), as WebP.
 */
async function toStoredWebp(buffer, { maxSide = MAX_SIDE, quality = 80 } = {}) {
  return sharp(buffer)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
}

module.exports = { toStoredWebp, MAX_SIDE };

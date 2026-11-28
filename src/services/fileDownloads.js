const { getStorage } = require('../config/firebase');

// Download links for photos customers sent (wholesaler proof photos, payment
// screenshots): short-lived signed links that make the browser save the file
// under a clear name instead of opening it. Only files in our own storage,
// under the given folder, are signed.

const STORAGE_HOST = 'storage.googleapis.com';
const DOWNLOAD_LINK_MINUTES = 15;

/** { bucket, path } for a stored URL under [prefix], or null. */
function storedObject(url, prefix) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== STORAGE_HOST) return null;
  const [, bucket, ...rest] = parsed.pathname.split('/');
  if (!bucket || rest.length === 0) return null;
  let path;
  try {
    path = rest.map(decodeURIComponent).join('/');
  } catch (error) {
    return null;
  }
  if (!path.startsWith(prefix) || path.includes('..')) return null;
  return { bucket, path };
}

/** "Sharma Traders" → "sharma-traders" (safe in a file name). */
function fileSlug(value, fallback = 'file') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** The file's extension from its stored path ("webp", "jpg"), or "jpg". */
function extensionOf(path) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(path || '');
  return match ? match[1].toLowerCase() : 'jpg';
}

/** Our storage bucket, only when [name] is it (never another bucket). */
function ourBucket(name) {
  const bucket = getStorage();
  return bucket && bucket.name === name ? bucket : null;
}

/** Only letters, digits, "-", "_" and "." (safe in a download header). */
function safeFileName(value) {
  return String(value || '').replace(/[^\w.-]/g, '').slice(0, 120) || 'file';
}

// Signing failures are logged at most every 5 minutes.
let lastSignErrorAt = 0;
function logSignFailure(error) {
  if (Date.now() - lastSignErrorAt < 5 * 60 * 1000) return;
  lastSignErrorAt = Date.now();
  console.error(`Downloads can't be made: signing a download link failed (${error?.message || 'storage not configured'}).`);
}

/**
 * Signed download links for [items] ({ url, name } where name has no
 * extension). Returns { files: [{ name, url, signed, label? }], signed,
 * expiresAt }. A file that isn't ours or can't be signed (no storage
 * credentials, e.g. locally) comes back with its stored link and signed
 * false (and the top-level signed is false when any file is).
 */
async function downloadLinks(items, prefix) {
  const expires = Date.now() + DOWNLOAD_LINK_MINUTES * 60 * 1000;
  let signed = true;
  const files = await Promise.all(items.map(async ({ url, name, label }) => {
    const object = storedObject(url, prefix);
    const fileName = safeFileName(`${name}.${extensionOf(object ? object.path : url)}`);
    const base = { name: fileName, ...(label && { label }) };
    if (!object) {
      signed = false;
      return { ...base, url, signed: false };
    }
    try {
      const bucket = ourBucket(object.bucket);
      if (!bucket) throw new Error(getStorage() ? 'not our storage bucket' : 'storage not configured');
      const [link] = await bucket.file(object.path).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires,
        responseDisposition: `attachment; filename="${fileName}"`,
      });
      return { ...base, url: link, signed: true };
    } catch (error) {
      signed = false;
      logSignFailure(error);
      return { ...base, url, signed: false };
    }
  }));
  return { files, signed, expiresAt: new Date(expires).toISOString() };
}

module.exports = {
  DOWNLOAD_LINK_MINUTES,
  storedObject,
  fileSlug,
  extensionOf,
  safeFileName,
  downloadLinks,
};

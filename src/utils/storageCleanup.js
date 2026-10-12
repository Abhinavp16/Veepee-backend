const { getStorage } = require('../config/firebase');

// Best-effort removal of uploaded files. A storage hiccup must never leave an
// account half-deleted, so failures are logged and reported, not thrown.

function bucketOrNull() {
  try {
    return getStorage();
  } catch (error) {
    return null;
  }
}

const safeSegment = (value) => String(value || '').replace(/[^a-zA-Z0-9/_\-.]/g, '').replace(/^\/+|\/+$/g, '');

async function deleteByPrefix(prefix) {
  const clean = safeSegment(prefix);
  if (!clean) return false;
  const bucket = bucketOrNull();
  if (!bucket) return false;
  try {
    await bucket.deleteFiles({ prefix: `${clean}/` });
    return true;
  } catch (error) {
    console.error(`Storage cleanup failed for prefix ${clean}:`, error.message);
    return false;
  }
}

async function deleteFile(path) {
  const clean = safeSegment(path);
  if (!clean) return false;
  const bucket = bucketOrNull();
  if (!bucket) return false;
  try {
    await bucket.file(clean).delete({ ignoreNotFound: true });
    return true;
  } catch (error) {
    console.error(`Storage cleanup failed for file ${clean}:`, error.message);
    return false;
  }
}

module.exports = { deleteByPrefix, deleteFile };

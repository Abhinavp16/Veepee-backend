const { v4: uuidv4 } = require('uuid');
const { getStorage, admin } = require('../config/firebase');
const { toStoredWebp } = require('../utils/imageProcessing');
const { AppError, BadRequestError } = require('../utils/errors');

// Proof photos for wholesaler applications (shop photo, GST certificate,
// trade licence). They are private: stored without public access, and shown
// to admins through short-lived signed links. The stored value stays the
// plain https://storage.googleapis.com/<bucket>/proofs/... URL, so older data
// and code keep working; the object path is read back from it.

const PROOF_PREFIX = 'proofs/';
const SIGNED_LINK_MINUTES = 15;
const STORAGE_HOST = 'storage.googleapis.com';

/** { bucket, path } for a stored proof URL, or null when it isn't one. */
function proofObject(url) {
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
  if (!path.startsWith(PROOF_PREFIX) || path.includes('..')) return null;
  return { bucket, path };
}

function bucketByName(name) {
  const defaultBucket = getStorage();
  if (!defaultBucket) return null;
  return defaultBucket.name === name ? defaultBucket : admin.storage().bucket(name);
}

/**
 * Saves one proof photo (as WebP) under proofs/<userId>/ without public
 * access, and returns its stored URL. When storage isn't configured, tests
 * get a URL without an upload; anywhere else the upload is refused.
 */
async function uploadProof(userId, buffer) {
  let webp;
  try {
    webp = await toStoredWebp(buffer);
  } catch (error) {
    throw new BadRequestError('One of the photos could not be read. Please choose another photo.', 'PROOF_UNREADABLE');
  }
  const path = `${PROOF_PREFIX}${userId}/${uuidv4()}.webp`;
  const bucket = getStorage();
  if (!bucket) {
    if (process.env.NODE_ENV === 'test') return `https://${STORAGE_HOST}/test-bucket/${path}`;
    throw new AppError('Photo upload is unavailable right now. Please try again later.', 503, 'STORAGE_NOT_CONFIGURED');
  }
  // projectPrivate: no public access, whatever the bucket's default object
  // ACL is (the same ACL file.makePrivate() sets on older proofs).
  await bucket.file(path).save(webp, {
    resumable: false,
    predefinedAcl: 'projectPrivate',
    metadata: { contentType: 'image/webp', cacheControl: 'private, max-age=0' },
  });
  return `https://${STORAGE_HOST}/${bucket.name}/${path}`;
}

// Signing failures are logged as errors (admins can't see the photos), at
// most every 5 minutes so a broken setup doesn't flood the logs.
const SIGN_ERROR_LOG_MS = 5 * 60 * 1000;
let lastSignErrorAt = 0;
function logSignFailure(error) {
  if (Date.now() - lastSignErrorAt < SIGN_ERROR_LOG_MS) return;
  lastSignErrorAt = Date.now();
  console.error(`PROOF PHOTOS CAN'T BE SHOWN: signing proof photo links failed (${error?.message || 'storage not configured'}). Admins see "Photos can't be shown right now" until storage credentials can sign URLs.`);
}

/**
 * Signed read links (15 minutes) for stored proof URLs, in the same order,
 * and whether every proof link was signed. A link that can't be signed (no
 * storage credentials, e.g. locally or in tests) is returned as stored, and
 * signed is false.
 */
async function signProofs(urls) {
  const list = Array.isArray(urls) ? urls : [];
  if (list.length === 0) return { urls: [], signed: true };
  const expires = Date.now() + SIGNED_LINK_MINUTES * 60 * 1000;
  let signed = true;
  const out = await Promise.all(list.map(async (url) => {
    const object = proofObject(url);
    if (!object) return url;
    try {
      const bucket = bucketByName(object.bucket);
      if (!bucket) throw new Error('storage not configured');
      const [link] = await bucket.file(object.path).getSignedUrl({ version: 'v4', action: 'read', expires });
      return link;
    } catch (error) {
      signed = false;
      logSignFailure(error);
      return url;
    }
  }));
  return { urls: out, signed };
}

/** Just the links from signProofs. */
async function signProofUrls(urls) {
  return (await signProofs(urls)).urls;
}

/**
 * A copy of [user] (a plain object) for an admin: proof photos as signed
 * links, businessInfo.proofLinksSigned, and (when signed)
 * businessInfo.proofLinksExpireAt saying when they stop working.
 */
async function withSignedProofs(user) {
  if (!user || !user.businessInfo) return user;
  const { urls, signed } = await signProofs(user.businessInfo.proofImages);
  return {
    ...user,
    businessInfo: {
      ...user.businessInfo,
      proofImages: urls,
      proofLinksSigned: signed,
      proofLinksExpireAt: urls.length && signed
        ? new Date(Date.now() + SIGNED_LINK_MINUTES * 60 * 1000).toISOString()
        : null,
    },
  };
}

/**
 * Deletes stored proof photos (best effort: failures are logged, never
 * thrown). Only objects under proofs/ are touched.
 */
async function deleteProofs(urls) {
  const list = (Array.isArray(urls) ? urls : []).map(proofObject).filter(Boolean);
  if (list.length === 0) return;
  await Promise.all(list.map(async (object) => {
    try {
      const bucket = bucketByName(object.bucket);
      if (!bucket) return;
      await bucket.file(object.path).delete({ ignoreNotFound: true });
    } catch (error) {
      console.error(`Could not delete proof photo gs://${object.bucket}/${object.path}: ${error.message}`);
    }
  }));
}

/** A copy of [user] (a plain object) without proof photos (staff). */
function withoutProofs(user) {
  if (!user || !user.businessInfo) return user;
  const { proofImages, ...businessInfo } = user.businessInfo;
  return { ...user, businessInfo: { ...businessInfo, proofCount: Array.isArray(proofImages) ? proofImages.length : 0 } };
}

/** Signed for admins; left out for everyone else. */
function proofsForViewer(user, viewer) {
  return viewer?.role === 'admin' ? withSignedProofs(user) : Promise.resolve(withoutProofs(user));
}

module.exports = {
  PROOF_PREFIX,
  SIGNED_LINK_MINUTES,
  proofObject,
  uploadProof,
  deleteProofs,
  signProofs,
  signProofUrls,
  withSignedProofs,
  withoutProofs,
  proofsForViewer,
};

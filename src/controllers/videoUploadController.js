const { v4: uuidv4 } = require('uuid');
const { getStorage } = require('../config/firebase');
const { BadRequestError } = require('../utils/errors');

// Banner videos are sent by the admin's browser straight to Firebase Storage:
// Vercel accepts at most ~4.5 MB per request, too little for a video. The
// browser compresses the video first (720p H.264 MP4); the server only opens
// the upload and publishes the file once it is there.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const VIDEO_FOLDER = 'banners/videos/';

const noStorage = (res) => res.status(503).json({
  success: false,
  message: 'Firebase Storage is not configured, so videos cannot be uploaded here.',
  error: { code: 'STORAGE_NOT_CONFIGURED' },
});

/**
 * POST /upload/video/start { contentType, size } → { uploadUrl, path }.
 * A resumable upload session tied to the admin site's origin, so the
 * browser may send the file to it (no bucket-wide CORS setting needed).
 */
exports.startVideoUpload = async (req, res, next) => {
  try {
    const bucket = getStorage();
    if (!bucket) return noStorage(res);

    const contentType = String(req.body.contentType || '');
    const size = Number(req.body.size);
    const extension = VIDEO_TYPES[contentType];
    if (!extension) throw new BadRequestError('Use an MP4, WebM or MOV video', 'INVALID_VIDEO_TYPE');
    if (!Number.isFinite(size) || size <= 0) throw new BadRequestError('Video size is missing', 'INVALID_VIDEO_SIZE');
    if (size > MAX_VIDEO_BYTES) {
      throw new BadRequestError('Video is larger than 25 MB even after compressing. Trim it and try again.', 'VIDEO_TOO_LARGE');
    }

    const path = `${VIDEO_FOLDER}${uuidv4()}.${extension}`;
    const [uploadUrl] = await bucket.file(path).createResumableUpload({
      origin: req.get('origin') || undefined,
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { uploadedBy: String(req.user?._id || ''), uploadedAt: new Date().toISOString() },
      },
    });

    res.json({ success: true, data: { uploadUrl, path, maxBytes: MAX_VIDEO_BYTES } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /upload/video/finish { path } → { url }. Checks the uploaded file
 * (a video, within the size limit), makes it public and returns its address.
 */
exports.finishVideoUpload = async (req, res, next) => {
  try {
    const bucket = getStorage();
    if (!bucket) return noStorage(res);

    const path = String(req.body.path || '');
    if (!path.startsWith(VIDEO_FOLDER) || path.includes('..') || !/^[\w/.-]+$/.test(path)) {
      throw new BadRequestError('Unknown upload', 'INVALID_VIDEO_PATH');
    }
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) throw new BadRequestError('The video did not finish uploading. Try again.', 'VIDEO_NOT_UPLOADED');

    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (!Object.keys(VIDEO_TYPES).includes(metadata.contentType) || !(size > 0) || size > MAX_VIDEO_BYTES) {
      await file.delete().catch(() => {});
      throw new BadRequestError('That file is not a video within 25 MB', 'INVALID_VIDEO');
    }

    await file.makePublic();
    res.json({
      success: true,
      data: { url: `https://storage.googleapis.com/${bucket.name}/${path}`, size },
    });
  } catch (error) {
    next(error);
  }
};

exports.MAX_VIDEO_BYTES = MAX_VIDEO_BYTES;

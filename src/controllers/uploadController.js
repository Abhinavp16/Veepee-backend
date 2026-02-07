const { getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const sharp = require('sharp');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Convert image buffer to WebP using sharp
async function convertToWebP(buffer, quality = 80) {
  return sharp(buffer)
    .webp({ quality })
    .toBuffer();
}

exports.uploadImage = async (req, res, next) => {
  try {
    const bucket = getStorage();
    
    if (!bucket) {
      return res.status(503).json({
        success: false,
        message: 'Firebase Storage is not configured. Please use URL option instead.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
    }

    const file = req.file;

    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP',
      });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size: 5MB',
      });
    }

    // Convert to WebP
    const webpBuffer = await convertToWebP(file.buffer);

    // Generate unique filename with .webp extension
    const filename = `${req.query.folder || 'uploads'}/${uuidv4()}.webp`;

    // Create file in Firebase Storage
    const fileUpload = bucket.file(filename);
    
    const blobStream = fileUpload.createWriteStream({
      metadata: {
        contentType: 'image/webp',
        metadata: {
          originalName: file.originalname,
          uploadedBy: req.user?.id || 'anonymous',
          uploadedAt: new Date().toISOString(),
          originalSize: file.size,
          convertedSize: webpBuffer.length,
        },
      },
    });

    blobStream.on('error', (error) => {
      console.error('Upload error:', error);
      return res.status(500).json({
        success: false,
        message: 'Upload failed',
        error: error.message,
      });
    });

    blobStream.on('finish', async () => {
      // Make the file publicly accessible
      await fileUpload.makePublic();

      // Get the public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

      res.json({
        success: true,
        data: {
          url: publicUrl,
          publicId: filename,
          originalName: file.originalname,
          originalSize: file.size,
          convertedSize: webpBuffer.length,
          mimeType: 'image/webp',
          savings: Math.round((1 - webpBuffer.length / file.size) * 100) + '%',
        },
      });
    });

    blobStream.end(webpBuffer);
  } catch (error) {
    next(error);
  }
};

exports.uploadMultipleImages = async (req, res, next) => {
  try {
    const bucket = getStorage();
    
    if (!bucket) {
      return res.status(503).json({
        success: false,
        message: 'Firebase Storage is not configured. Please use URL option instead.',
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded',
      });
    }

    const uploadPromises = req.files.map(async (file, index) => {
      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        throw new Error(`Invalid file type for ${file.originalname}`);
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File ${file.originalname} is too large`);
      }

      // Convert to WebP
      const webpBuffer = await convertToWebP(file.buffer);

      // Generate unique filename with .webp extension
      const filename = `${req.query.folder || 'uploads'}/${uuidv4()}.webp`;

      const fileUpload = bucket.file(filename);

      return new Promise((resolve, reject) => {
        const blobStream = fileUpload.createWriteStream({
          metadata: {
            contentType: 'image/webp',
            metadata: {
              originalName: file.originalname,
              uploadedBy: req.user?.id || 'anonymous',
              uploadedAt: new Date().toISOString(),
              originalSize: file.size,
              convertedSize: webpBuffer.length,
            },
          },
        });

        blobStream.on('error', reject);

        blobStream.on('finish', async () => {
          await fileUpload.makePublic();
          const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
          
          resolve({
            url: publicUrl,
            publicId: filename,
            originalName: file.originalname,
            originalSize: file.size,
            convertedSize: webpBuffer.length,
            mimeType: 'image/webp',
            savings: Math.round((1 - webpBuffer.length / file.size) * 100) + '%',
            isPrimary: index === 0,
            order: index,
          });
        });

        blobStream.end(webpBuffer);
      });
    });

    const uploadedFiles = await Promise.all(uploadPromises);

    res.json({
      success: true,
      data: uploadedFiles,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteImage = async (req, res, next) => {
  try {
    const bucket = getStorage();
    
    if (!bucket) {
      return res.status(503).json({
        success: false,
        message: 'Firebase Storage is not configured',
      });
    }

    const { publicId } = req.body;

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'publicId is required',
      });
    }

    const file = bucket.file(publicId);
    
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: 'File not found',
      });
    }

    await file.delete();

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

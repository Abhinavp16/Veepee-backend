const assert = require('assert');

// Video banners: the admin's browser uploads straight to storage (the
// server opens the upload and publishes the file), hero banners keep their
// media type and video, and an empty button text stays empty.
//
//   BANNER_VIDEO_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_banner_video_test?replicaSet=rs0' node tests/bannerVideo.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.BANNER_VIDEO_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set BANNER_VIDEO_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: BANNER_VIDEO_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

// A stand-in for Firebase Storage, installed before the app loads.
const stored = new Map();
const calls = [];
let storageOn = true;
const fakeBucket = {
  name: 'test-bucket',
  file(path) {
    return {
      async createResumableUpload(options) {
        calls.push({ path, options });
        return [`https://upload.test/session/${encodeURIComponent(path)}`];
      },
      async exists() { return [stored.has(path)]; },
      async getMetadata() { return [stored.get(path)]; },
      async makePublic() { stored.get(path).public = true; },
      async delete() { stored.delete(path); },
    };
  },
};
const firebase = require('../src/config/firebase');
firebase.getStorage = () => (storageOn ? fakeBucket : null);

const randomPhone = () => {
  for (;;) {
    const candidate = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(candidate) && new Set(candidate).size > 4) return candidate;
  }
};

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const M = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const made = [];
  const before = (await M.Settings.getSettings()).toObject();

  const call = async (method, path, token, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const makeUser = async (role) => {
    const user = await M.User.create({ name: `BV ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role });
    made.push(user._id);
    return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const MB = 1024 * 1024;

    // 1. Opening an upload: admins only, a video within 25 MB.
    let res = await call('POST', '/upload/video/start', staff, { contentType: 'video/mp4', size: MB });
    assert.strictEqual(res.status, 403, JSON.stringify(res.json));
    res = await call('POST', '/upload/video/start', admin, { contentType: 'image/png', size: MB });
    assert.strictEqual(codeOf(res), 'INVALID_VIDEO_TYPE');
    res = await call('POST', '/upload/video/start', admin, { contentType: 'video/mp4', size: 26 * MB });
    assert.strictEqual(codeOf(res), 'VIDEO_TOO_LARGE');
    res = await call('POST', '/upload/video/start', admin, { contentType: 'video/mp4', size: 6 * MB }, { Origin: 'http://localhost:3103' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const { uploadUrl, path } = res.json.data;
    assert.ok(uploadUrl.startsWith('https://upload.test/session/'));
    assert.ok(/^banners\/videos\/[\w-]+\.mp4$/.test(path), path);
    assert.strictEqual(calls.at(-1).options.origin, 'http://localhost:3103', 'upload tied to the admin site');
    assert.strictEqual(calls.at(-1).options.metadata.contentType, 'video/mp4');
    console.log('ok - an upload is opened for admins only');

    // 2. Publishing: only what was uploaded, only a video within the limit.
    res = await call('POST', '/upload/video/finish', admin, { path });
    assert.strictEqual(codeOf(res), 'VIDEO_NOT_UPLOADED');
    res = await call('POST', '/upload/video/finish', admin, { path: '../secrets/key.json' });
    assert.strictEqual(codeOf(res), 'INVALID_VIDEO_PATH');
    stored.set(path, { contentType: 'video/mp4', size: String(6 * MB) });
    res = await call('POST', '/upload/video/finish', admin, { path });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.url, `https://storage.googleapis.com/test-bucket/${path}`);
    assert.strictEqual(stored.get(path).public, true);
    const bad = 'banners/videos/not-a-video.mp4';
    stored.set(bad, { contentType: 'text/html', size: '10' });
    res = await call('POST', '/upload/video/finish', admin, { path: bad });
    assert.strictEqual(codeOf(res), 'INVALID_VIDEO');
    assert.ok(!stored.has(bad), 'a file that is not a video is removed');
    console.log('ok - only an uploaded video within 25 MB is published');

    // 3. Without storage, a clear message.
    storageOn = false;
    res = await call('POST', '/upload/video/start', admin, { contentType: 'video/mp4', size: MB });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(codeOf(res), 'STORAGE_NOT_CONFIGURED');
    storageOn = true;
    console.log('ok - no storage: a clear message');

    // 4. Hero banners keep their media; an empty button stays empty.
    const videoUrl = `https://storage.googleapis.com/test-bucket/${path}`;
    res = await call('PUT', '/admin/settings', admin, {
      heroBanners: [
        { title: '', mediaType: 'video_upload', videoUrl, imageUrl: 'https://x.test/poster.webp', linkUrl: '/product/1', buttonText: '', isActive: true, order: 0 },
        { title: 'Monsoon', mediaType: 'youtube', videoUrl: 'https://youtu.be/dQw4w9WgXcQ', buttonText: 'Watch', isActive: true, order: 1 },
        { title: 'Plain', imageUrl: 'https://x.test/a.webp', isActive: true, order: 2 },
      ],
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await call('GET', '/settings/banners');
    const [video, youtube, plain] = res.json.data.heroBanners;
    assert.strictEqual(video.mediaType, 'video_upload');
    assert.strictEqual(video.videoUrl, videoUrl);
    assert.strictEqual(video.buttonText, '', 'no button text: no button');
    assert.strictEqual(youtube.mediaType, 'youtube');
    assert.strictEqual(plain.mediaType, 'image', 'image by default');
    assert.strictEqual(plain.buttonText, '', 'new banners have no button');
    res = await call('PUT', '/admin/settings', admin, { heroBanners: [{ title: 'x', mediaType: 'gif' }] });
    assert.strictEqual(res.status, 400, 'unknown media type refused');
    console.log('ok - hero banners keep their video; empty button stays empty');
  } finally {
    await M.Settings.updateOne({ _id: 'app_settings' }, { $set: { heroBanners: before.heroBanners || [] } });
    await M.User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS bannerVideo');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

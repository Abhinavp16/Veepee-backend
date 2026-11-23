const assert = require('assert');
const crypto = require('crypto');

// Wholesaler applications: proof photos are required (and private), the
// business contact details never change the account's own name and phone,
// old "wholesaler sign-up" routes make customers, and admin lists
// applications by status with counts, search and pages.
//
//   WHOLESALER_APPS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_wholesaler_apps_test?replicaSet=rs0' node tests/wholesalerApplications.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_STORAGE_BUCKET;
delete process.env.REQUIRE_TERMS_ACCEPTANCE;

const uri = process.env.WHOLESALER_APPS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set WHOLESALER_APPS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: WHOLESALER_APPS_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

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
  const sharp = require('sharp');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const M = require('../src/models');
  const proofStorage = require('../src/services/proofStorage');
  const { proofObject, signProofUrls } = proofStorage;
  const { AppError } = require('../src/utils/errors');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = `wa${Date.now().toString(36)}`;
  const made = { users: [] };

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#86efac' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  // multipart/form-data, as the app sends it.
  // A photo is a buffer (png / jpeg above) or { data, type, name }.
  const apply = async (token, fields, photos = []) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    photos.forEach((photo, index) => {
      if (!Buffer.isBuffer(photo)) {
        form.append('proofImages', new Blob([photo.data], { type: photo.type }), photo.name);
        return;
      }
      const isPng = photo === png;
      form.append('proofImages', new Blob([photo], { type: isPng ? 'image/png' : 'image/jpeg' }), `proof${index}.${isPng ? 'png' : 'jpg'}`);
    });
    const res = await fetch(`${base}/auth/convert-to-wholesaler`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const tokenFor = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const makeUser = async (role, extra = {}) => {
    const user = await M.User.create({ name: `WA ${role}`, phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role, ...extra });
    made.users.push(user._id);
    return { user, token: tokenFor(user) };
  };

  try {
    const admin = await makeUser('admin');
    const staff = await makeUser('staff');
    const applicant = await makeUser('buyer', { name: 'Ravi Kumar' });
    const ownPhone = applicant.user.phone;
    const contactPhone = randomPhone();
    const fields = {
      businessName: `Kumar Traders ${suffix}`,
      gstNumber: '22AAAAA0000A1Z5',
      businessAddress: 'Main Road, Rajkot',
      contactPerson: 'Suresh (shop manager)',
      phone: `+91 ${contactPhone.slice(0, 5)} ${contactPhone.slice(5)}`,
    };

    // 1. Proof photos are required, 1 to 3 of them.
    let res = await apply(applicant.token, fields);
    assert.strictEqual(res.status, 400, JSON.stringify(res.json));
    assert.strictEqual(codeOf(res), 'PROOF_REQUIRED');
    assert.match(res.json.message, /at least one proof photo/);
    res = await apply(applicant.token, fields, [png, png, jpeg, png]);
    assert.strictEqual(res.status, 400, 'more than 3 photos refused');
    assert.strictEqual(codeOf(res), 'TOO_MANY_PROOFS');
    assert.strictEqual(res.json.message, 'Add up to 3 proof photos.');
    // Wrong type (HEIC, PDF) or too large: a clear 400, not a server error.
    const fileMessage = 'Use a JPG, PNG or WebP photo up to 5 MB.';
    for (const bad of [
      { data: Buffer.from('not really heic'), type: 'image/heic', name: 'IMG_0001.HEIC' },
      { data: Buffer.from('%PDF-1.4'), type: 'application/pdf', name: 'gst.pdf' },
      { data: Buffer.alloc(5 * 1024 * 1024 + 10, 1), type: 'image/jpeg', name: 'huge.jpg' },
    ]) {
      res = await apply(applicant.token, fields, [bad]);
      assert.strictEqual(res.status, 400, `${bad.name}: ${JSON.stringify(res.json)}`);
      assert.strictEqual(codeOf(res), 'PROOF_FILE_INVALID', bad.name);
      assert.strictEqual(res.json.message, fileMessage);
    }
    // A JPG sent without a type is read by its name; garbage is refused.
    res = await apply(applicant.token, fields, [{ data: Buffer.from('garbage'), type: 'application/octet-stream', name: 'shop.jpg' }]);
    assert.strictEqual(codeOf(res), 'PROOF_UNREADABLE', JSON.stringify(res.json));
    assert.strictEqual((await M.User.findById(applicant.user._id).lean()).businessInfo.status, 'none', 'nothing saved');
    console.log('ok - proof photos required (1 to 3, JPG/PNG/WebP up to 5 MB)');

    // 2. The contact number is checked as a 10-digit Indian mobile.
    for (const bad of ['12345', '1234567890', '+1 415 555 0100', '9999999999']) {
      res = await apply(applicant.token, { ...fields, phone: bad }, [png]);
      assert.strictEqual(res.status, 400, `${bad}: ${JSON.stringify(res.json)}`);
      assert.strictEqual(codeOf(res), 'VALIDATION_ERROR');
    }
    console.log('ok - contact number validated');

    // 3. Applying keeps the account's name and phone; the contact details are the business's.
    const before = Date.now();
    res = await apply(applicant.token, fields, [png, jpeg]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.name, 'Ravi Kumar');
    assert.strictEqual(res.json.data.phone, ownPhone);
    assert.strictEqual(res.json.data.businessInfo.contactPhone, contactPhone);
    assert.strictEqual(res.json.data.businessInfo.proofImages, undefined, 'proofs not sent to the app');
    assert.strictEqual(res.json.data.businessInfo.reviewedBy, undefined);
    let stored = (await M.User.findById(applicant.user._id).lean());
    assert.strictEqual(stored.name, 'Ravi Kumar', 'name unchanged');
    assert.strictEqual(stored.phone, ownPhone, 'sign-in phone unchanged');
    assert.strictEqual(stored.role, 'buyer');
    assert.strictEqual(stored.businessInfo.status, 'pending');
    assert.strictEqual(stored.businessInfo.contactPerson, 'Suresh (shop manager)');
    assert.strictEqual(stored.businessInfo.contactPhone, contactPhone, 'saved as 10 digits');
    assert.ok(stored.businessInfo.appliedAt >= new Date(before - 1000), 'appliedAt recorded');
    assert.strictEqual(stored.businessInfo.proofImages.length, 2);
    for (const url of stored.businessInfo.proofImages) {
      const object = proofObject(url);
      assert.ok(object && object.path.startsWith(`proofs/${applicant.user._id}/`) && object.path.endsWith('.webp'), url);
    }
    const firstProofs = stored.businessInfo.proofImages;
    res = await call('GET', '/auth/me', applicant.token);
    assert.strictEqual(res.json.data.businessInfo.proofImages, undefined);
    assert.strictEqual(res.json.data.businessInfo.status, 'pending');
    console.log('ok - name and phone kept; contact phone, appliedAt and private proofs saved');

    // 4. Applying again needs new photos; the old ones aren't reused.
    res = await apply(applicant.token, { ...fields, phone: contactPhone }, []);
    assert.strictEqual(codeOf(res), 'PROOF_REQUIRED');
    // Storage stand-ins: record deletions; make one upload fail.
    const realUpload = proofStorage.uploadProof;
    const realDelete = proofStorage.deleteProofs;
    const deleted = [];
    proofStorage.deleteProofs = async (urls) => { deleted.push(...urls); };
    let uploadsSoFar = 0;
    proofStorage.uploadProof = async (userId, buffer) => {
      uploadsSoFar += 1;
      if (uploadsSoFar === 2) throw new AppError('storage hiccup', 503, 'STORAGE_ERROR');
      return realUpload(userId, buffer);
    };
    try {
      res = await apply(applicant.token, { ...fields, phone: contactPhone }, [png, jpeg, png]);
      assert.strictEqual(res.status, 503, JSON.stringify(res.json));
      assert.strictEqual(deleted.length, 2, 'the uploads that worked are deleted');
      stored = (await M.User.findById(applicant.user._id).lean());
      assert.deepStrictEqual(stored.businessInfo.proofImages, firstProofs, 'application unchanged');
      proofStorage.uploadProof = realUpload;
      deleted.length = 0;

      res = await apply(applicant.token, { ...fields, phone: contactPhone }, [jpeg]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      stored = (await M.User.findById(applicant.user._id).lean());
      assert.strictEqual(stored.businessInfo.proofImages.length, 1);
      assert.ok(!firstProofs.includes(stored.businessInfo.proofImages[0]));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepStrictEqual(deleted.sort(), [...firstProofs].sort(), 'old proofs deleted after the new ones are saved');
    } finally {
      proofStorage.uploadProof = realUpload;
      proofStorage.deleteProofs = realDelete;
    }
    console.log('ok - applying again replaces the proofs (old deleted; partial upload cleaned up)');

    // 5. Old "wholesaler sign-up" routes make customers with no application.
    const oldPhone = randomPhone();
    res = await call('POST', '/auth/register-phone/wholesaler', null, { name: 'Old App Dealer', phone: oldPhone, password: 'secret1', businessName: `Old Shop ${suffix}` });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.user.role, 'buyer');
    assert.ok(res.json.data.accessToken && res.json.data.refreshToken, 'tokens as before');
    assert.match(res.json.message, /apply for a wholesaler account from Profile/);
    let oldUser = await M.User.findOne({ phone: oldPhone }).lean();
    made.users.push(oldUser._id);
    assert.strictEqual(oldUser.businessInfo.businessName, `Old Shop ${suffix}`);
    assert.strictEqual(oldUser.businessInfo.status, 'none');
    const oldEmail = `${suffix}@example.com`;
    res = await call('POST', '/auth/register/wholesaler', null, { name: 'Old Email Dealer', email: oldEmail, password: 'secret123', phone: randomPhone(), businessName: `Old Email Shop ${suffix}` });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.user.role, 'buyer');
    assert.match(res.json.message, /Profile/);
    oldUser = await M.User.findOne({ email: oldEmail }).lean();
    made.users.push(oldUser._id);
    assert.strictEqual(oldUser.businessInfo.status, 'none');
    res = await call('GET', `/admin/wholesaler-applications?status=pending&search=${encodeURIComponent(`Old Shop ${suffix}`)}`, admin.token);
    assert.strictEqual(res.json.pagination.total, 0, 'not an application');
    console.log('ok - old wholesaler sign-ups make customers');

    // 6. Only admins see the applications.
    res = await call('GET', '/admin/wholesaler-applications', staff.token);
    assert.strictEqual(res.status, 403);
    res = await call('GET', '/admin/wholesaler-applications', applicant.token);
    assert.strictEqual(res.status, 403);
    res = await call('GET', '/admin/wholesaler-applications?status=everything', admin.token);
    assert.strictEqual(res.status, 400);
    console.log('ok - admin only');

    // 7. More than 50 applicants: filtered, searched and paged on the server.
    const baseline = (await call('GET', '/admin/wholesaler-applications', admin.token)).json.counts;
    const now = Date.now();
    const many = [];
    for (let i = 0; i < 55; i += 1) {
      many.push({
        name: `Bulk ${i}`, phone: randomPhone(), passwordHash: 'x', authProvider: 'email', role: 'buyer',
        businessInfo: { businessName: `Bulk ${suffix} ${i}`, status: 'pending', appliedAt: new Date(now - (60 - i) * 60000) },
      });
    }
    many.push(
      { name: 'Done A', phone: randomPhone(), passwordHash: 'x', authProvider: 'email', role: 'wholesaler', businessInfo: { businessName: `Done ${suffix} A`, status: 'accepted', reviewedAt: new Date(now - 3000) } },
      { name: 'Done B', phone: randomPhone(), passwordHash: 'x', authProvider: 'email', role: 'buyer', businessInfo: { businessName: `Done ${suffix} B`, status: 'rejected', gstNumber: `GST${suffix}`.toUpperCase() } },
      { name: 'Done C', phone: randomPhone(), passwordHash: 'x', authProvider: 'email', role: 'buyer', businessInfo: { businessName: `Done ${suffix} C`, status: 'removed', removedAt: new Date(now), removalReason: 'GST lapsed' } },
      { name: 'Gone', phone: randomPhone(), passwordHash: 'x', authProvider: 'email', role: 'buyer', deletedAt: new Date(), businessInfo: { businessName: `Bulk ${suffix} deleted`, status: 'pending' } },
    );
    const inserted = await M.User.insertMany(many);
    made.users.push(...inserted.map((u) => u._id));
    // From before application statuses: a business name and no status.
    const legacy = await M.User.collection.insertOne({ name: 'Legacy Applicant', phone: randomPhone(), authProvider: 'email', role: 'buyer', deletedAt: null, businessInfo: { businessName: `Bulk ${suffix} legacy` }, createdAt: new Date(now - 86400000), updatedAt: new Date(now - 86400000) });
    made.users.push(legacy.insertedId);
    // ...and one whose status was saved as null.
    const legacyNull = await M.User.collection.insertOne({ name: 'Legacy Null', phone: randomPhone(), authProvider: 'email', role: 'buyer', deletedAt: null, businessInfo: { businessName: `Bulk ${suffix} legacy null`, status: null }, createdAt: new Date(now - 2 * 86400000), updatedAt: new Date(now - 2 * 86400000) });
    made.users.push(legacyNull.insertedId);

    res = await call('GET', `/admin/wholesaler-applications?status=pending&search=${encodeURIComponent(`Bulk ${suffix}`)}&limit=50`, admin.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.pagination.total, 57, '55 pending + 2 legacy, deleted left out');
    assert.strictEqual(res.json.data.length, 50);
    assert.strictEqual(res.json.data[0].name, 'Bulk 54', 'newest first');
    assert.strictEqual(res.json.data[0].applicationStatus, 'pending');
    assert.strictEqual(res.json.data[0].passwordHash, undefined, 'no password');
    assert.strictEqual(res.json.data[0].fcmTokens, undefined);
    assert.strictEqual(res.json.pagination.hasNext, true);
    const page2 = await call('GET', `/admin/wholesaler-applications?status=pending&search=${encodeURIComponent(`Bulk ${suffix}`)}&limit=50&page=2`, admin.token);
    assert.strictEqual(page2.json.data.length, 7);
    assert.ok(page2.json.data.find((row) => row.name === 'Legacy Null'), 'null status listed as pending');
    const legacyRow = page2.json.data.find((row) => row.name === 'Legacy Applicant');
    assert.ok(legacyRow, 'legacy applicant listed');
    assert.strictEqual(legacyRow.applicationStatus, 'pending');
    const ids = new Set([...res.json.data, ...page2.json.data].map((row) => row._id));
    assert.strictEqual(ids.size, 57, 'no repeats across pages');
    res = await call('GET', '/admin/wholesaler-applications?limit=500', admin.token);
    assert.strictEqual(res.status, 400, 'limit above 50 refused');

    const counts = (await call('GET', '/admin/wholesaler-applications', admin.token)).json.counts;
    assert.deepStrictEqual(counts, {
      pending: baseline.pending + 57,
      accepted: baseline.accepted + 1,
      rejected: baseline.rejected + 1,
      removed: baseline.removed + 1,
    });
    res = await call('GET', `/admin/wholesaler-applications?status=rejected&search=${encodeURIComponent(`gst${suffix}`)}`, admin.token);
    assert.strictEqual(res.json.data.length, 1, 'search by GST');
    assert.strictEqual(res.json.data[0].name, 'Done B');
    res = await call('GET', `/admin/wholesaler-applications?status=removed&search=${suffix}`, admin.token);
    assert.strictEqual(res.json.data[0].businessInfo.removalReason, 'GST lapsed');
    res = await call('GET', `/admin/wholesaler-applications?status=pending&search=${contactPhone}`, admin.token);
    assert.strictEqual(res.json.data.length, 1, 'search by contact number');
    res = await call('GET', `/admin/wholesaler-applications?status=pending&search=${ownPhone}`, admin.token);
    assert.strictEqual(res.json.data.length, 1, 'search by account phone');
    const row = res.json.data[0];
    assert.strictEqual(row.businessInfo.contactPhone, contactPhone);
    assert.strictEqual(row.businessInfo.proofImages.length, 1, 'proof links for admin');
    console.log('ok - list filtered, searched and paged beyond 50, with counts');

    // 8. Accepting records who decided; the admin gets the application back.
    res = await call('PUT', `/admin/customers/${applicant.user._id}/upgrade`, staff.token, { action: 'accept' });
    assert.strictEqual(res.status, 403);
    res = await call('PUT', `/admin/customers/${applicant.user._id}/upgrade`, admin.token, { action: 'accept' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.role, 'wholesaler');
    assert.strictEqual(res.json.data.businessInfo.reviewedBy.name, 'WA admin');
    assert.strictEqual(res.json.data.businessInfo.proofImages.length, 1);
    assert.strictEqual(res.json.data.passwordHash, undefined);
    stored = await M.User.findById(applicant.user._id).lean();
    assert.strictEqual(String(stored.businessInfo.reviewedBy.id), String(admin.user._id));
    assert.ok(stored.businessInfo.reviewedAt);
    const rejectMe = inserted[0];
    res = await call('PUT', `/admin/customers/${rejectMe._id}/upgrade`, admin.token, { action: 'reject' });
    assert.strictEqual(res.status, 200);
    stored = await M.User.findById(rejectMe._id).lean();
    assert.strictEqual(stored.businessInfo.status, 'rejected');
    assert.strictEqual(stored.businessInfo.reviewedBy.name, 'WA admin');

    // Only a waiting application is decided: a second decision is a 409
    // saying who decided and when.
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    res = await call('PUT', `/admin/customers/${rejectMe._id}/upgrade`, admin.token, { action: 'accept' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.json));
    assert.strictEqual(codeOf(res), 'APPLICATION_NOT_PENDING');
    assert.strictEqual(res.json.message, `This application was already handled by WA admin on ${today}.`);
    assert.strictEqual((await M.User.findById(rejectMe._id).lean()).role, 'buyer', 'not made a wholesaler');
    res = await call('PUT', `/admin/customers/${applicant.user._id}/upgrade`, admin.token, { action: 'reject' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await M.User.findById(applicant.user._id).lean()).businessInfo.status, 'accepted', 'not undone');
    res = await call('PUT', `/admin/customers/${inserted[57]._id}/upgrade`, admin.token, { action: 'accept' });
    assert.strictEqual(res.status, 409, 'removed is not pending');
    assert.match(res.json.message, /wholesale access was removed on/);
    // Two admins at once: exactly one wins.
    const race = await Promise.all([
      call('PUT', `/admin/customers/${inserted[1]._id}/upgrade`, admin.token, { action: 'accept' }),
      call('PUT', `/admin/customers/${inserted[1]._id}/upgrade`, admin.token, { action: 'reject' }),
    ]);
    assert.deepStrictEqual(race.map((r) => r.status).sort(), [200, 409]);
    const raced = await M.User.findById(inserted[1]._id).lean();
    assert.strictEqual(raced.role === 'wholesaler', raced.businessInfo.status === 'accepted', 'role matches the decision');
    // A legacy (null status) application can be decided.
    res = await call('PUT', `/admin/customers/${legacyNull.insertedId}/upgrade`, admin.token, { action: 'accept' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.businessInfo.status, 'accepted');
    const racedAccepted = raced.businessInfo.status === 'accepted' ? 1 : 0;
    const after = (await call('GET', '/admin/wholesaler-applications', admin.token)).json.counts;
    assert.strictEqual(after.pending, counts.pending - 4);
    assert.strictEqual(after.accepted, counts.accepted + 2 + racedAccepted);
    assert.strictEqual(after.rejected, counts.rejected + 1 + (1 - racedAccepted));
    res = await call('GET', `/admin/wholesaler-applications?status=accepted&search=${suffix}`, admin.token);
    assert.strictEqual(res.json.data[0]._id, String(legacyNull.insertedId), 'latest decision first');
    assert.ok(res.json.data.some((row) => row._id === String(applicant.user._id)));
    res = await call('GET', '/auth/me', tokenFor(applicant.user));
    assert.strictEqual(res.json.data.businessInfo.reviewedBy, undefined, 'reviewer stays with the team');
    console.log('ok - reviewedBy and reviewedAt recorded; only pending applications decided (409 otherwise)');

    // 8b. A wholesaler can't apply.
    res = await apply(tokenFor(applicant.user), { ...fields, phone: contactPhone }, [png]);
    assert.strictEqual(res.status, 400, JSON.stringify(res.json));
    assert.strictEqual(codeOf(res), 'ALREADY_WHOLESALER');
    assert.strictEqual(res.json.message, 'Your account already has wholesale prices.');
    console.log('ok - wholesalers cannot apply');

    // 8c. Applying again keeps the earlier decision for admin and clears the removal.
    res = await apply(tokenFor(rejectMe), { ...fields, businessName: `Again ${suffix}`, phone: contactPhone }, [png]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.businessInfo.previousApplications, undefined, 'history stays with the team');
    stored = await M.User.findById(rejectMe._id).lean();
    assert.strictEqual(stored.businessInfo.status, 'pending');
    assert.strictEqual(stored.businessInfo.reviewedAt, null);
    assert.strictEqual(stored.businessInfo.previousApplications.length, 1);
    assert.strictEqual(stored.businessInfo.previousApplications[0].status, 'rejected');
    assert.strictEqual(stored.businessInfo.previousApplications[0].reviewedBy.name, 'WA admin');
    assert.ok(stored.businessInfo.previousApplications[0].reviewedAt);
    const removedUser = inserted[57];
    res = await apply(tokenFor(removedUser), { ...fields, phone: contactPhone }, [jpeg]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    stored = await M.User.findById(removedUser._id).lean();
    assert.strictEqual(stored.businessInfo.removedAt, null);
    assert.strictEqual(stored.businessInfo.removalReason, null);
    assert.strictEqual(stored.businessInfo.removalReasonShared, false);
    assert.strictEqual(stored.businessInfo.previousApplications[0].status, 'removed');
    assert.strictEqual(stored.businessInfo.previousApplications[0].removalReason, 'GST lapsed');
    res = await call('GET', `/admin/customers/${removedUser._id}`, admin.token);
    assert.strictEqual(res.json.data.businessInfo.previousApplications[0].status, 'removed', 'admin sees it');
    console.log('ok - applying again keeps the earlier decision and clears the removal');

    // 9. Customer records: proofs for admins (in the details), never for staff or in the list.
    res = await call('GET', `/admin/customers/${applicant.user._id}`, admin.token);
    assert.strictEqual(res.json.data.businessInfo.proofImages.length, 1);
    // No storage credentials here: the links can't be signed, and say so.
    assert.strictEqual(res.json.data.businessInfo.proofLinksSigned, false);
    assert.strictEqual(res.json.data.businessInfo.proofLinksExpireAt, null);
    res = await call('GET', `/admin/customers/${applicant.user._id}`, staff.token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.businessInfo.proofImages, undefined, 'staff: no proofs');
    assert.strictEqual(res.json.data.businessInfo.proofCount, 1);
    res = await call('GET', `/admin/customers?search=${ownPhone}`, admin.token);
    assert.strictEqual(res.json.data.length, 1);
    assert.strictEqual(res.json.data[0].businessInfo.proofImages, undefined, 'not in the list');
    console.log('ok - proofs only in admin details');

    // 10. Without storage credentials, links are sent as stored.
    const storedUrl = stored.businessInfo.proofImages?.[0] || 'https://storage.googleapis.com/test-bucket/proofs/x/y.webp';
    assert.deepStrictEqual(await signProofUrls([storedUrl, 'https://example.com/a.png']), [storedUrl, 'https://example.com/a.png']);
    assert.strictEqual(proofObject('https://storage.googleapis.com/b/avatars/x.webp'), null, 'only proofs/');
    assert.strictEqual(proofObject('https://storage.googleapis.com/b/proofs/../avatars/x.webp'), null);

    // 11. With a service account (a throwaway key, signed offline), links are
    // V4 signed for 15 minutes.
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FIREBASE_PROJECT_ID = 'oxon-test-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'signer@oxon-test-project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';
    const [signed] = await signProofUrls(['https://storage.googleapis.com/test-bucket/proofs/abc/photo.webp']);
    assert.match(signed, /^https:\/\/storage\.googleapis\.com\/test-bucket\/proofs\/abc\/photo\.webp\?/);
    assert.match(signed, /X-Goog-Algorithm=GOOG4-RSA-SHA256/);
    assert.match(signed, /X-Goog-Expires=(89\d|900)&/, 'about 15 minutes');
    assert.match(signed, /X-Goog-Signature=/);
    const signedUser = await proofStorage.withSignedProofs({ businessInfo: { proofImages: ['https://storage.googleapis.com/test-bucket/proofs/abc/photo.webp'] } });
    assert.strictEqual(signedUser.businessInfo.proofLinksSigned, true);
    assert.ok(new Date(signedUser.businessInfo.proofLinksExpireAt) > new Date(Date.now() + 14 * 60000), 'expiry about 15 minutes away');
    console.log('ok - signed links (V4, 15 minutes); stored links when signing is not possible');
  } finally {
    await M.AdminNotification.deleteMany({ 'data.userId': { $in: made.users } }).catch(() => {});
    await M.RefreshToken.deleteMany({ userId: { $in: made.users } });
    await M.User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS wholesalerApplications');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

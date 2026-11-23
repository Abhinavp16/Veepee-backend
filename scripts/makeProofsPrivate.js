/**
 * One-time: make older wholesaler proof photos private.
 *
 * Proof photos (shop photo, GST certificate, trade licence) used to be
 * uploaded with public access. New uploads are private, and admins see them
 * through 15-minute signed links (src/services/proofStorage.js). This script
 * removes public access from EVERY object already stored under proofs/ in
 * the storage bucket (including files no account points to any more) by
 * calling file.makePrivate() (project-private ACL) on each. Database records
 * are not changed.
 *
 * By default it only lists what it would change (a dry run: it reads the
 * bucket but changes nothing). Nothing is changed unless --confirm is passed:
 *
 *   node scripts/makeProofsPrivate.js              # dry run: list the files
 *   node scripts/makeProofsPrivate.js --confirm    # make them private
 *
 * It also checks the bucket itself: a bucket-level grant to allUsers (e.g.
 * roles/storage.objectViewer) keeps every object public whatever its ACL, so
 * it must be removed in the Cloud console as well. With uniform bucket-level
 * access on, per-object ACLs don't exist and makePrivate() fails: then the
 * bucket IAM policy alone decides.
 *
 * Uses the FIREBASE_* storage settings (from the environment or .env in the
 * current folder); MONGODB_URI is optional and only used to show which
 * listed files accounts still point to. Safe to run more than once. Before
 * running with --confirm, deploy the backend that signs proof links, or the
 * admin panel can no longer open the older photos.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { getStorage } = require('../src/config/firebase');
const { proofObject, PROOF_PREFIX } = require('../src/services/proofStorage');

const confirm = process.argv.includes('--confirm');
const PUBLIC_MEMBERS = ['allUsers', 'allAuthenticatedUsers'];

// Where we are connecting, without the password.
const describeUri = (uri) => String(uri).replace(/\/\/[^@/]*@/, '//***@').split('?')[0];

/** Proof paths (in [bucketName]) that accounts point to, or null without a database. */
async function referencedPaths(bucketName) {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  await mongoose.connect(uri);
  console.log(`Database: ${describeUri(uri)}`);
  const users = await User.find({ 'businessInfo.proofImages.0': { $exists: true } })
    .select('businessInfo.proofImages')
    .lean();
  const paths = new Set();
  for (const user of users) {
    for (const url of user.businessInfo.proofImages || []) {
      const object = proofObject(url);
      if (object && (!bucketName || object.bucket === bucketName)) paths.add(object.path);
    }
  }
  return paths;
}

/** Prints whether the bucket's IAM policy lets anyone read it. */
async function checkBucketAccess(bucket) {
  console.log('');
  console.log('WARNING: object ACLs are not the whole story. Check that the bucket has no bucket-level');
  console.log('public read (allUsers / allAuthenticatedUsers with roles/storage.objectViewer or a legacy');
  console.log('reader role) in Cloud Storage > Permissions; such a grant keeps every proof photo public.');
  try {
    const [metadata] = await bucket.getMetadata();
    const uniform = metadata?.iamConfiguration?.uniformBucketLevelAccess?.enabled;
    console.log(`Uniform bucket-level access: ${uniform ? 'ON (object ACLs are ignored; makePrivate() will fail, only IAM matters)' : 'off (object ACLs apply)'}`);
  } catch (error) {
    console.log(`Could not read the bucket settings: ${error.message}`);
  }
  try {
    const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    const publicGrants = (policy.bindings || [])
      .map((binding) => ({ role: binding.role, members: (binding.members || []).filter((m) => PUBLIC_MEMBERS.includes(m)) }))
      .filter((binding) => binding.members.length);
    if (publicGrants.length === 0) {
      console.log('Bucket IAM policy: no allUsers / allAuthenticatedUsers grants. Good.');
    } else {
      console.log('Bucket IAM policy: PUBLIC ACCESS FOUND. Remove these grants, or proof photos stay public:');
      for (const grant of publicGrants) console.log(`  ${grant.role}: ${grant.members.join(', ')}`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.log(`Could not read the bucket IAM policy (${error.message}). Check it by hand in the Cloud console.`);
  }
}

async function main() {
  console.log(confirm ? 'CONFIRMED RUN: objects will be made private.' : 'DRY RUN: nothing is changed (pass --confirm to change).');

  const bucket = getStorage();
  if (!bucket) {
    console.error('Firebase Storage is not configured (FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_STORAGE_BUCKET), so the bucket cannot be listed. Nothing was changed.');
    const paths = await referencedPaths(null);
    if (paths) console.log(`For reference, accounts point to ${paths.size} proof photo(s) in the database.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Bucket: gs://${bucket.name}, prefix ${PROOF_PREFIX}`);
  const [files] = await bucket.getFiles({ prefix: PROOF_PREFIX, autoPaginate: true });
  const referenced = await referencedPaths(bucket.name);

  console.log(`${files.length} object(s) under ${PROOF_PREFIX}:`);
  for (const file of files) {
    const note = referenced && !referenced.has(file.name) ? '  (no account points to it)' : '';
    console.log(`  gs://${bucket.name}/${file.name}${note}`);
  }
  if (referenced) {
    const listed = new Set(files.map((file) => file.name));
    const missing = [...referenced].filter((path) => !listed.has(path));
    if (missing.length) {
      console.log(`${missing.length} proof photo(s) in the database are not in the bucket:`);
      for (const path of missing) console.log(`  gs://${bucket.name}/${path}`);
    }
  }

  await checkBucketAccess(bucket);

  if (!confirm) {
    console.log('');
    console.log(files.length ? `Run again with --confirm to make these ${files.length} object(s) private.` : 'No objects to change.');
    return;
  }

  let done = 0;
  let failed = 0;
  for (const file of files) {
    try {
      await file.makePrivate();
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`  failed: gs://${bucket.name}/${file.name}: ${error.message}`);
    }
  }
  console.log(`Made private: ${done}. Failed: ${failed}.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

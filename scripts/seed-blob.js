/**
 * One-time seed: uploads local server/data/ JSON files to Vercel Blob.
 *
 * Run locally with your Vercel Blob token:
 *   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx node scripts/seed-blob.js
 *
 * Or copy .env values:
 *   node -r dotenv/config scripts/seed-blob.js dotenv_config_path=server/.env
 *
 * Only uploads: store.json, contacts.json, exports-meta.json
 * Does NOT upload the exports/ directory (those are temporary CSV files).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });

const blobStorage = require('../server/blobStorage');
const fs = require('fs');
const path = require('path');

const FILES_TO_SEED = ['store.json', 'contacts.json', 'exports-meta.json'];
const DATA_DIR = path.join(__dirname, '..', 'server', 'data');

async function seed() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('ERROR: BLOB_READ_WRITE_TOKEN is not set.');
    console.error('Run with:  BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx node scripts/seed-blob.js');
    process.exit(1);
  }

  console.log('Seeding Vercel Blob from server/data/ ...\n');

  for (const filename of FILES_TO_SEED) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP  ${filename}  (not found locally)`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`  ERROR ${filename}: ${err.message}`);
      continue;
    }

    const sizeMB = (Buffer.byteLength(JSON.stringify(data)) / 1024 / 1024).toFixed(2);
    process.stdout.write(`  Uploading ${filename} (${sizeMB} MB) ... `);
    try {
      await blobStorage.writeJSON(filename, data);
      console.log('✓');
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log('\nDone. Your Vercel deployment now has fresh data.');
  console.log('Tip: use Smart Update mode for incremental fetches (far fewer blob writes).');
}

seed().catch(err => { console.error(err); process.exit(1); });

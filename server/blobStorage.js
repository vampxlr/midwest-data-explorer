/**
 * Dual-mode storage abstraction.
 *
 * LOCAL DEV  → reads/writes from server/data/ using the existing sync fs calls
 *              (wrapped in async functions so callers are identical in both modes)
 * VERCEL     → reads/writes from Vercel Blob (object storage)
 *              detected via BLOB_READ_WRITE_TOKEN env var
 *
 * Usage:
 *   const blob = require('./blobStorage');
 *   const data = await blob.readJSON('store.json', {});
 *   await blob.writeJSON('store.json', data);
 */

const path = require('path');
const fs   = require('fs');

// ── Environment detection ─────────────────────────────────────────────────────

const IS_VERCEL = !!process.env.BLOB_READ_WRITE_TOKEN;
const DATA_DIR  = path.join(__dirname, 'data');

// Lazy-load Vercel Blob SDK so local dev doesn't need the package
let sdk = null;
function getSDK() {
  if (!sdk) sdk = require('@vercel/blob');
  return sdk;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find the most-recently-uploaded blob with a given pathname prefix. */
async function latestBlob(pathname) {
  const { list } = getSDK();
  const { blobs } = await list({ prefix: pathname, token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!blobs.length) return null;
  return blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
}

/** Delete ALL blobs with a given pathname prefix (cleans up old versions). */
async function deleteAllBlobs(pathname) {
  const { list, del } = getSDK();
  const { blobs } = await list({ prefix: pathname, token: process.env.BLOB_READ_WRITE_TOKEN });
  if (blobs.length > 0) {
    await del(blobs.map(b => b.url), { token: process.env.BLOB_READ_WRITE_TOKEN });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a JSON file. Returns `defaultVal` if not found or on error.
 */
async function readJSON(filename, defaultVal = null) {
  if (IS_VERCEL) {
    try {
      const blob = await latestBlob(filename);
      if (!blob) return defaultVal;
      const res = await fetch(blob.downloadUrl);
      if (!res.ok) return defaultVal;
      return await res.json();
    } catch (err) {
      console.error(`[blobStorage] readJSON(${filename}) error:`, err.message);
      return defaultVal;
    }
  }

  // Local fs
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultVal;
  }
}

/**
 * Write a JSON file (overwrites any existing version).
 */
async function writeJSON(filename, data) {
  if (IS_VERCEL) {
    const { put } = getSDK();
    // Delete stale versions first to avoid accumulation
    await deleteAllBlobs(filename);
    await put(filename, JSON.stringify(data, null, 2), {
      access:          'private',
      addRandomSuffix: false,
      contentType:     'application/json',
      token:           process.env.BLOB_READ_WRITE_TOKEN,
    });
    return;
  }

  // Local fs (atomic write)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, filename);
  const tmp      = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Read a raw file as a Buffer. Returns null if not found.
 */
async function readFile(filename) {
  if (IS_VERCEL) {
    try {
      const blob = await latestBlob(filename);
      if (!blob) return null;
      const res = await fetch(blob.downloadUrl);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
  }

  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

/**
 * Write a raw file (string or Buffer).
 */
async function writeFile(filename, content, contentType = 'text/plain; charset=utf-8') {
  if (IS_VERCEL) {
    const { put } = getSDK();
    await deleteAllBlobs(filename);
    await put(filename, content, {
      access:          'private',
      addRandomSuffix: false,
      contentType,
      token:           process.env.BLOB_READ_WRITE_TOKEN,
    });
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), content);
}

/**
 * Delete a file (all versions).
 */
async function deleteFile(filename) {
  if (IS_VERCEL) {
    await deleteAllBlobs(filename);
    return;
  }
  const filePath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/**
 * Check if a file exists.
 */
async function fileExists(filename) {
  if (IS_VERCEL) {
    const blob = await latestBlob(filename);
    return !!blob;
  }
  return fs.existsSync(path.join(DATA_DIR, filename));
}

/**
 * Get a download URL for serving a file to the browser.
 * On Vercel returns a signed Blob URL; locally returns the absolute file path
 * (callers use res.sendFile() locally).
 */
async function getDownloadUrl(filename) {
  if (IS_VERCEL) {
    const blob = await latestBlob(filename);
    return blob ? blob.downloadUrl : null;
  }
  const filePath = path.join(DATA_DIR, filename);
  return fs.existsSync(filePath) ? path.resolve(filePath) : null;
}

/**
 * List all files matching a prefix. Returns array of filenames.
 */
async function listFiles(prefix = '') {
  if (IS_VERCEL) {
    const { list } = getSDK();
    const { blobs } = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });
    // Deduplicate by pathname (there may be old versions)
    const seen = new Set();
    return blobs
      .sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .filter(b => { if (seen.has(b.pathname)) return false; seen.add(b.pathname); return true; })
      .map(b => b.pathname);
  }

  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith(prefix))
    .map(f => f);
}

module.exports = {
  IS_VERCEL,
  readJSON,
  writeJSON,
  readFile,
  writeFile,
  deleteFile,
  fileExists,
  getDownloadUrl,
  listFiles,
};

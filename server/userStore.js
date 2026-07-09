/**
 * User account store.
 *
 * IS_CONVEX (CONVEX_URL set) → Vercel/production: read/write to Convex `users` table.
 * Local dev (no CONVEX_URL)  → read/write from server/data/users.json on disk.
 */
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const IS_CONVEX  = !!process.env.CONVEX_URL;
const CONVEX_URL = process.env.CONVEX_URL;
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ── Convex HTTP helpers ────────────────────────────────────────────────────────

async function convexQuery(fnPath, args = {}) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path: fnPath, args, format: 'json' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Convex query ${fnPath} failed: ${JSON.stringify(data)}`);
  return data.value;
}

async function convexMutation(fnPath, args = {}) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path: fnPath, args, format: 'json' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Convex mutation ${fnPath} failed: ${JSON.stringify(data)}`);
  return data.value;
}

// ── Local filesystem helpers ───────────────────────────────────────────────────

function localLoad() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function localSave(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// ── Normalisation helpers ──────────────────────────────────────────────────────

// Internal: keep passwordHash but map userId→id (for auth/login use)
function withId(u) {
  if (!u) return null;
  // eslint-disable-next-line no-unused-vars
  const { _id, _creationTime, userId, ...rest } = u;
  return { ...rest, id: userId ?? rest.id };
}

// Public API: strip passwordHash + internal Convex fields, normalise userId→id
function publicView(u) {
  if (!u) return null;
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, _id, _creationTime, userId, ...rest } = u;
  return { ...rest, id: userId ?? rest.id };
}

// Build the clean payload for convexMutation (no Convex internals, null → omit)
function toConvexArgs(u) {
  const args = {
    userId:       u.userId || u.id,
    username:     u.username,
    passwordHash: u.passwordHash,
    role:         u.role,
    createdAt:    u.createdAt,
  };
  if (u.lastLoginAt) args.lastLoginAt = u.lastLoginAt;
  if (u.email)       args.email       = u.email;
  if (u.provider)    args.provider    = u.provider;
  return args;
}

// ── Public interface ───────────────────────────────────────────────────────────

async function list() {
  if (IS_CONVEX) {
    const users = await convexQuery('users:getAll', {});
    return users.map(publicView);
  }
  return localLoad().map(publicView);
}

async function findByUsername(username) {
  const needle = String(username || '').trim().toLowerCase();
  if (IS_CONVEX) {
    const users = await convexQuery('users:getAll', {});
    const found = users.find(u => u.username.toLowerCase() === needle) || null;
    return withId(found);
  }
  const users = localLoad();
  return users.find(u => u.username.toLowerCase() === needle) || null;
}

async function findById(id) {
  if (IS_CONVEX) {
    const users = await convexQuery('users:getAll', {});
    const found = users.find(u => u.userId === id) || null;
    return withId(found);
  }
  const users = localLoad();
  return users.find(u => u.id === id) || null;
}

async function findByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  if (IS_CONVEX) {
    const users = await convexQuery('users:getAll', {});
    const found = users.find(u => (u.email || '').toLowerCase() === needle) || null;
    return withId(found);
  }
  const users = localLoad();
  return users.find(u => (u.email || '').toLowerCase() === needle) || null;
}

async function create({ username, passwordHash, role, email, provider }) {
  const userId = crypto.randomUUID();
  const now    = new Date().toISOString();

  if (IS_CONVEX) {
    const existing = await findByUsername(username);
    if (existing) throw new Error('Username already exists');
    const user = { userId, username: String(username).trim(), passwordHash, role, createdAt: now };
    if (email)    user.email    = String(email).trim().toLowerCase();
    if (provider) user.provider = provider;
    await convexMutation('users:upsertUser', user);
    return publicView(user);
  }

  const users  = localLoad();
  const needle = String(username).trim().toLowerCase();
  if (users.some(u => u.username.toLowerCase() === needle)) {
    throw new Error('Username already exists');
  }
  const user = { id: userId, username: String(username).trim(), passwordHash, role, createdAt: now, lastLoginAt: null };
  if (email)    user.email    = String(email).trim().toLowerCase();
  if (provider) user.provider = provider;
  users.push(user);
  localSave(users);
  return publicView(user);
}

async function update(id, patch) {
  if (IS_CONVEX) {
    const user = await findById(id);
    if (!user) throw new Error('User not found');
    const updated = { ...user, ...patch };
    await convexMutation('users:upsertUser', toConvexArgs(updated));
    return publicView(updated);
  }

  const users = localLoad();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found');
  users[idx] = { ...users[idx], ...patch };
  localSave(users);
  return publicView(users[idx]);
}

async function remove(id) {
  if (IS_CONVEX) {
    await convexMutation('users:removeUser', { userId: id });
    return;
  }
  const users = localLoad();
  const next  = users.filter(u => u.id !== id);
  if (next.length === users.length) throw new Error('User not found');
  localSave(next);
}

async function recordLogin(id) {
  await update(id, { lastLoginAt: new Date().toISOString() });
}

async function count() {
  if (IS_CONVEX) {
    const users = await convexQuery('users:getAll', {});
    return users.length;
  }
  return localLoad().length;
}

module.exports = { list, findByUsername, findById, findByEmail, create, update, remove, recordLogin, count, publicView };

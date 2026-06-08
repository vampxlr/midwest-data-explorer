/**
 * User account store — persists app-login accounts (username, bcrypt hash, role).
 * All I/O is ASYNC via blobStorage (fs locally, Vercel Blob in prod) — same
 * pattern as exports-meta.json / contacts.json.
 */
const crypto = require('crypto');
const blobStorage = require('./blobStorage');

const STORE_FILE = 'users.json';

async function load() {
  const data = await blobStorage.readJSON(STORE_FILE, null);
  return Array.isArray(data) ? data : [];
}

async function save(users) {
  await blobStorage.writeJSON(STORE_FILE, users);
}

function publicView(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

async function list() {
  const users = await load();
  return users.map(publicView);
}

async function findByUsername(username) {
  const users = await load();
  const needle = String(username || '').trim().toLowerCase();
  return users.find(u => u.username.toLowerCase() === needle) || null;
}

async function findById(id) {
  const users = await load();
  return users.find(u => u.id === id) || null;
}

async function create({ username, passwordHash, role }) {
  const users = await load();
  const needle = String(username).trim().toLowerCase();
  if (users.some(u => u.username.toLowerCase() === needle)) {
    throw new Error('Username already exists');
  }
  const user = {
    id: crypto.randomUUID(),
    username: String(username).trim(),
    passwordHash,
    role,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  users.push(user);
  await save(users);
  return publicView(user);
}

async function update(id, patch) {
  const users = await load();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found');
  users[idx] = { ...users[idx], ...patch };
  await save(users);
  return publicView(users[idx]);
}

async function remove(id) {
  const users = await load();
  const next = users.filter(u => u.id !== id);
  if (next.length === users.length) throw new Error('User not found');
  await save(next);
}

async function recordLogin(id) {
  const users = await load();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return;
  users[idx].lastLoginAt = new Date().toISOString();
  await save(users);
}

async function count() {
  const users = await load();
  return users.length;
}

module.exports = { list, findByUsername, findById, create, update, remove, recordLogin, count, publicView };

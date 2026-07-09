/**
 * Custom username/password auth — small internal tool, no external provider.
 * Issues signed JWTs (HS256) on login; `requireAuth`/`requireRole` middleware
 * validate the `Authorization: Bearer <token>` header on protected routes.
 *
 * Roles:
 *   admin  — full access, including purge/delete and user management
 *   editor — can run data refresh/aggregation/exports, cannot purge or manage users
 */
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const userStore = require('./userStore');

const JWT_SECRET  = process.env.JWT_SECRET;
const TOKEN_TTL   = '7d';
const SALT_ROUNDS = 12;

if (!JWT_SECRET) {
  console.warn('[auth] WARNING: JWT_SECRET is not set — set it in server/.env before going to production.');
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET || 'dev-only-insecure-secret',
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET || 'dev-only-insecure-secret');
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Attaches req.user = { id, username, role } if a valid token is present; 401 otherwise.
 * Accepts the token either as `Authorization: Bearer <token>` (normal requests)
 * or `?token=<token>` query param (EventSource/SSE connections, which can't set headers).
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, headerToken] = header.split(' ');
  const token = (scheme === 'Bearer' && headerToken) ? headerToken : req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/** Restricts a route to one or more roles. Use AFTER requireAuth.
 *  Platform roles 'owner' and 'superadmin' pass every normal role gate.
 *  (Deletion endpoints use requireOwner — superadmins cannot delete.) */
const PLATFORM_ROLES = ['owner', 'superadmin'];
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!PLATFORM_ROLES.includes(req.user.role) && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

/** Owner-only gate — the one role that can delete platform entities. */
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the Owner can perform this action' });
  }
  next();
}

const requireAdmin = requireRole('admin');

module.exports = {
  signToken, verifyToken, hashPassword, verifyPassword,
  requireAuth, requireRole, requireAdmin, requireOwner,
};

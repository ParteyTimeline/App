const bcrypt = require('bcryptjs');
const store = require('./store');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

// Usernames end up as plain-object keys all over the codebase (rooms.js's
// playerSelections/pools, public/app.js's rendering) — USERNAME_RE alone
// still allows names like "constructor" or "__proto__" through (they're
// valid alphanumeric/underscore strings), and those aren't own properties
// at all: `obj['constructor']` resolves to Object.prototype's own
// constructor function instead of undefined, so the usual `sel || []`
// fallback never triggers and later array-only calls throw. Block anyone
// from ever claiming one of these names in the first place, rather than
// hardening every dictionary access site individually.
const RESERVED_USERNAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__']);

function isReservedUsername(name) {
  return RESERVED_USERNAMES.has(name);
}

function register(username, password) {
  if (!USERNAME_RE.test(username || '') || isReservedUsername(username)) {
    throw Object.assign(new Error('invalid_username'), { code: 'invalid_username' });
  }
  if (!password || password.length < 6) {
    throw Object.assign(new Error('weak_password'), { code: 'weak_password' });
  }
  if (store.getUser(username)) {
    throw Object.assign(new Error('exists'), { code: 'exists' });
  }
  const hash = bcrypt.hashSync(password, 10);
  store.createUser(username, hash);
}

function verify(username, password) {
  const user = store.getUser(username || '');
  if (!user) return false;
  return bcrypt.compareSync(password || '', user.passwordHash);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Nicht eingeloggt', code: 'not_authenticated' });
  }
  next();
}

// Playlist library management (rename/delete/clear-cache/import/export) acts
// on a shared resource every player draws from, not something scoped to one
// account — requireAuth alone would let any player who's simply logged in
// wipe out playlists other people contributed. ADMIN_PASSWORD_HASH is a
// single shared secret the server operator sets (see .env.example); once
// verified via POST /api/admin/login it's remembered on the session, same
// pattern as requireAuth's req.session.user.
function verifyAdmin(password) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) return false;
  return bcrypt.compareSync(password || '', hash);
}

// The Android app sets LOCAL_CONTROL_TOKEN itself (see NodeRuntime.kt) and
// hands the same secret only to its own host-role WebView (see
// GameWebViewActivity.kt's AndroidLocalBridge) — a request carrying it is
// the hosting device managing its own playlist library, which needs no
// separate password prompt. LOCAL_CONTROL_TOKEN is never set for a plain
// `npm start`/Docker deployment, so this never applies there.
function hasLocalControlToken(req) {
  const token = process.env.LOCAL_CONTROL_TOKEN;
  if (!token) return false;
  return req.headers['x-local-control-token'] === token || req.query.localToken === token;
}

function requireAdmin(req, res, next) {
  if (hasLocalControlToken(req)) return next();
  if (!process.env.ADMIN_PASSWORD_HASH) {
    return res.status(503).json({ error: 'Admin-Funktionen sind nicht konfiguriert', code: 'admin_not_configured' });
  }
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin-Passwort erforderlich', code: 'admin_required' });
  }
  next();
}

module.exports = { register, verify, requireAuth, verifyAdmin, requireAdmin, USERNAME_RE, isReservedUsername };

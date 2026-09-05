const bcrypt = require('bcryptjs');
const store = require('./store');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

function register(username, password) {
  if (!USERNAME_RE.test(username || '')) {
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
    return res.status(401).json({ error: 'Nicht eingeloggt' });
  }
  next();
}

module.exports = { register, verify, requireAuth, USERNAME_RE };

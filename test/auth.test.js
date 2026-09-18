const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/auth');

// Usernames end up as plain-object keys throughout the codebase (rooms.js's
// playerSelections/pools, public/app.js's rendering). A name matching an
// Object.prototype property resolves to that inherited value instead of
// undefined on a bare `obj[name]` lookup, breaking the usual `|| []`/
// `|| {}` fallback wherever one exists — see isReservedUsername's callers
// in auth.register() and server.js's /api/local/join.

test('rejects every own property name of Object.prototype', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(auth.isReservedUsername(name), true, `expected "${name}" to be reserved`);
  }
});

test('rejects __proto__ specifically (not an own property, but just as dangerous as a key)', () => {
  assert.equal(auth.isReservedUsername('__proto__'), true);
});

test('accepts ordinary usernames', () => {
  for (const name of ['alice', 'p1', 'Team-Host', 'guest_42']) {
    assert.equal(auth.isReservedUsername(name), false);
  }
});

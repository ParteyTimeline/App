const { test } = require('node:test');
const assert = require('node:assert/strict');
const isolatedStore = require('./helpers/isolated-store.cjs');

// store.users/store.playlists used to be plain objects, so a lookup by an
// attacker/user-controlled key (a login username, a playlist ID straight
// from a route param) could resolve to an INHERITED Object.prototype
// member (e.g. `({})['constructor']` is the Object function, not
// undefined) instead of a real miss. Every caller downstream assumed
// "found object or undefined" and broke on the former. Backing both with
// a real Map closes this for every current and future caller, not just
// the ones already known to be reachable with a hostile key.

for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
  test(`getUser('${key}') is a real miss, not an inherited property`, () => {
    const store = isolatedStore();
    assert.equal(store.getUser(key), undefined);
  });
  test(`getPlaylist('${key}') is a real miss, not an inherited property`, () => {
    const store = isolatedStore();
    assert.equal(store.getPlaylist(key), undefined);
  });
}

test('getUser rejects a non-string username instead of throwing', () => {
  const store = isolatedStore();
  assert.equal(store.getUser(123), undefined);
  assert.equal(store.getUser(null), undefined);
  assert.equal(store.getUser(undefined), undefined);
});

test('users and playlists round-trip through persistence correctly', () => {
  const store = isolatedStore();
  store.createUser('Alice', 'hash123');
  store.addPlaylist({ id: 'p1', name: 'Party Mix', tracks: [] });
  assert.equal(store.getUser('alice').username, 'Alice');
  assert.equal(store.getPlaylist('p1').name, 'Party Mix');
  const all = store.listPlaylists();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'p1');
});

test('createUser still rejects a duplicate (case-insensitive) username', () => {
  const store = isolatedStore();
  store.createUser('Alice', 'hash123');
  assert.throws(() => store.createUser('alice', 'otherhash'), { code: 'exists' });
});

test('a fresh store still starts with no users or playlists', () => {
  const store = isolatedStore();
  assert.equal(store.getUser('constructor'), undefined);
  assert.equal(store.listPlaylists().length, 0);
});

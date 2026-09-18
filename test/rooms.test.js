const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../src/rooms');

// One track per player is enough for startGame() to draw a starter card for
// every team without erroring on an empty pool.
function trackFor(username) {
  return { id: `track-${username}`, y: 2000, title: `${username}'s song`, artist: 'Artist' };
}

function makeRoom({ teamCount = 4, shuffleTeamOrder } = {}) {
  const room = rooms.createRoom({ hostUsername: 'p0', teamCount, shuffleTeamOrder });
  const usernames = ['p0'];
  for (let i = 1; i < teamCount; i++) {
    const u = `p${i}`;
    rooms.addPlayer(room, u);
    usernames.push(u);
  }
  for (const u of usernames) {
    rooms.setPlayerPlaylists(room, u, [{ id: `pl-${u}`, name: u, tracks: [trackFor(u)] }]);
  }
  return room;
}

test('shuffleTeamOrder defaults to true when not specified', () => {
  const room = rooms.createRoom({ hostUsername: 'solo', teamCount: 3 });
  assert.equal(room.shuffleTeamOrder, true);
});

test('shuffleTeamOrder can be explicitly disabled', () => {
  const room = rooms.createRoom({ hostUsername: 'solo', teamCount: 3, shuffleTeamOrder: false });
  assert.equal(room.shuffleTeamOrder, false);
});

test('disabled shuffleTeamOrder keeps teams in creation order at startGame()', () => {
  const room = makeRoom({ teamCount: 4, shuffleTeamOrder: false });
  rooms.startGame(room, 'p0');
  assert.deepEqual(room.teams.map((t) => t.id), ['t0', 't1', 't2', 't3']);
});

test('enabled shuffleTeamOrder varies the turn order across games', () => {
  const orders = new Set();
  for (let i = 0; i < 40; i++) {
    const room = makeRoom({ teamCount: 4, shuffleTeamOrder: true });
    rooms.startGame(room, 'p0');
    assert.equal(room.teams.length, 4); // every team kept, none dropped
    orders.add(room.teams.map((t) => t.id).join(','));
  }
  // With 24 possible orderings, seeing only one across 40 independent games
  // would mean shuffling isn't actually happening.
  assert.ok(orders.size > 1, `expected varied turn orders, got only: ${[...orders]}`);
});

test('shuffling reorders the array but never changes a team\'s own identity', () => {
  const room = makeRoom({ teamCount: 4, shuffleTeamOrder: true });
  const expectedBysId = new Map(room.teams.map((t) => [t.id, { name: t.name, color: t.color }]));
  rooms.startGame(room, 'p0');
  for (const t of room.teams) {
    const expected = expectedBysId.get(t.id);
    assert.equal(t.name, expected.name);
    assert.equal(t.color, expected.color);
  }
});

test('shuffling drops empty teams the same way as the unshuffled path', () => {
  // teamCount: 4 but only 2 players -> team t2/t3 stay empty and must be
  // dropped regardless of shuffle order.
  const room = rooms.createRoom({ hostUsername: 'p0', teamCount: 4, shuffleTeamOrder: true });
  rooms.addPlayer(room, 'p1');
  for (const u of ['p0', 'p1']) {
    rooms.setPlayerPlaylists(room, u, [{ id: `pl-${u}`, name: u, tracks: [trackFor(u)] }]);
  }
  rooms.startGame(room, 'p0');
  assert.equal(room.teams.length, 2);
  assert.deepEqual(new Set(room.teams.map((t) => t.id)), new Set(['t0', 't1']));
});

test('a rejected start (need_more_teams) leaves empty teams in place instead of deleting them', () => {
  // teamCount: 4 but only the host joined -> only 1 non-empty team, so
  // startGame() must throw before doing anything else. It used to filter
  // room.teams down to the non-empty ones FIRST and only check the count
  // after, permanently losing the 3 empty (but still joinable) teams even
  // though the start itself never went through.
  const room = rooms.createRoom({ hostUsername: 'p0', teamCount: 4 });
  rooms.setPlayerPlaylists(room, 'p0', [{ id: 'pl-p0', name: 'p0', tracks: [trackFor('p0')] }]);
  assert.throws(() => rooms.startGame(room, 'p0'), { code: 'need_more_teams' });
  assert.equal(room.teams.length, 4);
  assert.equal(room.phase, 'lobby');

  // A second player can still join one of the teams that would have been
  // deleted, and starting now succeeds.
  rooms.addPlayer(room, 'p1');
  rooms.setPlayerPlaylists(room, 'p1', [{ id: 'pl-p1', name: 'p1', tracks: [trackFor('p1')] }]);
  rooms.startGame(room, 'p0');
  assert.equal(room.phase, 'ready');
});

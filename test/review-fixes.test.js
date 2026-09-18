const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const makeServer = require('./helpers/review-server.cjs');
const rooms = require('../src/rooms');

async function fixture(t, options) {
  const server = await makeServer(options);
  t.after(() => server.close());
  return server;
}
async function guest(server, name = 'ReviewGuest') {
  return server.call('/api/local/join', { method: 'POST', body: { name } });
}
function archive(server, metadata, entries = []) {
  return server.archive.buildTarGz([{ name: 'playlist.json', data: Buffer.from(JSON.stringify(metadata)) }, ...entries]);
}
const track = { id: '123', t: 'A song', a: 'An artist', y: 2000 };

test('ordinary server deployment rejects passwordless local join', async t => {
  const server = await fixture(t, { local: false });
  assert.equal((await guest(server)).status, 503);
});

test('local join cannot claim a registered name or a prototype property', async t => {
  const server = await fixture(t);
  server.users.set('registered', { username: 'Registered', passwordHash: 'unused' });
  for (const name of ['Registered', 'constructor', '__proto__']) {
    assert.equal((await guest(server, name)).status, 400);
  }
});

test('malformed URL is rejected and the HTTP server remains usable', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  const response = await server.call('/api/playlists', { method: 'POST', cookie, body: { url: 123 } });
  assert.equal(response.status, 400);
  assert.equal((await server.call('/api/me', { cookie })).status, 200);
});

test('malformed WebSocket UTF-8 closes only that connection', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  const ws = new WebSocket(server.base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
  ws.send(Buffer.from([0xff]), { binary: false });
  await closed;
  assert.equal((await server.call('/api/me', { cookie })).status, 200);
});

test('invalid track metadata is rejected without a persisted playlist', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  for (const value of [null, { ...track, y: '<img src=x onerror=alert(1)>' }]) {
    const response = await server.call('/api/playlists/import', { method: 'POST', cookie, admin: true, body: archive(server, { name: 'Bad', tracks: [value] }) });
    assert.equal(response.status, 400);
    assert.equal(server.playlists.size, 0);
  }
});

test('a guest leaving a completed game receives no automatic rejoin code', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  server.rooms.createRoom({ hostUsername: 'ReviewGuest' }).phase = 'gameover';
  const response = await server.call('/api/local/join', { method: 'POST', cookie, body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.json.code, null);
});

test('REGRESSION: two sessions choosing the same name before room creation cannot share host identity', async t => {
  const server = await fixture(t);
  const first = await guest(server, 'FutureHost');
  const second = await guest(server, 'FutureHost');
  assert.equal(first.status, 200);
  // Rejecting the duplicate or assigning distinct stable identities is valid.
  if (second.status >= 400) return;
  const created = await server.call('/api/rooms', { method: 'POST', cookie: first.cookie, body: {} });
  assert.equal(created.status, 200);
  const otherIdentity = await server.call('/api/me', { cookie: second.cookie });
  const room = server.rooms.getRoom(created.json.code);
  assert.notEqual(otherIdentity.json.username, room.hostUsername, 'separate cookies must not grant the same host identity');
});

test('REGRESSION: a no-playlists start failure preserves all lobby team slots', () => {
  const room = rooms.createRoom({ hostUsername: 'host', teamCount: 4, shuffleTeamOrder: false });
  rooms.addPlayer(room, 'guest');
  const before = structuredClone(room.teams);
  assert.throws(() => rooms.startGame(room, 'host'), { code: 'no_playlists_selected' });
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.teams, before, 'rejected starts must not remove teams that later guests can join');
});

test('REGRESSION: failed cache restoration does not commit a ready playlist', async t => {
  const server = await fixture(t, { failAudioWrite: true });
  const { cookie } = await guest(server);
  const body = archive(server, { formatVersion: 1, name: 'Disk full fixture', tracks: [track] }, [{ name: 'audio/123.mp3', data: Buffer.from('audio fixture') }]);
  const response = await server.call('/api/playlists/import', { method: 'POST', cookie, admin: true, body });
  assert.ok(response.status >= 400, 'cache failure must be reported');
  assert.equal(server.playlists.size, 0, 'a failed import must not leave a ready playlist in the shared library');
});

test('REGRESSION: imported covers cannot trigger requests to a private host during prefetch', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  const privateUrl = 'http://127.0.0.1:9000/private-review-fixture';
  const imported = await server.call('/api/playlists/import', {
    method: 'POST', cookie, admin: true,
    body: archive(server, { formatVersion: 1, name: 'Cover boundary', tracks: [{ ...track, cover: privateUrl }] }),
  });
  if (imported.status >= 400) return; // Reject at ingestion or at fetch time.
  assert.equal(imported.status, 200);
  await server.call('/api/playlists/' + imported.json.id + '/prefetch', { method: 'POST', cookie });
  const playlist = server.playlists.get(imported.json.id);
  for (let i = 0; i < 100 && playlist.cacheStatus === 'caching'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.notEqual(playlist.cacheStatus, 'caching', 'fixture prefetch must finish before inspecting requests');
  assert.ok(!server.requests.includes(privateUrl), 'an archive-controlled cover crossed the private-network fetch boundary');
});

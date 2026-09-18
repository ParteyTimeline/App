const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const makeServer = require('./helpers/review-server.cjs');

async function fixture(t, options) {
  const server = await makeServer(options);
  t.after(() => server.close());
  return server;
}
async function guest(server, name = 'SecTestGuest') {
  return server.call('/api/local/join', { method: 'POST', body: { name } });
}

// Admin-only routes (playlist import/rename/delete/export, and the
// separate host-control toggle) gate access via auth.requireAdmin or an
// exact LOCAL_CONTROL_TOKEN header match — a regression in either check
// would expose playlist-library management to any logged-in player.

test('admin-only routes are closed by default (no ADMIN_PASSWORD_HASH, no local token presented)', async t => {
  const server = await fixture(t); // ADMIN_PASSWORD_HASH is never set by this fixture
  const { cookie } = await guest(server);
  const response = await server.call('/api/playlists/import', { method: 'POST', cookie, body: Buffer.from('x') });
  assert.equal(response.status, 503);
  assert.equal(response.json.code, 'admin_not_configured');
});

test('a request without the local-control-token header is rejected even when local mode is configured', async t => {
  const server = await fixture(t); // local:true -> LOCAL_CONTROL_TOKEN is set server-side
  const { cookie } = await guest(server);
  const response = await server.call('/api/playlists/import', { method: 'POST', cookie, body: Buffer.from('x') });
  assert.notEqual(response.status, 200);
});

test('/api/local/host-control rejects an incorrect token', async t => {
  const server = await fixture(t);
  const response = await server.call('/api/local/host-control', {
    method: 'POST',
    body: { active: false },
  }); // review-server's `admin: true` sends the CORRECT token; omitting it sends none
  assert.equal(response.status, 403);
});

// /api/register runs the same reserved-username check as /api/local/join
// (see auth.isReservedUsername) — this exercises it through the actual
// registration endpoint, not just the local-join path already covered in
// test/review-fixes.test.js.
test('registration rejects usernames that collide with Object.prototype members', async t => {
  const server = await fixture(t);
  for (const username of ['constructor', '__proto__', 'toString']) {
    const response = await server.call('/api/register', { method: 'POST', body: { username, password: 'a-real-password' } });
    assert.equal(response.status, 400);
  }
});

// The WebSocket upgrade path checks the session before accepting the
// connection at all (src/ws.js) — a regression here would let an
// unauthenticated client subscribe to room state.
test('a WebSocket upgrade without a valid session is refused', async t => {
  const server = await fixture(t);
  const ws = new WebSocket(server.base.replace('http:', 'ws:'));
  t.after(() => ws.terminate());
  const outcome = await Promise.race([
    once(ws, 'open').then(() => 'open'),
    once(ws, 'error').then(() => 'error'),
    once(ws, 'unexpected-response').then(() => 'unexpected-response'),
  ]);
  assert.notEqual(outcome, 'open');
});

// maxPayload (src/ws.js) caps frame size so a hostile/broken client can't
// force unbounded buffer allocation server-side — sending an oversized
// frame must close only that connection, not the whole process.
test('an oversized WebSocket frame closes only that connection', async t => {
  const server = await fixture(t);
  const { cookie } = await guest(server);
  const ws = new WebSocket(server.base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
  ws.send(Buffer.alloc(200 * 1024)); // over the 64 KiB maxPayload
  await closed;
  assert.equal((await server.call('/api/me', { cookie })).status, 200);
});

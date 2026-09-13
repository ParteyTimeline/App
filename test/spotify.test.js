const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const originalExec = childProcess.execFile;
let failure = false;
childProcess.execFile = (command, args, options, callback) => {
  assert.equal(command, 'python3');
  assert.equal(args[1], '64WfneVI8dqmpd6T6QKAMs');
  callback(failure ? new Error('unavailable') : null, JSON.stringify({ name: 'Playlist', total: 271,
    queries: Array.from({ length: 271 }, (_, i) => ({ title: `Song ${i}`, artist: 'Artist' })), truncated: false }));
};
const spotify = require('../src/spotify');
childProcess.execFile = originalExec;

// The pure-Node full-playlist path (see spotify.test.js's dedicated tests
// below) is tried first now, ahead of the Python/spotapi fallback these
// tests target — fetch is mocked to fail it immediately (no appServerConfig
// in this "page") so these deterministically exercise the Python tier
// instead of depending on live network access.
const noNodePathFetch = async () => ({ ok: true, text: async () => '<html>no config here</html>' });

test('full Spotify import returns all 271 queries', async () => {
  const originalFetch = global.fetch;
  global.fetch = noNodePathFetch;
  try {
    const result = await spotify.fetchPlaylistTracks('64WfneVI8dqmpd6T6QKAMs');
    assert.equal(result.queries.length, 271);
    assert.equal(result.truncated, false);
  } finally { global.fetch = originalFetch; }
});
test('tool failure explicitly marks embed fallback and truncation', async () => {
  failure = true;
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '<script id="__NEXT_DATA__">' + JSON.stringify({
    props: { pageProps: { state: { data: { entity: { name: 'Fallback', trackList:
      Array.from({ length: 100 }, (_, i) => ({ title: `Song ${i}`, subtitle: 'Artist' })) } } } } },
  }) + '</script>' });
  try {
    const result = await spotify.fetchPlaylistTracks('64WfneVI8dqmpd6T6QKAMs');
    assert.equal(result.fallback, true);
    assert.equal(result.truncated, true);
    assert.equal(result.queries.length, 100);
  } finally { global.fetch = originalFetch; failure = false; }
});
test('invalid playlist IDs never launch the helper', async () => {
  await assert.rejects(spotify.fetchPlaylistTracks('../invalid'), /Ungültige/);
});

// --- Pure-Node full-playlist read (no Python) ------------------------------
// Mocks the whole handshake spotify.js's fetchFullPlaylistNode drives:
// homepage (clientVersion + JS bundle link + sp_t cookie) -> anonymous
// access token -> client token -> persisted-query hash (scraped from the
// bundle) -> paginated partner GraphQL query. Verified for real against the
// live API during development (see git history); this keeps that path under
// fast, deterministic, offline test coverage instead of relying on network.
test('pure-Node playlist read paginates and skips non-tracks', async () => {
  failure = true; // irrelevant here since the Node path succeeds and is never overridden
  const originalFetch = global.fetch;
  const track = (n, artist = 'Artist') => ({
    itemV2: { data: { __typename: 'Track', name: `Song ${n}`, uri: `spotify:track:id${n}`,
      artists: { items: [{ profile: { name: artist } }] } } },
  });
  // fetchFullPlaylistNode advances offset by each page's RAW item count
  // (before track-type filtering), so the second page's key must match the
  // first page's items.length (3), not the number of real tracks in it (2).
  const pages = {
    0: { items: [track(1), { itemV2: { data: { __typename: 'Episode', name: 'Not a song' } } }, track(2)], totalCount: 5 },
    3: { items: [track(3), track(4)], totalCount: 5 },
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://open.spotify.com/') {
      return {
        ok: true,
        headers: { getSetCookie: () => ['sp_t=abc123; Path=/; Domain=.spotify.com'] },
        text: async () => `<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: '1.0.0.test' })).toString('base64')}</script>` +
          '<script src="https://cdn.example/web-player/web-player.abc.js"></script>',
      };
    }
    if (u === 'https://cdn.example/web-player/web-player.abc.js') {
      return { ok: true, text: async () => '..."fetchPlaylist","query","deadbeef1234"...' };
    }
    if (u.startsWith('https://open.spotify.com/api/token')) {
      return { ok: true, json: async () => ({ accessToken: 'tok', clientId: 'cid', accessTokenExpirationTimestampMs: Date.now() + 3600000 }) };
    }
    if (u === 'https://clienttoken.spotify.com/v1/clienttoken') {
      return { ok: true, json: async () => ({ response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: { token: 'ctok' } }) };
    }
    if (u.startsWith('https://api-partner.spotify.com/pathfinder/v1/query')) {
      const offset = Number(new URL(u).searchParams.get('variables') && JSON.parse(new URL(u).searchParams.get('variables')).offset);
      const page = pages[offset];
      return { ok: true, json: async () => ({ data: { playlistV2: { name: 'Mocked Playlist', content: page } } }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const result = await spotify.fetchPlaylistTracks('64WfneVI8dqmpd6T6QKAMs');
    assert.equal(result.fallback, undefined);
    assert.equal(result.truncated, false);
    assert.equal(result.total, 5);
    assert.equal(result.skipped, 1); // the Episode entry
    assert.deepEqual(result.queries.map((q) => q.title), ['Song 1', 'Song 2', 'Song 3', 'Song 4']);
  } finally { global.fetch = originalFetch; failure = false; }
});

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

test('full Spotify import returns all 271 queries', async () => {
  const result = await spotify.fetchPlaylistTracks('64WfneVI8dqmpd6T6QKAMs');
  assert.equal(result.queries.length, 271);
  assert.equal(result.truncated, false);
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

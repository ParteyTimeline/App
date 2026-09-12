const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const deezer = require('../src/deezer');
const youtube = require('../src/youtube');
const mb = require('../src/musicbrainz');
const spotify = require('../src/spotify');
const originalSpotify = spotify.findSongPreview;
const originals = { fetch: global.fetch, fallback: youtube.findSongPreview, year: mb.getEarliestReleaseYear };
afterEach(() => { spotify.findSongPreview = originalSpotify; global.fetch = originals.fetch; youtube.findSongPreview = originals.fallback; mb.getEarliestReleaseYear = originals.year; });
const q = { title: 'Song', artist: 'Artist' };
const hit = (id, title = 'Song', artist = 'Artist') => ({ id, title, artist: { name: artist } });
function setup(hits, details) {
  spotify.findSongPreview = async () => null;
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    return { ok: true, json: async () => url.includes('/search/') ? { data: hits } : details[url.split('/').at(-1)] };
  };
  mb.getEarliestReleaseYear = async () => null;
  return requested;
}
test('skips unrelated first result and recovers another matching release', async () => {
  const requested = setup([hit(1, 'Other Song'), hit(2), hit(3, 'Song - 2020 Remaster')], {
    2: { ...hit(2), preview: 'url', release_date: 'unknown' },
    3: { ...hit(3, 'Song - 2020 Remaster'), preview: 'url', release_date: '1990-01-01' },
  });
  youtube.findSongPreview = async () => { throw new Error('fallback should not run'); };
  const result = await deezer.matchExternalTracks([q]);
  assert.equal(result.tracks[0].id, 3);
  assert.equal(result.deezer, 1);
  assert.equal(result.youtube, 0);
  assert.ok(!requested.some((u) => u.endsWith('/track/1')));
});
test('tries another edition when the first has no preview', async () => {
  setup([hit(1), hit(2)], { 1: { ...hit(1), release_date: '1990-01-01' },
    2: { ...hit(2), release_date: '1990-01-01', preview: 'url' } });
  const result = await deezer.matchExternalTracks([q]);
  assert.equal(result.tracks[0].id, 2);
});
test('uses YouTube fallback and counts its source', async () => {
  setup([], {});
  youtube.findSongPreview = async () => ({ id: 'youtube:abcdefghijk', t: 'Song', a: 'Artist', y: 1990 });
  const result = await deezer.matchExternalTracks([q]);
  assert.equal(result.youtube, 1);
  assert.equal(result.deezer, 0);
});
test('fallback failures preserve progress and other results', async () => {
  setup([], {});
  youtube.findSongPreview = async () => { throw new Error('provider offline'); };
  const progress = [];
  const result = await deezer.matchExternalTracks([q], (done) => progress.push(done));
  assert.equal(result.matched, 0);
  assert.deepEqual(progress, [1]);
});
test('video selection rejects covers, remixes, wrong artists and live streams', () => {
  const candidates = ['Other - Song', 'Artist - Song (Cover)', 'Artist - Song (Remix)']
    .map((title) => ({ id: 'abcdefghijk', title }));
  candidates.push({ id: 'abcdefghijk', title: 'Artist - Song', is_live: true });
  assert.equal(youtube.selectSongVideo(candidates, q), null);
  assert.equal(youtube.selectSongVideo([{ id: '12345678901', title: 'Song', channel: 'Artist - Topic' }], q).id, '12345678901');
  assert.equal(youtube.selectSongVideo([{ id: '12345678901', title: 'Artist - Song (Official Video)' }], q).id, '12345678901');
});

test('original Spotify preview is preferred before Deezer', async () => {
  const requests = setup([], {});
  spotify.findSongPreview = async () => ({ id: 'spotify:1234567890123456789012', y: 1990 });
  const result = await deezer.matchExternalTracks([{ ...q, spotifyId: '1234567890123456789012' }]);
  assert.equal(result.spotify, 1);
  assert.equal(requests.length, 0);
});
test('Spotify search runs after Deezer and before YouTube', async () => {
  setup([], {});
  const calls = [];
  spotify.findSongPreview = async (query, options) => { calls.push(options.search); return { id: 'spotify:1234567890123456789012', y: 1990 }; };
  youtube.findSongPreview = async () => { assert.fail('YouTube must not run'); };
  const result = await deezer.matchExternalTracks([q]);
  assert.equal(result.spotify, 1);
  assert.deepEqual(calls, [true]);
});
test('native Deezer playlists also use Spotify when their preview is missing', async () => {
  setup([], {});
  global.fetch = async (url) => ({ ok: true, json: async () => url.includes('/tracks?')
    ? { data: [{ id: 1 }] } : url.includes('/search/') ? { data: [] } : hit(1) });
  spotify.findSongPreview = async () => ({ id: 'spotify:1234567890123456789012', y: 1990 });
  const tracks = await deezer.buildPlaylistTracks('10');
  assert.equal(tracks[0].id, 'spotify:1234567890123456789012');
});

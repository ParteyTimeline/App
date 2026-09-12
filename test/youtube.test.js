const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const musicbrainz = require('../src/musicbrainz');
const youtube = require('../src/youtube');
const originalFetch = global.fetch;
const originalFind = musicbrainz.findRecording;
afterEach(() => { global.fetch = originalFetch; musicbrainz.findRecording = originalFind; });

function recording(title, artist, year, score = 100) {
  return { id: `${artist}-${year}`, title, score, 'first-release-date': `${year}-01-01`,
    'artist-credit': [{ name: artist, artist: { id: artist, name: artist } }] };
}
function respond(recordings) {
  global.fetch = async () => ({ ok: true, json: async () => ({ recordings }) });
}

test('matches exact metadata and chooses earliest matching release', async () => {
  respond([recording('Song', 'Someone else', 1970), recording('Song', 'Artist', 2001), recording('Song', 'Artist', 1990)]);
  const result = await musicbrainz.findRecording('Artist', 'Song');
  assert.equal(result.y, 1990);
  assert.equal(result.a, 'Artist');
});
test('rejects wrong titles, low scores and missing dates', async () => {
  respond([recording('Song live', 'Artist', 1990), recording('Song', 'Artist', 1990, 50), recording('Song', 'Artist', 'unknown')]);
  assert.equal(await musicbrainz.findRecording('Artist', 'Song'), null);
});
test('rejects ambiguous title-only matches', async () => {
  respond([recording('Song', 'Artist', 1990), recording('Song', 'Other', 1980)]);
  assert.equal(await musicbrainz.findRecording('', 'Song'), null);
});
test('service errors fail import instead of silently dropping tracks', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(musicbrainz.findRecording('Artist', 'Song'), /500/);
});
test('YouTube imports retain video IDs, skip unmatched entries and report progress', async () => {
  musicbrainz.findRecording = async (artist, title) => title === 'Song' ? { t: title, a: artist, y: 1990, cover: null } : null;
  const progress = [];
  const result = await youtube.matchPlaylistTracks([
    { videoId: 'abcdefghijk', title: 'Song', artist: 'Artist' },
    { videoId: '12345678901', title: 'Unknown' },
    { videoId: '../../oops', title: 'Song' },
  ], (done, total) => progress.push([done, total]));
  assert.equal(result.matched, 1);
  assert.equal(result.total, 3);
  assert.equal(result.tracks[0].id, 'youtube:abcdefghijk');
  assert.equal(result.tracks[0].y, 1990);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

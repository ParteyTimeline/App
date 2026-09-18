const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const musicbrainz = require('../src/musicbrainz');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function recording(title, artist, year, score = 100) {
  return { id: `${artist}-${year}`, title, score, 'first-release-date': `${year}-01-01`,
    'artist-credit': [{ name: artist, artist: { id: artist, name: artist } }] };
}
function respond(recordings) {
  global.fetch = async () => ({ ok: true, json: async () => ({ recordings }) });
}

// getEarliestReleaseYear() hits the same fuzzy full-text search endpoint as
// findRecording() and used to trust every returned recording's year with no
// identity check at all — a lower-scoring, differently-titled/differently-
// credited hit (a search endpoint can and does return those alongside the
// real one) could drag the chosen year earlier than the actual song's.

test('picks the earliest year among genuinely matching recordings', async () => {
  respond([recording('Song', 'Artist', 2001), recording('Song', 'Artist', 1990)]);
  assert.equal(await musicbrainz.getEarliestReleaseYear('Artist', 'Song'), 1990);
});

test('ignores a lower-scoring hit for a different song by the same artist', async () => {
  respond([recording('Song', 'Artist', 2020), recording('Song Live', 'Artist', 1980, 50)]);
  assert.equal(await musicbrainz.getEarliestReleaseYear('Artist', 'Song'), 2020);
});

test('ignores an earlier-dated recording by a completely different artist', async () => {
  respond([recording('Song', 'Artist', 2020), recording('Song', 'Someone Else', 1975)]);
  assert.equal(await musicbrainz.getEarliestReleaseYear('Artist', 'Song'), 2020);
});

test('returns null when nothing confidently matches', async () => {
  respond([recording('Different Song', 'Artist', 1990), recording('Song', 'Other', 1980)]);
  assert.equal(await musicbrainz.getEarliestReleaseYear('Artist', 'Song'), null);
});

test('returns null (not a throw) on a service error, so callers keep their existing year', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await musicbrainz.getEarliestReleaseYear('Artist', 'Song'), null);
});

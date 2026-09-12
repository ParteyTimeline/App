const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const spotify = require('../src/spotify');
const mb = require('../src/musicbrainz');
const originalFetch = global.fetch;
const originalFind = mb.findRecording;
afterEach(() => { global.fetch = originalFetch; mb.findRecording = originalFind; });
const id = '1234567890123456789012';
function embed(artist = 'Artist', preview = 'https://p.scdn.co/mp3-preview/abc') {
  const entity = { type: 'track', title: 'Song', artists: [{ name: artist }],
    audioPreview: { url: preview }, releaseDate: { isoString: '2000-01-01' } };
  const payload = { props: { pageProps: { state: { data: { entity } } } } };
  global.fetch = async () => ({ ok: true, text: async () =>
    '<script id="__NEXT_DATA__">' + JSON.stringify(payload) + '</script>' });
  mb.findRecording = async () => ({ y: 1990 });
}
test('Spotify preview keeps its ID and uses corrected release year', async () => {
  embed();
  const track = await spotify.findSongPreview({ spotifyId: id, title: 'Song', artist: 'Artist' });
  assert.equal(track.id, `spotify:${id}`);
  assert.equal(track.y, 1990);
  assert.equal(await spotify.getFreshPreviewUrl(id), 'https://p.scdn.co/mp3-preview/abc');
});
test('missing audio and mismatched artists are rejected', async () => {
  embed('Other');
  assert.equal(await spotify.findSongPreview({spotifyId:id,title:'Song',artist:'Artist'}), null);
  embed('Artist', null);
  assert.equal(await spotify.findSongPreview({spotifyId:id,title:'Song',artist:'Artist'}), null);
});
test('preview redirects are restricted to Spotify preview CDN URLs', () => {
  assert.equal(spotify.validPreviewUrl('https://evil.test/mp3-preview/abc'), null);
  assert.equal(spotify.validPreviewUrl('http://p.scdn.co/mp3-preview/abc'), null);
  assert.equal(spotify.validPreviewUrl('https://p.scdn.co.evil.test/mp3-preview/abc'), null);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSafeExternalUrl } = require('../src/url-safety');
const makeServer = require('./helpers/review-server.cjs');

test('REGRESSION: a trailing DNS root dot cannot bypass the localhost restriction', () => {
  assert.equal(isSafeExternalUrl('http://localhost:9000/cover'), false);
  assert.equal(isSafeExternalUrl('http://localhost.:9000/cover'), false,
    'the absolute form of localhost must receive the same loopback restriction');
});

test('REGRESSION: cover prefetch must not fetch the absolute localhost hostname', async t => {
  const server = await makeServer();
  t.after(() => server.close());
  const login = await server.call('/api/local/join', { method: 'POST', body: { name: 'UrlReviewGuest' } });
  assert.equal(login.status, 200);
  const cover = 'http://localhost.:9000/private-review-fixture';
  server.playlists.set('absolute-localhost', {
    id: 'absolute-localhost', name: 'Legacy cover fixture', status: 'ready',
    tracks: [{ id: '123', t: 'Song', a: 'Artist', y: 2000, cover }],
  });
  const response = await server.call('/api/playlists/absolute-localhost/prefetch', { method: 'POST', cookie: login.cookie });
  assert.equal(response.status, 200);
  const playlist = server.playlists.get('absolute-localhost');
  for (let i = 0; i < 100 && playlist.cacheStatus === 'caching'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.notEqual(playlist.cacheStatus, 'caching', 'prefetch must finish before requests are checked');
  // The fixture intercepts fetch, so no real local/private service is contacted.
  assert.ok(!server.requests.includes(cover), 'actual cover downloader fetched the localhost alias');
});

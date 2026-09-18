const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const deezer = require('../src/deezer');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

// resolveToPlaylistId() used to fetch whatever URL it was given, following
// redirects automatically, with no host check at all — full SSRF: a caller
// could make the server issue a request to any host/port it named. It's
// only ever supposed to talk to Deezer's own domains.

test('a bare numeric ID is accepted without any network request', async () => {
  global.fetch = async () => { throw new Error('should not fetch'); };
  assert.equal(await deezer.resolveToPlaylistId('123456'), '123456');
});

test('resolves a real deezer.com playlist link', async () => {
  global.fetch = async (url) => {
    assert.match(url.toString(), /^https:\/\/www\.deezer\.com\//);
    return { status: 200, url: 'https://www.deezer.com/playlist/987654', headers: new Map() };
  };
  assert.equal(await deezer.resolveToPlaylistId('https://www.deezer.com/playlist/987654'), '987654');
});

test('rejects a non-Deezer host outright, with no network request', async () => {
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(deezer.resolveToPlaylistId('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(deezer.resolveToPlaylistId('http://internal-host/x'));
});

test('rejects a URL that only carries "deezer.com" in its query string', async () => {
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(deezer.resolveToPlaylistId('http://internal-host/x?source=deezer.com'));
});

test('follows a Deezer short-link redirect to another Deezer host', async () => {
  global.fetch = async (url) => {
    const u = url.toString();
    if (u === 'https://deezer.com/share/abc') {
      return { status: 302, headers: new Map([['location', 'https://www.deezer.com/playlist/42']]) };
    }
    return { status: 200, url: 'https://www.deezer.com/playlist/42', headers: new Map() };
  };
  assert.equal(await deezer.resolveToPlaylistId('https://deezer.com/share/abc'), '42');
});

test('rejects a redirect that points away from Deezer to an internal host', async () => {
  global.fetch = async (url) => {
    const u = url.toString();
    if (u === 'https://deezer.com/share/abc') {
      return { status: 302, headers: new Map([['location', 'http://169.254.169.254/secrets']]) };
    }
    throw new Error('should not follow the malicious redirect');
  };
  await assert.rejects(deezer.resolveToPlaylistId('https://deezer.com/share/abc'));
});

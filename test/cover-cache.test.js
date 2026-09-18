const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

// cover-cache.js's cacheFromUrl() is the one place an admin-imported
// playlist archive's `cover` field (untrusted, unlike a normal Deezer/
// Spotify-sourced cover) can make this server issue an outbound request —
// see src/url-safety.js. Loaded fresh per test via a temp CACHE_DIR
// override so file writes never touch the real data/cover-cache/.
function freshCoverCache() {
  delete require.cache[require.resolve('../src/cover-cache.js')];
  const mod = require('../src/cover-cache.js');
  return mod;
}

test('rejects a direct request to a loopback host, with no network request', async () => {
  const coverCache = freshCoverCache();
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(coverCache.cacheFromUrl('t1', 'http://127.0.0.1:9000/x'));
});

test('rejects a direct request to a private (RFC1918) host', async () => {
  const coverCache = freshCoverCache();
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(coverCache.cacheFromUrl('t1', 'http://10.0.0.5/x'));
  await assert.rejects(coverCache.cacheFromUrl('t1', 'http://192.168.1.1/x'));
});

test('rejects the AWS/GCP metadata link-local address', async () => {
  const coverCache = freshCoverCache();
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(coverCache.cacheFromUrl('t1', 'http://169.254.169.254/latest/meta-data/'));
});

test('rejects a non-http(s) scheme', async () => {
  const coverCache = freshCoverCache();
  global.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(coverCache.cacheFromUrl('t1', 'file:///etc/passwd'));
});

test('rejects a redirect that points from a public host to a private one', async () => {
  const coverCache = freshCoverCache();
  global.fetch = async (url) => {
    if (url.toString() === 'https://public.example.com/cover.jpg') {
      return { status: 302, headers: new Map([['location', 'http://127.0.0.1:9000/x']]) };
    }
    throw new Error('should not follow the malicious redirect');
  };
  await assert.rejects(coverCache.cacheFromUrl('t1', 'https://public.example.com/cover.jpg'));
});

test('accepts and stores a real public image, following a safe redirect', async () => {
  const coverCache = freshCoverCache();
  const testId = 'cover-cache-test-fixture-track';
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // minimal JPEG-ish marker bytes
  global.fetch = async (url) => {
    if (url.toString() === 'https://public.example.com/short-link') {
      return { status: 302, headers: new Map([['location', 'https://public.example.com/real-cover.jpg']]) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
  try {
    const dest = await coverCache.cacheFromUrl(testId, 'https://public.example.com/short-link');
    assert.ok(fs.existsSync(dest));
  } finally {
    coverCache.remove(testId); // never leave the fixture file behind, pass or fail
  }
});

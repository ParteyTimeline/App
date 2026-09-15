const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cover-cache');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Track IDs contain ':' (e.g. "spotify:123", "youtube:abc") — not filename-safe.
function cacheKey(trackId) {
  return String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cachePath(trackId) {
  return path.join(CACHE_DIR, cacheKey(trackId) + '.img');
}

function isCached(trackId) {
  return fs.existsSync(cachePath(trackId));
}

function remove(trackId) {
  const p = cachePath(trackId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function writeAtomic(trackId, buffer) {
  ensureCacheDir();
  const dest = cachePath(trackId);
  const tmp = dest + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, dest);
  return dest;
}

// Mirrors audio-cache.js's cacheFromUrl — downloads the actual cover bytes
// instead of holding onto Deezer/Spotify's CDN URL, so it can be served
// through the same same-origin endpoint a Nearby peer's tunnel already
// reaches, instead of requiring the peer's own device to have internet
// access to fetch it directly (see server.js's /api/track/:id/cover).
async function cacheFromUrl(trackId, url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Leere Antwort');
  return writeAtomic(trackId, buf);
}

// Used to restore a cover from a playlist export archive (see server.js's
// /api/playlists/import) without re-fetching it from the live CDN.
function cacheFromBuffer(trackId, buffer) {
  return writeAtomic(trackId, buffer);
}

// Deezer/Spotify cover URLs are effectively always JPEG in practice, but
// sniff the actual bytes rather than trust that — cheap, and avoids ever
// serving the wrong Content-Type if that changes.
function contentTypeFor(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function serveCached(trackId, res) {
  const buf = fs.readFileSync(cachePath(trackId));
  res.set({ 'Content-Type': contentTypeFor(buf), 'Cache-Control': 'private, max-age=86400' });
  res.send(buf);
}

module.exports = { CACHE_DIR, isCached, cachePath, cacheFromUrl, cacheFromBuffer, serveCached, remove };

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'audio-cache');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Track IDs contain ':' (e.g. "spotify:123", "youtube:abc") — not filename-safe.
function cacheKey(trackId) {
  return String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cachePath(trackId) {
  return path.join(CACHE_DIR, cacheKey(trackId) + '.mp3');
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

// Downloads and caches the actual audio bytes instead of just holding onto a
// signed CDN URL — those expire, but a local file lets play offline later.
async function cacheFromUrl(trackId, url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Leere Antwort');
  return writeAtomic(trackId, buf);
}

function cacheFromBuffer(trackId, buffer) {
  return writeAtomic(trackId, buffer);
}

// Mirrors the Range-request handling in youtube-audio.js's streamPreview,
// just reading from a cached file on disk instead of an in-memory buffer.
function serveCached(trackId, req, res) {
  const file = cachePath(trackId);
  const size = fs.statSync(file).size;
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes' });
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.set('Content-Length', String(size));
  fs.createReadStream(file).pipe(res);
}

module.exports = { CACHE_DIR, isCached, cachePath, cacheFromUrl, cacheFromBuffer, serveCached, remove };

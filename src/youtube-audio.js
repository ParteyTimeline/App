const { spawn } = require('child_process');

// Keep only a small in-memory clip cache. No media or signed URLs are persisted.
const cache = new Map();
let active = 0;
const MAX_ACTIVE = 3;

function createClip(videoId, signal) {
  return new Promise((resolve, reject) => {
    const download = spawn('yt-dlp', [
      '--ignore-config', '--no-playlist', '--no-warnings', '--no-progress',
      '--js-runtimes', 'node', '--socket-timeout', '15', '--retries', '1',
      '-f', 'bestaudio', '-o', '-', '--', `https://www.youtube.com/watch?v=${videoId}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const encoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '30',
      '-vn', '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('YouTube-Zeitlimit erreicht')), 90000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      download.stdout.unpipe(encoder.stdin);
      download.kill('SIGKILL');
      encoder.kill('SIGKILL');
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    }
    function abort() { finish(new Error('Wiedergabe abgebrochen')); }
    signal.addEventListener('abort', abort, { once: true });
    download.on('error', finish);
    encoder.on('error', finish);
    // ffmpeg closes its input after 30 seconds; EPIPE is expected then.
    encoder.stdin.on('error', () => {});
    download.stdout.on('error', finish);
    encoder.stdout.on('error', finish);
    encoder.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) return finish(new Error('Audioclip zu groß'));
      chunks.push(chunk);
    });
    encoder.on('close', (code) => {
      if (code !== 0 || !bytes) finish(new Error('YouTube-Audio nicht verfügbar'));
      else finish();
    });
    download.stdout.pipe(encoder.stdin);
    if (signal.aborted) abort();
  });
}

async function streamPreview(videoId, req, res) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).send('Ungültige Video-ID');
  let clip = cache.get(videoId);
  if (!clip) {
    if (active >= MAX_ACTIVE) return res.status(503).set('Retry-After', '5').send('Bitte erneut versuchen');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    active++;
    try {
      clip = await createClip(videoId, controller.signal);
      cache.set(videoId, clip);
      if (cache.size > 32) cache.delete(cache.keys().next().value);
    } catch (e) {
      if (!res.destroyed) res.status(502).send('YouTube-Audio nicht verfügbar');
      return;
    } finally {
      active--;
      res.removeListener('close', abort);
    }
  }
  if (res.destroyed) return;
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' });
  // Mobile browsers request byte ranges for seeking and replay.
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let start, end;
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, clip.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= clip.length) {
      return res.status(416).set('Content-Range', `bytes */${clip.length}`).end();
    }
    return res.status(206).set('Content-Range', `bytes ${start}-${end}/${clip.length}`).send(clip.subarray(start, end + 1));
  }
  res.send(clip);
}

module.exports = { streamPreview, createClip };

const musicbrainz = require('./musicbrainz');
const youtube = require('./youtube');
const spotify = require('./spotify');
const { sameSong } = require('./song-match');

const DEEZER_API = 'https://api.deezer.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only Deezer's own domains — detectSource() in server.js only routes here
// after already classifying the pasted link as Deezer by hostname, but
// re-checking here means this function stays safe to call with untrusted
// input on its own, and closes the window between that check and this
// fetch. Without a host allowlist, this function would fetch ANY URL a
// caller handed it (with automatic redirect-following) — full SSRF: the
// server itself issuing a request to any host/port a caller named.
const ALLOWED_DEEZER_HOST_SUFFIXES = ['deezer.com', 'dzcdn.net'];

function isAllowedDeezerHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOWED_DEEZER_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

function isAllowedDeezerUrl(url) {
  return (url.protocol === 'https:' || url.protocol === 'http:') && isAllowedDeezerHost(url.hostname);
}

async function resolveToPlaylistId(input) {
  const trimmed = String(input || '').trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed);
  } catch (e) {
    throw new Error('Das ist kein Deezer-Playlist-Link');
  }
  if (!isAllowedDeezerUrl(url)) throw new Error('Das ist kein Deezer-Playlist-Link');

  // Redirects are followed manually (not fetch's own redirect:'follow') so
  // every hop's target host is checked too — a Deezer short link is
  // allowed to redirect to another Deezer page, never to an arbitrary or
  // internal/loopback host.
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new Error('Link konnte nicht geöffnet werden');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next;
      try {
        next = new URL(res.headers.get('location'), current);
      } catch (e) {
        throw new Error('Das ist kein Deezer-Playlist-Link');
      }
      if (!isAllowedDeezerUrl(next)) throw new Error('Das ist kein Deezer-Playlist-Link');
      current = next;
      continue;
    }
    const m = current.toString().match(/playlist\/(\d+)/);
    if (m) return m[1];
    throw new Error('Das ist kein Deezer-Playlist-Link');
  }
  throw new Error('Das ist kein Deezer-Playlist-Link');
}

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 429 && attempt < 4) {
    await sleep(400 * (attempt + 1));
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error('Deezer antwortete mit Status ' + res.status);
  const json = await res.json();
  if (json && json.error) throw new Error(json.error.message || 'Deezer-Fehler');
  return json;
}

async function fetchPlaylistMeta(playlistId) {
  return fetchJson(`${DEEZER_API}/playlist/${playlistId}`);
}

async function fetchAllTrackIds(playlistId) {
  const ids = [];
  let next = `${DEEZER_API}/playlist/${playlistId}/tracks?limit=100`;
  while (next) {
    const json = await fetchJson(next);
    for (const t of json.data || []) ids.push(t.id);
    next = json.next || null;
  }
  return ids;
}

// Deezer doesn't error when it's throttling us — it silently omits the
// `preview` field instead. Hitting it too fast makes MOST tracks look
// preview-less even though they aren't. So: retry a missing preview a few
// times with backoff before believing the track genuinely has none.
async function fetchTrackDetail(id, attempt = 0) {
  let d;
  try {
    d = await fetchJson(`${DEEZER_API}/track/${id}`, attempt);
  } catch (e) {
    return null;
  }
  if (d && !d.preview && attempt < 3) {
    await sleep(350 * (attempt + 1));
    return fetchTrackDetail(id, attempt + 1);
  }
  return d;
}

// Low, staggered concurrency — the same throttling shows up as connection
// resets / empty fields under a burst, not clean 429s, so low-and-slow beats
// a high limit plus retries.
async function mapLimit(items, limit, stepDelayMs, fn, onProgress) {
  const results = new Array(items.length);
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      done++;
      if (onProgress) onProgress(done, items.length);
      if (stepDelayMs) await sleep(stepDelayMs);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function buildPlaylistTracks(playlistId, onProgress) {
  const ids = await fetchAllTrackIds(playlistId);
  const details = await mapLimit(ids, 2, 180, async (id) => {
    const d = await fetchTrackDetail(id);
    if (!d) return null;
    if (d.preview && validYear(d.release_date)) return toGameTrack(d);
    return matchSong({ title: d.title, artist: d.artist?.name });
  }, onProgress);
  return details.filter(Boolean);
}

async function getFreshPreviewUrl(trackId) {
  const d = await fetchTrackDetail(trackId);
  if (!d || !d.preview) throw new Error('Keine Vorschau verfügbar');
  return d.preview;
}

async function searchTracks(query) {
  const json = await fetchJson(`${DEEZER_API}/search/track?q=${encodeURIComponent(query)}&limit=10`);
  return json.data || [];
}

// Deezer's release_date is often a remaster/reissue/compilation date, not
// the song's true original release year (e.g. "Where Is The Love?" shows
// 2022 on Deezer — the real original is 2003). Cross-check against
// MusicBrainz's first-release-date and take whichever is EARLIER; MB
// lookups fail closed (return null on any error/no-match), so this only
// ever improves the year, never makes an import fail or block on it.
async function toGameTrack(d) {
  const artist = (d.artist && d.artist.name) || 'Unbekannt';
  const title = d.title_short || d.title;
  let y = parseInt(String(d.release_date).slice(0, 4), 10);
  const mbYear = await musicbrainz.getEarliestReleaseYear(artist, title);
  if (mbYear && mbYear < y) y = mbYear;
  return {
    id: String(d.id),
    t: title,
    a: artist,
    y,
    cover: (d.album && (d.album.cover_medium || d.album.cover_small)) || null,
  };
}

// Try alternate catalog editions before searching YouTube. Candidate details
// are checked again because search and detail responses can disagree.
function validYear(date) {
  const year = Number(String(date || '').slice(0, 4));
  return Number.isInteger(year) && year > 1900 && year <= new Date().getFullYear();
}

// Searches Deezer's own catalog for a matching, playable, plausibly-dated
// recording of (q.title, q.artist) — one step of matchSong's cascade, but
// also reused standalone by server.js's offline-cache prefetch to retry a
// different service when a track's original source has since lost its
// preview (previews get swapped out, region-locked, or removed over time).
async function matchViaSearch(q) {
  const title = (q.title || '').trim();
  if (!title || !q.artist) return null;
  let hits = [];
  try { hits = await searchTracks(`${q.artist} ${title}`); } catch (e) { return null; }
  const seen = new Set();
  for (const hit of hits) {
    const candidateTitle = hit.title || hit.title_short;
    if (seen.has(hit.id) || !sameSong(q, candidateTitle, [hit.artist?.name])) continue;
    seen.add(hit.id);
    const d = await fetchTrackDetail(hit.id);
    if (!d || !d.preview || !sameSong(q, d.title || d.title_short,
      [d.artist?.name, ...(d.contributors || []).map((a) => a.name)])) continue;
    const year = Number(String(d.release_date || '').slice(0, 4));
    if (!Number.isInteger(year) || year <= 1900 || year > new Date().getFullYear()) continue;
    return toGameTrack(d);
  }
  return null;
}

async function matchSong(q) {
    const title = (q.title || '').trim();
    if (!title || !q.artist) return null;
    if (q.spotifyId) {
      try { const track = await spotify.findSongPreview(q); if (track) return track; } catch (e) { /* Try Deezer. */ }
    }
    const viaDeezer = await matchViaSearch(q);
    if (viaDeezer) return viaDeezer;
    try { const track = await spotify.findSongPreview(q, { search: true }); if (track) return track; } catch (e) { /* YouTube is last. */ }
    try { return await youtube.findSongPreview(q); } catch (e) { return null; }
}

async function matchExternalTracks(queries, onProgress) {
  const results = await mapLimit(queries, 2, 200, matchSong, onProgress);
  const tracks = results.filter(Boolean);
  const youtubeCount = tracks.filter((t) => String(t.id).startsWith('youtube:')).length;
  const spotifyCount = tracks.filter((t) => String(t.id).startsWith('spotify:')).length;
  return { tracks, matched: tracks.length, total: queries.length,
    spotify: spotifyCount, deezer: tracks.length - youtubeCount - spotifyCount, youtube: youtubeCount };
}

module.exports = {
  matchViaSearch,
  resolveToPlaylistId,
  fetchPlaylistMeta,
  buildPlaylistTracks,
  getFreshPreviewUrl,
  matchExternalTracks,
  mapLimit,
};

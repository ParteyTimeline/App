const musicbrainz = require('./musicbrainz');
const youtube = require('./youtube');
const spotify = require('./spotify');
const { sameSong } = require('./song-match');

const DEEZER_API = 'https://api.deezer.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveToPlaylistId(input) {
  let url = String(input || '').trim();
  if (/^\d+$/.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error('Link konnte nicht geöffnet werden');
  }
  const finalUrl = res.url || url;
  const m = finalUrl.match(/playlist\/(\d+)/);
  if (m) return m[1];
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
    id: d.id,
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

async function matchSong(q) {
    const title = (q.title || '').trim();
    if (!title || !q.artist) return null;
    if (q.spotifyId) {
      try { const track = await spotify.findSongPreview(q); if (track) return track; } catch (e) { /* Try Deezer. */ }
    }
    let hits = [];
    try { hits = await searchTracks(`${q.artist} ${title}`); } catch (e) { /* Try the fallback. */ }
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
  resolveToPlaylistId,
  fetchPlaylistMeta,
  buildPlaylistTracks,
  getFreshPreviewUrl,
  matchExternalTracks,
  mapLimit,
};

// Deezer's `release_date` on a track is the date of whatever catalog
// edition happens to be indexed (a 2022 remaster, a streaming reissue,
// a "Best Of" compilation) — NOT the song's actual original release year.
// This is exactly the trap HitStar's own README warns about ("mp3 tags
// often have the sampler's date, not the true first release") and
// recommends MusicBrainz's "first release date" to fix. Same idea here:
// take the EARLIEST first-release-date among all matching recordings —
// live versions, remixes and reissues all come after the original by
// definition, so the minimum is a good proxy for "when this song first
// came out".
const MB_API = 'https://musicbrainz.org/ws/2/recording/';
// MusicBrainz's API etiquette asks for a User-Agent that identifies the app
// and gives them a way to reach the operator — set MUSICBRAINZ_USER_AGENT
// in .env (see .env.example) rather than relying on this generic fallback.
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || 'PareyTimeline/1.0 (no contact set — see .env.example)';
const MIN_INTERVAL_MS = 1100; // MusicBrainz's anonymous-access limit is 1 req/s

let lastRequestAt = 0;
async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function extractYear(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function escapeLucene(s) {
  return String(s || '').replace(/["\\]/g, '\\$&');
}

// Returns the earliest plausible release year found, or null (network
// error, no matches, rate-limited) — callers should keep whatever year
// they already had in that case, never block an import on this.
async function getEarliestReleaseYear(artist, title, attempt = 0) {
  const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
  const url = `${MB_API}?query=${encodeURIComponent(query)}&fmt=json&limit=10`;
  try {
    await throttle();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    // 503 is MusicBrainz's "you're going too fast, back off" — transient,
    // not "this song has no data". Worth one retry; anything else (or a
    // repeat failure) just falls back to Deezer's own date.
    if (res.status === 503 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return getEarliestReleaseYear(artist, title, attempt + 1);
    }
    if (!res.ok) return null;
    const json = await res.json();
    const years = (json.recordings || [])
      .map((r) => extractYear(r['first-release-date']))
      .filter((y) => y && y > 1900 && y <= new Date().getFullYear());
    if (years.length === 0) return null;
    return Math.min(...years);
  } catch (e) {
    return null;
  }
}

module.exports = { getEarliestReleaseYear };

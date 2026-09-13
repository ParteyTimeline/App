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
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || 'ParteyTimeline/1.0 (no contact set - see .env.example)';
const MIN_INTERVAL_MS = 1100; // MusicBrainz's anonymous-access limit is 1 req/s

let nextRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextRequestAt);
  nextRequestAt = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
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
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
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

// Built via the RegExp constructor (not a /literal/) so a runtime whose
// engine lacks Unicode property-escape support fails HERE, catchably —
// a literal with the same pattern throws an uncatchable SyntaxError while
// the file is still being parsed. That's not hypothetical: the Android
// app's embedded nodejs-mobile build lacks it, and an uncaught exception
// during require() takes the whole embedding process down with it.
function safeRegex(pattern, flags, fallback) {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return fallback;
  }
}
// Fallback ranges (used only when \p{} isn't supported), built from hex
// code points rather than literal characters so this file stays plain
// ASCII: combining-mark blocks for MARK_RE, and the letter/digit blocks
// covering Latin, Greek, Cyrillic, Hebrew, Arabic, CJK, Kana and Hangul for
// NON_ALPHANUMERIC_RE — not exhaustive of Unicode, but enough for song
// titles/artist names.
function codeRange(startHex, endHex) {
  return String.fromCodePoint(parseInt(startHex, 16)) + '-' + String.fromCodePoint(parseInt(endHex, 16));
}
const MARK_FALLBACK = [['0300', '036f'], ['1ab0', '1aff'], ['1dc0', '1dff'], ['20d0', '20ff'], ['fe20', 'fe2f']]
  .map(([a, b]) => codeRange(a, b)).join('');
const LETTER_DIGIT_FALLBACK = [
  ['0030', '0039'], ['0041', '005a'], ['0061', '007a'], // ASCII digits/letters
  ['00c0', '02af'], // Latin-1 Supplement + Latin Extended
  ['0370', '04ff'], // Greek + Cyrillic
  ['0590', '06ff'], // Hebrew + Arabic
  ['3040', '30ff'], // Hiragana + Katakana
  ['4e00', '9fff'], // CJK Unified Ideographs
  ['ac00', 'd7a3'], // Hangul syllables
].map(([a, b]) => codeRange(a, b)).join('');

const MARK_RE = safeRegex('\\p{M}', 'gu', new RegExp('[' + MARK_FALLBACK + ']', 'g'));
const NON_ALPHANUMERIC_RE = safeRegex('[^\\p{L}\\p{N}]', 'gu', new RegExp('[^' + LETTER_DIGIT_FALLBACK + ']', 'g'));

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(MARK_RE, '')
    .toLowerCase().replace(NON_ALPHANUMERIC_RE, '');
}

// A high search score alone is not proof of identity: also check title and
// artist, and reject ambiguous title-only matches from different artists.
async function findRecording(artist, title, attempt = 0) {
  const query = `recording:"${escapeLucene(title)}"` +
    (artist ? ` AND artist:"${escapeLucene(artist)}"` : '');
  await throttle();
  const res = await fetch(`${MB_API}?query=${encodeURIComponent(query)}&fmt=json&limit=100`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if ((res.status === 503 || res.status === 429) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return findRecording(artist, title, attempt + 1);
  }
  if (!res.ok) throw new Error('MusicBrainz antwortete mit Status ' + res.status);
  const json = await res.json();
  const matches = (json.recordings || []).filter((r) => {
    const credits = r['artist-credit'] || [];
    const fullArtist = credits.map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('');
    const year = extractYear(r['first-release-date']);
    return Number(r.score) >= 90 && normalized(r.title) === normalized(title) &&
      credits.length && year > 1900 && year <= new Date().getFullYear() &&
      (!artist || normalized(fullArtist) === normalized(artist) ||
        credits.some((c) => normalized(c.name || c.artist?.name) === normalized(artist)));
  });
  if (!artist && new Set(matches.map((r) =>
    (r['artist-credit'] || []).map((c) => c.artist?.id || normalized(c.name)).join(','))).size > 1) return null;
  matches.sort((a, b) => extractYear(a['first-release-date']) - extractYear(b['first-release-date']));
  const r = matches[0];
  if (!r) return null;
  return {
    musicbrainzId: r.id,
    t: r.title,
    a: r['artist-credit'].map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join(''),
    y: extractYear(r['first-release-date']),
    cover: null,
  };
}

module.exports = { getEarliestReleaseYear, findRecording };

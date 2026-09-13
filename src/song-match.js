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

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(MARK_RE, '')
    .toLowerCase().replace(NON_ALPHANUMERIC_RE, '');
}

// Ignore reissue labels, but preserve live/remix/cover qualifiers.
function titleKey(value) {
  return normalize(String(value || '').replace(
    /\s*(?:[-–—]\s*|[([])\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*[)\]]?\s*$/i, ''));
}

function sameSong(query, title, artists) {
  if (!titleKey(query.title) || titleKey(query.title) !== titleKey(title)) return false;
  const expected = normalize(query.artist);
  if (!expected) return false;
  return artists.some((artist) => normalize(artist) === expected) ||
    normalize(artists.join(', ')) === expected;
}

module.exports = { normalize, titleKey, sameSong };

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
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

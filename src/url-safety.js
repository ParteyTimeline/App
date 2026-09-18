const net = require('net');

// Best-effort SSRF guard for a URL an untrusted source (an admin-imported
// playlist archive, currently the only caller) supplied as "fetch this and
// cache the bytes" — rejects the obvious cases: loopback, the RFC1918
// private ranges, link-local/cloud-metadata addresses, IPv6 equivalents of
// all of the above (including IPv4-mapped/-compatible IPv6 literals), and
// the literal "localhost". This is a hostname-literal check, not real DNS
// resolution — it does not defend against DNS rebinding (an ordinary-
// looking hostname that resolves to an internal address only at request
// time), which would need a resolve-then-connect-by-IP hook at the fetch
// layer to close fully.

function isPrivateIPv4Octets(a, b) {
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Expands a compressed IPv6 literal into its 8 groups, or null if
// malformed. The WHATWG URL parser's `.hostname` always hands back pure
// hex groups here — any embedded IPv4 tail notation like
// "::ffff:127.0.0.1" is already canonicalized to hex (e.g. "::ffff:7f00:1")
// by the time this runs, so there's no dotted-decimal case to parse.
function expandIPv6Groups(addr) {
  const sections = addr.split('::');
  if (sections.length > 2) return null;
  const head = sections[0] ? sections[0].split(':').filter(Boolean) : [];
  if (sections.length === 1) return head.length === 8 ? head : null;
  const tail = sections[1] ? sections[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail];
}

function groupValue(hex) {
  return parseInt(hex || '0', 16);
}

function isPrivateIPv6(addr) {
  const groups = expandIPv6Groups(addr);
  if (!groups) return false;
  const v = groups.map(groupValue);

  // "::" (unspecified) and "::1" (loopback) — and, conservatively, every
  // other low "::x" address, none of which are legitimately routable
  // public targets.
  if (v.slice(0, 7).every((g) => g === 0)) return true;

  if (v[0] >= 0xfe80 && v[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (v[0] >= 0xfc00 && v[0] <= 0xfdff) return true; // fc00::/7 unique local

  // IPv4-mapped (::ffff:0:0/96 — 5 zero groups, then "ffff", then the IPv4
  // address in the last 2 groups) and IPv4-compatible (::0.0.0.0/96,
  // legacy — 6 zero groups then the IPv4 address) — defer to the embedded
  // IPv4 address's own privacy check rather than treating "it's an IPv6
  // literal" as inherently safe.
  const isMapped = v.slice(0, 5).every((g) => g === 0) && v[5] === 0xffff;
  const isCompatible = v.slice(0, 6).every((g) => g === 0);
  if (isMapped || isCompatible) {
    const last32 = (v[6] << 16) | v[7];
    return isPrivateIPv4Octets((last32 >>> 24) & 0xff, (last32 >>> 16) & 0xff);
  }
  return false;
}

function isPrivateOrLoopbackHost(hostname) {
  const raw = String(hostname || '').toLowerCase();
  if (raw === 'localhost') return true;
  // URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]") —
  // net.isIP doesn't recognize that form at all and silently falls through
  // to "not an IP, must be an ordinary hostname", skipping every check
  // below entirely. Strip them before classifying.
  const h = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const version = net.isIP(h);
  if (version === 4) {
    const [a, b] = h.split('.').map(Number);
    return isPrivateIPv4Octets(a, b);
  }
  if (version === 6) return isPrivateIPv6(h);
  return false; // a real hostname — DNS rebinding isn't covered here, see above
}

function isSafeExternalUrl(value) {
  if (typeof value !== 'string') return false;
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !isPrivateOrLoopbackHost(u.hostname);
}

module.exports = { isPrivateOrLoopbackHost, isSafeExternalUrl };

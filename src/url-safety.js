const net = require('net');

// Best-effort SSRF guard for a URL an untrusted source (an admin-imported
// playlist archive, currently the only caller) supplied as "fetch this and
// cache the bytes" — rejects the obvious cases: loopback, the RFC1918
// private ranges, link-local/cloud-metadata addresses, and the literal
// "localhost". This is a hostname-literal check, not real DNS resolution —
// it does not defend against DNS rebinding (an ordinary-looking hostname
// that resolves to an internal address only at request time), which would
// need a resolve-then-connect-by-IP hook at the fetch layer to close fully.
function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost') return true;
  const version = net.isIP(h);
  if (version === 4) {
    const parts = h.split('.').map(Number);
    const [a, b] = parts;
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (version === 6) {
    return h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  }
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

const zlib = require('zlib');

// Minimal TAR (ustar) reader/writer, gzipped via Node's built-in zlib —
// deliberately hand-rolled instead of adding a zip/tar dependency: every
// entry here is a small, flat file with a short name (playlist.json plus
// cache-key-named audio/cover files, see server.js's playlist export/
// import), well within ustar's 100-char name field, so the format's real
// complexity (long-name extensions, sparse files, directories, ...) never
// comes up. Produces/reads plain, standard .tar.gz files — inspectable
// with any normal archive tool, not just this app.

const BLOCK = 512;

function tarHeader(name, size) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000666\0', 100, 8, 'utf8'); // mode (octal, unused but required)
  buf.write('0000000\0', 108, 8, 'utf8'); // uid
  buf.write('0000000\0', 116, 8, 'utf8'); // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8'); // size (octal)
  buf.write('00000000000\0', 136, 12, 'utf8'); // mtime
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder (8 spaces) while computing it below
  buf.write('0', 156, 1, 'utf8'); // typeflag: '0' = regular file
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8'); // ustar version
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function tarEntry(name, data) {
  const header = tarHeader(name, data.length);
  const padLen = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([header, data, Buffer.alloc(padLen)]);
}

// entries: [{ name, data: Buffer }]
function buildTarGz(entries) {
  const parts = entries.map((e) => tarEntry(e.name, e.data));
  parts.push(Buffer.alloc(BLOCK * 2)); // two zero blocks mark end-of-archive
  return zlib.gzipSync(Buffer.concat(parts));
}

function parseTarGz(buf) {
  const tarBuf = zlib.gunzipSync(buf);
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeOctal, 8);
    // A malformed/negative/oversized size must not be trusted: a negative
    // size (e.g. from a crafted octal field) cancels out the header's own
    // 512 bytes below and sends `offset` right back to where it started —
    // reprocessing the same header forever with no progress, hanging
    // whichever request triggered the parse (the admin-only playlist
    // import route). A size bigger than what's left in the buffer would
    // otherwise silently read a truncated/garbage entry instead of
    // rejecting the archive outright.
    if (!Number.isInteger(size) || size < 0 || size > tarBuf.length - offset - BLOCK) {
      throw new Error('invalid tar entry size');
    }
    offset += BLOCK;
    if (name) entries.push({ name, data: Buffer.from(tarBuf.subarray(offset, offset + size)) });
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return entries;
}

module.exports = { buildTarGz, parseTarGz };

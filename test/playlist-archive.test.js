const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { buildTarGz, parseTarGz } = require('../src/playlist-archive');

const BLOCK = 512;

function tarHeaderWithSize(name, sizeField) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000666\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  buf.write(sizeField.padEnd(11, '0') + '\0', 124, 12, 'utf8');
  buf.write('00000000000\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8');
  buf.write('0', 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

test('round-trips a normal archive', () => {
  const entries = [{ name: 'playlist.json', data: Buffer.from('{"a":1}') }];
  const archive = buildTarGz(entries);
  const parsed = parseTarGz(archive);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'playlist.json');
  assert.equal(parsed[0].data.toString('utf8'), '{"a":1}');
});

// A crafted negative size used to cancel out the header's own 512 bytes in
// the offset arithmetic, sending the parser right back to where it started
// and reprocessing the same header forever instead of terminating.
test('rejects a negative entry size instead of looping forever', () => {
  const header = tarHeaderWithSize('evil', '-0000000001'); // octal-ish negative field
  const tarBuf = Buffer.concat([header, Buffer.alloc(BLOCK * 2)]);
  const archive = zlib.gzipSync(tarBuf);
  assert.throws(() => parseTarGz(archive), /invalid tar entry size/);
});

test('rejects an entry size larger than the remaining archive data', () => {
  const header = tarHeaderWithSize('evil', '77777777777'); // huge octal size
  const tarBuf = Buffer.concat([header, Buffer.alloc(BLOCK * 2)]);
  const archive = zlib.gzipSync(tarBuf);
  assert.throws(() => parseTarGz(archive), /invalid tar entry size/);
});

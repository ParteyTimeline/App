const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
const processes = [];
let fail = false;
childProcess.spawn = (command, args) => {
  const process = new EventEmitter();
  Object.assign(process, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), killed: false,
    kill() { this.killed = true; } });
  processes.push(process);
  if (command === 'ffmpeg') setImmediate(() => {
    if (fail) process.emit('error', new Error('missing binary'));
    else { process.stdout.end(Buffer.from('fake-mp3-clip')); process.emit('close', 0); }
  });
  return process;
};
const { createClip, streamPreview } = require('../src/youtube-audio');
childProcess.spawn = originalSpawn;

function response() {
  const res = new EventEmitter();
  return Object.assign(res, { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this; },
    send(body) { this.body = body; return this; }, end() { return this; } });
}
test('produces a bounded metadata-free MP3 and cleans up both processes', async () => {
  const clip = await createClip('abcdefghijk', new AbortController().signal);
  assert.equal(clip.toString(), 'fake-mp3-clip');
  assert.ok(processes.slice(-2).every((p) => p.killed));
  const encoder = processes.at(-1);
  assert.equal(encoder.args[encoder.args.indexOf('-t') + 1], '30');
  assert.equal(encoder.args[encoder.args.indexOf('-map_metadata') + 1], '-1');
});
test('serves cached clips and byte ranges, rejects invalid ranges and IDs', async () => {
  const res = response();
  await streamPreview('abcdefghijk', { headers: {} }, res);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  const count = processes.length;
  const range = response();
  await streamPreview('abcdefghijk', { headers: { range: 'bytes=0-3' } }, range);
  assert.equal(range.statusCode, 206);
  assert.equal(range.body.toString(), 'fake');
  assert.equal(processes.length, count);
  const invalid = response();
  await streamPreview('abcdefghijk', { headers: { range: 'bytes=999-' } }, invalid);
  assert.equal(invalid.statusCode, 416);
  const badId = response();
  await streamPreview('../bad', { headers: {} }, badId);
  assert.equal(badId.statusCode, 400);
});
test('missing tools fail cleanly and terminate children', async () => {
  fail = true;
  await assert.rejects(createClip('abcdefghijk', new AbortController().signal), /missing binary/);
  assert.ok(processes.slice(-2).every((p) => p.killed));
  fail = false;
});
test('cancelled playback terminates both children', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createClip('abcdefghijk', controller.signal), /abgebrochen/);
  assert.ok(processes.slice(-2).every((p) => p.killed));
});

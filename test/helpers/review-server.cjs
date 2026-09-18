// Isolated HTTP fixture: executes production modules with private module state,
// memory-only persistence, and a network stub. Never opens the real data store.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { once } = require('node:events');

module.exports = async function reviewServer({ local = true, failAudioWrite = false } = {}) {
  const root = path.resolve(__dirname, '../..');
  const token = 'isolated-test-control-token';
  const env = { PORT: '0', SESSION_SECRET: 'isolated-test-session-secret', ...(local ? { LOCAL_CONTROL_TOKEN: token } : {}) };
  const playlists = new Map();
  const users = new Map();
  const requests = [];
  const files = new Map();
  const modules = new Map();
  const store = {
    getUser: name => users.get(String(name).toLowerCase()),
    createUser(name, passwordHash) { users.set(name.toLowerCase(), { username: name, passwordHash }); },
    listPlaylists: () => [...playlists.values()],
    getPlaylist: id => playlists.get(id),
    findPlaylistBySourceKey: key => [...playlists.values()].find(p => p.sourceKey === key),
    addPlaylist(p) { playlists.set(p.id, p); return p; },
    updatePlaylist(id, patch) { const p = playlists.get(id); if (p) Object.assign(p, patch); return p; },
    removePlaylist: id => playlists.delete(id),
  };
  const memoryFs = {
    existsSync: name => files.has(String(name)), mkdirSync() {},
    writeFileSync: (name, data) => files.set(String(name), Buffer.from(data)),
    readFileSync: name => files.get(String(name)),
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    unlinkSync: name => files.delete(String(name)),
  };
  const audio = {
    isCached: () => false,
    cachePath: id => path.join('test-audio', String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.mp3'),
    cacheFromBuffer() { if (failAudioWrite) throw new Error('simulated cache disk full'); },
    remove() {},
  };
  let server;
  const logs = [];
  const context = vm.createContext({
    process: { env }, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    console: { log() {}, warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    fetch: async url => {
      requests.push(String(url));
      // A response fixture, including for private URLs: no outbound traffic.
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('fixture bytes') };
    },
  });
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    if (filename === path.join(root, 'src/store.js')) return store;
    if (filename === path.join(root, 'src/audio-cache.js')) return audio;
    const module = { exports: {} };
    modules.set(filename, module);
    const realRequire = createRequire(filename);
    const requireFixture = id => {
      if (id === 'http') return { ...http, createServer(app) {
        server = http.createServer(app);
        const listen = server.listen.bind(server);
        server.listen = (_port, callback) => listen(0, '127.0.0.1', callback);
        return server;
      } };
      if (id === 'fs' && filename.endsWith('cover-cache.js')) return memoryFs;
      if (id.startsWith('.')) return load(realRequire.resolve(id));
      return realRequire(id);
    };
    const fn = vm.runInContext('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})', context, { filename, lineOffset: -1 });
    fn(requireFixture, module, module.exports, filename, path.dirname(filename));
    if (filename.endsWith('deezer.js')) {
      module.exports.getFreshPreviewUrl = async () => 'https://fixture.invalid/preview';
    }
    return module.exports;
  }
  load(path.join(root, 'server.js'));
  if (!server.listening) await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(route, { method = 'GET', body, cookie, admin = false } = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(admin ? { 'X-Local-Control-Token': token } : {}) };
    if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'application/gzip' : 'application/json';
    const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  return {
    call, base, playlists, users, requests, logs,
    rooms: load(path.join(root, 'src/rooms.js')),
    archive: load(path.join(root, 'src/playlist-archive.js')),
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
};

// Loads the REAL src/store.js with fs stubbed to an in-memory map, so
// tests can exercise its actual lookup/persistence logic without ever
// touching the developer's real data/store.json (which holds real users'
// accounts and playlists). Mirrors review-server.cjs's technique.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = function isolatedStore() {
  const filename = path.resolve(__dirname, '../../src/store.js');
  const files = new Map();
  const memoryFs = {
    existsSync: (p) => files.has(String(p)),
    mkdirSync() {},
    writeFileSync: (p, data) => files.set(String(p), data),
    readFileSync: (p) => files.get(String(p)),
    renameSync: (from, to) => { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
  };
  const context = vm.createContext({ console, Buffer, Date, require, setImmediate, clearImmediate });
  const moduleObj = { exports: {} };
  const requireFixture = (id) => (id === 'fs' ? memoryFs : id === 'path' ? path : require(id));
  const fn = vm.runInContext(
    '(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})',
    context,
    { filename }
  );
  fn(requireFixture, moduleObj, moduleObj.exports, filename, path.dirname(filename));
  return moduleObj.exports;
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// deploy/sw-selfdestruct.js in a node:vm sandbox: skip waiting, delete radui-shell-* caches only,
// unregister, reload the controlled windows.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', '..', '..', 'deploy', 'sw-selfdestruct.js'), 'utf8');

function load({ cacheNames = [], clientList = [] } = {}) {
  const handlers = {};
  const calls = { skipWaiting: 0, unregistered: 0, deleted: [], navigated: [] };
  const self = {
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {
      calls.skipWaiting += 1;
    },
    registration: {
      unregister: async () => {
        calls.unregistered += 1;
        return true;
      },
    },
    clients: {
      matchAll: async (opts) => {
        assert.equal(opts.type, 'window');
        return clientList.map((url) => ({
          url,
          navigate: (to) => {
            calls.navigated.push(to);
          },
        }));
      },
    },
  };
  const caches = {
    keys: async () => [...cacheNames],
    delete: async (name) => {
      calls.deleted.push(name);
      return true;
    },
  };
  vm.runInNewContext(SOURCE, { self, caches });
  const run = async (type) => {
    const waits = [];
    handlers[type]({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { handlers, calls, run };
}

test('registers exactly an install and an activate handler, and no fetch handler', () => {
  const w = load();
  assert.deepEqual(Object.keys(w.handlers).sort(), ['activate', 'install']);
});

test('install skips waiting', async () => {
  const w = load();
  await w.run('install');
  assert.equal(w.calls.skipWaiting, 1);
});

test('activate deletes only radui-shell-* caches, unregisters and reloads every window', async () => {
  const w = load({
    cacheNames: ['radui-shell-aaaa', 'other-cache', 'radui-shell-bbbb'],
    clientList: ['https://example.org/ui/', 'https://example.org/ui/#/contacts'],
  });
  await w.run('activate');
  assert.deepEqual(w.calls.deleted, ['radui-shell-aaaa', 'radui-shell-bbbb']);
  assert.equal(w.calls.unregistered, 1);
  assert.deepEqual(w.calls.navigated, ['https://example.org/ui/', 'https://example.org/ui/#/contacts']);
});

test('activate works with no caches and no windows', async () => {
  const w = load();
  await w.run('activate');
  assert.equal(w.calls.unregistered, 1);
  assert.deepEqual(w.calls.deleted, []);
});

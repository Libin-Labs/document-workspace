import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentWorkspace, WorkspaceError } from '../dist/esm/index.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function adapter() {
  const data = new Map([
    ['a', { text: 'A', version: 'v1' }],
    ['b', { text: 'B', version: 'v1' }],
  ]);
  let seq = 1;
  return {
    data,
    async load(key) {
      return { ...data.get(key) };
    },
    async save(key, text, expected) {
      if (data.get(key).version !== expected) throw new Error('CAS conflict');
      const version = 'v' + ++seq;
      data.set(key, { text, version });
      return { version };
    },
  };
}
test('independent handles, dirty/save/close and no browser interaction', async () => {
  const storage = adapter(),
    workspace = createDocumentWorkspace(storage),
    a = await workspace.open('a'),
    b = await workspace.open('b');
  a.edit('new A');
  assert.equal(a.snapshot().dirty, true);
  assert.equal(b.snapshot().text, 'B');
  assert.equal(b.snapshot().dirty, false);
  assert.throws(() => a.close(), { code: 'dirty' });
  await a.save();
  assert.equal(storage.data.get('a').text, 'new A');
  assert.equal(a.snapshot().dirty, false);
  a.close();
  assert.deepEqual(workspace.keys(), ['b']);
  assert.throws(() => a.edit('bad'), { code: 'closed' });
  assert.throws(() => a.snapshot(), { code: 'closed' });
  b.close();
});
test('open collisions include in-flight loads and failed loads release reservations', async () => {
  const gate = deferred(),
    storage = adapter(),
    workspace = createDocumentWorkspace({ ...storage, load: () => gate.promise }, { maxOpen: 1 });
  const opening = workspace.open('a');
  await assert.rejects(workspace.open('a'), { code: 'collision' });
  await assert.rejects(workspace.open('b'), { code: 'capacity' });
  gate.reject(new Error('missing'));
  await assert.rejects(opening, /missing/);
  assert.deepEqual(workspace.keys(), []);
});
test('save revision races serialize and drain edits without losing content', async () => {
  const storage = adapter(),
    gate = deferred(),
    writes = [];
  let active = 0,
    maximum = 0;
  const workspace = createDocumentWorkspace({
    ...storage,
    async save(key, text, expected) {
      maximum = Math.max(maximum, ++active);
      writes.push([text, expected]);
      if (writes.length === 1) await gate.promise;
      const result = await storage.save(key, text, expected);
      active--;
      return result;
    },
  });
  const handle = await workspace.open('a');
  handle.edit('one');
  const first = handle.save();
  await tick();
  assert.throws(() => handle.close({ discard: true }), { code: 'saving' });
  handle.edit('two');
  assert.equal(handle.save(), first);
  gate.resolve();
  await first;
  assert.deepEqual(writes, [
    ['one', 'v1'],
    ['two', 'v2'],
  ]);
  assert.equal(maximum, 1);
  assert.equal(storage.data.get('a').text, 'two');
  assert.equal(handle.snapshot().dirty, false);
  handle.close();
});
test('persistence CAS failure remains dirty and can retry truthfully', async () => {
  const storage = adapter();
  let fail = true;
  const workspace = createDocumentWorkspace({
    ...storage,
    async save(...args) {
      if (fail) throw new Error('disk');
      return storage.save(...args);
    },
  });
  const handle = await workspace.open('a');
  handle.edit('draft');
  await assert.rejects(handle.save(), /disk/);
  assert.equal(handle.snapshot().dirty, true);
  assert.equal(handle.snapshot().saving, false);
  fail = false;
  await handle.save();
  assert.equal(handle.snapshot().dirty, false);
  handle.close();
});
test('external version collisions propagate rather than overwrite', async () => {
  const storage = adapter(),
    workspace = createDocumentWorkspace(storage),
    handle = await workspace.open('a');
  storage.data.set('a', { text: 'remote', version: 'remote' });
  handle.edit('local');
  await assert.rejects(handle.save(), /CAS conflict/);
  assert.equal(storage.data.get('a').text, 'remote');
  handle.close({ discard: true });
  assert.equal((await workspace.open('a')).snapshot().text, 'remote');
});
test('invalid load/save versions, capacity, keys and text reject', async () => {
  assert.throws(() => createDocumentWorkspace(adapter(), { maxOpen: 0 }), { code: 'invalid' });
  const workspace = createDocumentWorkspace(adapter());
  await assert.rejects(workspace.open(''), { code: 'invalid' });
  await assert.rejects(workspace.open('a\u0000'), { code: 'invalid' });
  const invalid = createDocumentWorkspace({
    async load() {
      return { text: 'x', version: '' };
    },
    async save() {
      return { version: 'v1' };
    },
  });
  await assert.rejects(invalid.open('a'), { code: 'invalid' });
  assert.deepEqual(invalid.keys(), []);
  const bad = createDocumentWorkspace({
    async load() {
      return { text: 'x', version: 'v1' };
    },
    async save() {
      return { version: 'v1' };
    },
  });
  const handle = await bad.open('x');
  assert.throws(() => handle.edit('x'.repeat(1000001)));
  handle.edit('new');
  await assert.rejects(handle.save(), { code: 'invalid' });
  assert.equal(handle.snapshot().dirty, true);
  assert.ok(new WorkspaceError('invalid', 'bad') instanceof Error);
});
test('a failed in-flight write preserves newer edits and the original CAS base for retry', async () => {
  const storage = adapter(),
    gate = deferred(),
    writes = [];
  let fail = true;
  const workspace = createDocumentWorkspace({
    ...storage,
    async save(key, text, expected) {
      writes.push([text, expected]);
      if (fail) {
        await gate.promise;
        throw new Error('interrupted');
      }
      return storage.save(key, text, expected);
    },
  });
  const handle = await workspace.open('a');
  handle.edit('older');
  const pending = handle.save();
  await tick();
  handle.edit('newest');
  gate.resolve();
  await assert.rejects(pending, /interrupted/);
  assert.equal(handle.snapshot().dirty, true);
  assert.equal(handle.snapshot().version, 'v1');
  fail = false;
  await handle.save();
  assert.deepEqual(writes, [
    ['older', 'v1'],
    ['newest', 'v1'],
  ]);
  assert.equal(storage.data.get('a').text, 'newest');
  handle.close();
});

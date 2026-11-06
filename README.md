# @lp-labs/document-workspace

Independent bounded document handles with open collisions, dirty state and serialized durable saves.

Original, independent MIT implementation. Zero runtime, peer or sibling dependencies. Requires Node.js 18+; strict TypeScript declarations support both ESM and CommonJS.

## Install

```sh
npm install @lp-labs/document-workspace
```

## Quickstart

```js
import { createDocumentWorkspace, WorkspaceError } from '@lp-labs/document-workspace';
let stored = { text: 'Initial', version: 'v1' };
const workspace = createDocumentWorkspace({
  async load() {
    return { ...stored };
  },
  async save(key, text, expected) {
    if (expected !== stored.version) throw new Error('Version collision');
    stored = { text, version: 'v2' };
    return { version: stored.version };
  },
});
const handle = await workspace.open('notes');
handle.edit('Updated');
await handle.save();
handle.close();
if (
  stored.text !== 'Updated' ||
  workspace.keys().length ||
  !(new WorkspaceError('invalid', 'Example') instanceof Error)
)
  throw new Error('Workspace mismatch');
```

## API and types

`createDocumentWorkspace(adapter: WorkspaceAdapter, {maxOpen?}): DocumentWorkspace` exposes open(key): Promise<DocumentHandle> and keys(). load returns {text,version}; save(key,text,expectedVersion) must atomically reject stale versions and return a fresh nonempty version. Handles expose snapshot(): WorkspaceDocument plus revision/dirty/saving, edit(text): revision, save(): Promise<void>, close({discard?}). Open reserves a key before loading so concurrent opens collide; failed loads release it. Each handle tracks its own revision, content and persistence base. save drains edits made in-flight using the last successful adapter version; concurrent saves share the promise. close rejects while saving or dirty unless discard is explicit. Closed handles reject all further operations.

## Customize

Supply your own loader and version-aware saver, set maxOpen for resource budgets, use explicit await save before close, or discard only when intentionally dropping dirty edits. Persistence failures propagate and leave unsaved revisions dirty for an explicit retry. WorkspaceError codes: invalid, collision, capacity, closed, dirty, saving. `WorkspaceDocument`, `WorkspaceAdapter`, `DocumentHandle`, `DocumentWorkspace` describe the complete structural API.

## Errors and bounds

maxOpen defaults to 16 (1..128), includes opening handles; each text at most 1,000,000 UTF-16 units, key 1..512 without ASCII control characters, persistence version 1..1024 or null on load, safe-integer local revisions. O(maxOpen*document size) owned logical text, plus adapter buffers. Each handle serializes its writes; different handles may save concurrently. Exact case-sensitive keys are opaque, not normalized filesystem paths. No browser UI, global storage, hidden autosave or PDF/Word engine. The adapter is responsible for durable CAS and truthful versions; this package cannot enforce atomicity in an external database.

Invalid runtime inputs throw TypeError/RangeError or the documented typed error. Adapter errors propagate unchanged unless specifically noted; asynchronous methods reject. Inputs must be ordinary typed data, not hostile proxies or accessors. No I/O happens at import time. All runtime exports are documented above and the example executes without optional packages.

## Development

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm test
npm run format:check
```

Build emits dist/esm and dist/cjs with matching declarations. Tests use Node's test runner; consumer.mts and consumer.cts validate meaningful bare-package imports and expected type errors. Only TypeScript ^5.9.3 and Prettier ^3.6.2 are development dependencies.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.

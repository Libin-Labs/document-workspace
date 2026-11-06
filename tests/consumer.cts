import {
  createDocumentWorkspace,
  WorkspaceError,
  type WorkspaceAdapter,
  type DocumentWorkspace,
  type DocumentHandle,
  type WorkspaceDocument,
} from '@lp-labs/document-workspace';
const adapter: WorkspaceAdapter = {
  async load() {
    return { text: 'hello', version: null };
  },
  async save() {
    return { version: 'v1' };
  },
};
const workspace: DocumentWorkspace = createDocumentWorkspace(adapter);
const opened: Promise<DocumentHandle> = workspace.open('doc');
const projection = (handle: DocumentHandle): WorkspaceDocument => handle.snapshot();
const code: string = new WorkspaceError('dirty', 'unsaved').code;
// @ts-expect-error open requires an opaque string key
workspace.open(1);
void [opened, projection, code];

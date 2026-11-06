export interface WorkspaceDocument {
  key: string;
  text: string;
  version: string | null;
}
export interface WorkspaceAdapter {
  load(key: string): Promise<{ text: string; version: string | null }>;
  save(key: string, text: string, expectedVersion: string | null): Promise<{ version: string }>;
}
export interface DocumentHandle {
  snapshot(): WorkspaceDocument & { revision: number; dirty: boolean; saving: boolean };
  edit(text: string): number;
  save(): Promise<void>;
  close(options?: { discard?: boolean }): void;
}
export interface DocumentWorkspace {
  open(key: string): Promise<DocumentHandle>;
  keys(): string[];
}
export class WorkspaceError extends Error {
  constructor(
    readonly code: 'invalid' | 'collision' | 'capacity' | 'closed' | 'dirty' | 'saving',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
function text(value: string): void {
  if (typeof value !== 'string' || value.length > 1_000_000)
    throw new WorkspaceError('invalid', 'Document text limit');
}
function version(value: string | null): void {
  if (value !== null && (typeof value !== 'string' || !value || value.length > 1024))
    throw new WorkspaceError('invalid', 'Invalid persistence version');
}
/** Keys are opaque and case-sensitive. The adapter implements durable compare-and-swap. */
export function createDocumentWorkspace(
  adapter: WorkspaceAdapter,
  options: { maxOpen?: number } = {},
): DocumentWorkspace {
  const max = options.maxOpen ?? 16;
  if (
    !Number.isInteger(max) ||
    max < 1 ||
    max > 128 ||
    typeof adapter.load !== 'function' ||
    typeof adapter.save !== 'function'
  )
    throw new WorkspaceError('invalid', 'Invalid workspace configuration');
  const occupied = new Set<string>();
  return {
    keys: () => [...occupied],
    async open(key) {
      if (
        typeof key !== 'string' ||
        !key.trim() ||
        key.length > 512 ||
        /[\u0000-\u001f]/u.test(key)
      )
        throw new WorkspaceError('invalid', 'Invalid document key');
      if (occupied.has(key))
        throw new WorkspaceError('collision', 'Document already open or opening');
      if (occupied.size >= max) throw new WorkspaceError('capacity', 'Open document limit');
      occupied.add(key);
      let loaded: { text: string; version: string | null };
      try {
        loaded = await adapter.load(key);
        text(loaded.text);
        version(loaded.version);
      } catch (error) {
        occupied.delete(key);
        throw error;
      }
      let content = loaded.text,
        base = loaded.version,
        revision = 0,
        saved = 0,
        closed = false;
      let active: Promise<void> | null = null;
      const check = () => {
        if (closed) throw new WorkspaceError('closed', 'Handle closed');
      };
      return {
        snapshot() {
          check();
          return {
            key,
            text: content,
            version: base,
            revision,
            dirty: revision !== saved,
            saving: active !== null,
          };
        },
        edit(value) {
          check();
          text(value);
          if (revision === Number.MAX_SAFE_INTEGER)
            throw new WorkspaceError('invalid', 'Revision exhausted');
          content = value;
          return ++revision;
        },
        save() {
          check();
          if (active) return active;
          if (revision === saved) return Promise.resolve();
          active = Promise.resolve().then(async () => {
            try {
              while (revision !== saved) {
                const target = revision,
                  value = content,
                  expected = base;
                const result = await adapter.save(key, value, expected);
                version(result.version);
                if (result.version === null || result.version === expected)
                  throw new WorkspaceError('invalid', 'Save must return a fresh version');
                base = result.version;
                saved = target;
              }
            } finally {
              active = null;
            }
          });
          return active;
        },
        close(closeOptions = {}) {
          check();
          if (active) throw new WorkspaceError('saving', 'Cannot close an in-flight save');
          if (revision !== saved && !closeOptions.discard)
            throw new WorkspaceError('dirty', 'Unsaved edits');
          closed = true;
          occupied.delete(key);
        },
      };
    },
  };
}

/**
 * Browser side of project refs: keep the server's list of uploads the open
 * video project uses in step with the store. A replaced or closed project
 * is released; a new / rehydrated / edited one is (re)registered, debounced.
 */
import { syncProjectRefs } from "./client";
import { uploadFilesInEdit } from "./sourceRef";

type Snap = {
  projectId: string | null;
  edit: Parameters<typeof uploadFilesInEdit>[0];
};

export interface RefsChange {
  /** Project id to release (closed or replaced). */
  release?: string;
  /** Project to (re)register. */
  register?: { projectId: string; files: string[] };
}

/** What to send when the store goes from `prev` to `next` (pure). */
export function projectRefsChange(prev: Snap, next: Snap): RefsChange {
  const out: RefsChange = {};
  if (prev.projectId && prev.projectId !== next.projectId)
    out.release = prev.projectId;
  if (next.projectId) {
    const files = uploadFilesInEdit(next.edit);
    const changed =
      prev.projectId !== next.projectId ||
      uploadFilesInEdit(prev.edit).join("|") !== files.join("|");
    if (changed) out.register = { projectId: next.projectId, files };
  }
  return out;
}

const DEBOUNCE_MS = 1500;

/**
 * Wire the sync to a store; returns the unsubscribe. Browser only.
 * `current` is the state now (a project restored from storage registers
 * again, which also keeps its entry fresh).
 */
export function installProjectRefsSync(
  subscribe: (fn: (next: Snap, prev: Snap) => void) => () => void,
  current: Snap,
  send: (projectId: string, files: string[]) => Promise<void> = syncProjectRefs,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { projectId: string; files: string[] } | null = null;
  const flush = () => {
    timer = null;
    if (pending) void send(pending.projectId, pending.files);
    pending = null;
  };
  const schedule = (r: { projectId: string; files: string[] }) => {
    pending = r;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };
  const first = projectRefsChange({ projectId: null, edit: null }, current);
  if (first.register) schedule(first.register);
  return subscribe((next, prev) => {
    if (next.projectId === prev.projectId && next.edit === prev.edit) return;
    const c = projectRefsChange(prev, next);
    if (c.release) {
      if (pending?.projectId === c.release) pending = null;
      void send(c.release, []);
    }
    if (c.register) schedule(c.register);
  });
}

import { atom } from "nanostores";
import { scene } from "../render/scene";
import { $revision, $selection, bumpRevision, doc, setSelection } from "./store";

/**
 * Snapshot-based undo/redo. Document mutations bump `$revision` and selection
 * changes update `$selection`; both feed the same trailing debounce, so a burst
 * (a whole drag, a color-slider sweep, a run of keystrokes, or a selection
 * change) coalesces into ONE history entry and each undo step maps to one
 * action. Selection lives in the snapshot, so undo/redo also restore what was
 * selected — selecting/deselecting nodes or groups is itself undoable.
 */
const LIMIT = 60;
const COALESCE_MS = 350;

type Snapshot = Pick<typeof doc.board, "shapes" | "edges" | "order" | "layers"> & {
  sel?: { shapes: string[]; edges: string[] };
};

let past: string[] = [];
let future: string[] = [];
let baseline = "";
let suspended = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubs: Array<() => void> = [];

export const $canUndo = atom(false);
export const $canRedo = atom(false);

function snapshot(): string {
  const b = doc.board;
  const sel = $selection.get();
  return JSON.stringify({
    shapes: b.shapes,
    edges: b.edges,
    order: b.order,
    layers: b.layers,
    sel: { shapes: [...sel.shapes], edges: [...sel.edges] },
  });
}

function updateFlags(): void {
  $canUndo.set(past.length > 0);
  $canRedo.set(future.length > 0);
}

function commit(): void {
  timer = undefined;
  if (suspended) return;
  const cur = snapshot();
  if (cur === baseline) return;
  past.push(baseline);
  if (past.length > LIMIT) past.shift();
  future = [];
  baseline = cur;
  updateFlags();
}

function schedule(): void {
  if (suspended) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(commit, COALESCE_MS);
}

function flushPending(): void {
  if (timer) {
    clearTimeout(timer);
    commit();
  }
}

function restore(snap: string): void {
  const data = JSON.parse(snap) as Snapshot;
  doc.board.shapes = data.shapes;
  doc.board.edges = data.edges;
  doc.board.order = data.order;
  doc.board.layers = data.layers ?? [];
  setSelection(data.sel?.shapes ?? [], data.sel?.edges ?? []);
  scene.rebuild();
}

/** Begin tracking history for the active board (call after loadBoard). */
export function initHistory(): void {
  for (const u of unsubs) u();
  past = [];
  future = [];
  baseline = snapshot();
  updateFlags();
  // Doc mutations AND selection changes both schedule a coalesced commit, so
  // selecting/deselecting is captured as its own undoable step.
  unsubs = [$revision.subscribe(() => schedule()), $selection.subscribe(() => schedule())];
}

export function disposeHistory(): void {
  for (const u of unsubs) u();
  unsubs = [];
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  past = [];
  future = [];
  baseline = "";
}

export function undo(): void {
  flushPending();
  if (!past.length) return;
  suspended = true;
  future.push(baseline);
  baseline = past.pop() as string;
  restore(baseline);
  bumpRevision();
  suspended = false;
  updateFlags();
}

export function redo(): void {
  flushPending();
  if (!future.length) return;
  suspended = true;
  past.push(baseline);
  baseline = future.pop() as string;
  restore(baseline);
  bumpRevision();
  suspended = false;
  updateFlags();
}

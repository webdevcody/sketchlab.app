import { atom } from "nanostores";
import { scene } from "../render/scene";
import { $revision, bumpRevision, doc, setSelection } from "./store";

/**
 * Snapshot-based undo/redo. Mutations bump `$revision`; we coalesce a burst of
 * bumps (a whole drag, a color-slider sweep, a run of keystrokes) into ONE
 * history entry via a trailing debounce, so each undo step maps to one action.
 */
const LIMIT = 60;
const COALESCE_MS = 350;

let past: string[] = [];
let future: string[] = [];
let baseline = "";
let suspended = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let unsub: (() => void) | null = null;

export const $canUndo = atom(false);
export const $canRedo = atom(false);

function snapshot(): string {
  const b = doc.board;
  return JSON.stringify({ shapes: b.shapes, edges: b.edges, order: b.order, fontScale: b.fontScale });
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
  const data = JSON.parse(snap) as Pick<typeof doc.board, "shapes" | "edges" | "order" | "fontScale">;
  doc.board.shapes = data.shapes;
  doc.board.edges = data.edges;
  doc.board.order = data.order;
  doc.board.fontScale = data.fontScale;
  setSelection([], []);
  scene.rebuild();
}

/** Begin tracking history for the active board (call after loadBoard). */
export function initHistory(): void {
  if (unsub) unsub();
  past = [];
  future = [];
  baseline = snapshot();
  updateFlags();
  unsub = $revision.subscribe(() => schedule());
}

export function disposeHistory(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
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

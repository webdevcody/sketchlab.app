import { measureTextBox } from "../render/measure";
import { scene } from "../render/scene";
import { uid } from "../util";
import { computeAutoLayoutEdgeBends, computeAutoLayoutPositions, isFullyAnchoredEdge } from "./autoLayout";
import {
  $activeLayer,
  $boardName,
  $selection,
  $style,
  bumpRevision,
  doc,
  setSelection,
} from "./store";
import type { Board, Edge, ID, LayerDef, Shape, ShapeKind } from "./types";

export const DEFAULT_SIZE = 110;

/**
 * Ensure `order` lists every shape and edge exactly once. Legacy boards stored
 * only shape ids (edges lived in a separate, always-behind layer); migrate them
 * by dropping any missing edges at the BOTTOM so existing diagrams keep their
 * look, while shapes/edges drawn later stack on top like any other object.
 */
function normalizeOrder(board: Board): ID[] {
  const seen = new Set<ID>();
  const kept: ID[] = [];
  for (const id of board.order) {
    if ((board.shapes[id] || board.edges[id]) && !seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  const missingEdges = Object.keys(board.edges).filter((id) => !seen.has(id));
  const missingShapes = Object.keys(board.shapes).filter((id) => !seen.has(id));
  return [...missingEdges, ...kept, ...missingShapes];
}

/**
 * Backfill `board.layers` for boards saved before the named-floor feature.
 * All-ground boards (every shape at layer 0) get an empty list (one implicit
 * floor — looks like today). Boards that used z-ordering get one synthesized
 * named floor per distinct elevation so their stacking still reads correctly.
 */
export function ensureLayers(board: Board): void {
  if (board.layers) return;
  let maxL = 0;
  for (const s of Object.values(board.shapes)) maxL = Math.max(maxL, s.layer ?? 0);
  board.layers =
    maxL === 0
      ? []
      : Array.from({ length: maxL + 1 }, (_, i): LayerDef => ({
          id: uid(),
          name: i === 0 ? "Ground" : `Layer ${i}`,
        }));
}

/** Replace the active document and rebuild the scene from scratch. */
export function loadBoard(board: Board): void {
  board.order = normalizeOrder(board);
  ensureLayers(board);
  doc.board = board;
  $boardName.set(board.name);
  $activeLayer.set(0);
  setSelection([], []);
  scene.rebuild();
}

/** Replace just the diagram contents of the active board as one undoable edit. */
export function replaceBoardContent(
  next: Pick<Board, "name" | "shapes" | "edges" | "order"> & { layers?: LayerDef[] },
): void {
  doc.board.name = next.name.trim() || doc.board.name;
  doc.board.shapes = next.shapes;
  doc.board.edges = next.edges;
  doc.board.layers = next.layers ?? [];
  doc.board.order = normalizeOrder(doc.board);
  $boardName.set(doc.board.name);
  $activeLayer.set(0);
  setSelection([], []);
  scene.rebuild();
  bumpRevision();
}

export function renameBoard(name: string): void {
  doc.board.name = name;
  $boardName.set(name);
  bumpRevision();
}

export function autoLayoutBoard(): boolean {
  const positions = computeAutoLayoutPositions(doc.board);
  let changed = false;

  for (const [id, pos] of Object.entries(positions)) {
    const shape = doc.board.shapes[id];
    if (!shape) continue;
    if (shape.x === pos.x && shape.y === pos.y) continue;
    shape.x = pos.x;
    shape.y = pos.y;
    scene.updateNode(id);
    changed = true;
  }

  const bends = computeAutoLayoutEdgeBends(doc.board);
  for (const edge of Object.values(doc.board.edges)) {
    if (!isFullyAnchoredEdge(edge)) continue;
    const bend = bends[edge.id];
    const nextCx = bend?.cx;
    const nextCy = bend?.cy;
    if (edge.cx === nextCx && edge.cy === nextCy) continue;
    if (bend) {
      edge.cx = bend.cx;
      edge.cy = bend.cy;
    } else {
      delete edge.cx;
      delete edge.cy;
    }
    scene.updateEdge(edge.id);
    changed = true;
  }

  if (changed) bumpRevision();
  return changed;
}

export function createShape(
  kind: ShapeKind,
  x: number,
  y: number,
  w = DEFAULT_SIZE,
  h = DEFAULT_SIZE,
  extra: Partial<Shape> = {},
): Shape {
  const style = $style.get();
  const shape: Shape = {
    id: uid(),
    kind,
    x,
    y,
    w,
    h,
    fill: style.fill,
    fontSize: style.fontSize,
    text: "",
    layer: $activeLayer.get(), // new tokens land on the active floor
    ...extra,
  };
  doc.board.shapes[shape.id] = shape;
  doc.board.order.push(shape.id);
  scene.addNode(shape.id);
  bumpRevision();
  return shape;
}

export function updateShape(id: ID, patch: Partial<Shape>): void {
  const s = doc.board.shapes[id];
  if (!s) return;
  Object.assign(s, patch);
  scene.updateNode(id);
  bumpRevision();
}

export function moveShapesBy(ids: Iterable<ID>, dx: number, dy: number): void {
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    s.x += dx;
    s.y += dy;
    scene.updateNode(id);
  }
  bumpRevision();
}

export function setShapesStyle(
  ids: Iterable<ID>,
  patch: { fill?: string },
): void {
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    if (patch.fill !== undefined) s.fill = patch.fill;
    scene.updateNode(id);
  }
  bumpRevision();
}

/**
 * Apply an absolute label/text font size (a size preset) to each shape. Text
 * objects are content-sized, so they re-measure their box to the new font
 * (top-left pinned); other shapes just restyle their centered label.
 */
export function setShapesFontSize(ids: Iterable<ID>, fontSize: number): void {
  let changed = false;
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    s.fontSize = fontSize;
    if (s.kind === "text") {
      const box = measureTextBox(s.text, fontSize);
      s.w = box.w;
      s.h = box.h;
    }
    scene.updateNode(id);
    changed = true;
  }
  if (changed) bumpRevision();
}

export function setShapeText(id: ID, text: string): void {
  const s = doc.board.shapes[id];
  if (!s) return;
  s.text = text;
  if (s.kind === "text") {
    const box = measureTextBox(text, s.fontSize);
    s.w = box.w;
    s.h = box.h;
  }
  scene.updateNode(id);
  bumpRevision();
}

export function deleteShape(id: ID): void {
  if (!doc.board.shapes[id]) return;
  const removed = new Set<ID>([id]);
  for (const e of edgesConnectedTo(id)) {
    delete doc.board.edges[e.id];
    scene.removeEdge(e.id);
    removed.add(e.id);
  }
  delete doc.board.shapes[id];
  doc.board.order = doc.board.order.filter((x) => !removed.has(x));
  scene.removeNode(id);
  bumpRevision();
}

// ---------------------------------------------------------------------------
// Layering in 3D. Paint order is driven by each shape's integer `layer`, which
// renders as a world-up elevation (a higher layer lifts the token off the board
// toward the viewer = "front"; a lower layer sinks it = "back"). These actions
// move the selected shapes up/down through layers; the renderer re-sorts and
// re-elevates from the new value.
// ---------------------------------------------------------------------------

/** Highest (`pick=max`) or lowest (`pick=min`) layer among shapes NOT in `ids`. */
function boundaryLayer(ids: Set<ID>, pick: "max" | "min"): number {
  let best = pick === "max" ? -Infinity : Infinity;
  for (const [id, s] of Object.entries(doc.board.shapes)) {
    if (ids.has(id)) continue;
    const L = s.layer ?? 0;
    best = pick === "max" ? Math.max(best, L) : Math.min(best, L);
  }
  return Number.isFinite(best) ? best : 0;
}

/** Set each selected shape's layer via `next`, redraw it, and persist if changed. */
function applyLayer(ids: Iterable<ID>, next: (cur: number) => number): void {
  let changed = false;
  for (const id of new Set(ids)) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    const cur = s.layer ?? 0;
    const nl = next(cur);
    if (nl === cur) continue;
    s.layer = nl;
    scene.updateNode(id); // re-elevate the pedestal + refresh connected edges
    changed = true;
  }
  if (changed) bumpRevision();
}

/** Lift the selection above every other shape (drawn on top / nearest the viewer). */
export function bringToFront(ids: Iterable<ID>): void {
  const set = new Set(ids);
  const target = boundaryLayer(set, "max") + 1;
  applyLayer(set, () => target);
}

/** Sink the selection below every other shape (drawn behind everything). */
export function sendToBack(ids: Iterable<ID>): void {
  const set = new Set(ids);
  const target = boundaryLayer(set, "min") - 1;
  applyLayer(set, () => target);
}

/** Raise the selection one layer toward the viewer. */
export function bringForward(ids: Iterable<ID>): void {
  applyLayer(ids, (cur) => cur + 1);
}

/** Lower the selection one layer away from the viewer. */
export function sendBackward(ids: Iterable<ID>): void {
  applyLayer(ids, (cur) => cur - 1);
}

// ---------------------------------------------------------------------------
// Named floors. The board carries an ordered list of named floors; a shape's
// `layer` is its index into that list. These manage the list itself (the
// per-shape assignment reuses applyLayer above).
// ---------------------------------------------------------------------------

/** Highest floor index actually occupied by a shape (0 when none are elevated). */
function maxShapeFloor(): number {
  let m = 0;
  for (const s of Object.values(doc.board.shapes)) m = Math.max(m, s.layer ?? 0);
  return m;
}

/** Number of floors the board renders (named list, occupied shapes, min 1). */
export function floorCount(board: Board): number {
  let m = 0;
  for (const s of Object.values(board.shapes)) m = Math.max(m, s.layer ?? 0);
  return Math.max(board.layers?.length ?? 0, m + 1, 1);
}

/** Add a new floor on top of the stack and return its index. */
export function addLayer(name?: string): number {
  const layers = (doc.board.layers ??= []);
  // promote the implicit ground floor into the list so indices line up
  if (layers.length === 0) {
    const ground = Math.max(1, maxShapeFloor() + 1);
    for (let i = 0; i < ground; i++) {
      layers.push({ id: uid(), name: i === 0 ? "Ground" : `Layer ${i}` });
    }
  }
  const idx = layers.length;
  layers.push({ id: uid(), name: name ?? `Layer ${idx}` });
  bumpRevision();
  return idx;
}

/** Rename a floor by index. */
export function renameLayer(index: number, name: string): void {
  const L = doc.board.layers?.[index];
  if (!L) return;
  L.name = name.trim() || L.name;
  bumpRevision();
}

/** Set a floor's accent color (drives its frame, active plate, badge & panel swatch). */
export function setLayerColor(index: number, color: string): void {
  const layers = materializeLayers();
  const L = layers[index];
  if (!L || L.color === color) return;
  L.color = color;
  scene.redrawBoard(); // repaint the frames/plates + badges immediately
  bumpRevision(); // refresh the layers panel row swatches
}

/** Remove a floor: shapes on it drop to the floor below, higher shapes re-index down. */
export function deleteLayer(index: number): void {
  const layers = doc.board.layers;
  if (!layers || index < 0 || index >= layers.length) return;
  layers.splice(index, 1);
  for (const s of Object.values(doc.board.shapes)) {
    const l = s.layer ?? 0;
    if (l === index) s.layer = Math.max(0, index - 1);
    else if (l > index) s.layer = l - 1;
    scene.updateNode(s.id);
  }
  const active = $activeLayer.get();
  if (active >= layers.length) $activeLayer.set(Math.max(0, layers.length - 1));
  bumpRevision();
}

/** Move the given shapes onto floor `index`. */
export function assignSelectionToLayer(ids: Iterable<ID>, index: number): void {
  applyLayer(ids, () => index);
}

/**
 * Ensure `board.layers` has a named entry for every rendered floor, promoting the
 * implicit ground/elevated floors into the list so per-floor flags (name, hidden)
 * have somewhere to live. Returns the (now fully-populated) layers array.
 */
function materializeLayers(): LayerDef[] {
  const layers = (doc.board.layers ??= []);
  const n = floorCount(doc.board);
  while (layers.length < n) {
    const i = layers.length;
    layers.push({ id: uid(), name: i === 0 ? "Ground" : `Layer ${i}` });
  }
  return layers;
}

/** Whether floor `index` is currently hidden. */
export function isLayerHidden(board: Board, index: number): boolean {
  return !!board.layers?.[index]?.hidden;
}

/** Lowest floor index that is still visible, or null when every floor is hidden. */
function firstVisibleFloor(): number | null {
  const n = floorCount(doc.board);
  for (let i = 0; i < n; i++) if (!isLayerHidden(doc.board, i)) return i;
  return null;
}

/**
 * Show or hide a floor. A hidden floor's frame, tokens, edges and badge stop
 * rendering and stop hit-testing. Selected shapes on it are dropped, and if the
 * active floor is the one being hidden the highlight hops to a visible floor so
 * new shapes never land somewhere invisible.
 */
export function setLayerHidden(index: number, hidden: boolean): void {
  const layers = materializeLayers();
  const L = layers[index];
  if (!L || !!L.hidden === hidden) return;
  if (hidden) L.hidden = true;
  else delete L.hidden;

  if (hidden) {
    const sel = $selection.get();
    const kept = [...sel.shapes].filter((id) => (doc.board.shapes[id]?.layer ?? 0) !== index);
    if (kept.length !== sel.shapes.size) setSelection(kept, sel.edges);
    if ($activeLayer.get() === index) {
      const next = firstVisibleFloor();
      if (next != null) $activeLayer.set(next);
    }
  }

  scene.refreshLayerVisibility();
  bumpRevision();
}

/** Flip a floor between shown and hidden. */
export function toggleLayerHidden(index: number): void {
  setLayerHidden(index, !isLayerHidden(doc.board, index));
}

/** True when floor `index` is the only visible floor (every other floor hidden). */
export function isLayerSoloed(board: Board, index: number): boolean {
  const n = floorCount(board);
  if (n < 2) return false;
  for (let i = 0; i < n; i++) {
    if (isLayerHidden(board, i) !== (i !== index)) return false;
  }
  return true;
}

/**
 * Isolate floor `index`: hide every other floor and reveal this one. If it is
 * already the only visible floor, restore every floor to visible instead, so the
 * same button toggles solo on and off. The isolated floor becomes the active one.
 */
export function soloLayer(index: number): void {
  const layers = materializeLayers();
  if (index < 0 || index >= layers.length) return;
  const restore = isLayerSoloed(doc.board, index);
  for (let i = 0; i < layers.length; i++) {
    if (!restore && i !== index) layers[i].hidden = true;
    else delete layers[i].hidden;
  }

  // drop any selection that now sits on a hidden floor, then park the highlight
  // on the isolated (always-visible) floor so new shapes never land out of sight
  const sel = $selection.get();
  const kept = [...sel.shapes].filter(
    (id) => !isLayerHidden(doc.board, doc.board.shapes[id]?.layer ?? 0),
  );
  if (kept.length !== sel.shapes.size) setSelection(kept, sel.edges);
  $activeLayer.set(index);

  scene.refreshLayerVisibility();
  bumpRevision();
}

/** Cycle the active/highlighted floor by `dir`, wrapping through the stack. */
export function cycleActiveLayer(dir: 1 | -1): void {
  const n = floorCount(doc.board);
  const cur = $activeLayer.get();
  $activeLayer.set(((cur + dir) % n + n) % n);
}

/**
 * Drop any selected SHAPES that aren't on floor `i` (edges are left alone). Keeps
 * the invariant that only nodes on the active floor can be selected, so switching
 * floors never leaves a now-hidden node showing selection handles.
 */
export function pruneSelectionToLayer(i: number): void {
  const sel = $selection.get();
  if (!sel.shapes.size) return;
  const kept = [...sel.shapes].filter((id) => (doc.board.shapes[id]?.layer ?? 0) === i);
  if (kept.length === sel.shapes.size) return;
  setSelection(kept, sel.edges);
}

export function edgesConnectedTo(id: ID): Edge[] {
  return Object.values(doc.board.edges).filter(
    (e) => e.from === id || e.to === id,
  );
}

export function createEdge(from: ID, to: ID, directed = false): Edge | null {
  if (from === to) return null;
  // parallel edges are allowed — they auto-fan so you can draw, e.g., a request
  // arrow and a response arrow between the same two services.
  return createFreeEdge({ from, to, directed });
}

/**
 * Create an edge whose ends may each be a shape anchor (`from`/`to`) or a free
 * world point (`x1,y1` / `x2,y2`). This powers free-floating lines/arrows that
 * aren't attached to anything, as well as half-anchored connectors.
 */
export function createFreeEdge(opts: {
  from?: ID;
  to?: ID;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  directed?: boolean;
  /** floor a free end floats on (defaults to the active layer); see Edge.layer */
  layer?: number;
}): Edge {
  const style = $style.get();
  const edge: Edge = {
    id: uid(),
    from: opts.from,
    to: opts.to,
    x1: opts.x1,
    y1: opts.y1,
    x2: opts.x2,
    y2: opts.y2,
    label: "",
    fontSize: style.fontSize,
    directed: opts.directed,
    layer: opts.layer ?? $activeLayer.get(),
  };
  doc.board.edges[edge.id] = edge;
  // new edges join the top of the shared z-stack, like any newly created object
  doc.board.order.push(edge.id);
  scene.addEdge(edge.id);
  bumpRevision();
  return edge;
}

/**
 * Translate the free parts of edges by (dx,dy): free endpoints and any manual
 * bend. Shape-anchored ends are left alone — they follow their shapes — so a
 * fully-connected edge is a no-op here.
 */
export function moveEdgesBy(ids: Iterable<ID>, dx: number, dy: number): void {
  let changed = false;
  for (const id of ids) {
    const e = doc.board.edges[id];
    if (!e) continue;
    const hasFreeEnd = e.from === undefined || e.to === undefined;
    if (!hasFreeEnd) continue;
    if (e.from === undefined && e.x1 !== undefined && e.y1 !== undefined) {
      e.x1 += dx;
      e.y1 += dy;
    }
    if (e.to === undefined && e.x2 !== undefined && e.y2 !== undefined) {
      e.x2 += dx;
      e.y2 += dy;
    }
    if (e.cx !== undefined && e.cy !== undefined) {
      e.cx += dx;
      e.cy += dy;
    }
    scene.updateEdge(id);
    changed = true;
  }
  if (changed) bumpRevision();
}

export function updateEdge(id: ID, patch: Partial<Edge>): void {
  const e = doc.board.edges[id];
  if (!e) return;
  Object.assign(e, patch);
  scene.updateEdge(id);
  bumpRevision();
}

export function setEdgeLabel(id: ID, label: string): void {
  updateEdge(id, { label });
}

/** Apply an absolute label font size to line/arrow labels. */
export function setEdgesFontSize(ids: Iterable<ID>, fontSize: number): void {
  let changed = false;
  for (const id of ids) {
    const e = doc.board.edges[id];
    if (!e) continue;
    e.fontSize = fontSize;
    scene.updateEdge(id);
    changed = true;
  }
  if (changed) bumpRevision();
}

export function deleteSelection(): void {
  const sel = $selection.get();
  const removedShapes = [...sel.shapes];
  // collect edges touching deleted shapes
  const edgeIds = new Set<ID>(sel.edges);
  for (const e of Object.values(doc.board.edges)) {
    if ((e.from !== undefined && sel.shapes.has(e.from)) ||
        (e.to !== undefined && sel.shapes.has(e.to))) {
      edgeIds.add(e.id);
    }
  }
  for (const id of edgeIds) {
    delete doc.board.edges[id];
    scene.removeEdge(id);
  }
  for (const id of removedShapes) {
    delete doc.board.shapes[id];
    scene.removeNode(id);
  }
  if (removedShapes.length || edgeIds.size) {
    const removed = new Set<ID>([...removedShapes, ...edgeIds]);
    doc.board.order = doc.board.order.filter((x) => !removed.has(x));
    setSelection([], []);
    bumpRevision();
  }
}

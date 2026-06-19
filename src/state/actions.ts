import { stepFontScale } from "../render/fontPresets";
import { clampFont, measureTextBox } from "../render/measure";
import { EDGE_LABEL_FONT, edgeFontScale } from "../render/edgeView";
import { defaultLabelFont, effectiveFontSize, shapeFontScale } from "../render/shapeView";
import { scene } from "../render/scene";
import { uid } from "../util";
import {
  $boardName,
  $selection,
  $style,
  bumpRevision,
  doc,
  setSelection,
} from "./store";
import type { Board, Edge, ID, Shape, ShapeKind } from "./types";

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

/** Replace the active document and rebuild the scene from scratch. */
export function loadBoard(board: Board): void {
  board.order = normalizeOrder(board);
  doc.board = board;
  $boardName.set(board.name);
  setSelection([], []);
  scene.rebuild();
}

export function renameBoard(name: string): void {
  doc.board.name = name;
  $boardName.set(name);
  bumpRevision();
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
    stroke: style.stroke,
    text: "",
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
  patch: { fill?: string; stroke?: string },
): void {
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    if (patch.fill !== undefined) s.fill = patch.fill;
    if (patch.stroke !== undefined) s.stroke = patch.stroke;
    scene.updateNode(id);
  }
  bumpRevision();
}

export function setShapeText(id: ID, text: string): void {
  const s = doc.board.shapes[id];
  if (!s) return;
  s.text = text;
  if (s.kind === "text") {
    const box = measureTextBox(text, effectiveFontSize(s));
    s.w = box.w;
    s.h = box.h;
  }
  scene.updateNode(id);
  bumpRevision();
}

/**
 * Text objects are content-sized, so a font change must re-measure the box.
 * Re-fit around the current center so the object grows/shrinks in place.
 */
function reflowTextBox(s: Shape): void {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const box = measureTextBox(s.text, effectiveFontSize(s));
  s.x = cx - box.w / 2;
  s.y = cy - box.h / 2;
  s.w = box.w;
  s.h = box.h;
}

/**
 * Set the board-wide font scale (Small/Medium/Large/XLarge). Only objects
 * without an explicit `fontSize` follow the new scale; per-object overrides
 * (from a preset click or resize) are left unchanged.
 */
export function setFontScale(scale: number): void {
  doc.board.fontScale = scale;
  for (const s of Object.values(doc.board.shapes)) {
    if (s.fontSize != null) continue;
    if (s.kind === "text") reflowTextBox(s);
    scene.updateNode(s.id);
  }
  for (const e of Object.values(doc.board.edges)) {
    if (e.fontSize != null) continue;
    scene.updateEdge(e.id);
  }
  bumpRevision();
}

/**
 * Apply a font preset to specific objects only (individual modification): pins
 * each to an explicit `fontSize` of its kind default × scale. These objects then
 * keep that size independent of the board default until resized again.
 */
export function setShapesFontPreset(ids: Iterable<ID>, scale: number): void {
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    s.fontSize = clampFont(defaultLabelFont(s.kind) * scale);
    if (s.kind === "text") reflowTextBox(s);
    scene.updateNode(id);
  }
  bumpRevision();
}

/** Apply a font preset to selected edges (lines/arrows). */
export function setEdgesFontPreset(ids: Iterable<ID>, scale: number): void {
  for (const id of ids) {
    const e = doc.board.edges[id];
    if (!e) continue;
    e.fontSize = clampFont(EDGE_LABEL_FONT * scale);
    scene.updateEdge(id);
  }
  bumpRevision();
}

/** Bump font size one preset tier for the selection, or the board default when empty. */
export function adjustFontSize(dir: 1 | -1): void {
  const { shapes, edges } = $selection.get();
  if (shapes.size || edges.size) {
    for (const id of shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      const scale = stepFontScale(shapeFontScale(s), dir);
      s.fontSize = clampFont(defaultLabelFont(s.kind) * scale);
      if (s.kind === "text") reflowTextBox(s);
      scene.updateNode(id);
    }
    for (const id of edges) {
      const e = doc.board.edges[id];
      if (!e) continue;
      const scale = stepFontScale(edgeFontScale(e), dir);
      e.fontSize = clampFont(EDGE_LABEL_FONT * scale);
      scene.updateEdge(id);
    }
    bumpRevision();
    return;
  }
  setFontScale(stepFontScale(doc.board.fontScale ?? 1, dir));
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

/**
 * Move shapes to the top of the unified paint order (drawn last → in front of
 * every other shape and edge). `order` is bottom→top and holds both shape and
 * edge ids; the moved ids keep their relative order.
 */
export function bringToFront(ids: Iterable<ID>): void {
  reorderShapes(ids, "front");
}

/** Move shapes to the bottom of the paint order (drawn first → behind everything). */
export function sendToBack(ids: Iterable<ID>): void {
  reorderShapes(ids, "back");
}

function reorderShapes(ids: Iterable<ID>, where: "front" | "back"): void {
  const set = new Set(ids);
  const order = doc.board.order;
  const moved = order.filter((id) => set.has(id));
  if (!moved.length) return;
  const kept = order.filter((id) => !set.has(id));
  doc.board.order = where === "front" ? [...kept, ...moved] : [...moved, ...kept];
  scene.reorder();
  bumpRevision();
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
}): Edge {
  const edge: Edge = {
    id: uid(),
    from: opts.from,
    to: opts.to,
    x1: opts.x1,
    y1: opts.y1,
    x2: opts.x2,
    y2: opts.y2,
    stroke: $style.get().stroke,
    label: "",
    directed: opts.directed,
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

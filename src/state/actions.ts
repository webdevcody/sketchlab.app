import { DEFAULT_FONT_SIZE, snapFontSize, stepFontSize } from "../render/fontPresets";
import { measureTextBox } from "../render/measure";
import { effectiveEdgeFontSize } from "../render/edgeView";
import { effectiveFontSize } from "../render/shapeView";
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

/**
 * Migrate legacy font data to the absolute-tier model: the old board-wide
 * multiplier (`fontScale`) becomes an absolute default, and every per-object
 * `fontSize` is snapped to its nearest tier so prior free-resizes render at a
 * consistent size instead of an arbitrary one.
 */
function normalizeFonts(board: Board): void {
  if (board.fontSize == null && board.fontScale != null) {
    board.fontSize = snapFontSize(board.fontScale * DEFAULT_FONT_SIZE);
  }
  delete board.fontScale;
  for (const s of Object.values(board.shapes)) {
    if (s.fontSize != null) s.fontSize = snapFontSize(s.fontSize);
  }
  for (const e of Object.values(board.edges)) {
    if (e.fontSize != null) e.fontSize = snapFontSize(e.fontSize);
  }
}

/** Replace the active document and rebuild the scene from scratch. */
export function loadBoard(board: Board): void {
  board.order = normalizeOrder(board);
  normalizeFonts(board);
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
  const set = ids instanceof Set ? (ids as Set<ID>) : new Set(ids);
  // A manual bend (cx/cy) is a FIXED world anchor, not derived from the shapes.
  // When the whole edge (both endpoints) is part of the moved group, translate
  // the bend too so curved connectors — and their labels, which sit on the
  // curve midpoint — travel rigidly with the nodes instead of pivoting around a
  // stale control point. Done before the shape loop so the refresh that
  // updateNode triggers picks up the new control point.
  for (const e of Object.values(doc.board.edges)) {
    if (e.cx === undefined || e.cy === undefined) continue;
    if (e.from === undefined || e.to === undefined) continue;
    if (!set.has(e.from) || !set.has(e.to)) continue;
    e.cx += dx;
    e.cy += dy;
  }
  for (const id of set) {
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

/**
 * Set the active fill/stroke color: update the board default ({@link $style}) so
 * new shapes inherit it, and repaint the current selection. Stroke also recolors
 * selected edges; fill does not (edges have no fill). Shared by the style-panel
 * swatch pickers and the `1`–`0` color hotkeys.
 */
export function applyColor(target: "fill" | "stroke", color: string): void {
  $style.set({ ...$style.get(), [target]: color });
  const sel = $selection.get();
  if (target === "fill") {
    if (sel.shapes.size) setShapesStyle(sel.shapes, { fill: color });
  } else {
    if (sel.shapes.size) setShapesStyle(sel.shapes, { stroke: color });
    for (const id of sel.edges) updateEdge(id, { stroke: color });
  }
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
 * Set the board-wide default font size (one of the S/M/L/XL/XXL tiers). Only
 * objects without an explicit `fontSize` follow it; per-object overrides (from a
 * preset click) are left unchanged.
 */
export function setBoardFontSize(size: number): void {
  doc.board.fontSize = size;
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
 * Pin specific shapes to an absolute tier font size (individual override). The
 * same size applies to every kind; objects keep it independent of the board
 * default.
 */
export function setShapesFontSize(ids: Iterable<ID>, size: number): void {
  for (const id of ids) {
    const s = doc.board.shapes[id];
    if (!s) continue;
    s.fontSize = size;
    if (s.kind === "text") reflowTextBox(s);
    scene.updateNode(id);
  }
  bumpRevision();
}

/** Pin selected edges (lines/arrows) to an absolute tier font size. */
export function setEdgesFontSize(ids: Iterable<ID>, size: number): void {
  for (const id of ids) {
    const e = doc.board.edges[id];
    if (!e) continue;
    e.fontSize = size;
    scene.updateEdge(id);
  }
  bumpRevision();
}

/** Bump font size one tier for the selection, or the board default when empty. */
export function adjustFontSize(dir: 1 | -1): void {
  const { shapes, edges } = $selection.get();
  if (shapes.size || edges.size) {
    for (const id of shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      s.fontSize = stepFontSize(effectiveFontSize(s), dir);
      if (s.kind === "text") reflowTextBox(s);
      scene.updateNode(id);
    }
    for (const id of edges) {
      const e = doc.board.edges[id];
      if (!e) continue;
      e.fontSize = stepFontSize(effectiveEdgeFontSize(e), dir);
      scene.updateEdge(id);
    }
    bumpRevision();
    return;
  }
  setBoardFontSize(stepFontSize(doc.board.fontSize ?? DEFAULT_FONT_SIZE, dir));
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

// ---- grouping ----

/**
 * Grow a selection so that picking any member of a group pulls in the whole
 * group. Shared by click and marquee selection so grouped objects act as one
 * unit. Elements with no group are returned unchanged.
 */
export function expandSelectionGroups(
  shapes: Iterable<ID>,
  edges: Iterable<ID>,
): { shapes: Set<ID>; edges: Set<ID> } {
  const outShapes = new Set<ID>(shapes);
  const outEdges = new Set<ID>(edges);
  const groups = new Set<ID>();
  for (const id of outShapes) {
    const g = doc.board.shapes[id]?.group;
    if (g) groups.add(g);
  }
  for (const id of outEdges) {
    const g = doc.board.edges[id]?.group;
    if (g) groups.add(g);
  }
  if (groups.size === 0) return { shapes: outShapes, edges: outEdges };
  for (const s of Object.values(doc.board.shapes)) {
    if (s.group && groups.has(s.group)) outShapes.add(s.id);
  }
  for (const e of Object.values(doc.board.edges)) {
    if (e.group && groups.has(e.group)) outEdges.add(e.id);
  }
  return { shapes: outShapes, edges: outEdges };
}

/**
 * The clicked element plus its group siblings — i.e. what a single click should
 * select. An ungrouped element resolves to just itself.
 */
export function groupSiblings(id: ID): { shapes: ID[]; edges: ID[] } {
  const isShape = doc.board.shapes[id] !== undefined;
  const ex = expandSelectionGroups(isShape ? [id] : [], isShape ? [] : [id]);
  return { shapes: [...ex.shapes], edges: [...ex.edges] };
}

/** Bind the current selection (2+ objects) into one new group, flattening any
 *  prior group membership among the selected objects. */
export function groupSelection(): void {
  const sel = $selection.get();
  if (sel.shapes.size + sel.edges.size < 2) return;
  const gid = uid();
  for (const id of sel.shapes) {
    const s = doc.board.shapes[id];
    if (s) s.group = gid;
  }
  for (const id of sel.edges) {
    const e = doc.board.edges[id];
    if (e) e.group = gid;
  }
  scene.requestRender();
  bumpRevision();
}

/** Dissolve the group(s) of every selected object, leaving the objects selected. */
export function ungroupSelection(): void {
  const sel = $selection.get();
  let changed = false;
  for (const id of sel.shapes) {
    const s = doc.board.shapes[id];
    if (s?.group !== undefined) {
      delete s.group;
      changed = true;
    }
  }
  for (const id of sel.edges) {
    const e = doc.board.edges[id];
    if (e?.group !== undefined) {
      delete e.group;
      changed = true;
    }
  }
  if (changed) {
    scene.requestRender();
    bumpRevision();
  }
}

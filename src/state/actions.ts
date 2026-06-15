import { measureTextBox } from "../render/measure";
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

/** Replace the active document and rebuild the scene from scratch. */
export function loadBoard(board: Board): void {
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
    const box = measureTextBox(text, s.fontSize);
    s.w = box.w;
    s.h = box.h;
  }
  scene.updateNode(id);
  bumpRevision();
}

export function deleteShape(id: ID): void {
  if (!doc.board.shapes[id]) return;
  for (const e of edgesConnectedTo(id)) {
    delete doc.board.edges[e.id];
    scene.removeEdge(e.id);
  }
  delete doc.board.shapes[id];
  const idx = doc.board.order.indexOf(id);
  if (idx >= 0) doc.board.order.splice(idx, 1);
  scene.removeNode(id);
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
  const edge: Edge = {
    id: uid(),
    from,
    to,
    stroke: $style.get().stroke,
    label: "",
    directed,
  };
  doc.board.edges[edge.id] = edge;
  scene.addEdge(edge.id);
  bumpRevision();
  return edge;
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
    if (sel.shapes.has(e.from) || sel.shapes.has(e.to)) edgeIds.add(e.id);
  }
  for (const id of edgeIds) {
    delete doc.board.edges[id];
    scene.removeEdge(id);
  }
  for (const id of removedShapes) {
    delete doc.board.shapes[id];
    const idx = doc.board.order.indexOf(id);
    if (idx >= 0) doc.board.order.splice(idx, 1);
    scene.removeNode(id);
  }
  if (removedShapes.length || edgeIds.size) {
    setSelection([], []);
    bumpRevision();
  }
}

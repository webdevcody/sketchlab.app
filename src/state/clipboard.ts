import type { Pt } from "../render/geometry";
import { scene } from "../render/scene";
import { uid } from "../util";
import { deleteSelection } from "./actions";
import { $selection, bumpRevision, doc, setSelection } from "./store";
import type { Edge, Shape } from "./types";

const PASTE_OFFSET = 24;

let clipShapes: Shape[] = [];
let clipEdges: Edge[] = [];
let pasteCount = 0;

/**
 * Copy the current selection to the clipboard: every selected shape, plus every
 * edge that is either explicitly selected or fully spanned by the selected shapes
 * (so duplicating a subgraph keeps its internal connectors).
 */
export function copySelection(): void {
  const sel = $selection.get();
  const shapes: Shape[] = [];
  for (const id of sel.shapes) {
    const s = doc.board.shapes[id];
    if (s) shapes.push({ ...s });
  }
  const ids = new Set(shapes.map((s) => s.id));
  const edges: Edge[] = [];
  for (const e of Object.values(doc.board.edges)) {
    const spanned =
      e.from !== undefined && e.to !== undefined && ids.has(e.from) && ids.has(e.to);
    if (sel.edges.has(e.id) || spanned) edges.push({ ...e });
  }
  if (!shapes.length && !edges.length) return;
  clipShapes = shapes;
  clipEdges = edges;
  pasteCount = 0;
}

export function cutSelection(): void {
  const sel = $selection.get();
  if (!sel.shapes.size && !sel.edges.size) return;
  copySelection();
  deleteSelection();
}

/**
 * The center of the clipboard's bounding box in world space — spanning every
 * copied shape plus any free (unanchored) edge endpoints. Returns null when the
 * clipboard holds nothing positionable. Used to recenter a paste on the cursor.
 */
function clipboardCenter(): Pt | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of clipShapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  for (const e of clipEdges) {
    if (e.from === undefined && e.x1 !== undefined && e.y1 !== undefined) {
      minX = Math.min(minX, e.x1);
      minY = Math.min(minY, e.y1);
      maxX = Math.max(maxX, e.x1);
      maxY = Math.max(maxY, e.y1);
    }
    if (e.to === undefined && e.x2 !== undefined && e.y2 !== undefined) {
      minX = Math.min(minX, e.x2);
      minY = Math.min(minY, e.y2);
      maxX = Math.max(maxX, e.x2);
      maxY = Math.max(maxY, e.y2);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Paste a fresh copy of the clipboard. When `at` (a world point, e.g. under the
 * mouse cursor) is given, the copy is translated so its bounding-box center lands
 * there. Otherwise repeats are cascaded by a fixed offset so they don't stack.
 */
export function pasteClipboard(at?: Pt): void {
  if (!clipShapes.length && !clipEdges.length) return;

  let dx: number;
  let dy: number;
  const center = at ? clipboardCenter() : null;
  if (at && center) {
    // drop the whole selection so its center sits under the cursor
    dx = at.x - center.x;
    dy = at.y - center.y;
  } else {
    // no target: cascade off the original so repeats don't land exactly on top
    pasteCount++;
    dx = dy = PASTE_OFFSET * pasteCount;
  }

  const idMap = new Map<string, string>();
  const newShapeIds: string[] = [];
  for (const s of clipShapes) {
    const nid = uid();
    idMap.set(s.id, nid);
    doc.board.shapes[nid] = { ...s, id: nid, x: s.x + dx, y: s.y + dy };
    doc.board.order.push(nid);
    scene.addNode(nid);
    newShapeIds.push(nid);
  }

  const newEdgeIds: string[] = [];
  for (const e of clipEdges) {
    // resolve each end: a copied shape -> its copy; an uncopied shape -> the
    // original if it still exists; a free end -> stays free. an anchored end
    // whose shape is gone can't be placed, so the whole edge is skipped.
    const fromCopied = e.from !== undefined && idMap.has(e.from);
    const toCopied = e.to !== undefined && idMap.has(e.to);
    let skip = false;
    const resolveEnd = (id: string | undefined): string | undefined => {
      if (id === undefined) return undefined;
      if (idMap.has(id)) return idMap.get(id)!;
      if (doc.board.shapes[id]) return id;
      skip = true;
      return undefined;
    };
    const from = resolveEnd(e.from);
    const to = resolveEnd(e.to);
    if (skip) continue;

    const nid = uid();
    const clone: Edge = { ...e, id: nid, from, to };
    // free endpoints move with the pasted copy so it doesn't sit on the original
    if (clone.from === undefined && clone.x1 !== undefined && clone.y1 !== undefined) {
      clone.x1 += dx;
      clone.y1 += dy;
    }
    if (clone.to === undefined && clone.x2 !== undefined && clone.y2 !== undefined) {
      clone.x2 += dx;
      clone.y2 += dy;
    }
    // shift a manual bend only when both of its endpoints moved with it (both
    // copied, or free) — so an edge re-attached to existing shapes keeps its shape.
    const bendMoves = (fromCopied || e.from === undefined) && (toCopied || e.to === undefined);
    if (bendMoves) {
      if (clone.cx !== undefined) clone.cx += dx;
      if (clone.cy !== undefined) clone.cy += dy;
    }
    doc.board.edges[nid] = clone;
    doc.board.order.push(nid);
    scene.addEdge(nid);
    newEdgeIds.push(nid);
  }

  setSelection(newShapeIds, newEdgeIds);
  bumpRevision();
}

export function hasClipboard(): boolean {
  return clipShapes.length > 0 || clipEdges.length > 0;
}

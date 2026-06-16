import type { Edge, ID, Shape } from "../state/types";

export interface Pt {
  x: number;
  y: number;
}

export function center(s: Shape): Pt {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** Point on the shape's outline along the ray from its center toward `target`. */
export function boundaryPoint(s: Shape, target: Pt): Pt {
  const c = center(s);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  if (s.kind === "circle") {
    const rx = s.w / 2;
    const ry = s.h / 2;
    const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  // rect / icon: intersect ray with the half-extent box
  const hw = s.w / 2;
  const hh = s.h / 2;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export function pointInShape(s: Shape, p: Pt): boolean {
  if (s.kind === "circle") {
    const rx = s.w / 2;
    const ry = s.h / 2;
    const nx = (p.x - (s.x + rx)) / rx;
    const ny = (p.y - (s.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
}

export function rectIntersectsShape(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  s: Shape,
): boolean {
  // bounding-box overlap is enough for marquee selection
  return !(s.x > rx1 || s.x + s.w < rx0 || s.y > ry1 || s.y + s.h < ry0);
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * vx;
  const cy = a.y + t * vy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Sample a quadratic bezier into n+1 points. */
export function quadPoints(a: Pt, ctrl: Pt, b: Pt, n = 12): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push({
      x: mt * mt * a.x + 2 * mt * t * ctrl.x + t * t * b.x,
      y: mt * mt * a.y + 2 * mt * t * ctrl.y + t * t * b.y,
    });
  }
  return out;
}

/** Resolved endpoints + control + label anchor for an edge. */
export interface EdgeGeometry {
  p1: Pt;
  p2: Pt;
  ctrl: Pt | null;
  mid: Pt;
}

/** One end of an edge: a shape it anchors to, or a fixed world point. */
type EdgeEnd = { shape: Shape; point?: undefined } | { shape?: undefined; point: Pt };

/** The free point of an end, or the center of its shape — i.e. where it "aims from". */
function endCenter(end: EdgeEnd): Pt {
  return end.shape ? center(end.shape) : end.point;
}

/** The drawn endpoint: a shape's boundary toward `target`, or the fixed free point. */
function endPoint(end: EdgeEnd, target: Pt): Pt {
  return end.shape ? boundaryPoint(end.shape, target) : end.point;
}

export function edgeGeometry(from: EdgeEnd, to: EdgeEnd, ctrl: Pt | null): EdgeGeometry {
  const targetA = ctrl ?? endCenter(to);
  const targetB = ctrl ?? endCenter(from);
  const p1 = endPoint(from, targetA);
  const p2 = endPoint(to, targetB);
  const mid = ctrl ?? { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  return { p1, p2, ctrl, mid };
}

/** Resolve an edge's two ends to shapes or fixed points, given the board's shapes. */
function edgeEnds(shapes: Record<ID, Shape>, edge: Edge): { from: EdgeEnd; to: EdgeEnd } {
  const resolve = (id: ID | undefined, fx: number | undefined, fy: number | undefined): EdgeEnd => {
    const shape = id !== undefined ? shapes[id] : undefined;
    if (shape) return { shape };
    return { point: { x: fx ?? 0, y: fy ?? 0 } };
  };
  return {
    from: resolve(edge.from, edge.x1, edge.y1),
    to: resolve(edge.to, edge.x2, edge.y2),
  };
}

/** world-space lateral spacing between adjacent parallel edges at their apex */
const LANE_GAP = 28;

/** All edges connecting the same unordered pair of shapes as `edge` (incl. itself). */
export function pairSiblings(edges: Record<ID, Edge>, edge: Edge): Edge[] {
  const a = edge.from;
  const b = edge.to;
  // free / half-anchored edges have no shape pair to fan against
  if (a === undefined || b === undefined) return [edge];
  const out: Edge[] = [];
  for (const e of Object.values(edges)) {
    if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) out.push(e);
  }
  return out;
}

/**
 * Auto control point so parallel edges fan out instead of stacking. Returns null
 * for a lone edge (and the first edge of a pair), which stay straight. Edges rank
 * by creation order — `siblings` arrives in board insertion order — and stack
 * cumulatively to one side: the first line stays on top and each newly added line
 * sits strictly below the previous ones, never above them. The offset side is
 * forced "down" the screen (to the right for vertical edges) and is shared by all
 * siblings (both directions), so the stack stays consistent.
 */
function autoControl(edge: Edge, from: Shape, to: Shape, siblings: Edge[]): Pt | null {
  if (siblings.length <= 1) return null;
  if (edge.from === undefined || edge.to === undefined) return null;
  const rank = siblings.findIndex((e) => e.id === edge.id);
  if (rank <= 0) return null; // first-created edge stays straight; others stack below

  const firstIsFrom = edge.from < edge.to;
  const ca = center(firstIsFrom ? from : to);
  const cb = center(firstIsFrom ? to : from);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  let px = -dy / len;
  let py = dx / len;
  if (py < 0 || (py === 0 && px < 0)) {
    px = -px;
    py = -py;
  }
  const mx = (ca.x + cb.x) / 2;
  const my = (ca.y + cb.y) / 2;
  // control offset is ~2× the apex offset for a quadratic bezier
  const off = 2 * rank * LANE_GAP;
  return { x: mx + px * off, y: my + py * off };
}

/**
 * Geometry for an edge honoring (a) a manual bend (edge.cx/cy) or (b) the auto
 * parallel-edge fan. For auto-curves the label/handle anchor (`mid`) sits on the
 * curve apex rather than at the control point.
 */
export function resolveEdgeGeometry(
  edges: Record<ID, Edge>,
  shapes: Record<ID, Shape>,
  edge: Edge,
): EdgeGeometry {
  const { from, to } = edgeEnds(shapes, edge);
  if (edge.cx !== undefined && edge.cy !== undefined) {
    return edgeGeometry(from, to, { x: edge.cx, y: edge.cy });
  }
  // auto-fan only applies between two shapes; free edges stay straight
  const ctrl =
    from.shape && to.shape
      ? autoControl(edge, from.shape, to.shape, pairSiblings(edges, edge))
      : null;
  if (!ctrl) return edgeGeometry(from, to, null);
  const geo = edgeGeometry(from, to, ctrl);
  return {
    ...geo,
    mid: {
      x: 0.25 * geo.p1.x + 0.5 * ctrl.x + 0.25 * geo.p2.x,
      y: 0.25 * geo.p1.y + 0.5 * ctrl.y + 0.25 * geo.p2.y,
    },
  };
}

/** Sentinel `fill`/`stroke` value meaning "no paint" — the shape renders as outline only. */
export const NO_FILL = "transparent";

export function hexToNumber(hex: string): number {
  if (hex.startsWith("#")) hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return parseInt(hex, 16) || 0;
}

/** Pick a readable text color (dark or light) for a given background hex. */
export function readableText(bgHex: string): number {
  // a transparent fill shows the dark canvas behind it, so labels read light
  if (bgHex === NO_FILL) return 0xf1f5f9;
  const n = hexToNumber(bgHex);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? 0x0f172a : 0xf1f5f9;
}

import type { Graphics } from "pixi.js";
import { hexToNumber } from "./geometry";
import type { Projector, ScreenPoint } from "./projection";
import { depthAtBoard, projectBoard, projectBoardSegment, scaleAtBoard } from "./projection";
import { layerFade, shade, tint } from "./shading";

/** Legacy cyan neon hue — the default floor accent when a layer has no color set. */
export const DEFAULT_FLOOR_COLOR = "#38bdf8";

export interface GridBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const NEAR_CLIP_EPS = 1e-5;
const MIN_GRID_GAP_PX = 10;
const MIN_GRID_LINES_PER_AXIS = 6;
const MAX_GRID_LINES_PER_AXIS = 180;

interface BoardPoint {
  x: number;
  y: number;
  depth: number;
}

export interface GridLine {
  axis: 0 | 1;
  seg: [ScreenPoint, ScreenPoint];
  wxMid: number;
  wyMid: number;
  isMajor: boolean;
}

/**
 * Project a board rectangle after clipping it to the camera's near plane. The
 * finite board can be much larger than the current view; clipping here keeps a
 * close zoom from making the whole field/frame disappear when only the near edge
 * is behind the eye.
 */
function clippedRect(proj: Projector, b: GridBounds, elev = 0, inset = 0): ScreenPoint[] | null {
  const xs: [number, number] = [b.minX - inset, b.maxX + inset];
  const ys: [number, number] = [b.minY - inset, b.maxY + inset];
  // order: far-left, far-right, near-right, near-left (CW-ish for a clean fill)
  const order: BoardPoint[] = [
    [xs[0], ys[0]],
    [xs[1], ys[0]],
    [xs[1], ys[1]],
    [xs[0], ys[1]],
  ].map(([x, y]) => ({ x, y, depth: depthAtBoard(proj, x, y, elev) }));

  const clipDepth = proj.cam.near + NEAR_CLIP_EPS;
  const inside = (p: BoardPoint): boolean => p.depth > clipDepth;
  const intersect = (a: BoardPoint, c: BoardPoint): BoardPoint => {
    const t = (clipDepth - a.depth) / (c.depth - a.depth);
    const x = a.x + (c.x - a.x) * t;
    const y = a.y + (c.y - a.y) * t;
    return { x, y, depth: clipDepth };
  };

  const clipped: BoardPoint[] = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const c = order[(i + 1) % order.length];
    const aInside = inside(a);
    const cInside = inside(c);
    if (aInside && cInside) {
      clipped.push(c);
    } else if (aInside && !cInside) {
      clipped.push(intersect(a, c));
    } else if (!aInside && cInside) {
      clipped.push(intersect(a, c), c);
    }
  }
  if (clipped.length < 3) return null;

  const out: ScreenPoint[] = [];
  for (const { x, y } of clipped) {
    const p = projectBoard(proj, x, y, elev);
    if (!p.ok) return null;
    out.push({ sx: p.sx, sy: p.sy });
  }
  return out;
}

function polyPath(g: Graphics, pts: ScreenPoint[]): void {
  g.moveTo(pts[0].sx, pts[0].sy);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].sx, pts[i].sy);
  g.closePath();
}

/** Recessed deep-navy board field (the surface the grid is etched into). */
export function drawField(g: Graphics, proj: Projector, b: GridBounds): void {
  const c = clippedRect(proj, b, 0, 0);
  if (!c) return;
  polyPath(g, c);
  g.fill({ color: 0x0a0f1a, alpha: 1 });
  polyPath(g, c);
  g.fill({ color: 0x060912, alpha: 0.55 });
}

/** Converging, depth-faded perspective grid. One Graphics, many stroke passes. */
function projectedStepPx(proj: Projector, b: GridBounds, step: number, axis: 0 | 1): number {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const a = projectBoard(proj, cx, cy);
  const d = axis === 0 ? projectBoard(proj, cx + step, cy) : projectBoard(proj, cx, cy + step);
  if (!a.ok || !d.ok) return 0;
  return Math.hypot(d.sx - a.sx, d.sy - a.sy);
}

function lineCount(min: number, max: number, step: number): number {
  return Math.max(0, Math.floor((max - min) / step) + 1);
}

function adaptiveGridStep(
  proj: Projector,
  b: GridBounds,
  baseStep: number,
  axis: 0 | 1,
): number {
  const min = axis === 0 ? b.minX : b.minY;
  const max = axis === 0 ? b.maxX : b.maxY;
  let step = baseStep;
  while (
    step < (max - min) &&
    lineCount(min, max, step * 2) >= MIN_GRID_LINES_PER_AXIS &&
    (projectedStepPx(proj, b, step, axis) < MIN_GRID_GAP_PX ||
      lineCount(min, max, step) > MAX_GRID_LINES_PER_AXIS)
  ) {
    step *= 2;
  }
  return step;
}

function isGridMultiple(value: number, step: number): boolean {
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

export function collectGridLines(
  proj: Projector,
  b: GridBounds,
  minor = 48,
  major = 240,
): GridLine[] {
  const lines: GridLine[] = [];
  const xStep = adaptiveGridStep(proj, b, minor, 0);
  const yStep = adaptiveGridStep(proj, b, minor, 1);
  const addLine = (ax: number, ay: number, bx: number, by: number, axis: 0 | 1, isMajor: boolean): void => {
    const seg = projectBoardSegment(proj, ax, ay, bx, by, 0); // near-clipped
    if (!seg) return;
    lines.push({
      axis,
      seg,
      wxMid: (ax + bx) / 2,
      wyMid: (ay + by) / 2,
      isMajor,
    });
  };

  const x0 = Math.ceil(b.minX / xStep) * xStep;
  for (let x = x0; x <= b.maxX; x += xStep) addLine(x, b.minY, x, b.maxY, 0, isGridMultiple(x, major));
  const y0 = Math.ceil(b.minY / yStep) * yStep;
  for (let y = y0; y <= b.maxY; y += yStep) addLine(b.minX, y, b.maxX, y, 1, isGridMultiple(y, major));
  return lines;
}

export function drawGrid(
  g: Graphics,
  proj: Projector,
  b: GridBounds,
  minor = 48,
  major = 240,
): void {
  const midX = (b.minX + b.maxX) / 2;
  const d0 = depthAtBoard(proj, midX, b.minY);
  const d1 = depthAtBoard(proj, midX, b.maxY);
  const dNear = Math.min(d0, d1);
  const dFar = Math.max(d0, d1);
  const span = Math.max(1e-6, dFar - dNear);
  const bright = (wxMid: number, wyMid: number): number =>
    1 - (depthAtBoard(proj, wxMid, wyMid) - dNear) / span;

  const strokeLine = (line: GridLine): void => {
    const t = clamp01(bright(line.wxMid, line.wyMid));
    const sc = scaleAtBoard(proj, line.wxMid, line.wyMid);
    g.moveTo(line.seg[0].sx, line.seg[0].sy).lineTo(line.seg[1].sx, line.seg[1].sy);
    if (line.isMajor) {
      g.stroke({ width: Math.max(0.6, 1.6 * sc), color: 0x38bdf8, alpha: lerp(0.05, 0.34, t), cap: "round" });
    } else {
      g.stroke({ width: Math.max(0.4, 1.0 * sc), color: 0x1f4a63, alpha: lerp(0.02, 0.2, t), cap: "round" });
    }
  };

  const lines = collectGridLines(proj, b, minor, major);
  for (const line of lines) if (!line.isMajor) strokeLine(line);
  for (const line of lines) if (line.isMajor) strokeLine(line);
}

/**
 * A single glowing board FLOOR frame, lifted to `elev`, in the floor's accent
 * `color` (defaults to cyan). `distance` is how many floors away from the active
 * layer this one sits: the active floor (0) glows full, and each floor of
 * separation fades geometrically so far floors recede.
 *
 * The ACTIVE floor is filled with a clearly visible, hue-matched translucent
 * plate — the primary "you are here" cue. Inactive floors stay open wireframes,
 * so the selected layer reads as a solid surface among bare frames at a glance.
 */
export function drawFloor(
  g: Graphics,
  proj: Projector,
  b: GridBounds,
  elev: number,
  distance: number,
  color: string = DEFAULT_FLOOR_COLOR,
): void {
  const ring = clippedRect(proj, b, elev, 0);
  if (!ring) return;
  const sc = scaleAtBoard(proj, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, elev);
  const active = distance === 0;
  // frames keep a slightly higher floor than tokens so the stack stays readable
  const dim = layerFade(distance, 0.22);

  const base = hexToNumber(color); // the floor's accent (frame + bolts)
  const core = tint(color, 0.45); // lighter mid-glow / core line
  const hot = tint(color, 0.78); // near-white inner line + bolt centers

  // filled, hue-matched plate so the ACTIVE floor reads as a solid surface you're
  // standing on — far stronger than the old near-invisible 0.1-alpha navy plate.
  if (active) {
    polyPath(g, ring);
    g.fill({ color: shade(color, 0.5), alpha: 0.2 });
    polyPath(g, ring);
    g.fill({ color: base, alpha: 0.06 });
  }
  // multi-pass glow in the floor's hue: wide+faint underlay → bright core
  const passes = [
    { w: 9, color: base, alpha: 0.1 },
    { w: 5, color: base, alpha: 0.2 },
    { w: 2.5, color: core, alpha: 0.55 },
  ];
  for (const pass of passes) {
    polyPath(g, ring);
    g.stroke({
      width: Math.max(0.6, pass.w * sc),
      color: pass.color,
      alpha: pass.alpha * dim,
      cap: "round",
      join: "round",
    });
  }
  // bright inner core line
  polyPath(g, ring);
  g.stroke({ width: Math.max(0.5, 1.2 * sc), color: hot, alpha: 0.95 * dim, cap: "round" });

  // corner "bolts" — small bright nodes that anchor each frame corner
  const r = Math.max(1.5, 3.4 * sc);
  for (const c of ring) {
    g.circle(c.sx, c.sy, r * 1.8);
    g.fill({ color: base, alpha: 0.18 * dim });
    g.circle(c.sx, c.sy, r);
    g.fill({ color: hot, alpha: 0.95 * dim });
  }
}

/** Thin near-black lip tracing the ground field edge (seats the floor stack). */
export function drawFrame(g: Graphics, proj: Projector, b: GridBounds): void {
  const inner = clippedRect(proj, b, 0, 0);
  if (!inner) return;
  polyPath(g, inner);
  g.stroke({ width: 2, color: 0x04070c, alpha: 0.9 });
}

/**
 * Paint the full board surface into one Graphics: the navy field + glowing grid,
 * a thin ground lip, then one neon FRAME per floor (bottom→top) at its elevation.
 * `floorElevations` defaults to a single ground floor so legacy callers behave.
 */
export function drawBoard(
  g: Graphics,
  proj: Projector,
  b: GridBounds,
  floorElevations: number[] = [0],
  activeIndex = 0,
  hidden: boolean[] = [],
  colors: Array<string | undefined> = [],
): void {
  g.clear();
  drawField(g, proj, b);
  drawGrid(g, proj, b);
  drawFrame(g, proj, b);
  floorElevations.forEach((elev, i) => {
    if (hidden[i]) return; // a hidden floor draws no frame, plate or bolts
    drawFloor(g, proj, b, elev, Math.abs(i - activeIndex), colors[i] ?? DEFAULT_FLOOR_COLOR);
  });
}

// src/render/projection.ts
//
// Perspective ground-plane projection for the tactical board. The board DATA
// stays in flat ground coordinates (wx, wy); this module reinterprets that
// plane as Z = 0 in a 3D world and projects it through a pinhole camera pitched
// down at the table, so the grid CONVERGES toward a vanishing point (true
// perspective, not an affine tilt). Self-contained: zero imports, zero deps.
//
//   project(wx, wy, height?)  -> { sx, sy, scale, depth, ok }   (forward)
//   unprojectGround(sx, sy)   -> { wx, wy } | null              (EXACT inverse)
//
// Conventions (chosen to match the y-down canvas + the reference image):
//   wx     -> board RIGHT
//   wy     -> board DEPTH: increasing wy moves a point AWAY from the camera,
//             toward the far edge / vanishing point near the top of the screen.
//   height -> world-up (+Z): lifts a point off the board toward the viewer
//             (pedestal tops, floating icons, arrows hovering over the surface).
//   canvas y grows DOWNWARD; the focus ground point is pinned to screen center.
//
// ----------------------------------------------------------------------------
// WHY THIS PARAMETERIZATION (the merge of the two derivations)
// ----------------------------------------------------------------------------
// Both derivations are the same pinhole-pitched-at-a-plane camera and produce
// algebraically identical maps. We adopt derivation A's *vector* form with a
// GROUND-POINT focus rather than derivation B's homography form with a
// SCREEN-SPACE principal point, because:
//   * The task asks for a Camera3D param set {focus, distance, pitch, zoom} that
//     extends the old {x, y, zoom}. A's `focusX/focusY` IS the ground point shown
//     under the screen center, so "pan = move focus" and at the focus `scale ==
//     zoom` exactly — identical hand-feel to the retired affine camera. B's
//     `focus` is a principal point in px, a less direct fit for that seam.
//   * Height rides through cleanly as a per-point term (`-height*sin` in depth).
//     In B's 3x3 it cannot pass through the matrix at all (height lives in the
//     homogeneous denominator) and needs the same per-point function anyway, so
//     the matrix buys nothing here.
//   * The closed-form inverse is identical either way; we keep A's, which never
//     forms a 3x3 and is a two-line solve.
// B's contributions are folded in: the depth-faded screen-space grid generator,
// the vanishing point, and the horizon anchor for the depth fade / vignette.
//
// Verified: project -> unprojectGround round-trips to floating-point epsilon.
// Worked example (D=1200, pitch=60deg, zoom=1, screen 800x600 => cx=400,cy=300):
//   project(150, 300)        -> sx=533.333, sy=69.060, scale=0.88889, depth=1350
//   unprojectGround(533.333, 69.060) -> wx=150, wy=300   (identity to ~1e-12)
// See roundTripError() below to re-verify in code.

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Camera3D — supersedes the flat `Camera {x, y, zoom}`. `focusX/focusY` replace
 * the old pan offset (now a GROUND point, not a screen translation); `zoom` is
 * preserved 1:1; `distance` + `pitch` are the new perspective knobs.
 */
export interface Camera3D {
  /** ground point shown under the screen center (this is what "pan" moves) */
  focusX: number;
  focusY: number;
  /** eye-to-focus distance, in world units */
  distance: number;
  /** optical-axis angle BELOW horizontal, radians. PI/2 = straight-down plan
   *  view (parallel grid); ~PI/3 (60deg) matches the reference's convergence. */
  pitch: number;
  /** focal-length multiplier (this is what "zoom" scales) */
  zoom: number;
  /** turntable spin (radians) around the vertical axis through the focus —
   *  rotates the board in its own ground plane, keeping it flat. Default 0. */
  yaw?: number;
  /** base focal length in px; default = distance, so scale == zoom at the focus */
  focal0?: number;
  /** near clip on eye-space depth; default = max(1e-4, distance * 1e-3) */
  near?: number;
}

export interface ScreenSize {
  w: number;
  h: number;
  /** screen point the focus maps to; defaults to (w/2, h/2) */
  cx?: number;
  cy?: number;
}

export interface Projected {
  sx: number;
  sy: number;
  /** px per world unit at this point (size billboards / pedestals / strokes by this) */
  scale: number;
  /** eye-space depth; larger = farther. Sort DESCENDING for back-to-front paint. */
  depth: number;
  /** false when clipped (at/behind the near plane — sx/sy are NaN) */
  ok: boolean;
}

export interface GroundPoint {
  wx: number;
  wy: number;
}

export interface ScreenPoint {
  sx: number;
  sy: number;
}

export interface GridFloorOptions {
  /** world-space region to grid (the visible floor you want covered) */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** spacing in world units between grid lines */
  step: number;
  /** depth at which the fade starts (default: depth of the near edge, minY) */
  fadeStart?: number;
  /** depth at which the fade reaches minAlpha (default: depth of the far edge, maxY) */
  fadeEnd?: number;
  /** floor alpha for the farthest visible lines (default 0.05) */
  minAlpha?: number;
}

export interface GridSegment {
  /** screen endpoints, already clipped to the near plane */
  a: ScreenPoint;
  b: ScreenPoint;
  /** farthest endpoint depth (for optional re-sorting) */
  depth: number;
  /** depth-fade alpha in [minAlpha, 1] */
  alpha: number;
  /** 0 = line of constant wx (recedes toward the vanishing point); 1 = constant wy */
  axis: 0 | 1;
}

export interface Projector {
  /** the resolved camera (defaults filled in) */
  readonly cam: Required<Camera3D>;
  /** the resolved screen (cx/cy filled in) */
  readonly screen: Required<ScreenSize>;
  /** focal length in px (zoom * focal0) */
  readonly focal: number;
  /** screen y of the horizon / vanishing line, or null for a top-down camera */
  readonly horizonY: number | null;
  /** screen point all constant-wx depth lines converge to, or null (top-down) */
  readonly vanishingPoint: ScreenPoint | null;

  /** Ground/raised point -> canvas px (+ scale, depth, clip flag). */
  project(wx: number, wy: number, height?: number): Projected;
  /** EXACT inverse: canvas px -> ground point, or null if at/above the horizon. */
  unprojectGround(sx: number, sy: number): GroundPoint | null;
  /**
   * Inverse onto the plane at world-up `height` (a lifted floor): canvas px ->
   * the ground point (wx,wy) whose point at that elevation projects to (sx,sy).
   * `height = 0` reduces exactly to unprojectGround. null at/above the horizon.
   */
  unprojectAt(sx: number, sy: number, height?: number): GroundPoint | null;
  /** px per world unit at a point (sugar over project().scale). */
  scaleAt(wx: number, wy: number, height?: number): number;
  /** eye-space depth at a point — painter's sort key (sugar over project().depth). */
  depthAt(wx: number, wy: number, height?: number): number;
  /**
   * Project a straight world segment, clipping it to the near plane first.
   * Returns the two screen endpoints, or null if the segment is fully behind the
   * camera. Straight ground lines stay straight under perspective, so the two
   * clipped endpoints fully describe the projected line (used for edges/arrows).
   */
  projectSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    height?: number,
  ): [ScreenPoint, ScreenPoint] | null;
  /** Generate the visible floor as depth-faded, near-clipped screen segments. */
  gridFloor(opts: GridFloorOptions): GridSegment[];
}

// ───────────────────────────────────────────────────────────────────────────
// Construction
// ───────────────────────────────────────────────────────────────────────────

const MIN_PITCH = 1e-3; // > 0; pitch -> 0 is edge-on (board collapses)
const HALF_PI = Math.PI / 2;
const HORIZON_EPS = 1e-9;
const NEAR_CLIP_EPS = 1e-5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Build a projector with precomputed sin/cos/focal for a camera + screen. */
export function createProjector(cam: Camera3D, screen: ScreenSize): Projector {
  const distance = cam.distance;
  // pitch in (0, PI/2]: 0 is edge-on (degenerate), > PI/2 would aim backwards.
  const pitch = clamp(cam.pitch, MIN_PITCH, HALF_PI);
  const zoom = Math.max(cam.zoom, 1e-6);
  const yaw = cam.yaw ?? 0;
  const focal0 = cam.focal0 ?? distance;
  const near = cam.near ?? Math.max(1e-4, distance * 1e-3);

  const sin = Math.sin(pitch);
  const cos = Math.cos(pitch);
  // yaw spins the ground plane around the vertical axis through the focus
  // (a turntable), BEFORE the pitch tilt — so the board stays flat and level.
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const focal = zoom * focal0;

  const cx = screen.cx ?? screen.w / 2;
  const cy = screen.cy ?? screen.h / 2;

  const resolvedCam: Required<Camera3D> = {
    focusX: cam.focusX,
    focusY: cam.focusY,
    distance,
    pitch,
    zoom,
    yaw,
    focal0,
    near,
  };
  const resolvedScreen: Required<ScreenSize> = { w: screen.w, h: screen.h, cx, cy };

  // Yaw-rotated depth axis: vr is the focus-relative DEPTH coordinate after the
  // turntable spin, so depth now depends on BOTH wx and wy (it didn't before yaw).
  function depthV(wx: number, wy: number): number {
    const u = wx - cam.focusX;
    const v = wy - cam.focusY;
    return u * sinY + v * cosY;
  }

  // eye-space depth of a world point — linear in the yawed depth & height.
  function depthOf(wx: number, wy: number, height: number): number {
    return distance + depthV(wx, wy) * cos - height * sin;
  }

  function project(wx: number, wy: number, height = 0): Projected {
    const u = wx - cam.focusX;
    const v = wy - cam.focusY;
    // spin around the vertical axis at the focus (turntable), then tilt by pitch
    const ur = u * cosY - v * sinY;
    const vr = u * sinY + v * cosY;
    const xe = ur;
    const ye = vr * sin + height * cos;
    const d = distance + vr * cos - height * sin;
    if (d <= near) {
      return { sx: NaN, sy: NaN, scale: 0, depth: d, ok: false };
    }
    const s = focal / d;
    return { sx: cx + xe * s, sy: cy - ye * s, scale: s, depth: d, ok: true };
  }

  /** Un-rotate the yawed focus-relative offset (ur, vr) back to a world point. */
  function unrotate(ur: number, vr: number): GroundPoint {
    const u = ur * cosY + vr * sinY;
    const v = -ur * sinY + vr * cosY;
    return { wx: cam.focusX + u, wy: cam.focusY + v };
  }

  function unprojectGround(sx: number, sy: number): GroundPoint | null {
    const px = sx - cx;
    const py = cy - sy; // un-flip canvas y
    const denom = focal * sin - py * cos; // -> 0 exactly on the horizon line
    if (denom <= HORIZON_EPS) return null; // at/above the horizon: no ground hit
    const vr = (py * distance) / denom;
    const d = distance + vr * cos;
    if (d <= near) return null; // behind the eye plane
    const ur = (px * d) / focal;
    return unrotate(ur, vr);
  }

  function unprojectAt(sx: number, sy: number, height = 0): GroundPoint | null {
    const px = sx - cx;
    const py = cy - sy; // un-flip canvas y
    const denom = focal * sin - py * cos; // -> 0 exactly on the horizon line
    if (denom <= HORIZON_EPS) return null; // at/above the horizon: no plane hit
    // Solve project(.,.,height).sy == sy for the yawed depth vr. At height 0 the
    // `height * (...)` term vanishes and this collapses to unprojectGround.
    const vr = (py * distance - height * (focal * cos + py * sin)) / denom;
    const d = distance + vr * cos - height * sin;
    if (d <= near) return null; // behind the eye plane
    const ur = (px * d) / focal;
    return unrotate(ur, vr);
  }

  function scaleAt(wx: number, wy: number, height = 0): number {
    const d = depthOf(wx, wy, height);
    return d <= near ? 0 : focal / d;
  }

  function depthAt(wx: number, wy: number, height = 0): number {
    return depthOf(wx, wy, height);
  }

  /** Clip a constant-height world segment to the near plane (or null if behind). */
  function clipToNear(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    height: number,
  ): { ax: number; ay: number; bx: number; by: number; da: number; db: number } | null {
    const clipDepth = near + Math.max(NEAR_CLIP_EPS, near * NEAR_CLIP_EPS);
    let da = depthOf(ax, ay, height);
    let db = depthOf(bx, by, height);
    const aBehind = da <= clipDepth;
    const bBehind = db <= clipDepth;
    if (aBehind && bBehind) return null;

    let aX = ax;
    let aY = ay;
    let bX = bx;
    let bY = by;
    if (aBehind || bBehind) {
      // depth(t) is linear along the segment; solve depth(t*) = near in closed form.
      const t = (clipDepth - da) / (db - da);
      const cxw = ax + (bx - ax) * t;
      const cyw = ay + (by - ay) * t;
      if (aBehind) {
        aX = cxw;
        aY = cyw;
        da = clipDepth;
      } else {
        bX = cxw;
        bY = cyw;
        db = clipDepth;
      }
    }
    return { ax: aX, ay: aY, bx: bX, by: bY, da, db };
  }

  function projectSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    height = 0,
  ): [ScreenPoint, ScreenPoint] | null {
    const clip = clipToNear(ax, ay, bx, by, height);
    if (!clip) return null;
    const pa = project(clip.ax, clip.ay, height);
    const pb = project(clip.bx, clip.by, height);
    if (!pa.ok || !pb.ok) return null; // numeric safety
    return [
      { sx: pa.sx, sy: pa.sy },
      { sx: pb.sx, sy: pb.sy },
    ];
  }

  function gridFloor(opts: GridFloorOptions): GridSegment[] {
    const { minX, minY, maxX, maxY, step } = opts;
    const out: GridSegment[] = [];
    if (step <= 0) return out;

    const minAlpha = opts.minAlpha ?? 0.05;
    const midX = (minX + maxX) / 2;
    const fadeStart = opts.fadeStart ?? depthOf(midX, minY, 0);
    const fadeEnd = opts.fadeEnd ?? depthOf(midX, maxY, 0);
    const span = Math.max(HORIZON_EPS, fadeEnd - fadeStart);
    const fade = (depth: number): number =>
      clamp(1 - (depth - fadeStart) / span, minAlpha, 1);

    const emit = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      axis: 0 | 1,
    ): void => {
      const clip = clipToNear(ax, ay, bx, by, 0);
      if (!clip) return;
      const pa = project(clip.ax, clip.ay, 0);
      const pb = project(clip.bx, clip.by, 0);
      if (!pa.ok || !pb.ok) return;
      const depth = Math.max(clip.da, clip.db);
      out.push({
        a: { sx: pa.sx, sy: pa.sy },
        b: { sx: pb.sx, sy: pb.sy },
        depth,
        alpha: fade(depth),
        axis,
      });
    };

    const x0 = Math.ceil(minX / step) * step;
    const y0 = Math.ceil(minY / step) * step;
    // constant-wx lines (recede toward the vanishing point)
    for (let x = x0; x <= maxX + HORIZON_EPS; x += step) {
      emit(x, minY, x, maxY, 0);
    }
    // constant-wy lines (run across the board)
    for (let y = y0; y <= maxY + HORIZON_EPS; y += step) {
      emit(minX, y, maxX, y, 1);
    }
    return out;
  }

  const hasHorizon = cos > HORIZON_EPS;
  const horizonY = hasHorizon ? cy - focal * (sin / cos) : null;

  return {
    cam: resolvedCam,
    screen: resolvedScreen,
    focal,
    horizonY,
    vanishingPoint: horizonY === null ? null : { sx: cx, sy: horizonY },
    project,
    unprojectGround,
    unprojectAt,
    scaleAt,
    depthAt,
    projectSegment,
    gridFloor,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Painter's comparator: farther (larger depth) first, so near items paint on top. */
export function byDepthDesc(a: { depth: number }, b: { depth: number }): number {
  return b.depth - a.depth;
}

/** A sensible tactical-board default camera (~60deg pitch, centered focus). */
export function defaultCamera3D(): Camera3D {
  return { focusX: 0, focusY: 0, distance: 1200, pitch: Math.PI / 3, zoom: 1 };
}

/**
 * Round-trip error in world units for a forward->inverse compose at one point —
 * a runtime check that project ∘ unprojectGround == identity. Returns Infinity
 * if the point is clipped or maps above the horizon.
 */
export function roundTripError(
  proj: Projector,
  wx: number,
  wy: number,
): number {
  const p = proj.project(wx, wy);
  if (!p.ok) return Infinity;
  const g = proj.unprojectGround(p.sx, p.sy);
  if (!g) return Infinity;
  return Math.hypot(g.wx - wx, g.wy - wy);
}

// ───────────────────────────────────────────────────────────────────────────
// Active-projector singleton, so the existing viewport.ts seam keeps its 2-arg
// worldToScreen/screenToWorld signatures while everything resolves through one
// perspective source. Rebuild whenever the camera or screen size changes.
// ───────────────────────────────────────────────────────────────────────────

let active: Projector = createProjector(defaultCamera3D(), { w: 1, h: 1 });

export function setActiveProjector(cam: Camera3D, screen: ScreenSize): Projector {
  active = createProjector(cam, screen);
  return active;
}

export function getActiveProjector(): Projector {
  return active;
}

// ───────────────────────────────────────────────────────────────────────────
// Board-space adapters. The board DATA is y-down (+y = nearer/lower on screen),
// but the projector treats +wy as receding away from the camera. We negate board
// y in exactly TWO centralized places — toProjCamera (focusY) and these wrappers
// — and NOWHERE else. Every renderer + the viewport seam goes through these.
// ───────────────────────────────────────────────────────────────────────────

import type { Camera } from "../state/types";

/** Map the app's board Camera to a projector Camera3D (the y-flip lives here). */
export function toProjCamera(cam: Camera): Camera3D {
  return {
    focusX: cam.focusX,
    focusY: -cam.focusY, // board → projector y-flip (centralized)
    distance: cam.distance,
    pitch: cam.pitch,
    zoom: cam.zoom,
    yaw: cam.yaw, // turntable spin (handled in the projector's ground plane)
    focal0: cam.distance, // ⇒ scale == zoom at the focus
  };
}

/**
 * Screen for the projector: the principal point = viewport center + the camera's
 * pan offset. Shifting it is a pure 2D translate of the image, separate from
 * zoom's focal-length scaling, so neither changes the perspective shape.
 */
export function projScreen(cam: Camera, w: number, h: number): ScreenSize {
  return { w, h, cx: w / 2 + cam.panX, cy: h / 2 + cam.panY };
}

/** Board (wx,wy,height) → screen. Use this, never the raw project(). */
export function projectBoard(p: Projector, wx: number, wy: number, height = 0): Projected {
  return p.project(wx, -wy, height);
}

/** Screen → board ground point (un-flips y), or null above the horizon. */
export function unprojectBoard(p: Projector, sx: number, sy: number): GroundPoint | null {
  const g = p.unprojectGround(sx, sy);
  return g ? { wx: g.wx, wy: -g.wy } : null;
}

/** Screen → board point on the plane at world-up `height` (un-flips y), or null above the horizon. */
export function unprojectBoardAt(
  p: Projector,
  sx: number,
  sy: number,
  height = 0,
): GroundPoint | null {
  const g = p.unprojectAt(sx, sy, height);
  return g ? { wx: g.wx, wy: -g.wy } : null;
}

/**
 * px per world unit at a board point (y-flip aware). `wx` matters once the board
 * is yawed (depth then depends on both axes); pass the point's real x.
 */
export function scaleAtBoard(p: Projector, wx: number, wy: number, height = 0): number {
  return p.scaleAt(wx, -wy, height);
}

/**
 * Eye-space depth at a board point — painter's sort key (y-flip aware). `wx`
 * matters once the board is yawed (depth then depends on both axes).
 */
export function depthAtBoard(p: Projector, wx: number, wy: number, height = 0): number {
  return p.depthAt(wx, -wy, height);
}

/** Project a board straight segment (y-flip + near clipping). */
export function projectBoardSegment(
  p: Projector,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  height = 0,
): [ScreenPoint, ScreenPoint] | null {
  return p.projectSegment(ax, -ay, bx, -by, height);
}

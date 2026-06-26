import { scene } from "../render/scene";
import {
  ELEV_CAP,
  floorElevation,
  getFloorStep,
  getLayerFadeStep,
  setFloorStep,
  setLayerFadeStep,
} from "../render/shading";
import { $camera, $floorSpacing, $layerFade, doc } from "../state/store";
import type { Camera } from "../state/types";
import { clamp } from "../util";
import { screenToWorld } from "./viewport";

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 6;
const MIN_DISTANCE = 500;
const BASE_MAX_DISTANCE = 120000; // dolly ceiling for a single-floor board (reaches MIN_ZOOM)
const MAX_DISTANCE_PER_FLOOR = 1200; // extra pull-back room each stacked floor adds…
const MAX_DISTANCE_CAP = 120000; // …up to here, where DEFAULT_DISTANCE / cap === MIN_ZOOM
const MIN_PITCH = 0.05;
const MAX_PITCH = (85 * Math.PI) / 180; // keep the horizon out of the working field
const DEFAULT_PITCH = (60 * Math.PI) / 180; // 30deg tilted from directly above
const DEFAULT_DISTANCE = 1200;
const FRAME_INSET = 120; // matches drawFrame's bezel inset; keep it in front of the near plane too
const NEAR_MARGIN = 0.25; // floor the board's near edge at 25% of camera distance in depth

/**
 * Lowest focusY (the deepest you can pan the board DOWN) that keeps the board's
 * near edge in front of the camera. Past this, the near corners cross the near
 * plane, `corners()` returns null, and the field/frame/grid blink out — the
 * "grid breaks when I move the board down too far" bug.
 *
 *   depth(nearEdge) = distance + (focusY - nearEdge) * cos(pitch)  ≥  distance·NEAR_MARGIN
 */
function minFocusY(next: Camera): number {
  const cos = Math.cos(clamp(next.pitch, MIN_PITCH, MAX_PITCH));
  const nearEdge = scene.getBoardBounds().maxY + FRAME_INSET; // closest board row incl. bezel
  return nearEdge + (next.distance * NEAR_MARGIN - next.distance) / cos;
}

function minDistanceForFocus(next: Camera): number {
  const cos = Math.cos(clamp(next.pitch, MIN_PITCH, MAX_PITCH));
  const nearEdge = scene.getBoardBounds().maxY + FRAME_INSET;
  const distance = ((nearEdge - next.focusY) * cos) / (1 - NEAR_MARGIN);
  return Math.max(MIN_DISTANCE, Number.isFinite(distance) ? distance : MIN_DISTANCE);
}

/** Number of rendered floors — named layers, or the highest shape layer in use. */
function floorCount(): number {
  let maxL = 0;
  for (const s of Object.values(doc.board.shapes)) maxL = Math.max(maxL, s.layer ?? 0);
  return Math.max(doc.board.layers?.length ?? 0, maxL + 1, 1);
}

/**
 * Dolly ceiling. A taller floor stack needs the camera to pull back further to
 * keep the whole board in frame, so the max distance — and thus how far you can
 * zoom OUT — grows with the floor count, up to MAX_DISTANCE_CAP (the point where
 * DEFAULT_DISTANCE / cap reaches MIN_ZOOM, so the zoom readout stays consistent).
 */
function maxDistance(): number {
  return Math.min(
    MAX_DISTANCE_CAP,
    BASE_MAX_DISTANCE + Math.max(0, floorCount() - 1) * MAX_DISTANCE_PER_FLOOR,
  );
}

function clampDollyDistance(next: Camera): number {
  return clamp(next.distance, minDistanceForFocus(next), maxDistance());
}

function keepDefaultPerspective(next: Camera): Camera {
  const requestedZoom = clamp(next.zoom, MIN_ZOOM, MAX_ZOOM);
  const requestedDistance = DEFAULT_DISTANCE / requestedZoom;
  const distance = clampDollyDistance({ ...next, zoom: requestedZoom, distance: requestedDistance });
  return { ...next, zoom: clamp(DEFAULT_DISTANCE / distance, MIN_ZOOM, MAX_ZOOM), distance };
}

/**
 * Keep the focus (the ground point shown under the principal point) on the board
 * so a pan/scroll can never carry the camera off into the void where the board
 * is no longer visible. focusX is held between the board's left/right edges;
 * focusY between its far edge (minY) and near edge (maxY). The far-edge bound
 * also honors the geometric floor (`minFocusY`) that keeps the near edge in
 * front of the camera, so this only ever tightens the existing "top" lock.
 */
function clampFocus(next: Camera): { focusX: number; focusY: number } {
  const b = scene.getBoardBounds();
  const loY = Math.max(b.minY, minFocusY(next)); // far edge, never past the near-plane floor
  const hiY = b.maxY; // near edge
  return {
    focusX: clamp(next.focusX, b.minX, b.maxX),
    focusY: clamp(next.focusY, loY, hiY),
  };
}

/** The sole camera writer: clamp, publish, then re-apply the projector + scene. */
export function setCamera(next: Camera): void {
  const pitch = clamp(next.pitch, MIN_PITCH, MAX_PITCH);
  const distance = clampDollyDistance({ ...next, pitch });
  const zoom = clamp(next.zoom, MIN_ZOOM, MAX_ZOOM);
  const { focusX, focusY } = clampFocus({ ...next, pitch, distance, zoom });
  $camera.set({
    focusX,
    focusY,
    zoom,
    pitch,
    distance,
    panX: next.panX,
    panY: next.panY,
    yaw: next.yaw,
  });
  scene.applyCamera();
}

/**
 * Ground-anchored pan: keep the world point grabbed at (lastSx,lastSy) under the
 * cursor as it moves to (sx,sy). Both points are unprojected to the ground plane
 * and the focus shifts by their difference, so the grid doesn't "swim".
 */
export function panBy(lastSx: number, lastSy: number, sx: number, sy: number): void {
  const a = screenToWorld(lastSx, lastSy);
  const b = screenToWorld(sx, sy);
  if (!a || !b) return;
  const c = $camera.get();
  setCamera({ ...c, focusX: c.focusX + (a.x - b.x), focusY: c.focusY + (a.y - b.y) });
}

/** Pan by a screen-space delta, anchored at the screen center (used for scroll). */
export function panByScreen(dx: number, dy: number): void {
  const { w, h } = scene.screenSize();
  panBy(w / 2, h / 2, w / 2 + dx, h / 2 + dy);
}

/**
 * Centered dolly zoom: move along the current pitched view axis instead of
 * widening/narrowing the field of view. Keeping distance*zoom constant keeps the
 * horizon/vanishing line fixed, so the board does not appear to fold while zooming.
 */
export function zoomBy(factor: number): void {
  const c = $camera.get();
  const focal = c.distance * c.zoom;
  const requestedZoom = clamp(c.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const requestedDistance = focal / requestedZoom;
  const distance = clampDollyDistance({ ...c, zoom: requestedZoom, distance: requestedDistance });
  const zoom = clamp(focal / distance, MIN_ZOOM, MAX_ZOOM);
  if (zoom === c.zoom && distance === c.distance) return;
  setCamera({ ...c, zoom, distance });
}

/**
 * Zoom while keeping the ground point under the cursor (sx,sy) pinned in place —
 * the Figma/Excalidraw "zoom toward the pointer" behavior. We dolly with zoomBy,
 * then shift the focus by however far that ground point drifted under the cursor
 * (same anchoring math as panBy). Falls back to a centered zoom when the cursor
 * is above the horizon (no ground point to anchor to).
 */
export function zoomAt(factor: number, sx: number, sy: number): void {
  const before = screenToWorld(sx, sy);
  zoomBy(factor);
  if (!before) return; // above the horizon — centered dolly is the best we can do
  const after = screenToWorld(sx, sy);
  if (!after) return;
  const c = $camera.get();
  setCamera({
    ...c,
    focusX: c.focusX + (before.x - after.x),
    focusY: c.focusY + (before.y - after.y),
  });
}

/**
 * Tilt the camera by swinging its pitch around the current focus point. Lowering
 * pitch rotates the optical axis toward the horizon, which spreads the stacked
 * floors apart vertically (easier to read a layered board); raising it flattens
 * toward a top-down plan view. `setCamera` clamps to [MIN_PITCH, MAX_PITCH] and
 * re-seats focus/distance, so a tilt can never push the board past the near plane.
 */
export function tiltBy(deltaPitch: number): void {
  const c = $camera.get();
  const pitch = clamp(c.pitch + deltaPitch, MIN_PITCH, MAX_PITCH);
  if (pitch === c.pitch) return;
  setCamera({ ...c, pitch });
}

/**
 * Spin the board around the vertical axis through its center origin by
 * `deltaYaw` radians (Option + horizontal trackpad swipe) — a turntable. The
 * board rotates within its own ground plane, so it stays flat and level (pitch,
 * distance, and zoom are untouched and nothing slides off the table). The angle
 * wraps into (-π, π] so it never grows without bound across many swipes.
 */
export function rotateBy(deltaYaw: number): void {
  const c = $camera.get();
  let yaw = (c.yaw + deltaYaw) % (Math.PI * 2);
  if (yaw > Math.PI) yaw -= Math.PI * 2;
  else if (yaw <= -Math.PI) yaw += Math.PI * 2;
  if (yaw === c.yaw) return;
  setCamera({ ...c, yaw });
}

/**
 * Spread the stacked floors apart or together by scaling the world-up gap between
 * adjacent layers (Option+pinch). `factor` > 1 fans the stack out, < 1 collapses
 * it. Changing the spacing re-seats every pedestal's base elevation, so we re-run
 * the camera — that bumps the scene epoch and reprojects the whole board at the
 * new floor heights. No-op once the spacing saturates at its clamp.
 *
 * The top floor's lift saturates at ELEV_CAP. Fanning out past the step that pins
 * the top floor there can't raise it any higher — it only drags the LOWER floors
 * up into the capped top. So once the top floor is at the cap we refuse to spread
 * further, and clamp an in-range spread so it stops exactly at that step.
 */
export function spaceLayersBy(factor: number): void {
  const before = getFloorStep();
  const topIndex = floorCount() - 1;
  const maxStep = topIndex > 0 ? ELEV_CAP / topIndex : Infinity;
  if (factor > 1 && before >= maxStep) return; // top floor already capped — don't spread
  const after = setFloorStep(factor > 1 ? Math.min(before * factor, maxStep) : before * factor);
  if (after === before) return;
  $floorSpacing.set(after); // keep the Layers-panel slider in sync
  scene.applyCamera();
}

/** Current world-up gap between adjacent floors (the live "spread" dial). */
export function getFloorSpacing(): number {
  return getFloorStep();
}

/**
 * Set the floor spread to an absolute world-up gap (the Layers-panel slider).
 * Clamped by setFloorStep; mirrors the applied value into $floorSpacing and
 * reprojects the whole board at the new floor heights. Returns what was applied.
 */
export function setFloorSpacing(step: number): number {
  const applied = setFloorStep(step);
  $floorSpacing.set(applied);
  scene.applyCamera();
  return applied;
}

/** Current geometric fade per floor of separation (the live "distant layer fade" dial). */
export function getLayerFade(): number {
  return getLayerFadeStep();
}

/**
 * Set how quickly floors away from the active layer fade out (the Layers-panel
 * slider). A lower value fades distant floors out faster. Clamped by
 * setLayerFadeStep; mirrors the applied value into $layerFade and repaints the
 * board chrome + re-dims the off-floor tokens/edges so the change shows at once
 * (no camera move needed). Returns what was applied.
 */
export function setLayerFade(step: number): number {
  const applied = setLayerFadeStep(step);
  $layerFade.set(applied);
  scene.redrawBoard();
  return applied;
}

export function getZoom(): number {
  return $camera.get().zoom;
}

function contentBounds(): { x: number; y: number; w: number; h: number } | null {
  const shapes = Object.values(doc.board.shapes);
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function fitToContent(): void {
  const { w, h } = scene.screenSize();
  const b = contentBounds();
  if (!b) {
    setCamera(
      keepDefaultPerspective({
        focusX: 0,
        focusY: 0,
        zoom: 1,
        pitch: DEFAULT_PITCH,
        distance: DEFAULT_DISTANCE,
        panX: 0,
        panY: 0,
        yaw: 0,
      }),
    );
    return;
  }
  // perspective compresses depth + needs floor around the content, so frame loose
  const pad = 0.5;
  // include the floor stack's vertical rise so the top floor stays in frame
  const effH = b.h + floorElevation(floorCount() - 1) * 0.7;
  const zoom = clamp(Math.min(w / b.w, h / effH) * pad, MIN_ZOOM, MAX_ZOOM);
  setCamera(keepDefaultPerspective({
    focusX: b.x + b.w / 2,
    // bias the focus toward the far edge so content seats in the lower-center,
    // leaving the receding grid filling the upper screen (reference framing)
    focusY: b.y + b.h / 2 - b.h * 0.2,
    zoom,
    pitch: DEFAULT_PITCH,
    distance: DEFAULT_DISTANCE,
    panX: 0,
    panY: 0,
    yaw: 0,
  }));
}

/** Center the viewport on the world origin at 100%. */
export function centerOrigin(): void {
  setCamera(
    keepDefaultPerspective({
      focusX: 0,
      focusY: 0,
      zoom: 1,
      pitch: DEFAULT_PITCH,
      distance: DEFAULT_DISTANCE,
      panX: 0,
      panY: 0,
      yaw: 0,
    }),
  );
}

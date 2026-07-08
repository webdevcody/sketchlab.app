// Lightweight, localStorage-backed input preferences. Read synchronously at
// gesture time (no store subscription needed) so the wheel handler stays cheap.

import { clamp } from "../util";

const WHEEL_ZOOM_KEY = "sketchlab:wheel-zoom";
const INVERT_PITCH_KEY = "sketchlab:invert-pitch";
const RIGHT_DRAG_PAN_KEY = "sketchlab:right-drag-pan";
const ZOOM_SENSITIVITY_KEY = "sketchlab:zoom-sensitivity";
const ZOOM_OUT_LIMIT_KEY = "sketchlab:zoom-out-limit";
const ZOOM_IN_LIMIT_KEY = "sketchlab:zoom-in-limit";

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false; // private mode / disabled storage — fall back to the default
  }
}

function writeBool(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore — preference just won't persist across reloads */
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore — preference just won't persist across reloads */
  }
}

// Default OFF: a plain scroll pans (the trackpad-first default). Mouse users opt
// in via Controls → "Scroll wheel zooms", after which a wheel notch zooms instead.
let wheelZoom = readBool(WHEEL_ZOOM_KEY);

/** True when a plain (unmodified) wheel notch should zoom-to-cursor instead of pan. */
export function getWheelZoom(): boolean {
  return wheelZoom;
}

export function setWheelZoom(on: boolean): void {
  wheelZoom = on;
  writeBool(WHEEL_ZOOM_KEY, on);
}

// Default OFF: vertical orbit drag keeps its native direction (drag down lowers
// the pitch toward the horizon). Users from other 3D tools opt in via
// Settings → "Reverse vertical pitch" to flip the up/down tilt direction.
let invertPitch = readBool(INVERT_PITCH_KEY);

/** True when the vertical orbit-drag (pitch tilt) direction should be flipped. */
export function getInvertPitch(): boolean {
  return invertPitch;
}

export function setInvertPitch(on: boolean): void {
  invertPitch = on;
  writeBool(INVERT_PITCH_KEY, on);
}

// Default OFF: the right button opens the z-order context menu. When enabled,
// holding the right button and dragging pans the canvas (hand cursor); a plain
// right-click without dragging still opens the context menu.
let rightDragPan = readBool(RIGHT_DRAG_PAN_KEY);

/** True when holding the right mouse button and dragging should pan the view. */
export function getRightDragPan(): boolean {
  return rightDragPan;
}

export function setRightDragPan(on: boolean): void {
  rightDragPan = on;
  writeBool(RIGHT_DRAG_PAN_KEY, on);
}

// Wheel/pinch zoom sensitivity as a 0..100 slider. The slider maps linearly to
// the per-notch exponent factor used by zoomAt: 0% is a gentle quarter-strength
// zoom, 100% is a bit stronger than the old fixed feel, and the default 75%
// reproduces the original factor of 0.01 exactly.
const ZOOM_SENSITIVITY_DEFAULT = 75;
const ZOOM_FACTOR_MIN = 0.0008; // slider 0% — very fine, precise zoom nudges
const ZOOM_FACTOR_MAX = 0.0130667; // slider 100% (75% ⇒ 0.01, the legacy value)

let zoomSensitivity = clamp(readNumber(ZOOM_SENSITIVITY_KEY, ZOOM_SENSITIVITY_DEFAULT), 0, 100);

/** Zoom sensitivity as a 0..100 slider position (default 75). */
export function getZoomSensitivityPercent(): number {
  return zoomSensitivity;
}

export function setZoomSensitivityPercent(percent: number): void {
  zoomSensitivity = clamp(Math.round(percent), 0, 100);
  writeNumber(ZOOM_SENSITIVITY_KEY, zoomSensitivity);
}

/** The per-wheel-delta exponent factor for zoomAt, derived from the slider. */
export function getZoomFactor(): number {
  return ZOOM_FACTOR_MIN + (zoomSensitivity / 100) * (ZOOM_FACTOR_MAX - ZOOM_FACTOR_MIN);
}

// Zoom limits, stored as on-screen percentages (100% = 1:1). Both share one
// domain so they can live on a single dual-thumb slider: the lower thumb is the
// zoom-out limit (smaller = more of the board visible), the upper thumb the
// zoom-in limit. Defaults reproduce the app's original reachable range (1%..240%).
// camera.ts reads getMinZoom()/getMaxZoom() as fractions.
export const ZOOM_LIMIT_MIN = 1; // % — shared slider floor
export const ZOOM_LIMIT_MAX = 1000; // % — shared slider ceiling
const ZOOM_OUT_LIMIT_DEFAULT = 1; // 1% — matches the legacy MIN_ZOOM of 0.01
const ZOOM_IN_LIMIT_DEFAULT = 240; // 240% — matches the legacy reachable max

let zoomOutLimit = clamp(
  readNumber(ZOOM_OUT_LIMIT_KEY, ZOOM_OUT_LIMIT_DEFAULT),
  ZOOM_LIMIT_MIN,
  ZOOM_LIMIT_MAX,
);
let zoomInLimit = clamp(
  readNumber(ZOOM_IN_LIMIT_KEY, ZOOM_IN_LIMIT_DEFAULT),
  ZOOM_LIMIT_MIN,
  ZOOM_LIMIT_MAX,
);

/** Zoom-out limit (lower thumb) as a percentage. */
export function getZoomOutLimitPercent(): number {
  return zoomOutLimit;
}

export function setZoomOutLimitPercent(percent: number): void {
  zoomOutLimit = clamp(Math.round(percent), ZOOM_LIMIT_MIN, ZOOM_LIMIT_MAX);
  writeNumber(ZOOM_OUT_LIMIT_KEY, zoomOutLimit);
}

/** Zoom-in limit (upper thumb) as a percentage. */
export function getZoomInLimitPercent(): number {
  return zoomInLimit;
}

export function setZoomInLimitPercent(percent: number): void {
  zoomInLimit = clamp(Math.round(percent), ZOOM_LIMIT_MIN, ZOOM_LIMIT_MAX);
  writeNumber(ZOOM_IN_LIMIT_KEY, zoomInLimit);
}

/** Minimum zoom as a fraction (e.g. 0.01 = 1%) — the zoom-out clamp. */
export function getMinZoom(): number {
  return zoomOutLimit / 100;
}

/** Maximum zoom as a fraction (e.g. 2.4 = 240%) — the zoom-in clamp. */
export function getMaxZoom(): number {
  return zoomInLimit / 100;
}

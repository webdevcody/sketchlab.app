import { ZOOM_LIMIT_MAX, ZOOM_LIMIT_MIN } from "../interaction/inputPrefs";

// The dual zoom-limit slider runs on a 0..1000 unit track mapped LOGARITHMICALLY
// to the 1%..1000% zoom range, so the useful low end (1%..100%) gets real room.
export const DUAL_UNITS = 1000;
export const DUAL_MIN_GAP = 15; // keep the two thumbs from crossing / touching
const LOG_SPAN = Math.log(ZOOM_LIMIT_MAX / ZOOM_LIMIT_MIN);

export function unitToPercent(u: number): number {
  return Math.round(ZOOM_LIMIT_MIN * Math.exp((u / DUAL_UNITS) * LOG_SPAN));
}

export function percentToUnit(p: number): number {
  return Math.round((Math.log(p / ZOOM_LIMIT_MIN) / LOG_SPAN) * DUAL_UNITS);
}

export type DualThumbMoving = "min" | "max";

/**
 * Enforce a non-crossing dual-thumb gap in track units, then ensure the
 * log-mapped percentages stay strictly ordered (min% < max%). Near the low
 * end, a unit gap of DUAL_MIN_GAP can still collapse to the same rounded %,
 * which would freeze the camera — so we walk the free thumb until percents differ.
 *
 * When a thumb is pinned against a track end, the other thumb is pushed back
 * so DUAL_MIN_GAP is preserved (instead of both sitting on the same unit).
 */
export function enforceDualZoomThumbGap(
  loIn: number,
  hiIn: number,
  moving: DualThumbMoving,
): { lo: number; hi: number; loPercent: number; hiPercent: number } {
  let lo = loIn;
  let hi = hiIn;

  if (hi - lo < DUAL_MIN_GAP) {
    if (moving === "max") {
      lo = Math.max(0, hi - DUAL_MIN_GAP);
      // MAX pinned at the floor — push it up so the gap can exist
      if (hi - lo < DUAL_MIN_GAP) {
        hi = Math.min(DUAL_UNITS, lo + DUAL_MIN_GAP);
        lo = Math.max(0, hi - DUAL_MIN_GAP);
      }
    } else {
      hi = Math.min(DUAL_UNITS, lo + DUAL_MIN_GAP);
      // MIN pinned at the ceiling — push it down so the gap can exist
      if (hi - lo < DUAL_MIN_GAP) {
        lo = Math.max(0, hi - DUAL_MIN_GAP);
        hi = Math.min(DUAL_UNITS, lo + DUAL_MIN_GAP);
      }
    }
  }

  // Percent-level: unit gap alone can still map both thumbs to the same %
  // (e.g. units 0 and 15 both round to 1%). Prefer moving the passive thumb.
  if (moving === "max") {
    while (unitToPercent(lo) >= unitToPercent(hi) && hi < DUAL_UNITS) hi += 1;
    while (unitToPercent(lo) >= unitToPercent(hi) && lo > 0) lo -= 1;
  } else {
    while (unitToPercent(lo) >= unitToPercent(hi) && lo > 0) lo -= 1;
    while (unitToPercent(lo) >= unitToPercent(hi) && hi < DUAL_UNITS) hi += 1;
  }

  return {
    lo,
    hi,
    loPercent: unitToPercent(lo),
    hiPercent: unitToPercent(hi),
  };
}

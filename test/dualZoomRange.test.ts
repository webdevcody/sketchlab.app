import { describe, expect, it } from "vitest";
import {
  DUAL_MIN_GAP,
  DUAL_UNITS,
  enforceDualZoomThumbGap,
  unitToPercent,
} from "../src/ui/dualZoomRange";

describe("enforceDualZoomThumbGap", () => {
  it("never freezes zoom when the min thumb hits the ceiling", () => {
    const { lo, hi, loPercent, hiPercent } = enforceDualZoomThumbGap(
      DUAL_UNITS,
      DUAL_UNITS,
      "min",
    );
    expect(hi - lo).toBeGreaterThanOrEqual(DUAL_MIN_GAP);
    expect(loPercent).toBeLessThan(hiPercent);
    expect(hi).toBe(DUAL_UNITS);
  });

  it("never freezes zoom when the max thumb hits the floor", () => {
    const { lo, hi, loPercent, hiPercent } = enforceDualZoomThumbGap(0, 0, "max");
    expect(hi - lo).toBeGreaterThanOrEqual(DUAL_MIN_GAP);
    expect(loPercent).toBeLessThan(hiPercent);
    expect(lo).toBe(0);
  });

  it("keeps unit gap when thumbs try to cross in the middle", () => {
    const draggingMax = enforceDualZoomThumbGap(400, 410, "max");
    expect(draggingMax.hi - draggingMax.lo).toBeGreaterThanOrEqual(DUAL_MIN_GAP);
    expect(draggingMax.loPercent).toBeLessThan(draggingMax.hiPercent);

    const draggingMin = enforceDualZoomThumbGap(400, 410, "min");
    expect(draggingMin.hi - draggingMin.lo).toBeGreaterThanOrEqual(DUAL_MIN_GAP);
    expect(draggingMin.loPercent).toBeLessThan(draggingMin.hiPercent);
  });

  it("widens past a unit gap when log rounding collapses both sides to 1%", () => {
    // unitToPercent(0) and unitToPercent(15) both round to 1% — a raw unit gap
    // alone is not enough to keep min zoom < max zoom.
    expect(unitToPercent(0)).toBe(unitToPercent(DUAL_MIN_GAP));

    const { lo, hi, loPercent, hiPercent } = enforceDualZoomThumbGap(
      0,
      DUAL_MIN_GAP,
      "max",
    );
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(DUAL_MIN_GAP);
    expect(loPercent).toBeLessThan(hiPercent);
  });

  it("dragging either thumb to either extreme never yields equal percents", () => {
    const extremes: Array<[number, number, "min" | "max"]> = [
      [0, 0, "min"],
      [0, 0, "max"],
      [DUAL_UNITS, DUAL_UNITS, "min"],
      [DUAL_UNITS, DUAL_UNITS, "max"],
      [DUAL_UNITS - 5, DUAL_UNITS, "min"],
      [0, 5, "max"],
      [990, 1000, "min"],
      [0, 10, "max"],
    ];
    for (const [loIn, hiIn, moving] of extremes) {
      const { loPercent, hiPercent } = enforceDualZoomThumbGap(loIn, hiIn, moving);
      expect(loPercent).toBeLessThan(hiPercent);
    }
  });
});

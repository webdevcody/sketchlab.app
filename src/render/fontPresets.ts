/** S/M/L/XL multipliers applied on top of each shape kind's default label size. */
export const FONT_PRESET_SCALES = [0.75, 1, 1.5, 2.25] as const;

export const FONT_EPS = 0.02;

/** Step to the next smaller or larger preset tier (clamped at S / XL). */
export function stepFontScale(current: number, dir: 1 | -1): number {
  const scales = FONT_PRESET_SCALES;
  if (dir > 0) {
    for (const s of scales) {
      if (s > current + FONT_EPS) return s;
    }
    return scales[scales.length - 1];
  }
  for (let i = scales.length - 1; i >= 0; i--) {
    if (scales[i] < current - FONT_EPS) return scales[i];
  }
  return scales[0];
}

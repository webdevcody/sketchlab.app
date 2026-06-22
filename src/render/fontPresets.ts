/**
 * Absolute label font sizes (world units) for the S / M / L / XL / XXL tiers.
 * A label always renders at exactly its tier size — the same size for every
 * object kind (text, shape, icon, edge) and independent of the object's
 * dimensions. Tiers never scale up or down when an object is resized.
 */
export const FONT_SIZES = [18, 24, 36, 54, 80] as const;

/** Short labels for the toolbar segmented control, parallel to FONT_SIZES. */
export const FONT_LABELS = ["S", "M", "L", "XL", "XXL"] as const;

/** Tooltips for each tier, parallel to FONT_SIZES. */
export const FONT_TITLES = [
  "Small font",
  "Medium font",
  "Large font",
  "Extra-large font",
  "Extra-extra-large font",
] as const;

/** Default tier (Medium) for new objects and legacy boards. */
export const DEFAULT_FONT_SIZE = FONT_SIZES[1];

/** Tolerance (px) when matching an absolute size back to a tier. */
export const FONT_EPS = 0.5;

/** Index of the tier nearest to an absolute font size. */
export function nearestFontIndex(size: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < FONT_SIZES.length; i++) {
    const dist = Math.abs(FONT_SIZES[i] - size);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Snap an arbitrary font size to its nearest tier value. */
export function snapFontSize(size: number): number {
  return FONT_SIZES[nearestFontIndex(size)];
}

/** Step to the next smaller or larger tier size (clamped at S / XXL). */
export function stepFontSize(current: number, dir: 1 | -1): number {
  const next = Math.min(FONT_SIZES.length - 1, Math.max(0, nearestFontIndex(current) + dir));
  return FONT_SIZES[next];
}

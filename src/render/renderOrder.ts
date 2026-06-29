export interface OrderedLayer<T> {
  children: T[];
  removeChildren(): unknown;
  addChild(...children: T[]): unknown;
}

export function isSameOrder<T>(current: readonly T[], next: readonly T[]): boolean {
  if (current.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (current[i] !== next[i]) return false;
  }
  return true;
}

/**
 * Pixi's setChildIndex is expensive when repeated for hundreds of nodes because
 * each move reshuffles the children array. Replacing the order in one batch keeps
 * perspective depth sorting linear after the O(n log n) comparator.
 */
export function syncLayerOrder<T>(layer: OrderedLayer<T>, ordered: readonly T[]): boolean {
  if (isSameOrder(layer.children, ordered)) return false;
  layer.removeChildren();
  if (ordered.length) layer.addChild(...ordered);
  return true;
}

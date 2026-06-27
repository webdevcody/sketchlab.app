import { atom } from "nanostores";
import { getFloorStep, getLayerFadeStep } from "../render/shading";
import { uid } from "../util";
import { DEFAULT_TEXT_FONT_SIZE } from "./style";
import type { Board, Camera, SelectionState, ToolName } from "./types";

export function emptyBoard(name = "Untitled"): Board {
  const now = Date.now();
  return {
    id: uid(),
    name,
    shapes: {},
    edges: {},
    order: [],
    layers: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** The active board document. Mutated in place by actions for performance. */
export const doc: { board: Board } = { board: emptyBoard() };

export const $tool = atom<ToolName>("select");
export const $camera = atom<Camera>({
  focusX: 0,
  focusY: 0,
  zoom: 1,
  pitch: Math.PI / 3,
  distance: 1200,
  panX: 0,
  panY: 0,
  yaw: 0,
});
export const $selection = atom<SelectionState>({
  shapes: new Set(),
  edges: new Set(),
});
/** Bumped on every document mutation; autosave listens to this. */
export const $revision = atom(0);
export const $boardName = atom("Untitled");
/** Style applied to newly created shapes / the current edit target. */
export const $style = atom<{ fill: string; fontSize: number }>({
  fill: "#0f2740",
  fontSize: DEFAULT_TEXT_FONT_SIZE,
});
/** Transient hint text shown in the status bar. */
export const $status = atom("");
/** Active/highlighted floor index. Transient — never persisted; reset on board load. */
export const $activeLayer = atom<number>(0);
/**
 * Live world-up gap between adjacent floors (the "floor spread" view dial). A UI
 * mirror of shading.ts's floorStep so the Layers-panel slider and the Option+pinch
 * gesture stay in sync. Seeded from shading.ts's localStorage-persisted value so a
 * refresh keeps the user's last spread (global view preference, not document data).
 */
export const $floorSpacing = atom<number>(getFloorStep());
/**
 * Live geometric fade applied per floor of separation from the active layer (the
 * "distant layer fade" view dial). A UI mirror of shading.ts's layerFadeStep so
 * the Layers-panel slider stays in sync. Seeded from shading.ts's localStorage-
 * persisted value so a refresh keeps the user's last fade (global view preference).
 */
export const $layerFade = atom<number>(getLayerFadeStep());

export function bumpRevision(): void {
  $revision.set($revision.get() + 1);
}

export function setSelection(shapes: Iterable<string>, edges: Iterable<string>): void {
  $selection.set({ shapes: new Set(shapes), edges: new Set(edges) });
}

export function clearSelection(): void {
  const cur = $selection.get();
  if (cur.shapes.size === 0 && cur.edges.size === 0) return;
  setSelection([], []);
}

export function isSelected(id: string): boolean {
  const s = $selection.get();
  return s.shapes.has(id) || s.edges.has(id);
}

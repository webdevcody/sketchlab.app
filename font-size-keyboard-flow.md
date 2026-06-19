# Font Size Keyboard Flow

This note explains how clicking an object and pressing `+` or `-` changes font size in Sketch Lab.

## High-Level Flow

1. Keyboard input is handled in `src/interaction/controller.ts`.
2. The controller calls `actions.adjustFontSize()` in `src/state/actions.ts`.
3. Font size moves through preset tiers from `src/render/fontPresets.ts`.
4. The selected object receives an explicit `fontSize`, or the board default changes if nothing is selected.
5. The scene re-renders the updated shape or edge.

## Keyboard Entry Point

The `keydown` listener is registered in `src/interaction/controller.ts`, and `onKeyDown` handles the font shortcuts.

```ts
// font size: "=" / "+" larger, "-" / "_" smaller (selection or board default)
if (!meta && (e.key === "=" || e.key === "+")) {
  e.preventDefault();
  actions.adjustFontSize(1);
  return;
}
if (!meta && (e.key === "-" || e.key === "_")) {
  e.preventDefault();
  actions.adjustFontSize(-1);
  return;
}
```

Important details:

- `+` and `=` increase font size.
- `-` and `_` decrease font size.
- Cmd/Ctrl must not be held (`!meta`).
- The shortcut is ignored while text editing, the icon palette, menus, or DOM inputs are active.

## Core State Logic

The main behavior lives in `src/state/actions.ts`.

```ts
/** Bump font size one preset tier for the selection, or the board default when empty. */
export function adjustFontSize(dir: 1 | -1): void {
  const { shapes, edges } = $selection.get();
  if (shapes.size || edges.size) {
    for (const id of shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      const scale = stepFontScale(shapeFontScale(s), dir);
      s.fontSize = clampFont(defaultLabelFont(s.kind) * scale);
      if (s.kind === "text") reflowTextBox(s);
      scene.updateNode(id);
    }
    for (const id of edges) {
      const e = doc.board.edges[id];
      if (!e) continue;
      const scale = stepFontScale(edgeFontScale(e), dir);
      e.fontSize = clampFont(EDGE_LABEL_FONT * scale);
      scene.updateEdge(id);
    }
    bumpRevision();
    return;
  }
  setFontScale(stepFontScale(doc.board.fontScale ?? 1, dir));
}
```

When an object is selected:

1. The current scale is calculated with `shapeFontScale()` or `edgeFontScale()`.
2. `stepFontScale()` chooses the next larger or smaller preset.
3. The object gets an explicit `fontSize`.
4. Text objects are remeasured with `reflowTextBox()` so the box grows or shrinks around its center.
5. The scene updates with `scene.updateNode()` or `scene.updateEdge()`.
6. `bumpRevision()` records the change for undo/redo.

When nothing is selected, the board-wide `doc.board.fontScale` changes instead.

## Preset Tiers

The preset sizes are defined in `src/render/fontPresets.ts`.

```ts
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
```

Pressing `+` or `-` does not move by one pixel. It steps through these multipliers:

- Small: `0.75`
- Medium: `1`
- Large: `1.5`
- Extra large: `2.25`

## Base Font Sizes

Each object kind has a base font size. The preset multiplier is applied on top of that base.

| Object kind | Base size | Source file |
| --- | ---: | --- |
| Text | `24` | `src/render/measure.ts` |
| Rectangle / circle label | `20` | `src/render/shapeView.ts` |
| Icon / image label | `16` | `src/render/shapeView.ts` |
| Edge / arrow label | `14` | `src/render/edgeView.ts` |

For shapes, rendering uses `effectiveFontSize()` in `src/render/shapeView.ts`.

```ts
export function effectiveFontSize(s: Shape): number {
  if (s.fontSize != null) return s.fontSize;
  return defaultLabelFont(s.kind) * (doc.board.fontScale ?? 1);
}

/** S/M/L/XL tier (0.75-2.25) implied by a shape's current label size. */
export function shapeFontScale(s: Shape): number {
  return effectiveFontSize(s) / defaultLabelFont(s.kind);
}
```

For edges, rendering uses `effectiveEdgeFontSize()` in `src/render/edgeView.ts`.

```ts
export const EDGE_LABEL_FONT = 14;

/** The label font (world units) an edge actually renders at. */
export function effectiveEdgeFontSize(e: Edge): number {
  if (e.fontSize != null) return e.fontSize;
  return EDGE_LABEL_FONT * (doc.board.fontScale ?? 1);
}
```

## Related Files

| File | Role |
| --- | --- |
| `src/interaction/controller.ts` | Handles the keyboard shortcuts and calls `adjustFontSize()` |
| `src/state/actions.ts` | Updates selected shapes, selected edges, or board-wide font scale |
| `src/render/fontPresets.ts` | Defines S/M/L/XL scales and stepping behavior |
| `src/render/shapeView.ts` | Defines shape base sizes and effective shape font size |
| `src/render/edgeView.ts` | Defines edge label base size and effective edge font size |
| `src/render/measure.ts` | Defines text base size, font clamping, and text box measurement |
| `src/state/types.ts` | Stores `fontSize` on shapes/edges and `fontScale` on the board |
| `src/ui/editor.ts` | Uses the same presets for the S/M/L/XL style panel buttons |
| `src/state/history.ts` | Supports undo/redo through revision bumps |

## Summary

Clicking an object selects it. Pressing `+` or `-` is handled by `src/interaction/controller.ts`, which calls `actions.adjustFontSize()`. That function steps the selected object through S/M/L/XL font presets, stores the resulting absolute `fontSize`, and updates the scene.

If no object is selected, the same shortcut changes the board-wide font scale instead of a specific object.

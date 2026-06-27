import { getFloorSpacing, getLayerFade, setFloorSpacing, setLayerFade } from "../interaction/camera";
import { DEFAULT_FLOOR_COLOR } from "../render/boardLayers";
import {
  MAX_FLOOR_STEP,
  MAX_LAYER_FADE_STEP,
  MIN_FLOOR_STEP,
  MIN_LAYER_FADE_STEP,
} from "../render/shading";
import * as actions from "../state/actions";
import { $activeLayer, $floorSpacing, $layerFade, $revision, $selection, doc } from "../state/store";
import { confirmDialog } from "./confirmDialog";
import { h, toast } from "./dom";
import { createSwatchPicker, LAYER_ACCENTS } from "./swatchPicker";

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const ICON_EYE = svg(
  '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
);
const ICON_EYE_OFF = svg(
  '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18.4 18.4 0 0 1-3.2 4.2"/><path d="M6.5 6.6A18.2 18.2 0 0 0 2 12s3.6 7 10 7a10.8 10.8 0 0 0 4-.75"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
);
const ICON_COLLAPSE = svg('<path d="M9 6l6 6-6 6"/>');
const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const ICON_SOLO = svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>');

// The fade slider runs 0..100 as a "how much do distant floors fade" strength
// (left = keep far floors clear, right = fade them out fast), which is the
// INVERSE of the underlying fade step (a higher step = clearer far floors).
const FADE_SLIDER_SPAN = MAX_LAYER_FADE_STEP - MIN_LAYER_FADE_STEP;
/** Slider strength 0..100 → fade step (0 → clearest/high step, 100 → most fade/low step). */
function sliderToFade(v: number): number {
  return MAX_LAYER_FADE_STEP - (v / 100) * FADE_SLIDER_SPAN;
}
/** Fade step → slider strength 0..100 (inverse of sliderToFade). */
function fadeToSlider(step: number): number {
  return Math.round(((MAX_LAYER_FADE_STEP - step) / FADE_SLIDER_SPAN) * 100);
}

export interface LayersPanelOptions {
  onCollapseChange?: (collapsed: boolean) => void;
}

/** One rendered floor row in the panel (high→low). */
interface FloorRow {
  index: number;
  name: string;
  count: number;
  hidden: boolean;
  /** the floor's accent color, or undefined to fall back to the cyan default */
  color?: string;
}

/**
 * Always-visible, right-docked panel listing every floor of the board (top→bottom).
 * Each row carries a show/hide eye toggle; clicking the body highlights that floor
 * as the active one (new shapes land there — see actions.createShape). The header
 * collapse button (or the topbar Layers button) slides the panel off-screen.
 * Add / rename / delete / "assign selection" controls manage the stack.
 */
export class LayersPanel {
  private panel: HTMLDivElement;
  private list: HTMLDivElement;
  private spread: HTMLLabelElement;
  private spreadInput: HTMLInputElement;
  private fade: HTMLLabelElement;
  private fadeInput: HTMLInputElement;
  private collapsed = false;
  /** a refresh requested while collapsed is deferred until the panel is shown again */
  private dirty = false;
  private unsubs: Array<() => void> = [];

  constructor(
    editor: HTMLElement,
    private opts: LayersPanelOptions = {},
  ) {
    const collapseBtn = h(
      "button",
      {
        class: "layers-panel__collapse",
        type: "button",
        title: "Hide the layers panel",
        "aria-label": "Hide the layers panel",
        html: ICON_COLLAPSE,
        onclick: () => this.collapse(),
      },
    );

    const addBtn = h(
      "button",
      {
        class: "layers-panel__add",
        type: "button",
        title: "Add a floor on top of the stack",
        "aria-label": "Add a floor on top of the stack",
        html: ICON_PLUS,
        onclick: () => {
          const idx = actions.addLayer();
          $activeLayer.set(idx);
          toast(`Added ${doc.board.layers?.[idx]?.name ?? "layer"}`);
        },
      },
    );

    this.list = h("div", { class: "layers-panel__list" });

    // Floor-spread dial: scales the world-up gap between stacked floors so a
    // layered board is easier to read. Mirrors (and is mirrored by) the
    // Option+pinch gesture via the $floorSpacing atom.
    this.spreadInput = h("input", {
      type: "range",
      class: "layers-panel__spread-range",
      min: String(MIN_FLOOR_STEP),
      max: String(MAX_FLOOR_STEP),
      step: "1",
      value: String(Math.round(getFloorSpacing())),
      "aria-label": "Floor spread",
      oninput: (e: Event) => setFloorSpacing(Number((e.target as HTMLInputElement).value)),
    }) as HTMLInputElement;
    this.spread = h(
      "label",
      { class: "layers-panel__spread" },
      h("span", null, "Floor spread"),
      this.spreadInput,
    ) as HTMLLabelElement;

    // Distant-fade dial: how quickly floors away from the active layer fade out,
    // so a deep stack reads at a glance. Drag right to fade far floors (e.g.
    // 3 floors away) out faster; left keeps them clear. Drives the live fade
    // falloff via setLayerFade / the $layerFade atom.
    this.fadeInput = h("input", {
      type: "range",
      class: "layers-panel__spread-range",
      min: "0",
      max: "100",
      step: "1",
      value: String(fadeToSlider(getLayerFade())),
      "aria-label": "Distant layer fade",
      oninput: (e: Event) => setLayerFade(sliderToFade(Number((e.target as HTMLInputElement).value))),
    }) as HTMLInputElement;
    this.fade = h(
      "label",
      { class: "layers-panel__spread" },
      h("span", null, "Distant layer fade"),
      this.fadeInput,
    ) as HTMLLabelElement;

    this.panel = h(
      "div",
      {
        class: "layers-panel",
        role: "region",
        "aria-label": "Layers",
      },
      h(
        "div",
        { class: "layers-panel__header" },
        h("h2", null, "Layers"),
        h("div", { class: "layers-panel__header-actions" }, addBtn, collapseBtn),
      ),
      this.list,
      this.spread,
      this.fade,
    );

    editor.append(this.panel);

    // re-render on floor changes (add/rename/delete/assign/visibility) + active/selection
    this.unsubs.push($activeLayer.subscribe(() => this.refresh()));
    this.unsubs.push($revision.subscribe(() => this.refresh()));
    this.unsubs.push($selection.subscribe(() => this.refresh()));
    // track the live spread so the slider follows the Option+pinch gesture too
    this.unsubs.push(
      $floorSpacing.subscribe((v) => {
        this.spreadInput.value = String(Math.round(v));
      }),
    );
    // follow any external fade change so the slider stays truthful
    this.unsubs.push(
      $layerFade.subscribe((v) => {
        this.fadeInput.value = String(fadeToSlider(v));
      }),
    );
    this.refresh();
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Floors to show, high→low. Synthesizes a single "Ground" row for empty boards. */
  private floorRows(): Array<FloorRow> {
    const layers = doc.board.layers ?? [];
    const counts: number[] = [];
    let maxL = 0;
    for (const s of Object.values(doc.board.shapes)) {
      const l = s.layer ?? 0;
      counts[l] = (counts[l] ?? 0) + 1;
      if (l > maxL) maxL = l;
    }
    const n = Math.max(layers.length, maxL + 1, 1);
    const rows: FloorRow[] = [];
    for (let i = n - 1; i >= 0; i--) {
      rows.push({
        index: i,
        name: layers[i]?.name ?? (i === 0 ? "Ground" : `Layer ${i}`),
        count: counts[i] ?? 0,
        hidden: !!layers[i]?.hidden,
        color: layers[i]?.color,
      });
    }
    return rows;
  }

  refresh(): void {
    if (this.collapsed) {
      this.dirty = true; // rebuild lazily when shown again
      return;
    }
    this.dirty = false;
    const active = $activeLayer.get();
    const hasSelection = $selection.get().shapes.size > 0;
    const rows = this.floorRows();
    this.list.replaceChildren();
    for (const row of rows) {
      this.list.appendChild(this.row(row, active, hasSelection, rows.length));
    }
    // spreading / fading only mean something with 2+ floors to separate
    const single = rows.length < 2;
    this.spreadInput.disabled = single;
    this.spread.classList.toggle("is-disabled", single);
    this.fadeInput.disabled = single;
    this.fade.classList.toggle("is-disabled", single);
  }

  expand(): void {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.panel.classList.remove("is-collapsed");
    this.opts.onCollapseChange?.(false);
    if (this.dirty) this.refresh();
  }

  collapse(): void {
    if (this.collapsed) return;
    this.collapsed = true;
    this.panel.classList.add("is-collapsed");
    this.opts.onCollapseChange?.(true);
  }

  toggle(): void {
    if (this.collapsed) this.expand();
    else this.collapse();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    this.panel.remove();
  }

  /** Highlight floor `i`; a hidden floor is revealed first so new shapes don't land out of sight. */
  private activate(i: number, hidden: boolean): void {
    if (hidden) actions.setLayerHidden(i, false);
    $activeLayer.set(i);
  }

  private row(
    row: FloorRow,
    active: number,
    hasSelection: boolean,
    total: number,
  ): HTMLElement {
    const i = row.index;

    // floor color key — opens a portaled accent picker (the panel list scrolls, so
    // the popover must escape its overflow). Picking recolors this floor's frame,
    // active plate & badge. Stop the click from also re-activating the row.
    const colorPicker = createSwatchPicker({
      title: "Floor color",
      initial: row.color ?? DEFAULT_FLOOR_COLOR,
      colors: LAYER_ACCENTS,
      portal: true,
      onPick: (value) => actions.setLayerColor(i, value),
    });
    colorPicker.el.classList.add("layers-panel__color");
    colorPicker.el.addEventListener("click", (e) => e.stopPropagation());

    const eyeBtn = h(
      "button",
      {
        class: "layers-panel__eye",
        type: "button",
        title: row.hidden ? "Show this floor" : "Hide this floor",
        "aria-label": row.hidden ? "Show this floor" : "Hide this floor",
        "aria-pressed": row.hidden ? "false" : "true",
        html: row.hidden ? ICON_EYE_OFF : ICON_EYE,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.toggleLayerHidden(i);
        },
      },
    );

    // "solo" — hide every other floor, leaving only this one. Toggles back to
    // showing all floors when this is already the only one visible. Pointless on a
    // single-floor board, so it's disabled there.
    const soloed = actions.isLayerSoloed(doc.board, i);
    const soloBtn = h(
      "button",
      {
        class: "layers-panel__solo",
        type: "button",
        title: soloed ? "Show all floors" : "Hide all other floors",
        "aria-label": soloed ? "Show all floors" : "Hide all other floors",
        "aria-pressed": soloed ? "true" : "false",
        disabled: total > 1 ? undefined : true,
        html: ICON_SOLO,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.soloLayer(i);
        },
      },
    );

    const assignBtn = h(
      "button",
      {
        class: "layers-panel__action",
        type: "button",
        title: "Move the current selection to this floor",
        disabled: hasSelection ? undefined : true,
        onclick: (e: Event) => {
          e.stopPropagation();
          const sel = $selection.get().shapes;
          if (!sel.size) return;
          actions.assignSelectionToLayer(sel, i);
          toast(`Moved ${sel.size} to ${row.name}`);
        },
      },
      "⤵",
    );

    const renameBtn = h(
      "button",
      {
        class: "layers-panel__action",
        type: "button",
        title: "Rename floor",
        onclick: (e: Event) => {
          e.stopPropagation();
          const name = prompt("Rename layer", row.name);
          if (name != null) actions.renameLayer(i, name);
        },
      },
      "✎",
    );

    const delBtn = h(
      "button",
      {
        class: "layers-panel__action layers-panel__action--danger",
        type: "button",
        title: "Delete floor",
        disabled: total > 1 ? undefined : true,
        onclick: async (e: Event) => {
          e.stopPropagation();
          const ok = await confirmDialog({
            title: "Delete floor",
            message: `Delete "${row.name}"? Shapes on it drop to the floor below.`,
          });
          if (!ok) return;
          actions.deleteLayer(i);
        },
      },
      "🗑",
    );

    return h(
      "div",
      {
        class: row.hidden ? "layers-panel__item is-hidden" : "layers-panel__item",
        role: "button",
        tabindex: "0",
        "aria-current": i === active ? "true" : undefined,
        onclick: () => this.activate(i, row.hidden),
        ondblclick: () => {
          const name = prompt("Rename layer", row.name);
          if (name != null) actions.renameLayer(i, name);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.activate(i, row.hidden);
          }
        },
      },
      // Top line: visibility controls + the (now full-width) floor name.
      h(
        "div",
        { class: "layers-panel__top" },
        eyeBtn,
        soloBtn,
        colorPicker.el,
        h("div", { class: "layers-panel__name" }, row.name),
      ),
      // Bottom line: floor / item count on the left, stack actions on the right.
      h(
        "div",
        { class: "layers-panel__bottom" },
        h(
          "div",
          { class: "layers-panel__sub" },
          `Floor ${i} · ${row.count} item${row.count === 1 ? "" : "s"}${row.hidden ? " · hidden" : ""}`,
        ),
        h("div", { class: "layers-panel__actions" }, assignBtn, renameBtn, delBtn),
      ),
    );
  }
}

import { reclampZoom } from "../interaction/camera";
import {
  getInvertPitch,
  getRightDragPan,
  getZoomInLimitPercent,
  getZoomOutLimitPercent,
  getZoomSensitivityPercent,
  setInvertPitch,
  setRightDragPan,
  setZoomInLimitPercent,
  setZoomOutLimitPercent,
  setZoomSensitivityPercent,
} from "../interaction/inputPrefs";
import { h } from "./dom";
import {
  DUAL_UNITS,
  enforceDualZoomThumbGap,
  percentToUnit,
} from "./dualZoomRange";

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const ICON_COLLAPSE = svg('<path d="M9 6l6 6-6 6"/>');

export interface SettingsPanelOptions {
  onCollapseChange?: (collapsed: boolean) => void;
}

/**
 * Right-docked preferences tray that slides in the same way the Layers panel does.
 * Opened by the topbar cog button; starts collapsed (off-screen). Holds global,
 * localStorage-backed input preferences: orbit pitch direction, right-drag pan,
 * zoom sensitivity, and the min/max zoom limits (one dual-thumb slider).
 */
export class SettingsPanel {
  private panel: HTMLDivElement;
  private invertPitchCheck: HTMLInputElement;
  private rightDragPanCheck: HTMLInputElement;
  private zoomSensInput: HTMLInputElement;
  private zoomMinInput!: HTMLInputElement;
  private zoomMaxInput!: HTMLInputElement;
  private zoomFill!: HTMLElement;
  private zoomRangeValue!: HTMLElement;
  private collapsed = true;

  constructor(
    editor: HTMLElement,
    private opts: SettingsPanelOptions = {},
  ) {
    const collapseBtn = h("button", {
      class: "settings-panel__collapse",
      type: "button",
      title: "Hide the view controls panel",
      "aria-label": "Hide the view controls panel",
      html: ICON_COLLAPSE,
      onclick: () => this.collapse(),
    });

    this.invertPitchCheck = this.makeCheck(getInvertPitch(), (on) => setInvertPitch(on));
    const invertPitchRow = this.toggleRow(
      this.invertPitchCheck,
      "Reverse vertical pitch",
      "Flip the up/down orbit direction (Alt / Option + drag) to match other 3D tools",
    );

    this.rightDragPanCheck = this.makeCheck(getRightDragPan(), (on) => setRightDragPan(on));
    const rightDragPanRow = this.toggleRow(
      this.rightDragPanCheck,
      "Right-click drag to pan",
      "Hold the right mouse button and drag to grab and pan the canvas",
    );

    this.zoomSensInput = h("input", {
      type: "range",
      class: "settings-panel__range",
      min: "0",
      max: "100",
      step: "1",
      value: String(getZoomSensitivityPercent()),
      "aria-label": "Zoom sensitivity",
      oninput: (e: Event) => setZoomSensitivityPercent(Number((e.target as HTMLInputElement).value)),
    }) as HTMLInputElement;
    const zoomSensRow = this.sliderRow(
      this.zoomSensInput,
      "Zoom sensitivity",
      "How strongly ⌘/Ctrl + scroll (or pinch) zooms in and out",
    );

    const zoomLimitRow = this.dualRangeRow();

    this.panel = h(
      "div",
      {
        class: "settings-panel is-collapsed",
        role: "region",
        "aria-label": "View controls",
      },
      h(
        "div",
        { class: "settings-panel__header" },
        h("h2", null, "View controls"),
        h("div", { class: "settings-panel__header-actions" }, collapseBtn),
      ),
      h(
        "div",
        { class: "settings-panel__section" },
        invertPitchRow,
        rightDragPanRow,
        zoomSensRow,
        zoomLimitRow,
      ),
    ) as HTMLDivElement;

    editor.append(this.panel);
  }

  /** A preference checkbox that writes through `onToggle` on change. */
  private makeCheck(initial: boolean, onToggle: (on: boolean) => void): HTMLInputElement {
    return h("input", {
      type: "checkbox",
      class: "settings-panel__check",
      checked: initial,
      onchange: (e: Event) => onToggle((e.target as HTMLInputElement).checked),
    }) as HTMLInputElement;
  }

  /** A labelled toggle row: checkbox + bold title + muted subtitle. */
  private toggleRow(check: HTMLInputElement, title: string, sub: string): HTMLElement {
    return h(
      "label",
      { class: "settings-panel__toggle" },
      check,
      h(
        "span",
        null,
        h("strong", null, title),
        h("span", { class: "settings-panel__toggle-sub" }, sub),
      ),
    );
  }

  /** A labelled slider row: bold title + muted subtitle above a range input. */
  private sliderRow(range: HTMLInputElement, title: string, sub: string): HTMLElement {
    return h(
      "label",
      { class: "settings-panel__slider" },
      h("strong", null, title),
      h("span", { class: "settings-panel__toggle-sub" }, sub),
      range,
    );
  }

  /**
   * The min/max zoom limits as a single dual-thumb range. Two overlaid range
   * inputs (only their thumbs take pointer events) share one log-scaled track;
   * a highlighted fill spans between them. The lower thumb writes the zoom-out
   * limit, the upper the zoom-in limit; a small gap stops them from crossing.
   */
  private dualRangeRow(): HTMLElement {
    this.zoomRangeValue = h("span", { class: "settings-panel__slider-value" });

    const makeThumb = (initialUnit: number, label: string): HTMLInputElement =>
      h("input", {
        type: "range",
        class: "dualrange__input",
        min: "0",
        max: String(DUAL_UNITS),
        step: "1",
        value: String(initialUnit),
        "aria-label": label,
        oninput: () => this.onZoomThumbInput(),
      }) as HTMLInputElement;

    this.zoomMinInput = makeThumb(percentToUnit(getZoomOutLimitPercent()), "Zoom-out limit");
    this.zoomMaxInput = makeThumb(percentToUnit(getZoomInLimitPercent()), "Zoom-in limit");
    this.zoomFill = h("div", { class: "dualrange__fill" });

    const dual = h(
      "div",
      { class: "dualrange" },
      h("div", { class: "dualrange__track" }),
      this.zoomFill,
      this.zoomMinInput,
      this.zoomMaxInput,
    );

    this.syncZoomRange();

    return h(
      "label",
      { class: "settings-panel__slider" },
      h(
        "div",
        { class: "settings-panel__slider-head" },
        h("strong", null, "Zoom range"),
        this.zoomRangeValue,
      ),
      h(
        "span",
        { class: "settings-panel__toggle-sub" },
        "Zoom-out (left) and zoom-in (right) limits",
      ),
      dual,
    );
  }

  /** Handle a drag on either zoom thumb: enforce the gap, persist, and re-clamp. */
  private onZoomThumbInput(): void {
    const moving = document.activeElement === this.zoomMaxInput ? "max" : "min";
    const { lo, hi, loPercent, hiPercent } = enforceDualZoomThumbGap(
      Number(this.zoomMinInput.value),
      Number(this.zoomMaxInput.value),
      moving,
    );
    this.zoomMinInput.value = String(lo);
    this.zoomMaxInput.value = String(hi);
    setZoomOutLimitPercent(loPercent);
    setZoomInLimitPercent(hiPercent);
    this.syncZoomRange();
    reclampZoom();
  }

  /** Refresh the fill span + the "1% – 240%" readout from the current limits. */
  private syncZoomRange(): void {
    const lo = Number(this.zoomMinInput.value);
    const hi = Number(this.zoomMaxInput.value);
    this.zoomFill.style.left = `${(lo / DUAL_UNITS) * 100}%`;
    this.zoomFill.style.right = `${100 - (hi / DUAL_UNITS) * 100}%`;
    this.zoomRangeValue.textContent = `${getZoomOutLimitPercent()}% – ${getZoomInLimitPercent()}%`;
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  expand(): void {
    if (!this.collapsed) return;
    this.collapsed = false;
    // reflect the current preferences whenever the tray is (re)opened
    this.invertPitchCheck.checked = getInvertPitch();
    this.rightDragPanCheck.checked = getRightDragPan();
    this.zoomSensInput.value = String(getZoomSensitivityPercent());
    this.zoomMinInput.value = String(percentToUnit(getZoomOutLimitPercent()));
    this.zoomMaxInput.value = String(percentToUnit(getZoomInLimitPercent()));
    this.syncZoomRange();
    this.panel.classList.remove("is-collapsed");
    this.opts.onCollapseChange?.(false);
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
    this.panel.remove();
  }
}

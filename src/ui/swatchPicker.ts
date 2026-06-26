import { NO_FILL } from "../render/geometry";
import { h } from "./dom";

/**
 * A curated palette of 12 fills spanning dark→light, each verified to reach WCAG
 * AAA (≥7:1) against its auto-chosen label color (see `readableText`): six dark
 * tones that take light text and six light tones that take dark text. The first
 * entry (`#0f2740`) is the default fill so it shows as selected out of the box.
 */
export const SWATCH_COLORS = [
  // dark fills — render with light labels
  "#0f2740", // navy (default fill)
  "#1e293b", // slate
  "#0c4a6e", // ocean
  "#7f1d1d", // crimson
  "#14532d", // forest
  "#5b21b6", // violet
  // light fills — render with dark labels
  "#e2e8f0", // light
  "#fbbf24", // amber
  "#fb923c", // orange
  "#4ade80", // green
  "#38bdf8", // sky
  "#f9a8d4", // pink
];

/**
 * Neon-friendly accent palette for board FLOORS (layers panel). These are bright,
 * saturated hues — unlike {@link SWATCH_COLORS} (shape fills, half of them dark) —
 * because a floor's color drives a glowing frame, so it must read at low alpha.
 * The first entry is the cyan default so an unset floor shows as selected.
 */
export const LAYER_ACCENTS = [
  "#38bdf8", // cyan (default)
  "#22d3ee", // aqua
  "#4ade80", // green
  "#a3e635", // lime
  "#fbbf24", // amber
  "#fb923c", // orange
  "#f87171", // red
  "#f472b6", // pink
  "#c084fc", // violet
  "#818cf8", // indigo
];

export interface SwatchPicker {
  /** the trigger element to drop into the style panel */
  el: HTMLElement;
  /** reflect an externally-changed color onto the trigger swatch */
  setValue(hex: string): void;
}

/** Paint a swatch element with a color, or the diagonal "no fill" indicator. */
function paintSwatch(el: HTMLElement, value: string): void {
  const none = value === NO_FILL;
  el.classList.toggle("swatch--none", none);
  el.style.background = none ? "" : value;
}

/**
 * A swatch button that opens a small popover of {@link SWATCH_COLORS} presets,
 * replacing the native `<input type="color">` OS picker. Picking a color fires
 * `onPick` and closes the popover; outside-click / Esc dismiss it. When
 * `transparent` is set, a leading "no fill" chip lets the shape render as
 * outline only.
 */
export function createSwatchPicker(opts: {
  title: string;
  initial: string;
  transparent?: boolean;
  /** override the preset palette (defaults to {@link SWATCH_COLORS}) */
  colors?: string[];
  /**
   * Render the popover into <body> with fixed positioning instead of absolutely
   * inside the trigger's wrapper. Use when the trigger lives in a scroll/overflow
   * container (e.g. the layers panel list) that would otherwise clip the popover.
   */
  portal?: boolean;
  onPick: (value: string) => void;
}): SwatchPicker {
  let current = opts.initial;
  let pop: HTMLDivElement | null = null;
  let onScroll: (() => void) | null = null;
  const base = opts.colors ?? SWATCH_COLORS;
  const values = opts.transparent ? [NO_FILL, ...base] : base;

  const trigger = h("button", {
    type: "button",
    class: "swatch",
    title: opts.title,
  });
  paintSwatch(trigger, current);
  // wrapper anchors the popover so the chip <button>s aren't nested inside the
  // trigger <button> (invalid HTML)
  const wrap = h("div", { class: "swatch-wrap" }, trigger);

  const onDocPointerDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    // a portaled popover lives outside `wrap`, so also keep clicks inside `pop`
    if (pop && !wrap.contains(t) && !pop.contains(t)) close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && pop) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  function close(): void {
    if (!pop) return;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    if (onScroll) {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      onScroll = null;
    }
    pop.remove();
    pop = null;
    trigger.classList.remove("is-open");
  }

  /** Anchor a portaled popover above (or, if it would clip, below) the trigger. */
  function positionPortal(): void {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - pr.width / 2, vw - pr.width - margin));
    let top = r.top - pr.height - 10; // prefer above the trigger
    if (top < margin) top = Math.min(r.bottom + 10, vh - pr.height - margin); // flip below
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function open(): void {
    pop = h("div", {
      class: opts.portal ? "swatch-pop swatch-pop--portal" : "swatch-pop",
    }) as HTMLDivElement;
    for (const value of values) {
      const none = value === NO_FILL;
      const chip = h("button", {
        type: "button",
        class: "swatch-pop__chip",
        title: none ? "No fill" : value,
      });
      paintSwatch(chip, value);
      chip.classList.toggle("is-active", value.toLowerCase() === current.toLowerCase());
      chip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setValue(value);
        opts.onPick(value);
        close();
      });
      pop.appendChild(chip);
    }
    if (opts.portal) {
      document.body.appendChild(pop);
      positionPortal();
      // a scroll/resize moves the anchor out from under the popover — just dismiss
      onScroll = () => close();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
    } else {
      wrap.appendChild(pop);
    }
    trigger.classList.add("is-open");
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
  }

  function setValue(value: string): void {
    current = value;
    paintSwatch(trigger, value);
  }

  trigger.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop) close();
    else open();
  });

  return { el: wrap, setValue };
}

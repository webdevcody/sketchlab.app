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
 * A single-character hotkey per swatch (mnemonic where possible), shown on each
 * chip and active while the popover is open. Parallel to {@link SWATCH_COLORS}.
 * Avoids `f` / `u`, which open the fill / outline popovers.
 */
const SWATCH_KEYS = [
  "n", // navy
  "s", // slate
  "b", // ocean (blue)
  "r", // crimson (red)
  "e", // forest
  "v", // violet
  "w", // light (white)
  "a", // amber
  "o", // orange
  "g", // green
  "k", // sky
  "p", // pink
];

/** The hotkey letter bound to / shown on the swatch at `index`, if any. */
function hotkeyForSwatch(index: number): string | null {
  return SWATCH_KEYS[index] ?? null;
}

/** Resolve a pressed character to the swatch color it selects, if any. */
function swatchForKey(key: string): string | null {
  const index = SWATCH_KEYS.indexOf(key.toLowerCase());
  return index === -1 ? null : SWATCH_COLORS[index];
}

export interface SwatchPicker {
  /** the trigger element to drop into the style panel */
  el: HTMLElement;
  /** reflect an externally-changed color onto the trigger swatch */
  setValue(hex: string): void;
  /** open the preset popover (no-op if already open) */
  open(): void;
  /** close the preset popover (no-op if already closed) */
  close(): void;
  /** open the popover if closed, close it if open */
  toggle(): void;
  /** whether the preset popover is currently shown */
  isOpen(): boolean;
}

/** Paint a swatch element with a color, or the diagonal "no fill" indicator. */
function paintSwatch(el: HTMLElement, value: string): void {
  const none = value === NO_FILL;
  el.classList.toggle("swatch--none", none);
  el.style.background = none ? "" : value;
}

/**
 * A swatch button that opens a small popover of {@link SWATCH_COLORS} presets,
 * replacing the native `<input type="color">` OS picker. Each preset shows its
 * letter hotkey in the corner; while the popover is open that key picks the
 * matching color and closes it, taking priority over the canvas tool shortcuts.
 * Picking a color fires `onPick` and closes the popover; outside-click / Esc
 * dismiss it. When `transparent` is set, a leading "no fill" chip lets the shape
 * render as outline only.
 */
export function createSwatchPicker(opts: {
  title: string;
  initial: string;
  transparent?: boolean;
  onPick: (value: string) => void;
}): SwatchPicker {
  let current = opts.initial;
  let pop: HTMLDivElement | null = null;
  const values = opts.transparent ? [NO_FILL, ...SWATCH_COLORS] : SWATCH_COLORS;

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
    if (pop && !wrap.contains(e.target as Node)) close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (!pop) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // let editor/browser shortcuts (Cmd+R, etc.) through; only bare letters pick
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // a letter mapped to a swatch picks it and collapses the popover. Running in
    // the capture phase + stopPropagation gives it priority over the canvas tool
    // hotkeys (e.g. "r" picks red here instead of selecting the rectangle tool).
    const value = swatchForKey(e.key);
    if (value) {
      e.preventDefault();
      e.stopPropagation();
      pick(value);
    }
  };

  function pick(value: string): void {
    setValue(value);
    opts.onPick(value);
    close();
  }

  function close(): void {
    if (!pop) return;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    pop.remove();
    pop = null;
    trigger.classList.remove("is-open");
  }

  function open(): void {
    if (pop) return;
    pop = h("div", { class: "swatch-pop" }) as HTMLDivElement;
    for (const value of values) {
      const none = value === NO_FILL;
      const key = none ? null : hotkeyForSwatch(SWATCH_COLORS.indexOf(value));
      const chip = h("button", {
        type: "button",
        class: "swatch-pop__chip",
        title: none ? "No fill" : key ? `${value} (${key.toUpperCase()})` : value,
      });
      paintSwatch(chip, value);
      chip.classList.toggle("is-active", value.toLowerCase() === current.toLowerCase());
      if (key) chip.appendChild(h("span", { class: "swatch-pop__key" }, key.toUpperCase()));
      chip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pick(value);
      });
      pop.appendChild(chip);
    }
    wrap.appendChild(pop);
    trigger.classList.add("is-open");
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
  }

  function toggle(): void {
    if (pop) close();
    else open();
  }

  function setValue(value: string): void {
    current = value;
    paintSwatch(trigger, value);
  }

  trigger.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  return { el: wrap, setValue, open, close, toggle, isOpen: () => pop !== null };
}

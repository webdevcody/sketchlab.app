import { NO_FILL } from "../render/geometry";
import { h } from "./dom";

/**
 * A curated palette of 12 colors that read well as both fills and outlines on
 * the dark canvas — a neutral trio (light / slate / ink) plus nine vibrant hues
 * spanning the wheel. Kept in sync with the swatch grid below.
 */
export const SWATCH_COLORS = [
  "#e2e8f0", // light
  "#94a3b8", // slate
  "#1e293b", // ink
  "#f87171", // red
  "#fb923c", // orange
  "#fbbf24", // amber
  "#4ade80", // green
  "#2dd4bf", // teal
  "#38bdf8", // sky
  "#818cf8", // indigo
  "#c084fc", // purple
  "#f472b6", // pink
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
    pop.remove();
    pop = null;
    trigger.classList.remove("is-open");
  }

  function open(): void {
    pop = h("div", { class: "swatch-pop" }) as HTMLDivElement;
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
    wrap.appendChild(pop);
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

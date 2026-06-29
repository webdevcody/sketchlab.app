import { NO_FILL } from "../src/render/geometry";
import type { Shape } from "../src/state/types";

export type CirclePerfScenario =
  | "all-visible"
  | "mostly-offscreen"
  | "mixed-colors"
  | "selected-all"
  | "non-batchable";

const COLORS = ["#0f2740", "#164e63", "#155e75", "#1d4ed8", "#7c3aed", "#be123c"];

export function makeCircleScenario(count: number, scenario: CirclePerfScenario): Shape[] {
  const cols = Math.ceil(Math.sqrt(count));
  const spacing = scenario === "all-visible" || scenario === "mixed-colors" ? 76 : 96;
  return Array.from({ length: count }, (_, i) => {
    const visible = scenario !== "mostly-offscreen" || i < Math.min(500, count);
    const layoutCols = scenario === "mostly-offscreen" && visible ? 25 : cols;
    const layoutRows = scenario === "mostly-offscreen" && visible ? Math.ceil(Math.min(500, count) / layoutCols) : Math.ceil(count / layoutCols);
    const col = i % layoutCols;
    const row = Math.floor(i / layoutCols);
    const shape: Shape = {
      id: `${scenario}_${i}`,
      kind: "circle",
      x: visible ? col * spacing - (layoutCols * spacing) / 2 : 40_000 + col * spacing,
      y: visible ? row * spacing - (layoutRows * spacing) / 2 : 40_000 + row * spacing,
      w: 64,
      h: 64,
      fill: scenario === "mixed-colors" ? COLORS[i % COLORS.length] : "#0f2740",
      text: scenario === "selected-all" ? `Circle ${i}` : "",
    };
    if (scenario === "non-batchable") {
      shape.fill = NO_FILL;
    }
    return shape;
  });
}

import { Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import { doc } from "../state/store";
import type { Edge, ID } from "../state/types";
import { DEFAULT_FONT_SIZE } from "./fontPresets";
import { type EdgeGeometry, hexToNumber } from "./geometry";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * The label font (world units) an edge renders at: its explicit per-object tier
 * size, else the board-wide default tier — the same tier sizes shapes use.
 */
export function effectiveEdgeFontSize(e: Edge): number {
  return e.fontSize ?? doc.board.fontSize ?? DEFAULT_FONT_SIZE;
}

export interface EdgeView {
  container: Container;
  gfx: Graphics;
  label: Text | null;
  /** shape endpoints (undefined for a free end), retained so the scene can re-fan siblings on removal */
  from?: ID;
  to?: ID;
}

function labelStyle(fontSize: number): TextStyleOptions {
  return {
    fontFamily: FONT,
    fontSize,
    fill: 0xe2e8f0,
    align: "center",
  };
}

export function createEdgeView(from: ID | undefined, to: ID | undefined): EdgeView {
  const container = new Container();
  const gfx = new Graphics();
  container.addChild(gfx);
  return { container, gfx, label: null, from, to };
}

export function updateEdgeView(
  view: EdgeView,
  edge: Edge,
  geo: EdgeGeometry,
): void {
  const { p1, p2, ctrl, mid } = geo;
  const g = view.gfx;
  g.clear();
  const color = hexToNumber(edge.stroke);
  g.moveTo(p1.x, p1.y);
  if (ctrl) g.quadraticCurveTo(ctrl.x, ctrl.y, p2.x, p2.y);
  else g.lineTo(p2.x, p2.y);
  g.stroke({ width: 2, color, cap: "round", join: "round" });

  // arrowhead at the destination for directed edges
  if (edge.directed) {
    const ax = ctrl ? p2.x - ctrl.x : p2.x - p1.x;
    const ay = ctrl ? p2.y - ctrl.y : p2.y - p1.y;
    const ang = Math.atan2(ay, ax);
    const size = 12;
    const spread = Math.PI / 7;
    g.moveTo(p2.x - size * Math.cos(ang - spread), p2.y - size * Math.sin(ang - spread));
    g.lineTo(p2.x, p2.y);
    g.lineTo(p2.x - size * Math.cos(ang + spread), p2.y - size * Math.sin(ang + spread));
    g.stroke({ width: 2, color, cap: "round", join: "round" });
  }

  // label with a small backing panel for legibility
  if (edge.label) {
    const fontSize = effectiveEdgeFontSize(edge);
    if (!view.label) {
      view.label = new Text({ text: edge.label, style: labelStyle(fontSize), resolution: 2 });
      view.label.anchor.set(0.5);
      view.container.addChild(view.label);
    } else {
      view.label.text = edge.label;
      view.label.style = labelStyle(fontSize);
    }
    const lw = view.label.width + 10;
    const lh = view.label.height + 4;
    g.roundRect(mid.x - lw / 2, mid.y - lh / 2, lw, lh, 4);
    g.fill({ color: 0x0b1220, alpha: 0.85 });
    view.label.position.set(mid.x, mid.y);
  } else if (view.label) {
    view.container.removeChild(view.label);
    view.label.destroy();
    view.label = null;
  }
}

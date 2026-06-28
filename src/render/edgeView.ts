import { Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import type { Edge, ID, Shape } from "../state/types";
import { DEFAULT_TEXT_FONT_SIZE } from "../state/style";
import { type EdgeGeometry, quadPoints } from "./geometry";
import {
  getActiveProjector,
  type Projected,
  type Projector,
  projectBoard,
} from "./projection";
import { elevationOf, floorElevation, H_ARROW, shade, tint } from "./shading";
import {
  LABEL_FONT,
  NAMEPLATE_BACKGROUND_HEX,
  NAMEPLATE_BORDER_ALPHA,
  NAMEPLATE_BORDER_HEX,
  NAMEPLATE_FONT_WEIGHT,
  NAMEPLATE_PAD_X,
  NAMEPLATE_PAD_Y,
  NAMEPLATE_RADIUS,
  NAMEPLATE_TEXT_HEX,
  NAMEPLATE_TRACKING,
} from "./labelStyle";

/** Multi-pass cyan glow: wide+faint underlay up to a bright thin core. */
const LINE_GLOW = [
  { w: 16, color: 0x22d3ee, alpha: 0.06 },
  { w: 10, color: 0x38bdf8, alpha: 0.12 },
  { w: 6, color: 0x67e8f9, alpha: 0.22 },
  { w: 3, color: 0xa5f3fc, alpha: 0.95 },
  { w: 1.4, color: 0xecfeff, alpha: 0.9 },
];

export function lineGlow(color: string) {
  if (color === "#0f2740") {
    // navy (default fill)
    return LINE_GLOW;
  }
  // other fills require darker tone to be more distinguishable
  return [
    { w: 16, color: shade(color, 0.45), alpha: 0.08 },
    { w: 13, color: shade(color, 0.25), alpha: 0.24 },
    { w: 10, color: color, alpha: 0.95 },
    { w: 3, color: tint(color, 0.18), alpha: 0.9 },
    { w: 1.4, color: tint(color, 0.35), alpha: 0.95 },
  ];
}

const FLOW_DOT_SPACING = 34;
const FLOW_DOT_SPEED = 90;

export interface EdgeView {
  container: Container;
  gfx: Graphics;
  label: Text | null;
  from?: ID;
  to?: ID;
  epoch: number;
}

export interface FlowPulsePoint {
  sx: number;
  sy: number;
  scale?: number;
}

function labelStyle(): TextStyleOptions {
  return {
    fontFamily: LABEL_FONT,
    fontSize: DEFAULT_TEXT_FONT_SIZE,
    fontWeight: NAMEPLATE_FONT_WEIGHT,
    fill: NAMEPLATE_TEXT_HEX,
    align: "center",
    letterSpacing: NAMEPLATE_TRACKING,
  };
}

function edgeLabelFontSize(edge: Edge): number {
  return edge.fontSize ?? DEFAULT_TEXT_FONT_SIZE;
}

export function flowPulsePhase(now = performance.now()): number {
  return ((now / 1000) * FLOW_DOT_SPEED) % FLOW_DOT_SPACING;
}

/** Draw moving screen-space dots along a projected arrow path, from source to target. */
export function drawFlowPulseDots(
  g: Graphics,
  pts: FlowPulsePoint[],
  phase: number,
  baseScale = 1,
): void {
  if (pts.length < 2) return;

  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].sx - pts[i].sx, pts[i + 1].sy - pts[i].sy);
    lengths.push(len);
    total += len;
  }
  if (total < 8) return;

  for (let target = phase; target < total; target += FLOW_DOT_SPACING) {
    if (target < 3 || target > total - 3) continue;

    let walked = 0;
    for (let i = 0; i < lengths.length; i++) {
      const len = lengths[i];
      if (walked + len < target) {
        walked += len;
        continue;
      }

      const a = pts[i];
      const b = pts[i + 1];
      const t = len > 0 ? (target - walked) / len : 0;
      const x = a.sx + (b.sx - a.sx) * t;
      const y = a.sy + (b.sy - a.sy) * t;
      const scaleA = a.scale ?? baseScale;
      const scaleB = b.scale ?? baseScale;
      const sc = scaleA + (scaleB - scaleA) * t;
      const edgeFade = Math.min(1, target / 22, (total - target) / 22);
      const radius = Math.max(1.7, Math.min(4.4, 3.4 * sc));
      const alpha = 0.85 * edgeFade;

      g.circle(x, y, radius * 1.9);
      g.fill({ color: 0x67e8f9, alpha: alpha * 0.16 });
      g.circle(x, y, radius);
      g.fill({ color: 0xecfeff, alpha });
      break;
    }
  }
}

export function createEdgeView(from: ID | undefined, to: ID | undefined): EdgeView {
  const container = new Container();
  const gfx = new Graphics();
  container.addChild(gfx);
  return { container, gfx, label: null, from, to, epoch: -1 };
}

/** Recompute screen geometry for the current camera and redraw the glowing arrow. */
export function updateEdgeView(
  view: EdgeView,
  edge: Edge,
  geo: EdgeGeometry,
  pulsePhase = 0,
  from?: Shape,
  to?: Shape,
): void {
  reprojectEdgeView(view, edge, geo, getActiveProjector(), pulsePhase, from, to);
}

export function reprojectEdgeView(
  view: EdgeView,
  edge: Edge,
  geo: EdgeGeometry,
  proj: Projector,
  pulsePhase = 0,
  from?: Shape,
  to?: Shape,
): void {
  const g = view.gfx;
  g.clear();
  const { p1, p2, ctrl, mid } = geo;
  // Each end rides its own node's hover height, so the edge draws as one
  // continuous 3D line: same-floor edges stay flat, while a cross-floor edge
  // climbs straight from the lower node up to the raised one (no vertical riser).
  // A free (unanchored) end floats on the edge's own floor instead of the ground,
  // so an arrow drawn on the active layer originates from that layer.
  const free = floorElevation(edge.layer ?? 0);
  const hFrom = (from ? elevationOf(from) : free) + H_ARROW;
  const hTo = (to ? elevationOf(to) : free) + H_ARROW;
  const world = ctrl ? quadPoints(p1, ctrl, p2, 24) : [p1, p2];
  const last = world.length - 1;
  const scr: Projected[] = [];
  for (let i = 0; i < world.length; i++) {
    const t = last > 0 ? i / last : 0;
    const p = projectBoard(proj, world[i].x, world[i].y, hFrom + (hTo - hFrom) * t);
    if (p.ok) scr.push(p);
  }
  if (scr.length >= 2) {
    const sc = scr[Math.floor(scr.length / 2)].scale;
    for (const pass of lineGlow(edge.fill)) {
      g.moveTo(scr[0].sx, scr[0].sy);
      for (let i = 1; i < scr.length; i++) g.lineTo(scr[i].sx, scr[i].sy);
      g.stroke({
        width: Math.max(0.5, pass.w * sc),
        color: pass.color,
        alpha: pass.alpha,
        cap: "round",
        join: "round",
      });
    }
    if (edge.directed) {
      drawFlowPulseDots(g, scr, pulsePhase, sc);
      const tip = scr[scr.length - 1];
      const prev = scr[scr.length - 2];
      const ang = Math.atan2(tip.sy - prev.sy, tip.sx - prev.sx);
      const len = 15 * sc;
      const spread = Math.PI / 7;
      g.moveTo(tip.sx, tip.sy)
        .lineTo(tip.sx - len * Math.cos(ang - spread), tip.sy - len * Math.sin(ang - spread))
        .lineTo(tip.sx - len * Math.cos(ang + spread), tip.sy - len * Math.sin(ang + spread))
        .closePath();
      g.fill({ color: edge.fill, alpha: 0.95 });
    }
  }

  // label panel at the projected mid-point
  if (edge.label) {
    const m = projectBoard(proj, mid.x, mid.y, (hFrom + hTo) / 2);
    if (!view.label) {
      view.label = new Text({ text: edge.label, style: labelStyle(), resolution: 2 });
      view.label.anchor.set(0.5);
      view.container.addChild(view.label);
    } else {
      view.label.text = edge.label;
    }
    view.label.style.fontSize = edgeLabelFontSize(edge);
    if (m.ok) {
      const sc = Math.max(0.4, m.scale);
      view.label.visible = true;
      view.label.scale.set(sc);
      view.label.position.set(m.sx, m.sy);
      const padX = NAMEPLATE_PAD_X * sc;
      const padY = NAMEPLATE_PAD_Y * sc;
      const lw = view.label.width + padX * 2;
      const lh = view.label.height + padY * 2;
      const x = m.sx - lw / 2;
      const y = m.sy - lh / 2;
      const r = NAMEPLATE_RADIUS * sc;
      g.roundRect(x, y, lw, lh, r);
      g.fill({ color: NAMEPLATE_BACKGROUND_HEX, alpha: 0.95 });
      g.roundRect(x, y, lw, lh, r);
      g.stroke({
        width: Math.max(0.75, 1.2 * sc),
        color: NAMEPLATE_BORDER_HEX,
        alpha: NAMEPLATE_BORDER_ALPHA,
      });
    } else {
      view.label.visible = false;
    }
  } else if (view.label) {
    view.container.removeChild(view.label);
    view.label.destroy();
    view.label = null;
  }
}

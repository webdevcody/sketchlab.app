import {
  Container,
  Graphics,
  ImageSource,
  Matrix,
  PerspectiveMesh,
  Sprite,
  Texture,
} from "pixi.js";
import type { Shape, ShapeKind } from "../state/types";
import { hexToNumber, NO_FILL, readableText } from "./geometry";
import { drawIcon } from "./icons";
import {
  ICON_LABEL_FONT_SIZE,
  LABEL_FONT,
  NAMEPLATE_BACKGROUND_CSS,
  NAMEPLATE_BORDER_CSS,
  NAMEPLATE_FONT_SIZE,
  NAMEPLATE_FONT_WEIGHT,
  NAMEPLATE_PAD_X,
  NAMEPLATE_PAD_Y,
  NAMEPLATE_RADIUS,
  NAMEPLATE_TEXT_CSS,
  NAMEPLATE_TRACKING,
} from "./labelStyle";
import { TEXT_FONT_SIZE, TEXT_PAD } from "./measure";
import {
  getActiveProjector,
  type Projector,
  projectBoard,
} from "./projection";
import { elevationOf, FALLBACK, H_PED, shade, tint } from "./shading";

const NAMEPLATE_OFFSET_Y = 14;
const NAMEPLATE_SCREEN_NUDGE_Y = 8;

/** Default label font size (world units) for a shape kind, before any resize scaling. */
export function defaultLabelFont(kind: ShapeKind): number {
  if (kind === "text") return TEXT_FONT_SIZE;
  if (kind === "icon" || kind === "image") return ICON_LABEL_FONT_SIZE;
  return NAMEPLATE_FONT_SIZE;
}

export interface NodeView {
  container: Container;
  /** nameplates render in the scene's label layer so arrows cannot cover them */
  labelContainer: Container;
  /** pedestal disc + side wall (screen-space geometry) */
  gfx: Graphics;
  /** icon stamp drawn on the pedestal top (kept separate so it isn't cleared by the disc) */
  iconGfx: Graphics;
  textMesh: PerspectiveMesh | null;
  textTexture: Texture | null;
  textW: number;
  textH: number;
  sprite: Sprite | null;
  styleKey: string;
  textKey: string;
  srcKey: string;
  labelHidden: boolean;
  culled: boolean;
  /** camera epoch this view was last reprojected at; stale views reproject lazily */
  epoch: number;
}

function styleKeyOf(s: Shape): string {
  return `${s.kind}|${s.w}|${s.h}|${s.fill}|${s.icon ?? ""}|${s.src ?? ""}`;
}
function textKeyOf(s: Shape): string {
  return `${s.kind}|${s.text}|${s.fill}|${s.fontSize ?? ""}|${s.w}|${s.h}`;
}

type SP = { sx: number; sy: number };

const UNIT_CIRCLES = new Map<number, Array<{ x: number; y: number }>>();

function unitCircle(n: number): Array<{ x: number; y: number }> {
  const cached = UNIT_CIRCLES.get(n);
  if (cached) return cached;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  UNIT_CIRCLES.set(n, pts);
  return pts;
}

/** Project a ground circle to its true screen polygon at a world-up height. */
function projectRing(proj: Projector, cx: number, cy: number, r: number, h: number, n = 30): SP[] {
  const pts: SP[] = [];
  for (const v of unitCircle(n)) {
    const p = projectBoard(proj, cx + v.x * r, cy + v.y * r, h);
    if (!p.ok) return []; // any vertex behind camera → skip this token entirely
    pts.push({ sx: p.sx, sy: p.sy });
  }
  return pts;
}

function poly(g: Graphics, pts: SP[]): void {
  if (!pts.length) return;
  g.moveTo(pts[0].sx, pts[0].sy);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].sx, pts[i].sy);
  g.closePath();
}

interface PedestalShades {
  base: number;
  top: number;
  rimHi: number;
  wall: number;
}
function shadesOf(s: Shape): PedestalShades {
  return {
    base: hexToNumber(s.fill === NO_FILL ? FALLBACK : s.fill),
    top: tint(s.fill, 0.16),
    rimHi: tint(s.fill, 0.45),
    wall: shade(s.fill, 0.32),
  };
}

/** Cyan rim halo passes (wide+faint → bright) that make a pedestal glow like the reference. */
const RIM_GLOW = [
  { w: 8, color: 0x38bdf8, alpha: 0.1 },
  { w: 4, color: 0x67e8f9, alpha: 0.22 },
  { w: 2, color: 0xa5f3fc, alpha: 0.5 },
];

/** Stroke the cyan rim halo around a pedestal's top outline, scaled to its projected size. */
function rimGlow(g: Graphics, pts: SP[], sc: number): void {
  for (const p of RIM_GLOW) {
    poly(g, pts);
    g.stroke({ width: Math.max(0.5, p.w * sc), color: p.color, alpha: p.alpha, cap: "round" });
  }
}

/** Project the 4 corners of an axis-aligned ground rect at a height, or [] if any is behind. */
function projectQuad(
  proj: Projector,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h: number,
): SP[] {
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const out: SP[] = [];
  for (const [x, y] of corners) {
    const p = projectBoard(proj, x, y, h);
    if (!p.ok) return [];
    out.push({ sx: p.sx, sy: p.sy });
  }
  return out;
}

/** Edge colors for a `NO_FILL` token: a bright raised rim/posts over a receding ground footprint. */
const EMPTY_RIM = 0x94a3b8; // slate-400 — the raised top edge + posts
const EMPTY_FOOT = 0x475569; // slate-600 — the ground footprint (sits behind, dimmer)

/**
 * Render an empty (`NO_FILL`) token as a hollow wireframe — a "raised fence":
 * the ground footprint, vertical posts up to the lifted top, and the top edge.
 * No faces are filled so the dark canvas shows straight through.
 */
function drawEmptyPedestal(g: Graphics, top: SP[], bottom: SP[]): void {
  const n = top.length;
  // ground footprint — faint, it recedes behind the raised body
  poly(g, bottom);
  g.stroke({ width: 1.5, color: EMPTY_FOOT, alpha: 0.7 });

  // vertical posts: every corner for a slab (n≤4), a handful spaced around a disc
  const posts = n <= 4 ? n : 8;
  for (let k = 0; k < posts; k++) {
    const i = n <= 4 ? k : Math.round((k / posts) * n) % n;
    g.moveTo(top[i].sx, top[i].sy).lineTo(bottom[i].sx, bottom[i].sy);
  }
  g.stroke({ width: 1.5, color: EMPTY_RIM, alpha: 0.85 });

  // raised top edge — the brightest line, the "rail"
  poly(g, top);
  g.stroke({ width: 2, color: EMPTY_RIM, alpha: 0.95 });
}

/** A faux-3D extruded face between a top ring/quad and its ground twin. */
function extrude(g: Graphics, top: SP[], bottom: SP[], sh: PedestalShades): void {
  const n = top.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    g.moveTo(top[i].sx, top[i].sy)
      .lineTo(top[j].sx, top[j].sy)
      .lineTo(bottom[j].sx, bottom[j].sy)
      .lineTo(bottom[i].sx, bottom[i].sy)
      .closePath();
  }
  g.fill(sh.wall);
}

/** Circular disc pedestal (circle / icon tokens). */
function drawDisc(g: Graphics, s: Shape, proj: Projector): void {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const r = Math.min(s.w, s.h) / 2;
  const base = elevationOf(s); // layer lift: pedestal floats from `base` to base+H_PED
  const ringTop = projectRing(proj, cx, cy, r, base + H_PED);
  const ringBottom = projectRing(proj, cx, cy, r, base);
  if (!ringTop.length || !ringBottom.length) return;

  if (s.fill === NO_FILL) {
    drawEmptyPedestal(g, ringTop, ringBottom);
    return;
  }
  const sh = shadesOf(s);

  // raised tokens cast a shadow on the floor (floating cue); sunk tokens keep it
  // tucked under their base so it never floats above the token
  const shadowH = Math.min(base, 0);
  const shadow = projectRing(proj, cx + r * 0.12, cy + r * 0.16, r * 1.06, shadowH);
  if (shadow.length) {
    poly(g, shadow);
    g.fill({ color: 0x02060a, alpha: 0.4 });
  }
  extrude(g, ringTop, ringBottom, sh);
  poly(g, ringTop);
  g.fill(sh.base);
  rimGlow(g, ringTop, projectBoard(proj, cx, cy, base + H_PED).scale);
  poly(g, ringTop);
  g.stroke({ width: 2, color: sh.rimHi, alpha: 0.9 });
  const face = projectRing(proj, cx, cy, r * 0.84, base + H_PED);
  if (face.length) {
    poly(g, face);
    g.fill(sh.top);
  }
}

/** Rectangular extruded slab (rect / image tokens). */
function drawSlab(g: Graphics, s: Shape, proj: Projector): void {
  const x0 = s.x;
  const y0 = s.y;
  const x1 = s.x + s.w;
  const y1 = s.y + s.h;
  const base = elevationOf(s); // layer lift: slab floats from `base` to base+H_PED
  const topQ = projectQuad(proj, x0, y0, x1, y1, base + H_PED);
  const botQ = projectQuad(proj, x0, y0, x1, y1, base);
  if (!topQ.length || !botQ.length) return;

  if (s.fill === NO_FILL) {
    drawEmptyPedestal(g, topQ, botQ);
    return;
  }
  const sh = shadesOf(s);

  // raised tokens cast a shadow on the floor (floating cue); sunk tokens keep it
  // tucked under their base so it never floats above the token
  const shadowH = Math.min(base, 0);
  const off = Math.min(s.w, s.h) * 0.12;
  const shadow = projectQuad(proj, x0 + off, y0 + off * 1.3, x1 + off, y1 + off * 1.3, shadowH);
  if (shadow.length) {
    poly(g, shadow);
    g.fill({ color: 0x02060a, alpha: 0.4 });
  }
  extrude(g, topQ, botQ, sh);
  poly(g, topQ);
  g.fill(sh.base);
  rimGlow(g, topQ, projectBoard(proj, s.x + s.w / 2, s.y + s.h / 2, base + H_PED).scale);
  poly(g, topQ);
  g.stroke({ width: 2, color: sh.rimHi, alpha: 0.9 });
  const ins = Math.min(s.w, s.h) * 0.12;
  const face = projectQuad(proj, x0 + ins, y0 + ins, x1 - ins, y1 - ins, base + H_PED);
  if (face.length) {
    poly(g, face);
    g.fill(sh.top);
  }
}

/** Faux-3D pedestal: a disc for circle/icon, a rectangular slab for rect/image. */
function drawPedestal(g: Graphics, s: Shape, proj: Projector): void {
  if (s.kind === "rect" || s.kind === "image") drawSlab(g, s, proj);
  else drawDisc(g, s, proj);
}

let measureCtx: CanvasRenderingContext2D | null = null;

function textMeasureContext(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

function textFillCss(s: Shape): string {
  return s.fill === NO_FILL ? "#e2e8f0" : s.fill;
}

function createTextTexture(s: Shape): Texture {
  const fontSize = s.fontSize ?? TEXT_FONT_SIZE;
  const lineHeight = fontSize * 1.3;
  const resolution = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(s.w * resolution));
  canvas.height = Math.max(1, Math.ceil(s.h * resolution));

  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(resolution, resolution);
    ctx.font = `600 ${fontSize}px ${LABEL_FONT}`;
    ctx.fillStyle = textFillCss(s);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lines = (s.text.length ? s.text : " ").split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i] || " ", TEXT_PAD, TEXT_PAD + i * lineHeight);
    }
  }

  return Texture.from(canvas, true);
}

function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  if (!text.length) return ctx.measureText(" ").width;
  return ctx.measureText(text).width + Math.max(0, text.length - 1) * tracking;
}

function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): void {
  if (!text.length) {
    ctx.fillText(" ", x, y);
    return;
  }
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

function nameplateMetrics(s: Shape): { w: number; h: number } {
  const fontSize = s.fontSize ?? defaultLabelFont(s.kind);
  const lineHeight = fontSize * 1.3;
  const lines = (s.text.length ? s.text : " ").split("\n");
  const ctx = textMeasureContext();
  let maxW = 0;
  if (ctx) {
    ctx.font = `${NAMEPLATE_FONT_WEIGHT} ${fontSize}px ${LABEL_FONT}`;
    for (const line of lines) maxW = Math.max(maxW, trackedWidth(ctx, line, NAMEPLATE_TRACKING));
  } else {
    for (const line of lines) maxW = Math.max(maxW, (line || " ").length * fontSize * 0.65);
  }
  return {
    w: Math.ceil(maxW + NAMEPLATE_PAD_X * 2),
    h: Math.ceil(lines.length * lineHeight + NAMEPLATE_PAD_Y * 2),
  };
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function createNameplateTexture(s: Shape, box = nameplateMetrics(s)): Texture {
  const fontSize = s.fontSize ?? defaultLabelFont(s.kind);
  const lineHeight = fontSize * 1.3;
  const resolution = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(box.w * resolution));
  canvas.height = Math.max(1, Math.ceil(box.h * resolution));

  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(resolution, resolution);
    roundedRectPath(ctx, 0.6, 0.6, box.w - 1.2, box.h - 1.2, NAMEPLATE_RADIUS);
    ctx.fillStyle = NAMEPLATE_BACKGROUND_CSS;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = NAMEPLATE_BORDER_CSS;
    ctx.stroke();

    ctx.font = `${NAMEPLATE_FONT_WEIGHT} ${fontSize}px ${LABEL_FONT}`;
    ctx.fillStyle = NAMEPLATE_TEXT_CSS;
    ctx.textBaseline = "top";
    const lines = (s.text.length ? s.text : " ").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || " ";
      const lineW = trackedWidth(ctx, line, NAMEPLATE_TRACKING);
      drawTrackedText(
        ctx,
        line,
        (box.w - lineW) / 2,
        NAMEPLATE_PAD_Y + i * lineHeight,
        NAMEPLATE_TRACKING,
      );
    }
  }

  return Texture.from(canvas, true);
}

export function createNodeView(s: Shape, onReady?: () => void): NodeView {
  const container = new Container();
  const labelContainer = new Container();
  const gfx = new Graphics();
  const iconGfx = new Graphics();
  container.addChild(gfx, iconGfx);
  const view: NodeView = {
    container,
    labelContainer,
    gfx,
    iconGfx,
    textMesh: null,
    textTexture: null,
    textW: 0,
    textH: 0,
    sprite: null,
    styleKey: "",
    textKey: "",
    srcKey: "",
    labelHidden: false,
    culled: false,
    epoch: -1,
  };
  updateNodeView(view, s, onReady);
  return view;
}

/** Sync content (gated by keys) AND reproject geometry for the current camera. */
export function updateNodeView(view: NodeView, s: Shape, onReady?: () => void): void {
  const sk = styleKeyOf(s);
  if (sk !== view.styleKey) {
    view.styleKey = sk;
    syncImage(view, s, onReady);
    syncIcon(view, s);
  }
  const tk = textKeyOf(s);
  if (tk !== view.textKey) {
    view.textKey = tk;
    syncText(view, s);
  }
  reprojectNodeView(view, s, getActiveProjector());
}

/** Camera-dependent geometry only — called when the camera changes (lazy/by epoch). */
export function reprojectNodeView(view: NodeView, s: Shape, proj: Projector): void {
  view.container.position.set(0, 0);
  view.labelContainer.position.set(0, 0);
  const g = view.gfx;
  const ig = view.iconGfx;
  g.clear();
  ig.visible = false;

  if (s.kind === "text") {
    placePerspectiveText(view, s, proj);
    return;
  }

  drawPedestal(g, s, proj);

  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const r = Math.min(s.w, s.h) / 2;
  const top = elevationOf(s) + H_PED; // pedestal top face, lifted by the layer
  const apex = projectBoard(proj, cx, cy, top);

  // draw the icon on the pedestal top — for icon tokens, and for any rect/circle
  // that has had an icon "locked" into its center. The icon must lie FLAT on the
  // tilted top plane like the disc beneath it, not be stamped head-on. We fit the
  // plane's local tangent at height H_PED by projecting the center and its world
  // +x/+y edges, then map the icon's unit square onto that parallelogram via a
  // Graphics matrix — so it shears/foreshortens with the camera (matching shading).
  if (s.icon && apex.ok) {
    const half = 0.6 * r; // icon half-width in world units (icon spans 0.6·diameter)
    const ex = projectBoard(proj, cx + half, cy, top);
    const ey = projectBoard(proj, cx, cy + half, top);
    if (ex.ok && ey.ok) {
      // Full-width screen basis vectors for the icon's +x / +y axes on the tilted
      // top plane (the ×2 turns the half-extent edge offsets into full spans).
      const ax = (ex.sx - apex.sx) * 2;
      const ay = (ex.sy - apex.sy) * 2;
      const bx = (ey.sx - apex.sx) * 2;
      const by = (ey.sy - apex.sy) * 2;
      // The vector icon is cached as a normalized centered square; per-frame work
      // only warps that square onto the tilted pedestal top.
      ig.setFromMatrix(new Matrix(ax, ay, bx, by, apex.sx, apex.sy));
      ig.visible = true;
    } else {
      const size = 0.6 * (2 * r) * apex.scale;
      ig.setFromMatrix(new Matrix(size, 0, 0, size, apex.sx, apex.sy));
      ig.visible = true;
    }
  }

  if (s.kind === "image" && view.sprite && apex.ok) {
    const sp = view.sprite;
    sp.anchor.set(0.5, 0.5);
    sp.position.set(apex.sx, apex.sy);
    sp.scale.set(apex.scale * 0.92);
  }

  placeNameplate(view, s, proj);
}

function placePerspectiveText(view: NodeView, s: Shape, proj: Projector): void {
  if (!view.textMesh) return;
  const q = projectQuad(proj, s.x, s.y, s.x + s.w, s.y + s.h, elevationOf(s));
  if (!q.length) {
    view.textMesh.visible = false;
    return;
  }
  view.textMesh.setFromMatrix(Matrix.IDENTITY);
  view.textMesh.setCorners(
    q[0].sx,
    q[0].sy,
    q[1].sx,
    q[1].sy,
    q[2].sx,
    q[2].sy,
    q[3].sx,
    q[3].sy,
  );
  view.textMesh.visible = !view.labelHidden;
}

/** Engraved nameplate beneath the token: a beveled plate + caps label. */
function placeNameplate(view: NodeView, s: Shape, proj: Projector): void {
  if (!view.textMesh) return;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const footY = cy + s.h / 2 + NAMEPLATE_OFFSET_Y;
  const base = elevationOf(s); // keep the nameplate glued under a lifted token
  const box = { w: view.textW, h: view.textH };
  const q = projectQuad(
    proj,
    cx - box.w / 2,
    footY - 4,
    cx + box.w / 2,
    footY - 4 + box.h,
    base,
  );
  if (!q.length) {
    view.textMesh.visible = false;
    return;
  }
  view.textMesh.setFromMatrix(Matrix.IDENTITY);
  view.textMesh.setCorners(
    q[0].sx,
    q[0].sy + NAMEPLATE_SCREEN_NUDGE_Y,
    q[1].sx,
    q[1].sy + NAMEPLATE_SCREEN_NUDGE_Y,
    q[2].sx,
    q[2].sy + NAMEPLATE_SCREEN_NUDGE_Y,
    q[3].sx,
    q[3].sy + NAMEPLATE_SCREEN_NUDGE_Y,
  );
  view.textMesh.visible = !view.labelHidden;
}

function syncImage(view: NodeView, s: Shape, onReady?: () => void): void {
  if (s.kind !== "image") {
    if (view.sprite) {
      view.container.removeChild(view.sprite);
      view.sprite.destroy();
      view.sprite = null;
      view.srcKey = "";
    }
    return;
  }
  if (!view.sprite) {
    view.sprite = new Sprite();
    view.container.addChildAt(view.sprite, 1); // above the pedestal disc
  }
  const sprite = view.sprite;
  if (view.srcKey !== (s.src ?? "")) {
    view.srcKey = s.src ?? "";
    if (s.src) {
      const img = new Image();
      img.onload = () => {
        sprite.texture = new Texture({ source: new ImageSource({ resource: img }) });
        onReady?.();
      };
      img.src = s.src;
    }
  }
}

function syncIcon(view: NodeView, s: Shape): void {
  const g = view.iconGfx;
  g.clear();
  g.setFromMatrix(Matrix.IDENTITY);
  g.visible = false;
  if (!s.icon) return;
  drawIcon(g, s.icon, -0.5, -0.5, 1, readableText(s.fill));
}

function syncText(view: NodeView, s: Shape): void {
  if (!s.text) {
    clearTextMesh(view);
    return;
  }
  const isTextKind = s.kind === "text";
  const box = isTextKind ? { w: s.w, h: s.h } : nameplateMetrics(s);
  const texture = isTextKind ? createTextTexture(s) : createNameplateTexture(s, box);
  if (!view.textMesh) {
    view.textMesh = new PerspectiveMesh({ texture, verticesX: 8, verticesY: 8 });
    (isTextKind ? view.container : view.labelContainer).addChild(view.textMesh);
  } else {
    view.textMesh.texture = texture;
    (isTextKind ? view.container : view.labelContainer).addChild(view.textMesh);
  }
  view.textTexture?.destroy(true);
  view.textTexture = texture;
  view.textW = box.w;
  view.textH = box.h;
  view.textMesh.visible = !view.labelHidden;
}

function clearTextMesh(view: NodeView): void {
  if (view.textMesh) {
    view.textMesh.parent?.removeChild(view.textMesh);
    view.textMesh.destroy();
    view.textMesh = null;
  }
  view.textTexture?.destroy(true);
  view.textTexture = null;
  view.textW = 0;
  view.textH = 0;
}

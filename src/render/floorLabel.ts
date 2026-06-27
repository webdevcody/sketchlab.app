// Floor-label placards. Each floor's name is rasterized into a small rounded
// "pill" texture here, then laid FLAT onto the floor plane (top-left corner) by
// scene.ts via a PerspectiveMesh — so the label reads as if it were printed on
// the layer itself, sheared/foreshortened by the same camera as the grid, rather
// than floating in screen space. Mirrors shapeView's nameplate-texture approach.
import { Texture } from "pixi.js";
import { DEFAULT_FLOOR_COLOR } from "./boardLayers";
import { LABEL_FONT, NAMEPLATE_FONT_WEIGHT, NAMEPLATE_TRACKING } from "./labelStyle";

const FONT_SIZE = 13;
const PAD_X = 9;
const PAD_Y = 5;
const RADIUS = 6;
const LINE_RATIO = 1.3;
const RESOLUTION = 2;

export interface FloorLabelTexture {
  texture: Texture;
  /** CSS-pixel pill width (the texture's logical size, before perspective warp). */
  w: number;
  /** CSS-pixel pill height. */
  h: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function context(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Advance width of `text` with manual letter tracking baked in. */
function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  if (!text.length) return ctx.measureText(" ").width;
  return ctx.measureText(text).width + Math.max(0, text.length - 1) * tracking;
}

/** Draw `text` glyph-by-glyph so canvas honors the same letter-spacing as the UI. */
function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): void {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
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

/** Cache key: the placard texture only needs rebuilding when one of these changes. */
export function floorLabelKey(name: string, active: boolean, accent: string): string {
  return `${name}|${active ? 1 : 0}|${accent}`;
}

/**
 * Rasterize a floor name into a pill placard. The ACTIVE floor takes its accent
 * border + a brighter plate (the "you are here" cue from the layers panel);
 * inactive floors stay a muted slate and dim their text. The returned `w`/`h` are
 * the placard's logical pixel size — scene.ts maps that rectangle onto the floor
 * plane so the placard foreshortens with the camera.
 */
export function createFloorLabelTexture(
  name: string,
  active: boolean,
  accent: string = DEFAULT_FLOOR_COLOR,
): FloorLabelTexture {
  const label = name.toUpperCase();
  const ctx0 = context();
  let textW = label.length * FONT_SIZE * 0.7; // fallback when no 2d context
  if (ctx0) {
    ctx0.font = `${NAMEPLATE_FONT_WEIGHT} ${FONT_SIZE}px ${LABEL_FONT}`;
    textW = trackedWidth(ctx0, label, NAMEPLATE_TRACKING);
  }
  const w = Math.ceil(textW + PAD_X * 2);
  const h = Math.ceil(FONT_SIZE * LINE_RATIO + PAD_Y * 2);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * RESOLUTION));
  canvas.height = Math.max(1, Math.ceil(h * RESOLUTION));

  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(RESOLUTION, RESOLUTION);
    // pill plate — brighter navy on the active floor, muted on the rest
    roundedRectPath(ctx, 0.6, 0.6, w - 1.2, h - 1.2, RADIUS);
    ctx.fillStyle = active ? "rgba(12, 39, 64, 0.92)" : "rgba(9, 22, 34, 0.92)";
    ctx.fill();
    // border picks up the floor's accent only when active, so the badge↔frame
    // color link only shouts on the floor you're editing
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = active ? 0.95 : 0.6;
    ctx.strokeStyle = active ? accent : "#1f3a52";
    ctx.stroke();

    ctx.globalAlpha = active ? 1 : 0.55;
    ctx.font = `${NAMEPLATE_FONT_WEIGHT} ${FONT_SIZE}px ${LABEL_FONT}`;
    ctx.fillStyle = "#dff6ff";
    ctx.textBaseline = "middle";
    drawTrackedText(ctx, label, PAD_X, h / 2, NAMEPLATE_TRACKING);
    ctx.globalAlpha = 1;
  }

  return { texture: Texture.from(canvas, true), w, h };
}

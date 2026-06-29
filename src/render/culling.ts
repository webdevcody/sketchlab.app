import type { Shape } from "../state/types";
import { elevationOf, H_PED } from "./shading";
import { type Projector, projectBoard, unprojectBoardAt } from "./projection";
import type { ShapeBounds } from "./shapeSpatialIndex";

export interface ScreenViewport {
  w: number;
  h: number;
}

const DEFAULT_MARGIN_PX = 220;

function intersectsViewport(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  viewport: ScreenViewport,
  marginPx: number,
): boolean {
  return (
    maxX >= -marginPx &&
    minX <= viewport.w + marginPx &&
    maxY >= -marginPx &&
    minY <= viewport.h + marginPx
  );
}

export function isShapeInViewport(
  shape: Shape,
  proj: Projector,
  viewport: ScreenViewport,
  marginPx = DEFAULT_MARGIN_PX,
): boolean {
  const h = elevationOf(shape) + (shape.kind === "text" ? 0 : H_PED);
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const rx = shape.w / 2;
  const ry = shape.h / 2;
  const points: Array<[number, number]> =
    shape.kind === "circle" || shape.kind === "icon"
      ? [
          [cx - rx, cy],
          [cx + rx, cy],
          [cx, cy - ry],
          [cx, cy + ry],
        ]
      : [
          [shape.x, shape.y],
          [shape.x + shape.w, shape.y],
          [shape.x + shape.w, shape.y + shape.h],
          [shape.x, shape.y + shape.h],
        ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let anyProjected = false;

  for (const [x, y] of points) {
    const p = projectBoard(proj, x, y, h);
    if (!p.ok) continue;
    anyProjected = true;
    minX = Math.min(minX, p.sx);
    minY = Math.min(minY, p.sy);
    maxX = Math.max(maxX, p.sx);
    maxY = Math.max(maxY, p.sy);
  }

  return anyProjected && intersectsViewport(minX, minY, maxX, maxY, viewport, marginPx);
}

export function boardViewportBounds(
  proj: Projector,
  viewport: ScreenViewport,
  marginPx = DEFAULT_MARGIN_PX,
): ShapeBounds | null {
  const corners: Array<[number, number]> = [
    [-marginPx, -marginPx],
    [viewport.w + marginPx, -marginPx],
    [viewport.w + marginPx, viewport.h + marginPx],
    [-marginPx, viewport.h + marginPx],
  ];
  const heights = [0, H_PED];
  const points: Array<{ wx: number; wy: number }> = [];
  for (const h of heights) {
    for (const [sx, sy] of corners) {
      const p = unprojectBoardAt(proj, sx, sy, h);
      if (p) points.push(p);
    }
  }
  if (points.length < corners.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.wx);
    minY = Math.min(minY, p.wy);
    maxX = Math.max(maxX, p.wx);
    maxY = Math.max(maxY, p.wy);
  }
  return { minX, minY, maxX, maxY };
}

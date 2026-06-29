import type { ID, Shape } from "../state/types";

export interface ShapeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type CellKey = string;

function boundsOf(shape: Shape): ShapeBounds {
  return {
    minX: Math.min(shape.x, shape.x + shape.w),
    minY: Math.min(shape.y, shape.y + shape.h),
    maxX: Math.max(shape.x, shape.x + shape.w),
    maxY: Math.max(shape.y, shape.y + shape.h),
  };
}

function intersects(a: ShapeBounds, b: ShapeBounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

export class ShapeSpatialIndex {
  private cells = new Map<CellKey, Set<ID>>();
  private shapes = new Map<ID, Shape>();
  private shapeCells = new Map<ID, CellKey[]>();

  constructor(private readonly cellSize = 512) {}

  rebuild(shapes: Iterable<Shape>): void {
    this.clear();
    for (const shape of shapes) this.upsert(shape);
  }

  clear(): void {
    this.cells.clear();
    this.shapes.clear();
    this.shapeCells.clear();
  }

  upsert(shape: Shape): void {
    this.remove(shape.id);
    const keys = this.keysFor(boundsOf(shape));
    this.shapes.set(shape.id, shape);
    this.shapeCells.set(shape.id, keys);
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(shape.id);
    }
  }

  remove(id: ID): void {
    const keys = this.shapeCells.get(id);
    if (!keys) return;
    for (const key of keys) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      cell.delete(id);
      if (!cell.size) this.cells.delete(key);
    }
    this.shapeCells.delete(id);
    this.shapes.delete(id);
  }

  queryRect(rect: ShapeBounds): Shape[] {
    const out: Shape[] = [];
    const seen = new Set<ID>();
    for (const key of this.keysFor(rect)) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      for (const id of cell) {
        if (seen.has(id)) continue;
        const shape = this.shapes.get(id);
        if (!shape || !intersects(boundsOf(shape), rect)) continue;
        seen.add(id);
        out.push(shape);
      }
    }
    return out;
  }

  queryPoint(x: number, y: number, radius: number): Shape[] {
    return this.queryRect({
      minX: x - radius,
      minY: y - radius,
      maxX: x + radius,
      maxY: y + radius,
    });
  }

  all(): Shape[] {
    return [...this.shapes.values()];
  }

  private keysFor(bounds: ShapeBounds): CellKey[] {
    const minX = Math.floor(bounds.minX / this.cellSize);
    const minY = Math.floor(bounds.minY / this.cellSize);
    const maxX = Math.floor(bounds.maxX / this.cellSize);
    const maxY = Math.floor(bounds.maxY / this.cellSize);
    const keys: CellKey[] = [];
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        keys.push(`${cx}:${cy}`);
      }
    }
    return keys;
  }
}

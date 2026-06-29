import { Container, Mesh, MeshGeometry, Texture } from "pixi.js";
import type { Shape } from "../state/types";
import { hexToNumber, NO_FILL } from "./geometry";
import { type Projector, projectBoard } from "./projection";
import { elevationOf, H_PED, shade, tint } from "./shading";

type SP = { sx: number; sy: number };

const CIRCLE_SEGMENTS = 30;

const CIRCLE = Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
  const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
});

type BatchPass = "shadow" | "wall" | "top" | "rim" | "face";

const PASS_ORDER: BatchPass[] = ["shadow", "wall", "top", "rim", "face"];
const RIM_WIDTH = 2;
const RIM_ALPHA = 0.9;

interface BatchGroup {
  pass: BatchPass;
  color: number;
  alpha: number;
  positions: number[];
  indices: number[];
}

interface BatchMesh {
  mesh: Mesh<MeshGeometry>;
  geometry: MeshGeometry;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface BatchNode {
  shape: Shape;
  depth: number;
  alpha: number;
}

export interface PedestalBatchStats {
  visibleNodes: number;
  batchVertices: number;
  batchMeshes: number;
  batchUploadBytes: number;
}

function groupKey(pass: BatchPass, color: number, alpha: number): string {
  return `${pass}|${color}|${alpha.toFixed(3)}`;
}

function groupFor(groups: Map<string, BatchGroup>, pass: BatchPass, color: number, alpha: number): BatchGroup {
  const key = groupKey(pass, color, alpha);
  let group = groups.get(key);
  if (!group) {
    group = { pass, color, alpha, positions: [], indices: [] };
    groups.set(key, group);
  }
  return group;
}

function pushVertex(group: BatchGroup, p: SP): number {
  const idx = group.positions.length / 2;
  group.positions.push(p.sx, p.sy);
  return idx;
}

function addQuad(group: BatchGroup, a: SP, b: SP, c: SP, d: SP): void {
  const i = pushVertex(group, a);
  pushVertex(group, b);
  pushVertex(group, c);
  pushVertex(group, d);
  group.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
}

function addStrokeSegment(group: BatchGroup, a: SP, b: SP, width: number): void {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  const len = Math.hypot(dx, dy);
  if (len <= 0.001) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  addQuad(
    group,
    { sx: a.sx + nx, sy: a.sy + ny },
    { sx: b.sx + nx, sy: b.sy + ny },
    { sx: b.sx - nx, sy: b.sy - ny },
    { sx: a.sx - nx, sy: a.sy - ny },
  );
}

function addClosedStroke(group: BatchGroup, pts: SP[], width: number): void {
  if (pts.length < 2) return;
  for (let i = 0; i < pts.length; i++) {
    addStrokeSegment(group, pts[i], pts[(i + 1) % pts.length], width);
  }
}

function addFan(group: BatchGroup, pts: SP[]): void {
  if (pts.length < 3) return;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.sx;
    sy += p.sy;
  }
  const center = { sx: sx / pts.length, sy: sy / pts.length };
  const centerIndex = pushVertex(group, center);
  const firstRing = group.positions.length / 2;
  for (const p of pts) pushVertex(group, p);
  for (let i = 0; i < pts.length; i++) {
    group.indices.push(centerIndex, firstRing + i, firstRing + ((i + 1) % pts.length));
  }
}

function projectCircle(proj: Projector, cx: number, cy: number, r: number, h: number): SP[] {
  const pts: SP[] = [];
  for (const u of CIRCLE) {
    const p = projectBoard(proj, cx + u.x * r, cy + u.y * r, h);
    if (!p.ok) return [];
    pts.push({ sx: p.sx, sy: p.sy });
  }
  return pts;
}

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

function addExtrusion(group: BatchGroup, top: SP[], bottom: SP[]): void {
  const n = Math.min(top.length, bottom.length);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    addQuad(group, top[i], top[j], bottom[j], bottom[i]);
  }
}

function addRim(groups: Map<string, BatchGroup>, pts: SP[], scale: number, fill: string, alpha: number): void {
  addClosedStroke(
    groupFor(groups, "rim", tint(fill, 0.45), RIM_ALPHA * alpha),
    pts,
    Math.max(0.5, RIM_WIDTH * scale),
  );
}

export function isBatchablePedestal(shape: Shape): boolean {
  return (
    (shape.kind === "circle" || shape.kind === "rect") &&
    shape.fill !== NO_FILL &&
    !shape.icon &&
    !shape.src
  );
}

export class PedestalBatch {
  readonly container = new Container();
  private meshes = new Map<string, BatchMesh>();
  private scratchGroups = new Map<string, BatchGroup>();
  private visibleKeys = new Set<string>();
  private stats: PedestalBatchStats = {
    visibleNodes: 0,
    batchVertices: 0,
    batchMeshes: 0,
    batchUploadBytes: 0,
  };

  get visible(): boolean {
    return this.visibleKeys.size > 0;
  }

  getStats(): PedestalBatchStats {
    return this.stats;
  }

  update(nodes: BatchNode[], proj: Projector): void {
    const groups = this.scratchGroups;
    for (const group of groups.values()) {
      group.positions.length = 0;
      group.indices.length = 0;
    }
    const sorted = [...nodes].sort((a, b) => b.depth - a.depth);

    for (const { shape, alpha } of sorted) {
      if (shape.kind === "circle") {
        this.addCircle(groups, shape, proj, alpha);
      } else if (shape.kind === "rect") {
        this.addRect(groups, shape, proj, alpha);
      }
    }

    const ordered = [...groups.values()].filter((group) => group.positions.length > 0).sort((a, b) => {
      const pass = PASS_ORDER.indexOf(a.pass) - PASS_ORDER.indexOf(b.pass);
      if (pass !== 0) return pass;
      return a.color - b.color || a.alpha - b.alpha;
    });
    this.visibleKeys = new Set(ordered.map((group) => groupKey(group.pass, group.color, group.alpha)));

    let batchVertices = 0;
    let batchUploadBytes = 0;
    for (const group of ordered) this.syncMesh(group);
    for (const group of ordered) {
      batchVertices += group.positions.length / 2;
      batchUploadBytes += (group.positions.length + group.positions.length + group.indices.length) * 4;
    }
    for (const [key, batch] of this.meshes) {
      batch.mesh.visible = this.visibleKeys.has(key);
    }
    this.container.removeChildren();
    for (const group of ordered) {
      const batch = this.meshes.get(groupKey(group.pass, group.color, group.alpha));
      if (batch) this.container.addChild(batch.mesh);
    }
    this.stats = {
      visibleNodes: nodes.length,
      batchVertices,
      batchMeshes: ordered.length,
      batchUploadBytes,
    };
  }

  clear(): void {
    this.visibleKeys.clear();
    for (const batch of this.meshes.values()) batch.mesh.visible = false;
    this.container.removeChildren();
    this.stats = {
      visibleNodes: 0,
      batchVertices: 0,
      batchMeshes: 0,
      batchUploadBytes: 0,
    };
  }

  destroy(): void {
    for (const batch of this.meshes.values()) batch.mesh.destroy({ children: true });
    this.meshes.clear();
    this.container.destroy({ children: true });
  }

  private addCircle(groups: Map<string, BatchGroup>, shape: Shape, proj: Projector, alpha: number): void {
    const cx = shape.x + shape.w / 2;
    const cy = shape.y + shape.h / 2;
    const r = Math.min(shape.w, shape.h) / 2;
    const base = elevationOf(shape);
    const top = projectCircle(proj, cx, cy, r, base + H_PED);
    const bottom = projectCircle(proj, cx, cy, r, base);
    if (!top.length || !bottom.length) return;

    const shadowH = Math.min(base, 0);
    const shadow = projectCircle(proj, cx + r * 0.12, cy + r * 0.16, r * 1.06, shadowH);
    if (shadow.length) addFan(groupFor(groups, "shadow", 0x02060a, 0.4 * alpha), shadow);

    addExtrusion(groupFor(groups, "wall", shade(shape.fill, 0.32), alpha), top, bottom);
    addFan(groupFor(groups, "top", hexToNumber(shape.fill), alpha), top);
    const center = projectBoard(proj, cx, cy, base + H_PED);
    if (center.ok) addRim(groups, top, center.scale, shape.fill, alpha);

    const face = projectCircle(proj, cx, cy, r * 0.84, base + H_PED);
    if (face.length) addFan(groupFor(groups, "face", tint(shape.fill, 0.16), alpha), face);
  }

  private addRect(groups: Map<string, BatchGroup>, shape: Shape, proj: Projector, alpha: number): void {
    const x0 = shape.x;
    const y0 = shape.y;
    const x1 = shape.x + shape.w;
    const y1 = shape.y + shape.h;
    const base = elevationOf(shape);
    const top = projectQuad(proj, x0, y0, x1, y1, base + H_PED);
    const bottom = projectQuad(proj, x0, y0, x1, y1, base);
    if (!top.length || !bottom.length) return;

    const shadowH = Math.min(base, 0);
    const off = Math.min(shape.w, shape.h) * 0.12;
    const shadow = projectQuad(proj, x0 + off, y0 + off * 1.3, x1 + off, y1 + off * 1.3, shadowH);
    if (shadow.length) addFan(groupFor(groups, "shadow", 0x02060a, 0.4 * alpha), shadow);

    addExtrusion(groupFor(groups, "wall", shade(shape.fill, 0.32), alpha), top, bottom);
    addFan(groupFor(groups, "top", hexToNumber(shape.fill), alpha), top);
    const center = projectBoard(proj, shape.x + shape.w / 2, shape.y + shape.h / 2, base + H_PED);
    if (center.ok) addRim(groups, top, center.scale, shape.fill, alpha);

    const ins = Math.min(shape.w, shape.h) * 0.12;
    const face = projectQuad(proj, x0 + ins, y0 + ins, x1 - ins, y1 - ins, base + H_PED);
    if (face.length) addFan(groupFor(groups, "face", tint(shape.fill, 0.16), alpha), face);
  }

  private syncMesh(group: BatchGroup): void {
    const key = groupKey(group.pass, group.color, group.alpha);
    let batch = this.meshes.get(key);
    const positionLength = group.positions.length;
    const indexLength = group.indices.length;
    if (!batch) {
      const positions = new Float32Array(Math.max(positionLength, 1));
      positions.set(group.positions);
      const uvs = new Float32Array(Math.max(positionLength, 1));
      const indices = new Uint32Array(Math.max(indexLength, 1));
      indices.set(group.indices);
      const geometry = new MeshGeometry({
        positions: positions.subarray(0, positionLength),
        uvs: uvs.subarray(0, positionLength),
        indices: indices.subarray(0, indexLength),
        shrinkBuffersToFit: false,
      });
      const mesh = new Mesh({ geometry, texture: Texture.WHITE });
      mesh.tint = group.color;
      mesh.alpha = group.alpha;
      batch = { mesh, geometry, positions, uvs, indices };
      this.meshes.set(key, batch);
    } else {
      if (batch.positions.length < positionLength) {
        batch.positions = new Float32Array(positionLength);
        batch.uvs = new Float32Array(positionLength);
      }
      if (batch.indices.length < indexLength) {
        batch.indices = new Uint32Array(indexLength);
      }
      batch.positions.set(group.positions);
      batch.indices.set(group.indices);
      batch.geometry.positions = batch.positions.subarray(0, positionLength);
      batch.geometry.uvs = batch.uvs.subarray(0, positionLength);
      batch.geometry.indices = batch.indices.subarray(0, indexLength);
      batch.mesh.tint = group.color;
      batch.mesh.alpha = group.alpha;
      batch.mesh.visible = true;
    }
  }
}

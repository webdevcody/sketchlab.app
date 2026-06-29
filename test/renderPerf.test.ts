import { describe, expect, it } from "vitest";
import { createFramePhases, RenderPerfRecorder, timePhase } from "../src/render/perfStats";
import { PedestalBatch, type BatchNode } from "../src/render/pedestalBatch";
import { NO_FILL } from "../src/render/geometry";
import { collectGridLines } from "../src/render/boardLayers";
import { createProjector, depthAtBoard, projectBoard } from "../src/render/projection";
import { syncLayerOrder, type OrderedLayer } from "../src/render/renderOrder";
import { H_PED } from "../src/render/shading";
import { boardViewportBounds, isShapeInViewport } from "../src/render/culling";
import { InstancedPedestalBatch } from "../src/render/instancedPedestalBatch";
import { ShapeSpatialIndex } from "../src/render/shapeSpatialIndex";
import type { Shape } from "../src/state/types";
import { makeCircleScenario } from "./perfScenarios";

class FakeLayer<T> implements OrderedLayer<T> {
  removeCalls = 0;
  addCalls = 0;

  constructor(public children: T[]) {}

  removeChildren(): unknown {
    this.removeCalls++;
    this.children = [];
    return [];
  }

  addChild(...children: T[]): unknown {
    this.addCalls++;
    this.children.push(...children);
    return children[children.length - 1];
  }
}

function recordSortFrame(recorder: RenderPerfRecorder, phaseMs: number): void {
  recorder.add({
    totalMs: phaseMs,
    phases: {
      syncBoard: 0,
      reproject: 0,
      visibility: 0,
      sort: phaseMs,
      overlay: 0,
      pixi: 0,
    },
    nodeCount: 1000,
    edgeCount: 0,
    reprojectedNodes: 0,
    reprojectedEdges: 0,
    sortedItems: 1000,
  });
}

describe("render performance instrumentation", () => {
  it("keeps both grid axes visible and capped at far zoom levels", () => {
    const bounds = { minX: -20_000, minY: -20_000, maxX: 20_000, maxY: 20_000 };
    for (const zoom of [0.03, 0.05, 0.08, 0.12]) {
      const projector = createProjector(
        { focusX: 0, focusY: 0, distance: 1200 / zoom, pitch: Math.PI / 3, zoom },
        { w: 1440, h: 900 },
      );
      const lines = collectGridLines(projector, bounds);
      const xAxis = lines.filter((line) => line.axis === 0);
      const yAxis = lines.filter((line) => line.axis === 1);
      expect(xAxis.length).toBeGreaterThan(2);
      expect(yAxis.length).toBeGreaterThan(2);
      expect(xAxis.length).toBeLessThanOrEqual(180);
      expect(yAxis.length).toBeLessThanOrEqual(180);
    }
  });

  it("builds deterministic 1k, 5k, and 10k circle perf scenarios", () => {
    expect(makeCircleScenario(1000, "all-visible")).toHaveLength(1000);
    expect(makeCircleScenario(5000, "mixed-colors")).toHaveLength(5000);
    expect(makeCircleScenario(10_000, "mostly-offscreen")).toHaveLength(10_000);
    expect(makeCircleScenario(1000, "selected-all").every((shape) => shape.text)).toBe(true);
    expect(makeCircleScenario(1000, "non-batchable").every((shape) => shape.fill === NO_FILL)).toBe(true);
  });

  it("uses a spatial index to narrow mostly-offscreen circle candidates", () => {
    const shapes = makeCircleScenario(10_000, "mostly-offscreen");
    const index = new ShapeSpatialIndex();
    index.rebuild(shapes);
    const projector = createProjector(
      { focusX: 0, focusY: 0, distance: 5000, pitch: Math.PI / 2, zoom: 1 },
      { w: 1440, h: 900 },
    );
    const bounds = boardViewportBounds(projector, { w: 1440, h: 900 });
    expect(bounds).not.toBeNull();
    const candidates = index.queryRect(bounds!);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(2000);
  });

  it("culls offscreen shapes before they enter the pedestal batch", () => {
    const projector = createProjector(
      { focusX: 0, focusY: 0, distance: 5000, pitch: Math.PI / 2, zoom: 1 },
      { w: 1440, h: 900 },
    );
    const onscreen: Shape = {
      id: "onscreen",
      kind: "circle",
      x: -32,
      y: -32,
      w: 64,
      h: 64,
      fill: "#0f2740",
      text: "",
    };
    const offscreen: Shape = {
      ...onscreen,
      id: "offscreen",
      x: 100_000,
      y: 100_000,
    };

    expect(isShapeInViewport(onscreen, projector, { w: 1440, h: 900 })).toBe(true);
    expect(isShapeInViewport(offscreen, projector, { w: 1440, h: 900 })).toBe(false);
  });

  it("updates the GPU pedestal batch for 900 mixed on/offscreen circles inside a 60fps frame budget", () => {
    const circles: Shape[] = Array.from({ length: 900 }, (_, i) => {
      const visible = i < 120;
      const col = i % 30;
      const row = Math.floor(i / 30);
      return {
        id: `mixed_circle_${i}`,
        kind: "circle",
        x: visible ? col * 90 - 1350 : 50_000 + col * 100,
        y: visible ? row * 90 - 450 : 50_000 + row * 100,
        w: 64,
        h: 64,
        fill: "#0f2740",
        text: "",
      };
    });
    const batch = new PedestalBatch();
    const recorder = new RenderPerfRecorder();

    try {
      for (let frame = 0; frame < 90; frame++) {
        const projector = createProjector(
          {
            focusX: 0,
            focusY: 0,
            distance: 5000,
            pitch: Math.PI / 2,
            zoom: 1,
            yaw: frame * 0.002,
          },
          { w: 1440, h: 900 },
        );
        const viewport = { w: 1440, h: 900 };
        const nodes: BatchNode[] = circles
          .filter((shape) => isShapeInViewport(shape, projector, viewport))
          .map((shape) => ({
            shape,
            alpha: 1,
            depth: depthAtBoard(projector, shape.x + shape.w / 2, shape.y + shape.h / 2, H_PED),
          }));
        const phases = createFramePhases();
        const start = performance.now();
        timePhase(phases, "reproject", () => batch.update(nodes, projector));
        recorder.add({
          totalMs: performance.now() - start,
          phases,
          nodeCount: circles.length,
          edgeCount: 0,
          reprojectedNodes: nodes.length,
          reprojectedEdges: 0,
          sortedItems: nodes.length,
        });
        expect(nodes.length).toBeLessThan(circles.length);
      }
    } finally {
      batch.destroy();
    }

    const summary = recorder.summary();
    expect(summary.frames).toBe(90);
    expect(summary.last?.nodeCount).toBe(900);
    expect(summary.last?.reprojectedNodes).toBeLessThan(900);
    expect(summary.estimatedFps).toBeGreaterThanOrEqual(55);
  });

  it("reports batch mesh, vertex, and upload metrics for large circle scenarios", () => {
    const circles = makeCircleScenario(5000, "mixed-colors");
    const batch = new PedestalBatch();
    const projector = createProjector(
      { focusX: 0, focusY: 0, distance: 6500, pitch: Math.PI / 2, zoom: 1 },
      { w: 1440, h: 900 },
    );
    const nodes: BatchNode[] = circles.map((shape) => ({
      shape,
      alpha: 1,
      depth: depthAtBoard(projector, shape.x + shape.w / 2, shape.y + shape.h / 2, H_PED),
    }));

    try {
      batch.update(nodes, projector);
      const stats = batch.getStats();
      expect(stats.visibleNodes).toBe(5000);
      expect(stats.batchVertices).toBeGreaterThan(5000);
      expect(stats.batchMeshes).toBeGreaterThan(0);
      expect(stats.batchUploadBytes).toBeGreaterThan(0);
    } finally {
      batch.destroy();
    }
  });

  it("keeps instanced chip data stable across camera-only frames", () => {
    const circles = makeCircleScenario(1000, "all-visible");
    const batch = new InstancedPedestalBatch();
    const firstProjector = createProjector(
      { focusX: 0, focusY: 0, distance: 6500, pitch: Math.PI / 2, zoom: 1 },
      { w: 1440, h: 900 },
    );
    const secondProjector = createProjector(
      { focusX: 40, focusY: -20, distance: 6500, pitch: Math.PI / 2, zoom: 1.1 },
      { w: 1440, h: 900 },
    );
    const nodes = circles.map((shape) => ({ shape, alpha: 1 }));

    batch.update(nodes, firstProjector, 1);
    expect(batch.getStats().cameraOnlyFrame).toBe(false);
    batch.update(nodes, secondProjector, 1);
    expect(batch.getStats().cameraOnlyFrame).toBe(true);
    expect(batch.getStats().instances).toBe(1000);
  });

  it("collapses mixed-color instanced chips into one draw stream", () => {
    const circles = makeCircleScenario(5000, "mixed-colors");
    const batch = new InstancedPedestalBatch();
    const projector = createProjector(
      { focusX: 0, focusY: 0, distance: 6500, pitch: Math.PI / 2, zoom: 1 },
      { w: 1440, h: 900 },
    );
    batch.update(circles.map((shape) => ({ shape, alpha: 1 })), projector, 1);
    expect(batch.getStats().instances).toBe(5000);
    expect(batch.getStats().drawCalls).toBe(1);
  });

  it("updates the GPU pedestal batch for 900 full-detail circles inside a 60fps frame budget", () => {
    const circles: Shape[] = Array.from({ length: 900 }, (_, i) => {
      const col = i % 30;
      const row = Math.floor(i / 30);
      return {
        id: `circle_${i}`,
        kind: "circle",
        x: col * 100 - 1500,
        y: row * 100 - 1500,
        w: 64,
        h: 64,
        fill: "#0f2740",
        text: "",
      };
    });
    const batch = new PedestalBatch();
    const recorder = new RenderPerfRecorder();

    try {
      for (let frame = 0; frame < 90; frame++) {
        const projector = createProjector(
          {
            focusX: 0,
            focusY: 0,
            distance: 5000,
            pitch: Math.PI / 2,
            zoom: 1,
            yaw: frame * 0.002,
          },
          { w: 1440, h: 900 },
        );
        const nodes: BatchNode[] = circles.map((shape) => ({
          shape,
          alpha: 1,
          depth: depthAtBoard(projector, shape.x + shape.w / 2, shape.y + shape.h / 2, H_PED),
        }));
        const phases = createFramePhases();
        const start = performance.now();
        timePhase(phases, "reproject", () => batch.update(nodes, projector));
        recorder.add({
          totalMs: performance.now() - start,
          phases,
          nodeCount: circles.length,
          edgeCount: 0,
          reprojectedNodes: circles.length,
          reprojectedEdges: 0,
          sortedItems: circles.length,
        });
        expect(batch.visible).toBe(true);
      }
    } finally {
      batch.destroy();
    }

    const summary = recorder.summary();
    expect(summary.frames).toBe(90);
    expect(summary.last?.nodeCount).toBe(900);
    expect(summary.estimatedFps).toBeGreaterThanOrEqual(55);
  });

  it("projects and depth-sorts 1000 nodes inside a 60fps frame budget", () => {
    const shapes: Shape[] = Array.from({ length: 1000 }, (_, i) => {
      const col = i % 40;
      const row = Math.floor(i / 40);
      return {
        id: `node_${i}`,
        kind: "rect",
        x: col * 130 - 2600,
        y: row * 100 - 1250,
        w: 90,
        h: 64,
        fill: "#0f2740",
        text: `Node ${i}`,
      };
    });
    const recorder = new RenderPerfRecorder();

    for (let frame = 0; frame < 90; frame++) {
      const projector = createProjector(
        {
          focusX: 0,
          focusY: 0,
          distance: 6000,
          pitch: Math.PI / 2,
          zoom: 1,
          yaw: frame * 0.002,
        },
        { w: 1440, h: 900 },
      );
      const phases = createFramePhases();
      const start = performance.now();
      const entries = timePhase(phases, "reproject", () =>
        shapes.map((shape) => {
          const top = H_PED;
          const corners = [
            projectBoard(projector, shape.x, shape.y, top),
            projectBoard(projector, shape.x + shape.w, shape.y, top),
            projectBoard(projector, shape.x + shape.w, shape.y + shape.h, top),
            projectBoard(projector, shape.x, shape.y + shape.h, top),
          ];
          return {
            visible: corners.every((corner) => corner.ok),
            depth: depthAtBoard(
              projector,
              shape.x + shape.w / 2,
              shape.y + shape.h / 2,
              top,
            ),
          };
        }),
      );
      timePhase(phases, "sort", () => entries.sort((a, b) => b.depth - a.depth));
      recorder.add({
        totalMs: performance.now() - start,
        phases,
        nodeCount: shapes.length,
        edgeCount: 0,
        reprojectedNodes: shapes.length,
        reprojectedEdges: 0,
        sortedItems: entries.length,
      });
      expect(entries.every((entry) => entry.visible)).toBe(true);
    }

    const summary = recorder.summary();
    expect(summary.frames).toBe(90);
    expect(summary.last?.nodeCount).toBe(1000);
    expect(summary.estimatedFps).toBeGreaterThanOrEqual(55);
  });

  it("keeps 1000-node layer ordering inside a 60fps frame budget", () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const forward = [...nodes];
    const reverse = [...nodes].reverse();
    const layer = new FakeLayer([...forward]);
    const recorder = new RenderPerfRecorder();

    for (let frame = 0; frame < 120; frame++) {
      const phases = createFramePhases();
      const start = performance.now();
      timePhase(phases, "sort", () =>
        syncLayerOrder(layer, frame % 2 === 0 ? reverse : forward),
      );
      recordSortFrame(recorder, performance.now() - start);
    }

    const summary = recorder.summary();
    expect(summary.frames).toBe(120);
    expect(summary.last?.nodeCount).toBe(1000);
    expect(summary.estimatedFps).toBeGreaterThanOrEqual(55);
    expect(layer.children).toEqual(forward);
  });

  it("does not touch the layer when the sorted order is unchanged", () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const layer = new FakeLayer([...nodes]);

    expect(syncLayerOrder(layer, nodes)).toBe(false);
    expect(layer.removeCalls).toBe(0);
    expect(layer.addCalls).toBe(0);
    expect(layer.children).toEqual(nodes);
  });
});

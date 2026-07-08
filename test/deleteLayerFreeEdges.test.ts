import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render/scene", () => ({
  scene: {
    addNode: vi.fn(),
    addEdge: vi.fn(),
    updateNode: vi.fn(),
    updateEdge: vi.fn(),
    removeEdge: vi.fn(),
    rebuild: vi.fn(),
    requestRender: vi.fn(),
  },
}));

import {
  addLayer,
  createFreeEdge,
  createShape,
  deleteLayer,
  loadBoard,
} from "../src/state/actions";
import { $activeLayer, doc } from "../src/state/store";
import type { Board } from "../src/state/types";

function emptyBoard(): Board {
  return { name: "t", shapes: {}, edges: {}, order: [] };
}

beforeEach(() => {
  loadBoard(emptyBoard());
  $activeLayer.set(0);
});

describe("deleteLayer free-floating edge re-index", () => {
  it("re-indexes free edges on higher floors after deleting a middle floor (drop)", () => {
    addLayer(); // 1
    addLayer(); // 2
    const groundLine = createFreeEdge({ x1: 0, y1: 0, x2: 40, y2: 0, layer: 0 });
    const midLine = createFreeEdge({ x1: 0, y1: 20, x2: 40, y2: 20, layer: 1 });
    const topLine = createFreeEdge({ x1: 0, y1: 40, x2: 40, y2: 40, layer: 2 });
    // Anchored edges are excluded from this pass (elevation comes from endpoints).
    const a = createShape("rect", 0, 0, 40, 40, { layer: 2 });
    const b = createShape("rect", 80, 0, 40, 40, { layer: 2 });
    const anchored = createFreeEdge({ from: a.id, to: b.id, layer: 9 });

    deleteLayer(1, "drop");

    expect(doc.board.edges[groundLine.id].layer).toBe(0);
    expect(doc.board.edges[midLine.id].layer).toBe(0); // dropped onto floor below
    expect(doc.board.edges[topLine.id].layer).toBe(1);
    expect(doc.board.edges[anchored.id].layer).toBe(9);
    expect(doc.board.shapes[a.id].layer).toBe(1);
    expect(doc.board.shapes[b.id].layer).toBe(1);
  });

  it("re-indexes higher free edges and purges free edges on the deleted floor", () => {
    addLayer();
    addLayer();
    const midLine = createFreeEdge({ x1: 0, y1: 0, x2: 40, y2: 0, layer: 1 });
    const topLine = createFreeEdge({ x1: 0, y1: 20, x2: 40, y2: 20, layer: 2 });

    deleteLayer(1, "purge");

    expect(doc.board.edges[midLine.id]).toBeUndefined();
    expect(doc.board.edges[topLine.id].layer).toBe(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render/scene", () => ({
  scene: {
    addNode: vi.fn(),
    addEdge: vi.fn(),
    updateNode: vi.fn(),
    updateEdge: vi.fn(),
    removeEdge: vi.fn(),
    rebuild: vi.fn(),
    redrawBoard: vi.fn(),
    requestRender: vi.fn(),
  },
}));

import {
  addLayer,
  createFreeEdge,
  createShape,
  loadBoard,
  reorderLayer,
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

describe("reorderLayer", () => {
  it("reorders named floors and remaps shapes + free edges", () => {
    addLayer(); // 1
    addLayer(); // 2
    doc.board.layers![0].name = "Ground";
    doc.board.layers![1].name = "Mid";
    doc.board.layers![2].name = "Top";

    const ground = createShape("rect", 0, 0, 40, 40, { layer: 0 });
    const mid = createShape("rect", 0, 0, 40, 40, { layer: 1 });
    const top = createShape("rect", 0, 0, 40, 40, { layer: 2 });
    const midLine = createFreeEdge({ x1: 0, y1: 0, x2: 40, y2: 0, layer: 1 });
    const anchored = createFreeEdge({ from: top.id, to: mid.id, layer: 9 });

    $activeLayer.set(2);
    reorderLayer(2, 0); // Top → bottom of stack

    expect(doc.board.layers!.map((l) => l.name)).toEqual(["Top", "Ground", "Mid"]);
    expect(doc.board.shapes[top.id].layer).toBe(0);
    expect(doc.board.shapes[ground.id].layer).toBe(1);
    expect(doc.board.shapes[mid.id].layer).toBe(2);
    expect(doc.board.edges[midLine.id].layer).toBe(2);
    expect(doc.board.edges[anchored.id].layer).toBe(9); // anchored edges keep their own field
    expect($activeLayer.get()).toBe(0); // active followed the moved floor
  });

  it("moves a lower floor upward and shifts intervening floors down", () => {
    addLayer();
    addLayer();
    const ground = createShape("rect", 0, 0, 40, 40, { layer: 0 });
    const mid = createShape("rect", 0, 0, 40, 40, { layer: 1 });
    const top = createShape("rect", 0, 0, 40, 40, { layer: 2 });

    reorderLayer(0, 2);

    expect(doc.board.layers!.map((layer) => layer.name)).toEqual(["Layer 1", "Layer 2", "Ground"]);
    expect(doc.board.shapes[ground.id].layer).toBe(2);
    expect(doc.board.shapes[mid.id].layer).toBe(0);
    expect(doc.board.shapes[top.id].layer).toBe(1);
  });

  it("does not materialize or reorder floors for invalid moves", () => {
    reorderLayer(0, 0);
    expect(doc.board.layers).toEqual([]);

    addLayer();
    const before = doc.board.layers!.map((l) => l.id);
    reorderLayer(-1, 0);
    reorderLayer(0, 99);
    expect(doc.board.layers!.map((l) => l.id)).toEqual(before);
  });
});

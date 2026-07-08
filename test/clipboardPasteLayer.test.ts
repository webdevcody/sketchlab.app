import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render/scene", () => ({
  scene: {
    addNode: vi.fn(),
    addEdge: vi.fn(),
    updateNode: vi.fn(),
    updateEdge: vi.fn(),
    rebuild: vi.fn(),
    requestRender: vi.fn(),
  },
}));

import { createEdge, createShape, loadBoard } from "../src/state/actions";
import { copySelection, pasteClipboard } from "../src/state/clipboard";
import { $activeLayer, doc, setSelection } from "../src/state/store";
import type { Board, LayerDef } from "../src/state/types";

function boardWithFloors(n: number): Board {
  const layers: LayerDef[] = Array.from({ length: n }, (_, i) => ({
    id: `L${i}`,
    name: i === 0 ? "Ground" : `Layer ${i}`,
  }));
  return { name: "t", shapes: {}, edges: {}, order: [], layers };
}

beforeEach(() => {
  loadBoard(boardWithFloors(3));
  $activeLayer.set(0);
});

describe("pasteClipboard layer rebase", () => {
  it("clamps rebased layers to layers.length - 1 (no phantom floors)", () => {
    // Copy shapes spanning floors 0 and 1, then paste onto the top floor (2).
    // Without an upper clamp, the floor-1 shape would land at index 3.
    const low = createShape("rect", 0, 0, 40, 40, { layer: 0 });
    const high = createShape("rect", 50, 0, 40, 40, { layer: 1 });
    setSelection([low.id, high.id], []);
    copySelection();

    $activeLayer.set(2);
    pasteClipboard();

    const pasted = Object.values(doc.board.shapes).filter(
      (s) => s.id !== low.id && s.id !== high.id,
    );
    expect(pasted).toHaveLength(2);
    const layers = pasted.map((s) => s.layer ?? 0).sort((a, b) => a - b);
    // Both clamp onto the top floor (2): floor0→2, floor1→3→2. No phantom index 3.
    expect(layers).toEqual([2, 2]);
    expect(Math.max(...layers)).toBeLessThanOrEqual(doc.board.layers!.length - 1);
  });

  it("still relative-rebases multi-floor content when it fits", () => {
    const low = createShape("rect", 0, 0, 40, 40, { layer: 0 });
    const high = createShape("rect", 50, 0, 40, 40, { layer: 1 });
    setSelection([low.id, high.id], []);
    copySelection();

    $activeLayer.set(1);
    pasteClipboard();

    const pasted = Object.values(doc.board.shapes).filter(
      (s) => s.id !== low.id && s.id !== high.id,
    );
    const layers = pasted.map((s) => s.layer ?? 0).sort((a, b) => a - b);
    expect(layers).toEqual([1, 2]);
  });

  it("includes anchored-edge layers in minLayer so relative floors stay aligned", () => {
    // Use enough floors that rebase (shapes→3, edge→2) is not capped by maxLayer.
    loadBoard(boardWithFloors(5));
    // Shapes live on floor 1; the spanning edge still carries layer 0 (as can
    // happen when an edge was created earlier). Pasting onto floor 2 must shift
    // both by the same delta so the edge does not land a floor below its ends.
    const a = createShape("rect", 0, 0, 80, 80, { layer: 1 });
    const b = createShape("rect", 200, 0, 80, 80, { layer: 1 });
    const edge = createEdge(a.id, b.id)!;
    edge.layer = 0;

    setSelection([a.id, b.id], [edge.id]);
    copySelection();

    $activeLayer.set(2);
    pasteClipboard();

    const pastedShapes = Object.values(doc.board.shapes).filter(
      (s) => s.id !== a.id && s.id !== b.id,
    );
    const pastedEdges = Object.values(doc.board.edges).filter((e) => e.id !== edge.id);

    expect(pastedShapes).toHaveLength(2);
    expect(pastedEdges).toHaveLength(1);
    // minLayer was 0 (from the anchored edge), so layerDelta = 2 - 0 = 2
    expect(pastedShapes.every((s) => s.layer === 3)).toBe(true);
    expect(pastedEdges[0].layer).toBe(2);
    // edge stays the same relative offset below its endpoint floors
    expect(pastedShapes[0].layer! - pastedEdges[0].layer!).toBe(1);
  });
});

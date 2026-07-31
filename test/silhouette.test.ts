import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render/scene", () => ({
  scene: {
    addNode: vi.fn(),
    updateNode: vi.fn(),
    updateEdge: vi.fn(),
    rebuild: vi.fn(),
    requestRender: vi.fn(),
  },
}));

import { createShape, loadBoard, setShapesSilhouette } from "../src/state/actions";
import { boundaryPoint, isRoundFootprint, supportsSilhouette } from "../src/render/geometry";
import { decodeBoard, encodeBoard } from "../src/persistence/share";
import { doc } from "../src/state/store";
import type { Board, Shape, ShapeKind } from "../src/state/types";

const ALL_KINDS: ShapeKind[] = ["rect", "circle", "icon", "image", "text", "code"];
const ROUND_BY_DEFAULT: ShapeKind[] = ["circle", "icon"];
const RESHAPABLE: ShapeKind[] = ["icon", "circle", "rect", "image"];

function shape(kind: ShapeKind, patch: Partial<Shape> = {}): Shape {
  return { id: kind, kind, x: 0, y: 0, w: 100, h: 100, fill: "#0f2740", text: "", ...patch };
}

function emptyBoard(): Board {
  return { id: "b", name: "t", shapes: {}, edges: {}, order: [], createdAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  loadBoard(emptyBoard());
});

describe("isRoundFootprint", () => {
  it("falls back to the kind default when no silhouette was chosen", () => {
    for (const kind of ALL_KINDS) {
      expect(isRoundFootprint(shape(kind))).toBe(ROUND_BY_DEFAULT.includes(kind));
    }
  });

  it("lets an explicit silhouette override the kind default", () => {
    for (const kind of ALL_KINDS) {
      expect(isRoundFootprint(shape(kind, { silhouette: "circle" }))).toBe(true);
      expect(isRoundFootprint(shape(kind, { silhouette: "square" }))).toBe(false);
    }
  });
});

describe("supportsSilhouette", () => {
  it("accepts the kinds that raise a pedestal and rejects the rest", () => {
    for (const kind of ALL_KINDS) {
      expect(supportsSilhouette(shape(kind))).toBe(RESHAPABLE.includes(kind));
    }
  });
});

describe("setShapesSilhouette", () => {
  it("reshapes eligible kinds and leaves text and code untouched", () => {
    const created = ALL_KINDS.map((kind) => createShape(kind, 0, 0));

    setShapesSilhouette(
      created.map((s) => s.id),
      "square",
    );

    created.forEach((s, i) => {
      const stored = doc.board.shapes[s.id];
      if (RESHAPABLE.includes(ALL_KINDS[i])) expect(stored.silhouette).toBe("square");
      else expect(stored.silhouette).toBeUndefined();
    });
  });

  it("keeps dimensions so switching back restores the original box", () => {
    const wide = createShape("rect", 0, 0, 400, 100);

    setShapesSilhouette([wide.id], "circle");
    expect(doc.board.shapes[wide.id].w).toBe(400);
    expect(doc.board.shapes[wide.id].h).toBe(100);

    setShapesSilhouette([wide.id], "square");
    expect(doc.board.shapes[wide.id]).toMatchObject({ w: 400, h: 100, silhouette: "square" });
  });

  it("ignores ids that are not on the board", () => {
    expect(() => setShapesSilhouette(["missing"], "circle")).not.toThrow();
  });
});

describe("edge anchoring", () => {
  it("follows the silhouette rather than the kind", () => {
    const target = { x: 500, y: 0 };
    const roundRect = boundaryPoint(shape("rect", { silhouette: "circle" }), target);
    const squareIcon = boundaryPoint(shape("icon", { silhouette: "square" }), target);

    expect(roundRect).toEqual(boundaryPoint(shape("circle"), target));
    expect(squareIcon).toEqual(boundaryPoint(shape("rect"), target));
  });
});

describe("share round trip", () => {
  it("preserves a chosen silhouette", () => {
    const icon = createShape("icon", 0, 0, 100, 100, { icon: "database" });
    setShapesSilhouette([icon.id], "square");

    const restored = decodeBoard(encodeBoard(doc.board));

    expect(Object.values(restored!.shapes)[0]).toMatchObject({
      kind: "icon",
      icon: "database",
      silhouette: "square",
    });
  });

  it("omits the key entirely for shapes that were never reshaped", () => {
    const icon = createShape("icon", 0, 0);

    const restored = decodeBoard(encodeBoard(doc.board));

    expect(restored!.shapes[icon.id]).not.toHaveProperty("silhouette");
    expect(isRoundFootprint(restored!.shapes[icon.id])).toBe(true);
  });
});

import { ICON_MAP, searchIcons } from "../render/icons";
import { uid } from "../util";
import { computeAutoLayoutEdgeBends, computeAutoLayoutPositions } from "./autoLayout";
import { DEFAULT_TEXT_FONT_SIZE } from "./style";
import { emptyBoard } from "./store";
import type { Board, Edge, ID, LayerDef, Shape, ShapeKind } from "./types";

export type GeneratedNodeKind = "rect" | "circle" | "icon" | "text";

export interface GeneratedNode {
  id: string;
  label: string;
  kind?: GeneratedNodeKind;
  icon?: string;
  color?: string;
  /** 0-based index of the named floor (see GeneratedGraph.layers) this node sits on. */
  layer?: number;
}

export interface GeneratedEdge {
  from: string;
  to: string;
  label?: string;
  directed?: boolean;
}

/** A named floor in the generated 3D stack; its array index is a node's `layer`. */
export interface GeneratedLayer {
  name: string;
  /** optional #RRGGBB accent for the floor frame/badge (defaults to cyan) */
  color?: string;
}

export interface GeneratedGraph {
  name?: string;
  /** Named floors, bottom→top. Index === GeneratedNode.layer. Omit/empty = single ground floor. */
  layers?: GeneratedLayer[];
  nodes: GeneratedNode[];
  edges: GeneratedEdge[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_FILL = "#0f2740";
const DEFAULT_ICON = "microservice";
const NODE_W = 150;
const NODE_H = 110;
const TEXT_W = 240;
const TEXT_H = 72;
const MAX_NODES = 48;
const MAX_EDGES = 96;
const MAX_LAYERS = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}

function normalizeKind(value: unknown, icon: string | undefined): GeneratedNodeKind {
  if (value === "rect" || value === "circle" || value === "icon" || value === "text") {
    return value;
  }
  return icon ? "icon" : "rect";
}

function normalizeColor(value: string | undefined): string {
  return value && HEX.test(value) ? value : DEFAULT_FILL;
}

/** A valid #RRGGBB accent, or undefined so callers fall back to the cyan default. */
function optionalHexColor(value: string | undefined): string | undefined {
  return value && HEX.test(value) ? value : undefined;
}

/** Clamp a model-supplied floor index to a non-negative integer within the cap. */
function normalizeLayerIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const i = Math.floor(value);
  return i < 0 ? 0 : i > MAX_LAYERS - 1 ? MAX_LAYERS - 1 : i;
}

function parseLayers(value: unknown): GeneratedLayer[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Generated diagram layers must be an array");
  if (value.length > MAX_LAYERS) {
    throw new Error(`Generated diagram has too many layers; max is ${MAX_LAYERS}`);
  }
  return value.map((raw, i): GeneratedLayer => {
    if (!isRecord(raw)) throw new Error(`layers[${i}] must be an object`);
    return {
      name: requiredString(raw, "name", `layers[${i}]`),
      color: optionalHexColor(optionalString(raw, "color")),
    };
  });
}

function normalizeIcon(value: string | undefined, label: string): string {
  if (value && ICON_MAP.has(value)) return value;
  const match = searchIcons(value ?? label)[0]?.key;
  return match && ICON_MAP.has(match) ? match : DEFAULT_ICON;
}

export function parseGeneratedGraph(value: unknown): GeneratedGraph {
  if (!isRecord(value)) throw new Error("Generated diagram must be a JSON object");

  const rawNodes = value.nodes;
  const rawEdges = value.edges;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error("Generated diagram must include at least one node");
  }
  if (rawNodes.length > MAX_NODES) {
    throw new Error(`Generated diagram has too many nodes; max is ${MAX_NODES}`);
  }
  if (rawEdges !== undefined && (!Array.isArray(rawEdges) || rawEdges.length > MAX_EDGES)) {
    throw new Error(`Generated diagram edges must be an array with at most ${MAX_EDGES} items`);
  }

  const seen = new Set<string>();
  const nodes = rawNodes.map((raw, i): GeneratedNode => {
    if (!isRecord(raw)) throw new Error(`nodes[${i}] must be an object`);
    const id = requiredString(raw, "id", `nodes[${i}]`);
    if (seen.has(id)) throw new Error(`Duplicate generated node id: ${id}`);
    seen.add(id);
    const label = requiredString(raw, "label", `nodes[${i}]`);
    const icon = optionalString(raw, "icon");
    return {
      id,
      label,
      kind: normalizeKind(raw.kind, icon),
      icon,
      color: optionalString(raw, "color"),
      layer: normalizeLayerIndex(raw.layer),
    };
  });

  const edges = (rawEdges ?? []).map((raw, i): GeneratedEdge => {
    if (!isRecord(raw)) throw new Error(`edges[${i}] must be an object`);
    const from = requiredString(raw, "from", `edges[${i}]`);
    const to = requiredString(raw, "to", `edges[${i}]`);
    if (!seen.has(from)) throw new Error(`edges[${i}].from references unknown node: ${from}`);
    if (!seen.has(to)) throw new Error(`edges[${i}].to references unknown node: ${to}`);
    if (from === to) throw new Error(`edges[${i}] cannot connect a node to itself`);
    return {
      from,
      to,
      label: optionalString(raw, "label") ?? "",
      directed: optionalBoolean(raw, "directed") ?? false,
    };
  });

  return {
    name: optionalString(value, "name"),
    layers: parseLayers(value.layers),
    nodes,
    edges,
  };
}

function shapeKind(kind: GeneratedNodeKind): ShapeKind {
  return kind === "text" ? "text" : kind === "circle" ? "circle" : kind === "icon" ? "icon" : "rect";
}

export function generatedGraphToBoard(graph: GeneratedGraph, fallbackName: string): Board {
  const board = emptyBoard(graph.name ?? fallbackName);
  const idMap = new Map<string, ID>();

  graph.nodes.forEach((node, index) => {
    const id = `ai_${index + 1}`;
    idMap.set(node.id, id);
    const kind = shapeKind(node.kind ?? "rect");
    const isText = kind === "text";
    const shape: Shape = {
      id,
      kind,
      x: 0,
      y: 0,
      w: isText ? TEXT_W : NODE_W,
      h: isText ? TEXT_H : NODE_H,
      fill: isText ? "transparent" : normalizeColor(node.color),
      text: node.label,
      fontSize: isText ? DEFAULT_TEXT_FONT_SIZE : 16,
    };
    if (kind === "icon") shape.icon = normalizeIcon(node.icon, node.label);
    const layer = node.layer ?? 0;
    if (layer > 0) shape.layer = layer; // 0 is the implicit ground floor — keep shapes minimal
    board.shapes[id] = shape;
    board.order.push(id);
  });

  // Materialize the named floor stack. Cover every floor a node lands on, naming
  // any gaps the model left, so the layers panel and renderer stay consistent. A
  // single-floor diagram keeps the empty list (one implicit ground), matching
  // emptyBoard and ensureLayers.
  const maxLayer = graph.nodes.reduce((m, node) => Math.max(m, node.layer ?? 0), 0);
  const floorCount = Math.max(graph.layers?.length ?? 0, maxLayer + 1);
  if (floorCount > 1) {
    board.layers = Array.from({ length: floorCount }, (_, i): LayerDef => {
      const def = graph.layers?.[i];
      const layer: LayerDef = {
        id: uid(),
        name: def?.name ?? (i === 0 ? "Ground" : `Layer ${i}`),
      };
      if (def?.color) layer.color = def.color;
      return layer;
    });
  }

  graph.edges.forEach((edge, index) => {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) return;
    const id = `ai_edge_${index + 1}`;
    const boardEdge: Edge = {
      id,
      from,
      to,
      label: edge.label ?? "",
      fontSize: 16,
      directed: edge.directed,
    };
    board.edges[id] = boardEdge;
    board.order.push(id);
  });

  const positions = computeAutoLayoutPositions(board);
  for (const [id, pos] of Object.entries(positions)) {
    board.shapes[id].x = pos.x;
    board.shapes[id].y = pos.y;
  }
  const bends = computeAutoLayoutEdgeBends(board);
  for (const [id, bend] of Object.entries(bends)) {
    const edge = board.edges[id];
    if (!edge) continue;
    edge.cx = bend.cx;
    edge.cy = bend.cy;
  }

  return board;
}

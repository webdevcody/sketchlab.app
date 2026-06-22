export type ID = string;

export type ShapeKind = "rect" | "circle" | "icon" | "image" | "text";

export interface Shape {
  id: ID;
  kind: ShapeKind;
  /** world-space top-left */
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  text: string;
  /** only for kind === "icon": registry key of the icon to draw */
  icon?: string;
  /** only for kind === "image": the image data URL (embedded so it persists & shares) */
  src?: string;
  /** label/text font size in world units; an absolute tier size, constant
   *  regardless of the object's dimensions. Unset → follows the board default. */
  fontSize?: number;
  /** id of the group this shape belongs to; undefined when ungrouped. Members of a
   *  group select, move, and delete together (Cmd+G / Cmd+U). */
  group?: ID;
}

export interface Edge {
  id: ID;
  /** source shape id; undefined when this end floats free at (x1,y1) */
  from?: ID;
  /** target shape id; undefined when this end floats free at (x2,y2) */
  to?: ID;
  /** world-space position of a free `from` end (used when `from` is undefined) */
  x1?: number;
  y1?: number;
  /** world-space position of a free `to` end (used when `to` is undefined) */
  x2?: number;
  y2?: number;
  stroke: string;
  label: string;
  /** label font size in world units; an absolute tier size. Unset → follows the board default. */
  fontSize?: number;
  /** when true, draw an arrowhead at the `to` end (directed edge) */
  directed?: boolean;
  /**
   * Optional world-space control point. When set, the line bends through it
   * (quadratic) and endpoints snap toward the control point. When undefined the
   * line is straight and snaps to the centers' boundary intersection.
   */
  cx?: number;
  cy?: number;
  /** id of the group this edge belongs to; undefined when ungrouped. */
  group?: ID;
}

export interface Board {
  id: ID;
  name: string;
  shapes: Record<ID, Shape>;
  edges: Record<ID, Edge>;
  /** unified paint order (bottom -> top) of shape AND edge ids */
  order: ID[];
  /**
   * Board-wide default label font size (world units), one of the S/M/L/XL/XXL
   * tier sizes. Applies to every label without an explicit `fontSize`.
   * Undefined → DEFAULT_FONT_SIZE (Medium).
   */
  fontSize?: number;
  /** @deprecated legacy board-wide font multiplier; migrated to `fontSize` on load. */
  fontScale?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardMeta {
  id: ID;
  name: string;
  updatedAt: number;
  shapeCount: number;
  thumbnail?: string;
}

export type ToolName =
  | "select"
  | "text"
  | "rect"
  | "circle"
  | "line"
  | "arrow"
  | "hand";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface SelectionState {
  shapes: Set<ID>;
  edges: Set<ID>;
}

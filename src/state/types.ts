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
  /** only for kind === "text": font size in world units (defaults to TEXT_FONT_SIZE) */
  fontSize?: number;
}

export interface Edge {
  id: ID;
  from: ID;
  to: ID;
  stroke: string;
  label: string;
  /** when true, draw an arrowhead at the `to` end (directed edge) */
  directed?: boolean;
  /**
   * Optional world-space control point. When set, the line bends through it
   * (quadratic) and endpoints snap toward the control point. When undefined the
   * line is straight and snaps to the centers' boundary intersection.
   */
  cx?: number;
  cy?: number;
}

export interface Board {
  id: ID;
  name: string;
  shapes: Record<ID, Shape>;
  edges: Record<ID, Edge>;
  /** paint order (bottom -> top) of shape ids */
  order: ID[];
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
